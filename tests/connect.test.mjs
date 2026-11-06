import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../packages/fluxa-wallet/bin/fluxa-wallet.js', import.meta.url));
const jwt = exp => `e30.${Buffer.from(JSON.stringify({ agent_id: 'existing-agent', exp })).toString('base64url')}.test`;

test('CLI reconnect preserves identity, keeps secrets private, and consumes the original credential shape', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fluxa-connect-'));
  const configPath = path.join(dir, 'config.json');
  const old = { agent_id: 'existing-agent', token: 'old-token', jwt: jwt(1) };
  let starts = [], refreshCode = 'token_expired', poll = 'pending', claimAgent = 'existing-agent';
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/refresh') { res.statusCode = refreshCode === 'unavailable' ? 503 : 401; return res.end(JSON.stringify({ error: refreshCode })); }
    if (req.url === '/connect/requests') {
      starts.push(body); res.statusCode = 201;
      return res.end(JSON.stringify({ request_id: `cr_${'a'.repeat(43)}`, poll_secret: 'private-poll-secret', authorization_url: `https://wallet.example/connect-agent?request_id=cr_${'a'.repeat(43)}`, expires_in: 10800, poll_interval: 5 }));
    }
    if (req.url === '/connect/token') {
      assert.equal(body.poll_secret, 'private-poll-secret');
      if (poll === 'expired') { res.statusCode = 401; return res.end(JSON.stringify({ error: 'token_expired', agent_id: 'existing-agent', reconnect_required: true })); }
      if (poll === 'pending') { res.statusCode = 202; return res.end(JSON.stringify({ error: 'authorization_pending' })); }
      if (poll === 'denied') { res.statusCode = 403; return res.end(JSON.stringify({ error: 'access_denied' })); }
      return res.end(JSON.stringify({ agent_id: claimAgent, token: 'private-new-token', jwt: jwt(4102444800) }));
    }
    if (req.url === '/api/mandates') return res.end('{}');
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  const env = { ...process.env, FLUXA_DATA_DIR: dir, AGENT_ID_API: base, WALLET_API: base, AGENT_WALLET_APP: 'https://wallet.example' };
  delete env.AGENT_ID; delete env.AGENT_TOKEN; delete env.AGENT_JWT;
  async function run(args, extraEnv = {}) {
    const child = spawn(process.execPath, [cli, ...args], { env: { ...env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    return { code, stdout, stderr, data: stdout ? JSON.parse(stdout) : null };
  }
  await writeFile(configPath, JSON.stringify({ agentId: old }));

  await t.test('payment and explicit refresh return token_expired rather than init instructions', async () => {
    for (const command of ['balance', 'refreshJWT', 'status']) {
      const result = await run([command]);
      assert.equal(result.code, 1, result.stdout + result.stderr);
      assert.equal(result.data.code, 'token_expired');
      assert.equal(result.data.reconnect_required, true);
      assert.equal(result.data.next_command, 'fluxa-wallet connect --agent-id existing-agent');
    }
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).agentId, old);
  });
  await t.test('connect carries the known ID/environment and outputs only a link, not secrets', async () => {
    const result = await run(['connect', '--client', 'Cloud AI', '--runtime', 'vm', '--hosting', 'cloud']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(starts.length, 1); assert.equal(starts[0].agent_id, old.agent_id);
    assert.equal(starts[0].client_name, 'Cloud AI'); assert.equal(starts[0].environment.runtime, 'vm');
    assert.equal(result.data.data.expires_in, 10800);
    assert.ok(!result.stdout.includes('private-poll-secret'));
    assert.equal((await stat(path.join(dir, 'pending-connect.json'))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).agentId, old);
    await run(['connect', '--client', 'Cloud AI']);
    assert.equal(starts.length, 1, 'reuse an existing pending request');
  });
  await t.test('pending status is resumable and claim atomically replaces the credentials', async () => {
    assert.equal((await run(['connect-status'])).data.data.connected, false);
    poll = 'approved';
    const result = await run(['connect-status', '--wait', '1']);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.equal(result.data.data.connected, true);
    assert.ok(!result.stdout.includes('private-new-token'));
    const config = JSON.parse(await readFile(configPath, 'utf8')).agentId;
    assert.equal(config.agent_id, old.agent_id); assert.equal(config.token, 'private-new-token');
    assert.ok(!('session_id' in config)); assert.ok(!('token_type' in config));
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.ok(!requests.includes('/register'));
  });
  await t.test('valid connections reuse existing credentials', async () => {
    const count = starts.length;
    assert.equal((await run(['connect'])).data.data.connected, true);
    assert.equal(starts.length, count);
  });
  await t.test('network/service failures never trigger identity registration', async () => {
    await writeFile(configPath, JSON.stringify({ agentId: old })); refreshCode = 'unavailable';
    const count = starts.length;
    const result = await run(['connect']);
    assert.equal(result.code, 1); assert.equal(starts.length, count);
    assert.ok(!requests.includes('/register'));
    assert.equal(JSON.parse(await readFile(configPath, 'utf8')).agentId.agent_id, old.agent_id);
    refreshCode = 'token_expired';
  });
  await t.test('injected credentials cannot be silently shadowed by a newly written file', async () => {
    const count = starts.length;
    const result = await run(['connect'], { AGENT_ID: old.agent_id, AGENT_TOKEN: old.token, AGENT_JWT: old.jwt });
    assert.equal(result.code, 1); assert.equal(result.data.code, 'token_expired');
    assert.match(result.data.error, /Injected/); assert.equal(starts.length, count);
  });
  await t.test('a claim for another identity is never saved over the original', async () => {
    await run(['connect', '--agent-id', old.agent_id]);
    claimAgent = 'unexpected-agent';
    const result = await run(['connect-status']);
    assert.equal(result.data.code, 'requested_agent_mismatch');
    assert.deepEqual(JSON.parse(await readFile(configPath, 'utf8')).agentId, old);
  });
  await t.test('expiry before claim clears the pending request and preserves the requested identity', async () => {
    poll = 'expired';
    const result = await run(['connect-status']);
    assert.equal(result.data.code, 'token_expired');
    assert.equal(result.data.reconnect_required, true);
    assert.equal(result.data.next_command, 'fluxa-wallet connect --agent-id existing-agent');
    await assert.rejects(stat(path.join(dir, 'pending-connect.json')), { code: 'ENOENT' });
  });
  await t.test('invalid connect wait fails before creating a remote request', async () => {
    const count = starts.length;
    assert.equal((await run(['connect', '--wait', '10801'])).data.code, 'invalid_wait');
    assert.equal(starts.length, count);
  });
});
