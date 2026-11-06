// Offline cross-repository E2E: real AgentDID HTTP/SQLite/JWT, real Wallet
// approval routes and JWT verifier, real CLI processes. Privy and Wallet owner
// records are replaced with local fixtures; no remote services or funds are used.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const root = fileURLToPath(new URL('..', import.meta.url));
const didRoot = process.env.AGENT_DID_REPO || path.resolve(root, '../agent-did');
const walletRoot = process.env.WALLET_SERVICE_REPO || path.resolve(root, '../FluxA-AI-Wallet-Service');
const requireDid = createRequire(path.join(didRoot, 'package.json'));
const requireWallet = createRequire(path.join(walletRoot, 'backend/package.json'));
const temp = await mkdtemp(path.join(os.tmpdir(), 'fluxa-connect-e2e-'));
const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const keyPath = path.join(temp, 'private.pem'); const publicPath = path.join(temp, 'public.pem');
await writeFile(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
await writeFile(publicPath, publicKey.export({ type: 'spki', format: 'pem' }));
Object.assign(process.env, { NODE_ENV: 'test', DB_PATH: path.join(temp, 'agents.db'),
  JWT_PRIVATE_KEY_PATH: keyPath, JWT_PUBLIC_KEY_PATH: publicPath, JWT_KEY_ID: 'e2e-key',
  SERVICE_API_KEY: 'offline-e2e-service-key-32-characters', JWT_EXPIRES_IN: '15m',
  AGENTID_S2S_SHARED_SECRET: '', WALLET_APP_URL: 'https://wallet.example', BCRYPT_SALT_ROUNDS: '4' });
const app = requireDid(path.join(didRoot, 'src/server.js'));
const SQLite = requireDid('better-sqlite3');
const sql = new SQLite(process.env.DB_PATH);
const express = requireWallet('express');
const starts = [];
const didOuter = express(); didOuter.use(express.json());
didOuter.use((req, _res, next) => { if (req.path === '/connect/requests') starts.push(req.body); next(); });
didOuter.use(app);
const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
const didServer = await listen(didOuter);
const didBase = `http://127.0.0.1:${didServer.address().port}`;
Object.assign(process.env, { AGENTID_SERVICE_URL: didBase, AGENTID_SERVICE_API_KEY: process.env.SERVICE_API_KEY,
  AGENT_JWKS_URL: `${didBase}/.well-known/jwks.json` });

const { createRouters } = requireWallet(path.join(walletRoot, 'backend/routes/agentConnect.js'));
const { verifyAgentJwt } = requireWallet(path.join(walletRoot, 'backend/utils/agentAuth.js'));
const agents = [];
let creates = 0;
const owner = id => ({ id, email: `owner-${id}@example.com`, wallet_id: `wallet-${id}`, wallet_address: `0x${String(id).repeat(40)}` });
const routes = createRouters({ statements: {
  getUserByPrivyId: async id => owner(Number(id)),
  getAgentsByUserIdActive: async id => agents.filter(a => a.user_id === id),
  getAgentByExternalId: async (external, id) => agents.find(a => a.external_agent_id === external && a.user_id === id),
  getAgentByExternalIdAny: async external => agents.find(a => a.external_agent_id === external),
  getAgentById: async id => agents.find(a => a.id === Number(id)),
  updateAgentAuth: async () => {},
}, createAgent: async ({ user, reqBody }) => {
  creates++;
  const agent = { id: agents.length + 1, user_id: user.id, external_agent_id: reqBody.externalAgentId,
    name: reqBody.name, is_authorized: 1, is_deleted: 0 };
  agents.push(agent); return { kind: 'ok', agent };
}, audit: async () => {},
verify: (req, res, next) => {
  if (!/^Bearer owner-[78]$/.test(req.headers.authorization || '')) return res.sendStatus(401);
  req.authenticatedPrivyId = req.headers.authorization.slice(-1); next();
}, readAuth: (_req, _res, next) => next(), writeAuth: (req, res, next) => {
  if (req.headers['x-test-recent-auth'] !== 'yes') return res.sendStatus(403);
  next();
} });
const walletApp = express(); walletApp.use(express.json());
walletApp.use('/api/agent-connect', routes.requests); walletApp.use('/api/agents', routes.management);
walletApp.get('/api/mandates', async (req, res) => {
  try {
    const payload = await verifyAgentJwt(req.headers.authorization);
    if (!agents.some(a => a.external_agent_id === payload.agent_id)) return res.sendStatus(403);
    return res.json({ mandates: [] });
  } catch { return res.sendStatus(401); }
});
const walletServer = await listen(walletApp);
const walletBase = `http://127.0.0.1:${walletServer.address().port}`;
const dataDir = path.join(temp, 'client'); await mkdir(dataDir);
const childEnv = { ...process.env, FLUXA_DATA_DIR: dataDir, AGENT_ID_API: didBase, WALLET_API: walletBase,
  AGENT_WALLET_APP: 'https://wallet.example' };
delete childEnv.AGENT_ID; delete childEnv.AGENT_TOKEN; delete childEnv.AGENT_JWT;
async function cli(...args) {
  const child = spawn(process.execPath, [path.join(root, 'packages/fluxa-wallet/bin/fluxa-wallet.js'), ...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => stdout += chunk); child.stderr.on('data', chunk => stderr += chunk);
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
  const output = JSON.parse(stdout);
  assert.ok(!stdout.includes('poll_secret'));
  return { code, output, stderr };
}
async function browser(endpoint, body, user = 7, method = body ? 'POST' : 'GET') {
  const response = await fetch(`${walletBase}${endpoint}`, { method,
    headers: { authorization: `Bearer owner-${user}`, 'x-test-recent-auth': 'yes', 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() };
}
const configPath = path.join(dataDir, 'config.json');
const readConfig = async () => JSON.parse(await readFile(configPath, 'utf8'));
try {
  const first = await cli('connect', '--client', 'Cloud AI', '--runtime', 'container', '--hosting', 'cloud');
  assert.equal(first.code, 0); assert.equal(first.output.data.expires_in, 10800);
  assert.equal(starts[0].agent_id, undefined);
  assert.equal(starts[0].environment.hosting, 'cloud');
  assert.ok(!('validity' in starts[0]), 'CLI must omit validity unless explicitly supplied');
  const requestId = first.output.data.request_id;
  const endpoint = `/api/agent-connect/requests/${requestId}`;
  const page = await browser(endpoint);
  assert.deepEqual(page.body.agents, []); assert.equal(creates, 0);
  assert.equal(page.body.request.default_validity, '7d');
  const approval = { decision: 'approve', assignment: { mode: 'new' }, validity: '7d', session_signer_id: 'offline-signer' };
  assert.equal((await browser(`${endpoint}/decision`, approval)).status, 200);
  assert.equal((await browser(`${endpoint}/decision`, approval)).status, 200);
  assert.equal(creates, 1); assert.equal(agents[0].name, 'Cloud AI');
  assert.equal((await cli('connect-status')).output.data.connected, true);
  const config = await readConfig();
  const agentId = config.agentId.agent_id;
  assert.equal(agentId, agents[0].external_agent_id);
  assert.deepEqual(Object.keys(requireDid('jsonwebtoken').decode(config.agentId.jwt)).sort(), ['agent_id', 'exp', 'iat']);
  assert.equal((await cli('connect')).output.data.connected, true, 'real Wallet JWT verifier accepts unchanged login JWT');

  sql.prepare('UPDATE agent_tokens SET expires_at=? WHERE agent_id=?').run(Date.now() - 1000, agentId);
  config.agentId.jwt = `e30.${Buffer.from(JSON.stringify({ agent_id: agentId, exp: 1 })).toString('base64url')}.test`;
  await writeFile(configPath, JSON.stringify(config));
  const expired = await cli('balance');
  assert.equal(expired.output.code, 'token_expired'); assert.equal(expired.output.reconnect_required, true);
  assert.equal((await readConfig()).agentId.agent_id, agentId);
  const reconnect = await cli('connect', '--client', 'Cloud AI', '--runtime', 'local', '--hosting', 'local');
  assert.equal(starts[1].agent_id, agentId);
  assert.ok(!('validity' in starts[1]));
  const nextEndpoint = `/api/agent-connect/requests/${reconnect.output.data.request_id}`;
  assert.equal((await browser(nextEndpoint, undefined, 8)).body.code, 'agent_not_owned');
  assert.equal((await browser(nextEndpoint)).body.target.agent_id, agentId);
  assert.equal((await browser(nextEndpoint)).body.request.default_validity, '180d');
  assert.equal((await browser(`${nextEndpoint}/decision`, approval)).body.code, 'requested_agent_mismatch');
  assert.equal((await browser(`${nextEndpoint}/decision`, { decision: 'approve' })).status, 200);
  assert.equal((await cli('connect-status')).output.data.connected, true);
  const replaced = await readConfig();
  assert.equal(replaced.agentId.agent_id, agentId); assert.notEqual(replaced.agentId.token, config.agentId.token);
  assert.equal(creates, 1);
  const longToken = sql.prepare('SELECT t.expires_at,r.approved_at FROM agent_tokens t JOIN agent_connect_requests r ON r.request_id=t.request_id WHERE t.request_id=?').get(reconnect.output.data.request_id);
  assert.equal(longToken.expires_at - longToken.approved_at, 180 * 86400000);
  const requested = await cli('connect', '--reconnect', '--validity', '24h', '--runtime', 'local', '--hosting', 'local');
  assert.equal(starts[2].validity, '24h');
  const requestedEndpoint = `/api/agent-connect/requests/${requested.output.data.request_id}`;
  assert.equal((await browser(requestedEndpoint)).body.request.default_validity, '24h');
  // The owner can still override a requester-specified duration on the page.
  assert.equal((await browser(`${requestedEndpoint}/decision`, { decision: 'approve', validity: '1h' })).status, 200);
  assert.equal((await cli('connect-status')).output.data.connected, true);
  const shortToken = sql.prepare('SELECT t.token_ref,t.expires_at,r.approved_at FROM agent_tokens t JOIN agent_connect_requests r ON r.request_id=t.request_id WHERE t.request_id=?').get(requested.output.data.request_id);
  assert.equal(shortToken.expires_at - shortToken.approved_at, 3600000);
  const list = await browser(`/api/agents/${agents[0].id}/connections`);
  assert.equal(list.body.connections.length, 3);
  const active = list.body.connections.find(c => c.token_ref === shortToken.token_ref);
  assert.equal((await browser(`/api/agents/${agents[0].id}/connections/${active.token_ref}`, undefined, 7, 'DELETE')).status, 200);
  assert.equal((await cli('refreshJWT')).output.code, 'token_revoked');

  const legacy = await (await fetch(`${didBase}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_name: 'Legacy' }) })).json();
  const legacyRefresh = await fetch(`${didBase}/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ agent_id: legacy.agent_id, token: legacy.token }) });
  assert.equal(legacyRefresh.status, 200);
  assert.deepEqual(Object.keys(requireDid('jsonwebtoken').decode((await legacyRefresh.json()).jwt)).sort(), ['agent_id', 'exp', 'iat']);
  // An already linked legacy identity must remain usable without new approval.
  agents.push({ id: agents.length + 1, user_id: 7, external_agent_id: legacy.agent_id,
    name: 'Legacy', is_authorized: 1, is_deleted: 0 });
  await writeFile(configPath, JSON.stringify({ agentId: { agent_id: legacy.agent_id, token: legacy.token,
    jwt: `e30.${Buffer.from(JSON.stringify({ agent_id: legacy.agent_id, exp: 1 })).toString('base64url')}.test` } }));
  const count = starts.length;
  const legacyStatus = await cli('status');
  assert.equal(legacyStatus.output.data.configured, true); assert.equal(legacyStatus.output.data.wallet_linked, true);
  const legacyConnect = await cli('connect');
  assert.equal(legacyConnect.output.data.connected, true); assert.equal(legacyConnect.output.data.agent_id, legacy.agent_id);
  assert.ok(!('authorization_url' in legacyConnect.output.data)); assert.equal(starts.length, count);
  assert.equal((await readConfig()).agentId.token, legacy.token);
  console.log('PASS: empty-account create, idempotent approval, unchanged JWT verification, expired-token recovery with locked Agent ID, server-selected durations, explicit request and owner overrides, foreign-owner rejection, independent token revocation, legacy registration/refresh and linked credential reuse without reauthorization.');
} finally {
  didServer.closeAllConnections(); walletServer.closeAllConnections();
  await Promise.all([new Promise(resolve => didServer.close(resolve)), new Promise(resolve => walletServer.close(resolve))]);
  sql.close(); await rm(temp, { recursive: true, force: true });
}
