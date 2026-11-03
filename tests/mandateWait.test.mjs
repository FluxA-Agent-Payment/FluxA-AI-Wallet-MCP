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

test('mandate-create / mandate-status --wait block until a final state', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fluxa-wait-test-'));
  let statuses, polls, creates;
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/mandates/create-intent') {
      creates++;
      return res.end(JSON.stringify({ status: 'ok', mandateId: 'mand_w', authorizationUrl: 'https://example.com/approve/mand_w' }));
    }
    if (req.url.startsWith('/api/mandates/agent/')) {
      const st = statuses[Math.min(polls, statuses.length - 1)];
      polls++;
      if (st === 'boom') { res.statusCode = 502; return res.end('bad gateway'); }
      return res.end(JSON.stringify({ status: 'ok', mandate: { mandateId: 'mand_w', status: st, remainingAmount: '1000000' } }));
    }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); await rm(dir, { recursive: true, force: true }); });

  const run = async (...args) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, AGENT_ID: 'agent_test', AGENT_TOKEN: 'test-token', AGENT_JWT: jwt, FLUXA_DATA_DIR: dir, WALLET_API: url, AGENT_ID_API: url, FLUXA_MANDATE_POLL_MS: '50' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    const timer = setTimeout(() => child.kill(), 10000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    clearTimeout(timer);
    return { code, stdout, stderr };
  };
  const reset = (...s) => { statuses = s; polls = 0; creates = 0; };

  await t.test('status --wait returns once signed, surviving a transient error', async () => {
    reset('pending_signature', 'boom', 'pending_signature', 'signed');
    const r = await run('mandate-status', '--id', 'mand_w', '--wait', '5');
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).data.mandate.status, 'signed');
    assert.equal(polls, 4);
  });

  for (const st of ['rejected', 'expired']) {
    await t.test(`status --wait stops on ${st}`, async () => {
      reset('pending_signature', st);
      const r = await run('mandate-status', '--id', 'mand_w', '--wait', '5');
      assert.equal(r.code, 1);
      const out = JSON.parse(r.stdout);
      assert.equal(out.code, `mandate_${st}`);
      assert.equal(out.data.mandate.status, st);
      assert.equal(polls, 2);
    });
  }

  await t.test('status --wait times out with the last state', async () => {
    reset('pending_signature');
    const r = await run('mandate-status', '--id', 'mand_w', '--wait', '1');
    assert.equal(r.code, 1);
    const out = JSON.parse(r.stdout);
    assert.equal(out.code, 'wait_timeout');
    assert.equal(out.data.mandate.status, 'pending_signature');
  });

  await t.test('status without --wait queries once', async () => {
    reset('pending_signature');
    const r = await run('mandate-status', '--id', 'mand_w');
    assert.equal(r.code, 0);
    assert.equal(polls, 1);
  });

  await t.test('create --wait prints the link first, then the signed state', async () => {
    reset('pending_signature', 'signed');
    const r = await run('mandate-create', '--desc', 'test', '--amount', '1000000', '--wait', '5');
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const nl = r.stdout.indexOf('\n');
    assert.deepEqual(JSON.parse(r.stdout.slice(0, nl)), { event: 'authorization_required', mandateId: 'mand_w', authorizationUrl: 'https://example.com/approve/mand_w' });
    const final = JSON.parse(r.stdout.slice(nl + 1));
    assert.equal(final.data.mandateId, 'mand_w');
    assert.equal(final.data.authorizationUrl, 'https://example.com/approve/mand_w');
    assert.equal(final.data.mandate.status, 'signed');
    assert.equal(creates, 1);
  });

  for (const bad of ['0', '901', 'abc', '1.5']) {
    await t.test(`--wait ${bad} is refused before any call`, async () => {
      reset('signed');
      const r = await run('mandate-status', '--id', 'mand_w', '--wait', bad);
      assert.equal(r.code, 1);
      assert.match(r.stdout, /--wait must be/);
      assert.equal(polls, 0);
    });
  }

  await t.test('create --wait refuses CARD_USD', async () => {
    reset('signed');
    const r = await run('mandate-create', '--currency', 'CARD_USD', '--desc', 'x', '--amount', '100', '--merchant-name', 'Amazon', '--merchant-url', 'https://www.amazon.com', '--merchant-country', 'US', '--wait', '5');
    assert.equal(r.code, 1);
    assert.match(r.stdout, /not supported for CARD_USD/);
    assert.equal(creates, 0);
  });
});
