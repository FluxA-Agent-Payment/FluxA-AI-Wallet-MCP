import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../packages/fluxa-wallet/bin/fluxa-wallet.js', import.meta.url));
const jwt = `e30.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString('base64url')}.test`;
const card = { id: 'card_1', cardTypeId: null, status: 'active' };
const profile = { firstName: 'Alice', lastName: 'Example', email: 'alice@example.com', phone: '+14155550123', address: { country: 'US', city: 'San Francisco', line1: '1 Example St', postalCode: '94105' } };

test('bundled CLI uses v2 contracts and keeps existing commands compatible', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fluxa-card-test-'));
  let calls = [];
  let handler;
  const server = http.createServer(async (req, res) => {
    try {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : undefined;
      const call = { path: req.url, method: req.method, body, headers: req.headers };
      calls.push(call);
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/v2/auth/challenge') return res.end(JSON.stringify({ challenge: 'challenge-test', audience: 'audience-test' }));
      if (req.url === '/agent/vc/issue') {
        assert.deepEqual(body, { challenge: 'challenge-test', audience: 'audience-test', ttl_seconds: 600 });
        return res.end(JSON.stringify({ vc: 'test-vc' }));
      }
      if (req.url.startsWith('/api/v2/') && req.url !== '/api/v2/payment/x402-payment') assert.equal(req.headers.authorization, 'Bearer test-vc');
      const result = handler(call);
      res.statusCode = result.status || 200;
      res.end(JSON.stringify(result.body));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: error.message, code: 'mock_assertion_failed' }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const run = async (...args) => {
    calls = [];
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, AGENT_ID: 'agent_test', AGENT_TOKEN: 'test-token', AGENT_JWT: jwt, FLUXA_DATA_DIR: dir, CARD_SERVICE_API: url, AGENT_ID_API: url, WALLET_API: url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { code, data: JSON.parse(stdout), stderr };
  };
  const businessCalls = () => calls.filter(call => call.path !== '/api/v2/auth/challenge' && call.path !== '/agent/vc/issue');

  await t.test('catalog returns unknown fees without inventing a zero charge', async () => {
    const product = { cardTypeId: 'ct_one', fees: { monthly: { status: 'unknown' } }, availability: { canApply: true } };
    handler = call => { assert.equal(call.path, '/api/v2/card-types'); return { body: { cardTypes: [product] } }; };
    const result = await run('card', 'types');
    assert.equal(result.code, 0);
    assert.deepEqual(result.data, [product]);
  });

  await t.test('legacy cards remain visible and default/global list scopes are preserved', async () => {
    for (const global of [false, true]) {
      handler = call => { assert.equal(call.path, global ? '/api/v2/cards' : '/api/v2/cards?issuedBy=me'); return { body: { cards: [card], cardCount: 1 } }; };
      const result = await run('card', 'list', ...(global ? ['--global'] : []));
      assert.equal(result.code, 0);
      assert.deepEqual(result.data, [card]);
    }
  });

  await t.test('new issuance sends a string selector and normalized USD, then returns pending without signing', async () => {
    handler = call => {
      assert.equal(call.path, '/api/v2/cards/initiate');
      assert.deepEqual(call.body, { binId: '00123', amountUsd: '25.00' });
      return { body: { pendingRequestId: 'req_1', requestType: 'issue', status: 'pending_cardholder' } };
    };
    const result = await run('card', 'create', '--bin-id', '00123', '--amount', '25', '--mandate', 'mand_test', '--wait', '0');
    assert.equal(result.code, 0);
    assert.equal(result.data.pendingRequestId, 'req_1');
    assert.match(result.data.continueCommand, /card create --request-id req_1/);
    assert.equal(businessCalls().length, 1);
  });

  await t.test('waitlist rejection forwards the application URL and never requests payment', async () => {
    handler = call => {
      assert.equal(call.path, '/api/v2/cards/initiate');
      return { status: 403, body: { code: 'card_waitlist_required', error: 'Approval required', details: { applicationUrl: 'https://wallet.fluxapay.xyz/cards' } } };
    };
    const result = await run('card', 'create', '--card-type-id', 'ct_one', '--amount', '25.00', '--mandate', 'mand_test');
    assert.equal(result.code, 1);
    assert.equal(result.data.code, 'card_waitlist_required');
    assert.match(result.data.error, /https:\/\/wallet.fluxapay.xyz\/cards/);
    assert.equal(businessCalls().length, 1);
  });

  await t.test('resume signs the fetched payment request and completes the same issue request', async () => {
    const paymentRequest = { x402Version: 2, accepts: [{ amount: '25000000' }] };
    handler = call => {
      if (call.path === '/api/v2/cards/requests/req_1') return { body: { pendingRequestId: 'req_1', requestType: 'issue', status: 'pending_payment', paymentRequest } };
      if (call.path === '/api/v2/payment/x402-payment') {
        assert.deepEqual(call.body, { mandateId: 'mand_test', paymentRequest });
        return { body: { status: 'ok', paymentPayloadB64: 'signed-payload' } };
      }
      assert.equal(call.path, '/api/v2/cards/complete');
      assert.deepEqual(call.body, { pendingRequestId: 'req_1', paymentPayloadB64: 'signed-payload' });
      return { status: 201, body: { success: true, card } };
    };
    const result = await run('card', 'create', '--request-id', 'req_1', '--mandate', 'mand_test', '--wait', '0');
    assert.equal(result.code, 0);
    assert.deepEqual(result.data, card);
    assert.deepEqual(businessCalls().map(call => call.path), ['/api/v2/cards/requests/req_1', '/api/v2/payment/x402-payment', '/api/v2/cards/complete']);
  });

  await t.test('resume recharge infers its original card and returns 202 as business state', async () => {
    handler = call => {
      if (call.path === '/api/v2/cards/requests/req_load') return { body: { pendingRequestId: 'req_load', requestType: 'recharge', cardId: 'card_1', status: 'pending_payment', paymentRequest: { x402Version: 2 } } };
      if (call.path === '/api/v2/payment/x402-payment') return { body: { status: 'ok', paymentPayloadB64: 'signed-payload' } };
      assert.equal(call.path, '/api/v2/cards/card_1/recharge/complete');
      assert.equal(call.body.pendingRequestId, 'req_load');
      return { status: 202, body: { success: false, status: 'payment_submitted', pendingRequestId: 'req_load' } };
    };
    const result = await run('card', 'recharge', '--request-id', 'req_load', '--mandate', 'mand_test', '--wait', '0');
    assert.equal(result.code, 0);
    assert.equal(result.data.status, 'payment_submitted');
    assert.equal(result.data.success, undefined);
    assert.equal(result.data.paymentRequest, undefined);
  });

  await t.test('new recharge sends its amount and returns the card/load without changing commands', async () => {
    handler = call => {
      if (call.path === '/api/v2/cards/card_1/recharge/initiate') {
        assert.deepEqual(call.body, { amountUsd: '10.00' });
        return { body: { pendingRequestId: 'req_load', status: 'pending_payment', paymentRequest: { x402Version: 2 } } };
      }
      if (call.path === '/api/v2/payment/x402-payment') return { body: { status: 'ok', paymentPayloadB64: 'signed-payload' } };
      assert.equal(call.path, '/api/v2/cards/card_1/recharge/complete');
      return { body: { success: true, card, recharge: { amountUsd: '10.00', feeUsd: '0.00' } } };
    };
    const result = await run('card', 'recharge', '--id', 'card_1', '--amount', '10', '--mandate', 'mand_test', '--wait', '0');
    assert.equal(result.code, 0);
    assert.deepEqual(result.data, { card, recharge: { amountUsd: '10.00', feeUsd: '0.00' } });
  });

  await t.test('KYC create accepts a file and profile update sends If-Match', async () => {
    const file = path.join(dir, 'profile.json');
    await writeFile(file, JSON.stringify(profile));
    handler = call => {
      assert.equal(call.path, '/api/v2/cardholders/create');
      assert.deepEqual(call.body, profile);
      return { status: 201, body: { cardholder: { kycStatus: 'pending', verificationUrl: 'https://verify.example.com', nextAction: 'verify' } } };
    };
    let result = await run('card', 'holder', 'create', '--profile', `@${file}`);
    assert.equal(result.code, 0);
    assert.equal(result.data.kycStatus, 'pending');
    handler = call => {
      assert.equal(call.path, '/api/v2/cardholders/update');
      assert.equal(call.headers['if-match'], '"2"');
      assert.deepEqual(call.body, { address: { city: 'Oakland' } });
      return { body: { cardholder: { revision: 3, kycStatus: 'approved' } } };
    };
    result = await run('card', 'holder', 'update', '--city', 'Oakland', '--revision', '2');
    assert.equal(result.code, 0);
    assert.equal(result.data.revision, 3);
    assert.doesNotMatch(await readFile(path.join(dir, 'audit.log'), 'utf8'), /alice@example.com|signed-payload|test-vc/);
  });

  await t.test('legacy holder GET does not trigger profile creation', async () => {
    const legacy = { source: 'legacy', revision: null, kycStatus: 'not_recorded', status: 'pass_audit' };
    handler = call => { assert.equal(call.path, '/api/v2/cardholders/get'); return { body: { cardholder: legacy } }; };
    const result = await run('card', 'holder', 'me');
    assert.equal(result.code, 0);
    assert.deepEqual(result.data, legacy);
    assert.equal(businessCalls().length, 1);
  });

  await t.test('existing read/detail/withdraw commands call v2 paths', async () => {
    const cases = [
      [['card', 'details', '--id', 'card_1'], 'POST', '/api/v2/cards/card_1/details', { success: true, details: { pan: 'test-pan' } }],
      [['card', 'balance', '--id', 'card_1'], 'GET', '/api/v2/cards/card_1/balance', { card, balance: { remainingAmountUsd: '10.00' } }],
      [['card', 'transactions', '--id', 'card_1', '--type', 'deposit', '--limit', '10'], 'GET', '/api/v2/cards/card_1/transactions?type=deposit&pageSize=10', { transactions: [], pageNum: 1, pageSize: 10, total: 0 }],
      [['card', '3ds', 'latest', '--id', 'card_1'], 'GET', '/api/v2/cards/card_1/3ds/latest', { threeDS: null }],
      [['card', '3ds', 'latest_1h', '--id', 'card_1'], 'GET', '/api/v2/cards/card_1/3ds', { threeDS: [], windowMinutes: 60 }],
      [['card', 'withdraw', '--id', 'card_1'], 'POST', '/api/v2/cards/card_1/withdraw', { withdrawalId: 'wd_1', status: 'processing' }],
      [['card', 'withdrawals', '--id', 'card_1'], 'GET', '/api/v2/cards/card_1/withdrawals', { withdrawals: [] }],
      [['card', 'withdrawal', '--id', 'card_1', '--withdrawal-id', 'wd_1'], 'GET', '/api/v2/cards/card_1/withdrawals/wd_1', { withdrawal: { withdrawalId: 'wd_1' } }],
    ];
    for (const [args, method, target, body] of cases) {
      handler = call => {
        assert.equal(call.method, method);
        assert.equal(call.path, target);
        if (target.endsWith('/withdraw')) assert.deepEqual(call.body, {});
        return { body };
      };
      assert.equal((await run(...args)).code, 0, target);
    }
  });

  await t.test('invalid/conflicting options fail before authentication or remote mutation', async () => {
    for (const args of [
      ['create', '--amount', '25', '--mandate', 'mand_test'],
      ['create', '--amount', '25', '--mandate', 'mand_test', '--bin', '123456', '--card-type-id', 'ct_one'],
      ['create', '--request-id', 'req_1', '--amount', '25', '--mandate', 'mand_test'],
      ['recharge', '--request-id', 'req_load', '--amount', '25', '--mandate', 'mand_test'],
      ['holder', 'create', '--first-name', 'Alice', '--last-name', 'Example'],
      ['holder', 'update', '--city', 'Oakland', '--revision', '2oops'],
    ]) {
      assert.equal((await run('card', ...args)).code, 1);
      assert.deepEqual(calls, []);
    }
  });
});
