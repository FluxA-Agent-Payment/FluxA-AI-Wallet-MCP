import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

test('MCP credential expiry preserves identity and directs the agent to browser reconnection', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'fluxa-connect-mcp-'));
  let refreshCode = 'token_expired';
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) {}
    assert.equal(req.url, '/refresh');
    res.writeHead(refreshCode === 'unavailable' ? 503 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: refreshCode }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  process.env.FLUXA_DATA_DIR = dir;
  process.env.AGENT_ID_API = `http://127.0.0.1:${server.address().port}`;
  delete process.env.AGENT_ID; delete process.env.AGENT_TOKEN; delete process.env.AGENT_JWT;
  const store = await import('../dist/store/store.js');
  store.ensureDataDirs(); await store.loadConfig();
  const { saveAgentId } = await import('../dist/agent/agentId.js');
  const { registerGetPayoutStatusTool } = await import('../dist/mcp/tools/getPayoutStatus.js');
  const { registerConnectWalletTools } = await import('../dist/mcp/tools/connectWallet.js');
  const tools = new Map();
  const serverFixture = { registerTool(name, _config, callback) { tools.set(name, callback); } };
  registerGetPayoutStatusTool(serverFixture); registerConnectWalletTools(serverFixture);
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
});
