import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAgent } from '../../wallet/client.js';
import { saveAgentId, hasAgentId, getEffectiveAgentId, getRegistrationInfoFromEnv, hasRegistrationInfo } from '../../agent/agentId.js';

const RequestSchema = z.object({
  email: z.string().email().optional(),
  agent_name: z.string().min(1).optional(),
  client_info: z.string().min(1).optional(),
}).strict();

export type InitAgentIdInput = z.infer<typeof RequestSchema>;

const PMC_PRIMER = 'Please read and follow pmc.instructions to guide the user through the next steps.';

export function registerInitAgentIdTool(server: McpServer) {
  const description = `Register and initialize a FluxA Agent ID. This is required before making x402 payments.

**When to use this tool:**
You MUST call this tool before using request_x402_payment if the agent is not yet registered with FluxA.

**Configuration methods:**
This tool supports two configuration methods:

1. **Environment variables (automatic)**: If AGENT_EMAIL, AGENT_NAME, and CLIENT_INFO environment variables are set, this tool will automatically use them. You don't need to provide parameters.

2. **Manual parameters**: If environment variables are not set, provide the following parameters:
   - email: User's email address (required)
     Example: "user@example.com"

   - agent_name: A meaningful name for this agent (required)
     Recommended format: "[Client Type] - [User Identifier]"
     Examples:
       * "Claude Desktop - John's MacBook"
       * "ChatGPT Plugin - Company XYZ"
       * "Cursor IDE - Development Team"
       * "Custom MCP Client - Project Alpha"

   - client_info: Description of the runtime environment (required)
     Recommended format: Include client name, version, and OS
     Examples:
       * "Claude Desktop v1.0 on macOS 14.1"
       * "Cursor IDE v0.8.3 on Windows 11"
       * "Custom MCP Client on Linux Ubuntu 22.04"

**Usage:**
- If environment variables are set, simply call: init_agent_id with empty parameters {}
- Otherwise, collect information from the user and call with parameters

**Important notes:**
- Registration is a one-time operation per agent
- If registration fails (e.g., email already exists), ask the user to confirm or use a different email
- The agent_id, token, and jwt are stored locally in the config file
- Do NOT share the jwt or token with users or external services`;

  server.registerTool(
    'init_agent_id',
    {
      description,
      inputSchema: RequestSchema.shape,
    },
    async (rawArgs) => {
      try {
        // Check if already registered
        if (hasAgentId()) {
          const existing = getEffectiveAgentId();
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'ok',
                  agent_id: existing?.agent_id,
                  message: 'Agent ID already configured',
                  pmc: {
                    primer: PMC_PRIMER,
                    instructions: 'Agent ID is already configured. You can proceed with request_x402_payment. If you need to re-register, please clear the existing configuration first.',
                  },
                }),
              },
            ],
          };
        }

        const args = RequestSchema.parse(rawArgs) as InitAgentIdInput;

        // Determine registration info: env vars take precedence over parameters
        let email: string;
        let agent_name: string;
        let client_info: string;

        const envInfo = getRegistrationInfoFromEnv();
        if (envInfo) {
          // Use environment variables
          email = envInfo.email;
          agent_name = envInfo.agent_name;
          client_info = envInfo.client_info;
          console.error('[init_agent_id] Using registration info from environment variables');
        } else if (args.email && args.agent_name && args.client_info) {
          // Use provided parameters
          email = args.email;
          agent_name = args.agent_name;
          client_info = args.client_info;
          console.error('[init_agent_id] Using registration info from parameters');
        } else {
          // Neither env vars nor complete parameters
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'error',
                  code: 'missing_registration_info',
                  message: 'Registration information is incomplete',
                  pmc: {
                    primer: PMC_PRIMER,
                    instructions: 'Registration requires email, agent_name, and client_info. Either:\n1. Set environment variables: AGENT_EMAIL, AGENT_NAME, CLIENT_INFO, or\n2. Provide these parameters when calling init_agent_id.\n\nPlease collect the user\'s email and provide appropriate agent name and client info.',
                  },
                }),
              },
            ],
          };
        }

        // Call FluxA registration API
        const response = await registerAgent({
          email,
          agent_name,
          client_info,
        });

        // Save to config
        saveAgentId({
          agent_id: response.agent_id,
          token: response.token,
          jwt: response.jwt,
          email,
          agent_name,
          client_info,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'ok',
                agent_id: response.agent_id,
                message: 'Agent ID registered successfully',
                pmc: {
                  primer: PMC_PRIMER,
                  instructions: 'Registration successful! Your FluxA Agent ID has been saved to the configuration file. You can now use the request_x402_payment tool to make x402 payments.',
                },
              }),
            },
          ],
        };
      } catch (err: any) {
        const payload = {
          status: 'error',
          code: 'registration_failed',
          message: err?.message || String(err),
          pmc: {
            primer: PMC_PRIMER,
            instructions: `Registration failed: ${err?.message || 'Unknown error'}. Please check that:\n1. The email format is valid\n2. The email is not already registered (try a different email if needed)\n3. Network connectivity is available\n\nIf the problem persists, please contact FluxA support.`,
          },
        };
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(payload),
            },
          ],
        };
      }
    }
  );
}
