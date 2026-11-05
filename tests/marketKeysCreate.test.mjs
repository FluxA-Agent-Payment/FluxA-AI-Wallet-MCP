import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile, stat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// `market keys create` asks for browser approval and saves the key to a file.
// The raw key must never appear on stdout or stderr.

const cli = fileURLToPath(new URL('../packages/fluxa-wallet/bin/fluxa-wallet.js', import.meta.url));
const jwt = `e30.${Buffer.from(JSON.stringify({ exp: 4102444800 })).toString('base64url')}.test`;
const RAW = 'fxa_live_secretvalue0123456789abcdef';
const REQ_ID = '6f1c2b9e-4d0a-4b7e-9a51-2e7c0d3f8a11';

test('keys create: approval link, encrypted hand-off, key only in a 0600 file', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fluxa-keys-test-'));
  let calls, createBody, polls, outcome;
  const server = http.createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    const body = text ? JSON.parse(text) : undefined;
    calls.push({ method: req.method, path: req.url, body });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/agent/vc/issue') return res.end(JSON.stringify({ vc: 'vc-token' }));
    if (req.method === 'POST' && req.url === '/llm/keys') {
      createBody = body;
      if (outcome === 'direct') {
        res.statusCode = 201;
        return res.end(JSON.stringify({ id: 'key-d', name: body.name, keyPrefix: 'fxa_live_secretva', spendLimit: null, rawKey: RAW }));
      }
      res.statusCode = 202;
      return res.end(JSON.stringify({ status: 'approval_required', requestId: REQ_ID, code: 'KQ7M-4XPD', approvalUrl: 'https://agentmarket.test/keys/approve?code=KQ7M-4XPD', expiresAt: '2100-01-01T00:00:00Z' }));
    }
    if (req.url === `/llm/keys/requests/${REQ_ID}`) {
      polls++;
      if (polls < 2) return res.end(JSON.stringify({ status: 'pending' }));
      if (outcome === 'approve') {
        const encryptedKey = crypto.publicEncrypt(
          { key: createBody.publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
          Buffer.from(RAW),
        ).toString('base64');
        return res.end(JSON.stringify({ status: 'approved', key: { id: 'key-1', name: 'ci', keyPrefix: 'fxa_live_secretva', spendLimit: 10 }, encryptedKey }));
      }
      if (outcome === 'deny') return res.end(JSON.stringify({ status: 'denied' }));
      return res.end(JSON.stringify({ status: 'pending' }));
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: `unexpected ${req.method} ${req.url}` }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    await rm(dir, { recursive: true, force: true });
  });
  const reset = (o) => { calls = []; polls = 0; outcome = o; createBody = undefined; };
  const run = async (...args) => {
    const child = spawn(process.execPath, [cli, 'market', 'keys', 'create', ...args], {
      env: { ...process.env, AGENT_ID: 'agent_test', AGENT_TOKEN: 'test-token', AGENT_JWT: jwt, FLUXA_DATA_DIR: dir, AGENT_ID_API: url, MARKET_PROXY: url, MARKET_PLATFORM: url, FLUXA_NO_BROWSER: '1', FLUXA_KEY_POLL_MS: '20' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const timer = setTimeout(() => child.kill(), 15000);
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    clearTimeout(timer);
    return { code, stdout, stderr };
  };

  await t.test('approved: key saved to a 0600 file, never printed', async () => {
    reset('approve');
    const r = await run('--name', 'ci', '--limit', '10');
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(createBody.publicKey, /BEGIN PUBLIC KEY/);
    assert.equal(createBody.name, 'ci');
    assert.equal(createBody.spendLimit, 10);
    assert.match(createBody.savePath, /keys[\\/]ci\.key$/);
    assert.match(r.stdout, /keys\/approve\?code=KQ7M-4XPD/);
    assert.match(r.stdout, /KQ7M-4XPD/);
    assert.match(r.stdout, /saved: .*ci\.key/);
    assert.equal((r.stdout + r.stderr).includes(RAW), false, 'raw key must not be printed');
    const file = path.join(dir, 'keys', 'ci.key');
    assert.equal((await readFile(file, 'utf8')).trim(), RAW);
    if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(path.join(dir, 'key-requests')), [], 'pending request (private key) removed');
  });

  await t.test('approval off (server default): key printed once as before, no file', async () => {
    reset('direct');
    const r = await run('--name', 'direct');
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /raw key — shown once/);
    assert.ok(r.stdout.includes(RAW));
    assert.equal(calls.filter((c) => c.path.startsWith('/llm/keys/requests/')).length, 0, 'no polling');
    await assert.rejects(stat(path.join(dir, 'keys', 'direct.key')));
    assert.deepEqual(await readdir(path.join(dir, 'key-requests')), [], 'no pending request left');
  });

  await t.test('a second key with the same name does not overwrite the first', async () => {
    reset('approve');
    const r = await run('--name', 'ci');
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(createBody.savePath, /ci-2\.key$/);
    assert.equal((await readFile(path.join(dir, 'keys', 'ci-2.key'), 'utf8')).trim(), RAW);
    assert.equal((await readFile(path.join(dir, 'keys', 'ci.key'), 'utf8')).trim(), RAW);
  });

  await t.test('denied: exit 1 with key_request_denied, no file', async () => {
    reset('deny');
    const r = await run('--name', 'nope');
    assert.equal(r.code, 1);
    assert.match(r.stdout, /key_request_denied/);
    await assert.rejects(stat(path.join(dir, 'keys', 'nope.key')));
  });

  await t.test('timeout: wait_timeout with a resume command; resume then saves', async () => {
    reset('pending');
    const r = await run('--name', 'later', '--wait', '1');
    assert.equal(r.code, 1);
    assert.match(r.stdout, /wait_timeout/);
    assert.match(r.stdout, new RegExp(`--request ${REQ_ID}`));
    const pending = JSON.parse(await readFile(path.join(dir, 'key-requests', `${REQ_ID}.json`), 'utf8'));
    if (process.platform !== 'win32') assert.equal((await stat(path.join(dir, 'key-requests', `${REQ_ID}.json`))).mode & 0o777, 0o600);
    const savedBody = createBody;
    reset('approve');
    createBody = savedBody; // the server encrypts to the key sent at create time
    polls = 1;
    const r2 = await run('--request', REQ_ID);
    assert.equal(r2.code, 0, r2.stdout + r2.stderr);
    assert.equal(calls.filter((c) => c.method === 'POST' && c.path === '/llm/keys').length, 0, 'resume does not open a new request');
    assert.equal((await readFile(pending.savePath, 'utf8')).trim(), RAW);
    assert.equal((r2.stdout + r2.stderr).includes(RAW), false);
  });
});
