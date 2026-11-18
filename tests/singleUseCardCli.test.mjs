import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const cli = fileURLToPath(new URL('../packages/fluxa-wallet/bin/fluxa-wallet.js', import.meta.url));
const jwt = `e30.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString('base64url')}.test`;
const mandatePath = '/api/mandates/agent/mand_test';
const redeemPath = '/v1/credential-redeem-sessions/synthetic-secret';
const credential = {
  pan: '9999999999999999',
  exp_month: 12,
  exp_year: 2099,
  dynamic_value: 'synthetic-davv-value',
  dynamic_data_type: 'DAVV',
  credential_expires_at: '2099-01-01T00:00:00Z',
};
const amount = { value: '12.34', currency: 'USD' };

test('single-use card CLI speaks the production contracts with isolated mock services', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'fluxa-single-use-cli-'));
  const dataDir = path.join(dir, 'wallet');
  const calls = [];
  let onWallet;
  let onVault;

  async function service(name, handle) {
    const server = createServer(async (req, res) => {
      let text = '';
      for await (const chunk of req) text += chunk;
      const call = { name, method: req.method, path: req.url, auth: req.headers.authorization, text };
      calls.push(call);
      const { status, body, headers } = handle(call);
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(body));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(async () => {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    });
    return `http://127.0.0.1:${server.address().port}`;
  }
  const wallet = await service('Wallet', call => onWallet(call));
  const vault = await service('CardVault', call => onVault(call));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, AGENT_ID: 'agent_test', AGENT_TOKEN: 'test-token', AGENT_JWT: jwt, FLUXA_DATA_DIR: dataDir, WALLET_API: wallet };
  const run = (...args) => exec(process.execPath, [cli, ...args], { env, timeout: 10_000 });
  const create = (...args) => run('linked-card', 'single-use-card', 'create', '--mandate', 'mand_test', ...args);

  function issued(call, url = vault + redeemPath) {
    return { status: 201, body: {
      status: 'ok',
      mandateId: 'mand_test',
      subcard: {
        virtualCardId: 'vcard_test',
        transactionReference: JSON.parse(call.text).transactionReference,
        amount,
        status: 'ACTIVE',
        spendStatus: 'RESERVED',
        mandateAmounts: {
          reserved: amount,
          spent: { value: '0.00', currency: 'USD' },
          available: { value: '7.66', currency: 'USD' },
        },
        merchant: { name: 'Example', url: 'https://merchant.example', country_code: 'US' },
      },
      redeem: { method: 'POST', url },
    } };
  }
  const redeemed = () => {
    const { pan, ...rest } = credential;
    return { status: 200, body: { success: true, data: { virtual_card_id: 'vcard_test', payment_token: pan, ...rest } } };
  };

  await t.test('reuses amount and generated reference for Wallet 5xx and a spent redemption link', async () => {
    let walletAttempts = 0;
    onWallet = call => {
      walletAttempts++;
      if (walletAttempts === 1) return { status: 503, body: { retryable: true } };
      return issued(call, vault + redeemPath + '-' + walletAttempts);
    };
    onVault = call => call.path.endsWith('-2')
      ? { status: 410, body: { error: { code: 'CREDENTIAL_SESSION_UNAVAILABLE' } } }
      : redeemed();
    const file = path.join(dir, 'credential.json');
    const { stdout, stderr } = await create('--amount', '1234', '--output-file', file);
    const response = JSON.parse(stdout);
    assert.match(response.transactionReference, /^sub-[0-9]+-[a-f0-9]+$/);
    assert.equal(response.virtualCardId, 'vcard_test');
    assert.deepEqual(response.mandateAmounts.available, { value: '7.66', currency: 'USD' });
    assert.equal(response.outputFile, await realpath(file));
    assert.equal(response.credential, undefined);
    assert.doesNotMatch(stdout + stderr, /9999999999999999|synthetic-davv-value|synthetic-secret/);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), credential);
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(calls.map(c => c.name), ['Wallet', 'Wallet', 'CardVault', 'Wallet', 'CardVault']);
    for (const call of calls) {
      assert.equal(call.method, 'POST');
      if (call.name === 'Wallet') {
        assert.equal(call.auth, 'Bearer ' + jwt);
        assert.equal(call.path, mandatePath + '/subcard');
        assert.deepEqual(JSON.parse(call.text), { amount: '1234', transactionReference: response.transactionReference });
      } else {
        assert.equal(call.auth, undefined);
        assert.equal(call.text, '');
      }
    }
    const { ts, ...audit } = JSON.parse(await readFile(path.join(dataDir, 'audit.log'), 'utf8'));
    assert.equal(typeof ts, 'number');
    assert.deepEqual(audit, {
      event: 'linked_card_single_use_create',
      mandate_id: 'mand_test',
      virtual_card_id: 'vcard_test',
      transaction_reference: response.transactionReference,
      amount,
    });
  });

  await t.test('returns the credential on stdout when no file is requested', async () => {
    calls.length = 0;
    onWallet = call => issued(call);
    onVault = redeemed;
    const { stdout } = await create('--amount', '1234', '--transaction-ref', 'order:1');
    assert.deepEqual(JSON.parse(stdout).credential, credential);
    assert.equal(JSON.parse(stdout).transactionReference, 'order:1');
    assert.doesNotMatch(stdout, /synthetic-secret/);
    assert.equal(calls.length, 2);
  });

  await t.test('validates the request and refuses to overwrite a file before issuance', async () => {
    calls.length = 0;
    const existing = path.join(dir, 'existing.json');
    await writeFile(existing, 'keep me');
    for (const args of [
      ['--amount', '12.34'],
      ['--amount', '0'],
      ['--amount', '1234', '--transaction-ref'],
      ['--amount', '1234', '--output-file'],
      ['--amount', '1234', '--output-file', existing],
    ]) await assert.rejects(create(...args), { code: 1 });
    assert.equal(await readFile(existing, 'utf8'), 'keep me');
    assert.equal(calls.length, 0);
  });

  await t.test('reports an expired credential after 502 without switching references', async () => {
    calls.length = 0;
    onWallet = call => calls.length === 1 ? issued(call) : {
      status: 404,
      body: {
        status: 'error', code: 'VIRTUAL_CARD_NOT_FOUND', upstreamCode: 'VIRTUAL_CARD_NOT_FOUND',
        upstreamStatus: 404, retryable: false, requestId: 'request-123',
        message: vault + redeemPath,
      },
    };
    onVault = () => ({ status: 502, body: { error: { code: 'VIRTUAL_CARD_CREDENTIAL_UNAVAILABLE' } } });
    const file = path.join(dir, 'failed.json');
    await assert.rejects(create('--amount', '1234', '--transaction-ref', 'order-expired', '--output-file', file), error => {
      const result = JSON.parse(error.stdout);
      assert.equal(error.code, 1);
      assert.equal(result.code, 'VIRTUAL_CARD_NOT_FOUND');
      assert.equal(result.details.requestId, 'request-123');
      assert.equal(result.details.transactionReference, 'order-expired');
      assert.doesNotMatch(error.stdout + error.stderr, /synthetic-secret/);
      return true;
    });
    assert.deepEqual(calls.map(c => c.name), ['Wallet', 'CardVault', 'Wallet']);
    assert.equal(calls[0].text, calls[2].text);
    await assert.rejects(stat(file), { code: 'ENOENT' });
  });

  await t.test('rejects remote plain HTTP and never follows redemption redirects', async () => {
    calls.length = 0;
    onWallet = call => issued(call, 'http://example.invalid' + redeemPath);
    await assert.rejects(create('--amount', '1234'), error => {
      assert.equal(JSON.parse(error.stdout).code, 'invalid_redeem_url');
      assert.doesNotMatch(error.stdout + error.stderr, /synthetic-secret/);
      return true;
    });
    assert.deepEqual(calls.map(c => c.name), ['Wallet']);
    calls.length = 0;
    onWallet = call => issued(call);
    onVault = () => ({ status: 307, body: {}, headers: { Location: vault + '/trap' } });
    await assert.rejects(create('--amount', '1234'), { code: 1 });
    assert.deepEqual(calls.map(c => c.path), [mandatePath + '/subcard', redeemPath]);
  });

  await t.test('keeps the deprecated command callable and hides it from help', async () => {
    calls.length = 0;
    onWallet = () => ({ status: 200, body: { status: 'ok', mandate: {
      mandateId: 'mand_test', currency: 'CARD_USD', status: 'signed', cardvault: { canTransact: true },
    } } });
    const { stdout } = await run('linked-card', 'subcard', '--mandate', 'mand_test');
    assert.equal(JSON.parse(stdout).isReady, true);
    assert.deepEqual(calls.map(c => [c.method, c.path]), [['GET', mandatePath]]);
    const help = await run('--help');
    assert.match(help.stdout, /linked-card single-use-card create/);
    assert.doesNotMatch(help.stdout, /linked-card subcard/);
  });
});
