import { startMcpServer } from './mcp/server.js';
import { startWebServer } from './web/server.js';
import { loadConfig, ensureDataDirs } from './store/store.js';

async function main() {
  ensureDataDirs();
  await loadConfig();

  // Start Web UI first so users can set private key
  const web = await startWebServer();
  if (web) {
    console.error(`[web] listening on http://localhost:${web.port}`);
  } else {
    console.error('[web] disabled or failed to start');
  }

  // Start MCP server
  const mcp = await startMcpServer();
  console.error(`[mcp] server started`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
