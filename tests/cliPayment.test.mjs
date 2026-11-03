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
const usdc = { scheme: 'exact', network: 'base', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '1000000', maxAmountRequired: '1000000', resource: 'https://example.com/api', payTo: '0x0000000000000000000000000000000000000001' };
const credits = { ...usdc, network: 'fluxa-monetize-credits', asset: 'FLUXA_MONETIZE_CREDITS' };

test('CLI payments allow Card and USDC, and reject Credits through every x402 input format', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fluxa-cli-payment-'));
  let currency = 'USDC', calls = [], lookupFails = false;
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const c of req) text += c;
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ path: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url.startsWith('/api/mandates/agent/')) {
      return res.end(JSON.stringify(lookupFails ? { status: 'error', message: 'Cannot read mandate' } : { status: 'ok', mandate: { currency } }));
    }
    res.end(JSON.stringify({ status: 'ok', mandateId: 'mand_new', xPaymentB64: 'signed', paymentPayloadB64: 'signed' }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); });
  const run = async (...args) => {
    calls = [];
    const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, AGENT_ID: 'test', AGENT_TOKEN: 'test', AGENT_JWT: jwt, FLUXA_DATA_DIR: dir, WALLET_API: url, AGENT_ID_API: url }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c);
    child.stderr.on('data', c => stderr += c);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    return { code, stdout, stderr };
  };
  for (const command of ['mandate-create', 'x402', 'x402-v3', 'payout']) {
    await t.test(`${command} rejects the removed credit flag without a request`, async () => {
      const r = await run(command, '--credit');
      assert.equal(r.code, 1); assert.match(r.stdout, /Credits payments are no longer supported/); assert.deepEqual(calls, []);
    });
  }
  for (const value of ['credits', 'FLUXA_MONETIZE_CREDITS', 'fluxa-monetize-credit', 'fluxa_monetize_credit', 'XRP']) {
    await t.test(`reject mandate currency ${value} without a request`, async () => {
      const r = await run('mandate-create', '--desc', 'test', '--amount', '100', '--currency', value);
      assert.equal(r.code, 1); assert.match(r.stdout, /Supported currencies: USDC, CARD_USD/); assert.deepEqual(calls, []);
    });
  }
  for (const value of ['USDC', 'card', 'CARD_USD']) {
    await t.test(`create ${value} mandate`, async () => {
      const flags = value === 'USDC' ? [] : ['--merchant-name', 'Example', '--merchant-url', 'https://example.com', '--merchant-country', 'US'];
      const r = await run('mandate-create', '--desc', 'test', '--amount', '100', '--currency', value, ...flags);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      assert.equal(calls[0].body.intent.currency, value === 'USDC' ? 'USDC' : 'CARD_USD');
    });
  }
  for (const version of [1, 2]) for (const b64 of [false, true]) {
    const payload = offers => ({ x402Version: version, resource: version === 2 ? { url: 'https://example.com/api' } : 'https://example.com/api', accepts: offers });
    const pay = offers => {
      const text = JSON.stringify(payload(offers));
      return run('x402-v3', '--mandate', 'mand_test', '--payload', b64 ? Buffer.from(text).toString('base64') : text);
    };
    await t.test(`v${version}, base64=${b64}: refuse old Credits mandate`, async () => {
      currency = 'FLUXA_MONETIZE_CREDITS';
      const r = await pay([credits, usdc]);
      assert.equal(r.code, 1); assert.equal(calls.filter(c => c.path.includes('/payment/')).length, 0);
    });
    await t.test(`v${version}, base64=${b64}: mixed offers pay USDC only`, async () => {
      currency = 'USDC';
      const r = await pay([credits, usdc]);
      assert.equal(r.code, 0, r.stdout + r.stderr);
      const payment = calls.find(c => c.path.includes('/payment/')).body;
      if (version === 2) assert.deepEqual(payment.paymentRequest.accepts, [usdc]);
      else assert.equal(payment.currency, 'USDC');
    });
    await t.test(`v${version}, base64=${b64}: reject Credits-only offer`, async () => {
      const r = await pay([credits]);
      assert.equal(r.code, 1); assert.equal(calls.filter(c => c.path.includes('/payment/')).length, 0);
    });
    await t.test(`v${version}, base64=${b64}: unknown mandate never signs`, async () => {
      lookupFails = true;
      try { const r = await pay([usdc]); assert.equal(r.code, 1); assert.equal(calls.filter(c => c.path.includes('/payment/')).length, 0); }
      finally { lookupFails = false; }
    });
  }
  await t.test('Credits payout fails before any request', async () => {
    const r = await run('payout', '--id', 'test', '--to', '0x0000000000000000000000000000000000000001', '--amount', '100', '--network', credits.network, '--asset', credits.asset);
    assert.equal(r.code, 1); assert.match(r.stdout, /USDC on Base only/); assert.deepEqual(calls, []);
  });
});
