import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('MCP credential expiry preserves identity and directs the agent to browser reconnection', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fluxa-connect-mcp-'));
  let refreshCode = 'token_expired';
  const requests = [];
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    requests.push(req.url);
    assert.equal(req.url, '/refresh');
    if (refreshCode === 'valid') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ jwt: `e30.${Buffer.from(JSON.stringify({ agent_id: 'original-agent', exp: 4102444800 })).toString('base64url')}.test` }));
    }
    res.writeHead(refreshCode === 'unavailable' ? 503 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: refreshCode }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  process.env.FLUXA_DATA_DIR = dir;
  process.env.AGENT_ID_API = `http://127.0.0.1:${server.address().port}`;
  process.env.WALLET_API = process.env.AGENT_ID_API;
  delete process.env.AGENT_ID; delete process.env.AGENT_TOKEN; delete process.env.AGENT_JWT;
  const store = await import('../dist/store/store.js');
  store.ensureDataDirs(); await store.loadConfig();
  const { saveAgentId } = await import('../dist/agent/agentId.js');
  const { registerGetPayoutStatusTool } = await import('../dist/mcp/tools/getPayoutStatus.js');
  const { registerConnectWalletTools } = await import('../dist/mcp/tools/connectWallet.js');
  const { registerGetAgentStatusTool } = await import('../dist/mcp/tools/getAgentStatus.js');
  const tools = new Map();
  const serverFixture = { registerTool(name, _config, callback) { tools.set(name, callback); } };
  registerGetPayoutStatusTool(serverFixture); registerConnectWalletTools(serverFixture); registerGetAgentStatusTool(serverFixture);
  saveAgentId({ agent_id: 'original-agent', token: 'opaque-token', jwt: `e30.${Buffer.from(JSON.stringify({ exp: 1 })).toString('base64url')}.test` });
  const result = await tools.get('get_payout_status')({ payout_id: 'pay_test' });
  const failure = JSON.parse(result.content[0].text);
  assert.equal(failure.code, 'token_expired'); assert.equal(failure.reconnect_required, true);
  assert.equal(failure.next_tool.name, 'connect_wallet'); assert.equal(failure.next_tool.arguments.agent_id, 'original-agent');
  assert.ok(!JSON.stringify(failure).includes('opaque-token'));
  assert.ok(!failure.pmc.instructions.includes('init_agent_id'));
  refreshCode = 'unavailable';
  const temporary = JSON.parse((await tools.get('get_payout_status')({ payout_id: 'pay_test' })).content[0].text);
  assert.equal(temporary.reconnect_required, false);
  assert.ok(tools.has('connect_wallet') && tools.has('get_wallet_connection'));
  assert.equal(store.memory.config.agentId.agent_id, 'original-agent');

  refreshCode = 'valid';
  process.env.AGENT_ID = 'original-agent'; process.env.AGENT_TOKEN = 'opaque-token';
  delete process.env.AGENT_JWT;
  const status = JSON.parse((await tools.get('get_agent_status')({})).content[0].text);
  assert.equal(status.configured, true); assert.equal(status.agent_id, 'original-agent');
  const connected = JSON.parse((await tools.get('connect_wallet')({})).content[0].text);
  assert.equal(connected.connected, true); assert.ok(!('authorization_url' in connected));
  assert.ok(!requests.includes('/connect/requests')); assert.ok(!requests.includes('/register'));
  assert.equal(store.memory.config.agentId.token, 'opaque-token');
});
