import { startMcpServer } from './mcp/server.js';
import { loadConfig, ensureDataDirs } from './store/store.js';

async function main() {
  ensureDataDirs();
  await loadConfig();

  // Start MCP server (non-blocking)
  const mcp = await startMcpServer();
  console.error('[mcp] FluxA AI Wallet MCP server started');
  console.error('[mcp] Tools available: init_agent_id, request_x402_payment, get_agent_status');
}

main().catch((err) => {
  console.error('[error]', err);
  process.exit(1);
});
