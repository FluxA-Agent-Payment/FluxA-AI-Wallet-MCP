import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerRequestX402PaymentTool } from './tools/requestX402Payment.js';
import { registerInitAgentIdTool } from './tools/initAgentId.js';
import { registerGetAgentStatusTool } from './tools/getAgentStatus.js';
import { registerGetPayoutStatusTool } from './tools/getPayoutStatus.js';
import { registerRequestPayoutTool } from './tools/requestPayout.js';

export async function startMcpServer() {
  const server = new McpServer({
    name: 'fluxa-ai-wallet-mcp',
    version: '0.2.0',
    capabilities: {
      tools: {},
    },
  });

  // Register MCP tools
  registerInitAgentIdTool(server);
  registerRequestX402PaymentTool(server);
  registerGetAgentStatusTool(server);
  registerRequestPayoutTool(server);
  registerGetPayoutStatusTool(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  return { server };
}
