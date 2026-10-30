import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../packages/fluxa-wallet/bin/fluxa-wallet.js', import.meta.url));
const jwt = `e30.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString('base64url')}.test`;

test('model topup reuses approved mandates without requesting another authorization', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fluxa-topup-test-'));
  let calls, mandate, accepts, paymentResult, lookupMissing;
  const server = http.createServer(async (req, res) => {
    try {
      let text = '';
      for await (const chunk of req) text += chunk;
      const body = text ? JSON.parse(text) : undefined;
      calls.push({ path: req.url, body });
      res.setHeader('Content-Type', 'application/json');
      let result;
      if (req.url.startsWith('/api/mandates/agent/')) {
        result = lookupMissing ? { status: 'error', message: 'Mandate not found' } : { status: 'ok', mandate };
      } else if (req.url === '/llm/topup/initiate') {
        assert.deepEqual(body, { packageSlug: 'starter' });
        res.statusCode = 402;
        result = { orderId: 'order_test', resource: `${url}/llm/topup/order_test/finalize`, costCredits: 5, creditsToGrant: 500000, accepts };
      } else if (req.url === '/api/mandates/create-intent') {
        mandate.currency = body.intent.currency;
        result = { status: 'ok', mandateId: 'mand_new', authorizationUrl: 'https://example.com/approve' };
      } else if (req.url === '/api/payment/x402V3Payment') {
        assert.equal(body.currency, mandate.currency);
        assert.equal(body.amount, mandate.currency === 'USDC' ? '5000000' : '500');
        result = paymentResult;
      } else if (req.url === '/llm/topup/order_test/finalize') {
        assert.equal(req.headers['x-payment'], 'test-payment');
        result = { creditsAdded: 500000, balance: 1500000 };
      } else {
        throw new Error(`Unexpected request: ${req.method} ${req.url}`);
      }
      res.end(JSON.stringify(result));
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ status: 'error', message: error.message }));
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const reset = (currency = 'USDC') => {
    calls = [];
    lookupMissing = false;
    mandate = { mandateId: 'mand_test', status: 'signed', isEnabled: true, currency, remainingAmount: '20000000', validFrom: '2020-01-01T00:00:00Z', validUntil: '2100-01-01T00:00:00Z' };
    accepts = [
      { scheme: 'exact', network: 'base', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', maxAmountRequired: '5000000', resource: `${url}/llm/topup/order_test/finalize`, payTo: '0x0000000000000000000000000000000000000001' },
      { scheme: 'exact', network: 'fluxa-monetize-credits', asset: 'FLUXA_MONETIZE_CREDITS', maxAmountRequired: '500', resource: `${url}/llm/topup/order_test/finalize`, payTo: 'merchant_test' },
    ];
    paymentResult = { status: 'ok', xPaymentB64: 'test-payment' };
  };
  const run = async (...args) => {
    const child = spawn(process.execPath, [cli, 'market', 'model', 'topup', ...args], {
      env: { ...process.env, AGENT_ID: 'agent_test', AGENT_TOKEN: 'test-token', AGENT_JWT: jwt, FLUXA_KEY: 'test-key', FLUXA_DATA_DIR: dir, WALLET_API: url, AGENT_ID_API: url, MARKET_PROXY: url, MARKET_PLATFORM: url },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    const timer = setTimeout(() => child.kill(), 10000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    clearTimeout(timer);
    return { code, stdout, stderr };
  };
  const payments = () => calls.filter(c => c.path === '/api/payment/x402V3Payment');
  const creations = () => calls.filter(c => c.path === '/api/mandates/create-intent');

  for (const currency of ['USDC', 'FLUXA_MONETIZE_CREDITS']) {
    for (const explicit of [false, true]) {
      await t.test(`reuse ${currency}, explicit currency: ${explicit}`, async () => {
        reset(currency);
        const result = await run('--bundle', 'starter', '--mandate', 'mand_test', ...(explicit ? [currency === 'USDC' ? '--usdc' : '--credit'] : []));
        assert.equal(result.code, 0, result.stdout + result.stderr);
        assert.match(result.stdout, /\+\$5\.00 Balance/);
        assert.equal(creations().length, 0);
        assert.equal(payments().length, 1);
        assert.equal(payments()[0].body.mandateId, 'mand_test');
        assert.equal(calls.filter(c => c.path.endsWith('/finalize')).length, 1);
        assert.doesNotMatch(result.stderr, /open the link|Sign the spending mandate/);
      });
    }
  }

  for (const [name, patch, flags] of [
    ['unsigned', { status: 'pending_signature' }, []],
    ['revoked', { status: 'revoked' }, []],
    ['disabled', { isEnabled: false }, []],
    ['expired', { validUntil: '2020-01-01T00:00:00Z' }, []],
    ['future', { validFrom: '2100-01-01T00:00:00Z' }, []],
    ['invalid expiry', { validUntil: 'invalid' }, []],
    ['unsupported currency', { currency: 'CARD_USD' }, []],
    ['currency mismatch', {}, ['--credit']],
  ]) {
    await t.test(`reject ${name} before creating an order`, async () => {
      reset(); Object.assign(mandate, patch);
      const result = await run('--mandate', 'mand_test', ...flags);
      assert.equal(result.code, 1);
      assert.equal(calls.length, 1);
      assert.equal(creations().length, 0);
      assert.equal(payments().length, 0);
    });
  }

  await t.test('missing mandate does not create a replacement', async () => {
    reset(); lookupMissing = true;
    const result = await run('--mandate', 'mand_missing');
    assert.equal(result.code, 1);
    assert.match(result.stdout, /Mandate not found/);
    assert.equal(calls.length, 1);
  });

  for (const currency of ['USDC', 'FLUXA_MONETIZE_CREDITS']) {
    await t.test(`reject insufficient ${currency} allowance before signing`, async () => {
      reset(currency); mandate.remainingAmount = currency === 'USDC' ? '4999999' : '499';
      const result = await run('--mandate', 'mand_test');
      assert.equal(result.code, 1);
      assert.match(result.stdout, /insufficient remaining allowance/);
      assert.equal(creations().length, 0);
      assert.equal(payments().length, 0);
    });
  }

  await t.test('unsupported USDC rail never falls back to Credits', async () => {
    reset(); accepts = accepts.slice(1);
    const result = await run('--mandate', 'mand_test');
    assert.equal(result.code, 1);
    assert.equal(creations().length, 0);
    assert.equal(payments().length, 0);
  });

  for (const flags of [['--mandate'], ['--mandate', ''], ['--mandate', 'mand_test', '--budget', '100'], ['--mandate', 'mand_test', '--seconds', '3600'], ['--usdc', '--credit']]) {
    await t.test(`reject invalid options ${flags.join(' ')}`, async () => {
      reset();
      assert.equal((await run(...flags)).code, 1);
      assert.equal(calls.length, 0);
    });
  }

  await t.test('payment denial is returned without finalization or new mandate', async () => {
    reset(); paymentResult = { status: 'error', message: 'mandate budget changed' };
    const result = await run('--mandate', 'mand_test');
    assert.equal(result.code, 1);
    assert.match(result.stdout, /mandate budget changed/);
    assert.equal(payments().length, 1);
    assert.equal(creations().length, 0);
    assert.equal(calls.filter(c => c.path.endsWith('/finalize')).length, 0);
  });

  for (const flags of [[], ['--usdc']]) {
    await t.test(`no mandate preserves create/approve/pay flow: ${flags}`, async () => {
      reset();
      const result = await run(...flags);
      assert.equal(result.code, 0, result.stdout + result.stderr);
      assert.equal(creations().length, 1);
      const currency = flags.length ? 'USDC' : 'FLUXA_MONETIZE_CREDITS';
      assert.equal(creations()[0].body.intent.currency, currency);
      assert.equal(creations()[0].body.intent.limitAmount, flags.length ? '5000000' : '500');
      assert.equal(payments().length, 1);
      assert.equal(payments()[0].body.mandateId, 'mand_new');
      assert.match(result.stderr, /open the link/);
    });
  }
});
