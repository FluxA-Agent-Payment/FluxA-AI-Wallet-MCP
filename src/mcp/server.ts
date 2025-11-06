import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerRequestX402PaymentTool } from './tools/requestX402Payment.js';

export async function startMcpServer() {
  const server = new McpServer({
    name: 'fluxa-ai-wallet-mcp',
    version: '0.1.0',
    capabilities: {
      tools: {},
    },
  });

  registerRequestX402PaymentTool(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  return { server };
}
