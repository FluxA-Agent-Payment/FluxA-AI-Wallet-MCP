import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { registerRequestX402PaymentTool } from './tools/requestX402Payment.js';
import { registerInitAgentIdTool } from './tools/initAgentId.js';
import { registerGetAgentStatusTool } from './tools/getAgentStatus.js';
import { registerGetPayoutStatusTool } from './tools/getPayoutStatus.js';
import { registerRequestPayoutTool } from './tools/requestPayout.js';
import { registerCreateIntentMandateTool } from './tools/createIntentMandate.js';
import { registerGetMandateStatusTool } from './tools/getMandateStatus.js';
import { registerRequestX402V3PaymentTool } from './tools/requestX402V3Payment.js';

export async function startMcpServer() {
  const server = new McpServer({
    name: 'fluxa-ai-wallet-mcp',
    version: '0.3.0',
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
  // x402 v3 tools (intent mandate based)
  registerCreateIntentMandateTool(server);
  registerGetMandateStatusTool(server);
  registerRequestX402V3PaymentTool(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  return { server };
}
