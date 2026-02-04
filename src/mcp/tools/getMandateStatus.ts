import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hasAgentId, getEffectiveAgentId, hasRegistrationInfo, updateJWT } from '../../agent/agentId.js';
import {
  getMandateStatus,
  isJWTExpired,
  refreshJWT,
  WalletApiError,
} from '../../wallet/client.js';
import { recordAudit } from '../../store/store.js';

const RequestSchema = z.object({
  mandate_id: z.string().min(1).describe('The mandate ID to query status for'),
});

export type GetMandateStatusInput = z.infer<typeof RequestSchema>;

const PMC_PRIMER = 'Please read and follow pmc.instructions to guide the user through the next steps.';

export function registerGetMandateStatusTool(server: McpServer) {
  const description = `Query the status of an intent mandate by mandateId.

Returns mandate details including:
- status: 'pending_signature', 'signed', 'revoked', 'expired', etc.
- limitAmount: Total budget in atomic units
- spentAmount: Amount already spent
- remainingAmount: Available budget
- validFrom/validUntil: Validity window

Use this to check if a mandate is ready for payments or needs user signature.`;

  server.registerTool(
    'get_mandate_status',
    {
      description,
      inputSchema: RequestSchema.shape,
    },
    async (rawArgs) => {
      const args = RequestSchema.parse(rawArgs) as GetMandateStatusInput;

      try {
        // Check if Agent ID is configured
        if (!hasAgentId()) {
          const hasRegInfo = hasRegistrationInfo();

          const instructions = hasRegInfo
            ? `Agent ID is not configured, but registration information is available from environment variables.

Simply call the init_agent_id tool with empty parameters {} to complete registration using the configured information.

After successful registration, retry querying mandate status.`
            : `Agent ID is not configured. To use FluxA Wallet, you need to register an Agent ID first.

Please follow these steps:
1. Ask the user for their email address
2. Choose a meaningful agent name
3. Provide client information
4. Call the init_agent_id tool with these parameters

After successful registration, retry querying mandate status.`;

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'error',
                  code: 'agent_not_registered',
                  message: 'FluxA Agent ID not configured. Please register first.',
                  pmc: {
                    primer: PMC_PRIMER,
                    instructions,
                  },
                }),
              },
            ],
          };
        }

        let agentId = getEffectiveAgentId();
        if (!agentId?.jwt) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'error',
                  code: 'invalid_agent_config',
                  message: 'Agent ID configuration is incomplete (missing JWT)',
                  pmc: {
                    primer: PMC_PRIMER,
                    instructions: 'Agent ID configuration is incomplete. Please re-register using the init_agent_id tool.',
                  },
                }),
              },
            ],
          };
        }

        // Check if JWT is expired and refresh if needed
        if (isJWTExpired(agentId.jwt)) {
          console.error('[get_mandate_status] JWT expired or expiring soon, refreshing...');
          try {
            const newJWT = await refreshJWT(agentId.agent_id, agentId.token);
            updateJWT(newJWT);
            agentId = getEffectiveAgentId()!;
            console.error('[get_mandate_status] JWT refreshed successfully');
          } catch (err: any) {
            console.error('[get_mandate_status] JWT refresh failed:', err.message);
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'error',
                    code: 'jwt_refresh_failed',
                    message: `JWT refresh failed: ${err?.message || 'Unknown error'}`,
                    pmc: {
                      primer: PMC_PRIMER,
                      instructions: `JWT token has expired and automatic refresh failed: ${err?.message || 'Unknown error'}.\n\nPlease re-register using the init_agent_id tool to get a new JWT token.`,
                    },
                  }),
                },
              ],
            };
          }
        }

        // Call Wallet API to get mandate status
        const response = await getMandateStatus(args.mandate_id, agentId.jwt);

        // Record audit
        await recordAudit({
          kind: 'get_mandate_status',
          decision: response.status === 'ok' ? 'ok' : 'error',
          mandate_id: args.mandate_id,
          agent_id: agentId.agent_id,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(response),
            },
          ],
        };
      } catch (err: any) {
        if (err instanceof WalletApiError) {
          await recordAudit({
            kind: 'get_mandate_status',
            decision: 'error',
            mandate_id: args.mandate_id,
            error: err.message,
            metadata: {
              wallet_response: err.details,
            },
          });

          return {
            content: [
              {
                type: 'text',
                text: typeof err.details === 'string' ? err.details : JSON.stringify({
                  status: 'error',
                  code: 'wallet_api_error',
                  message: err.message,
                }),
              },
            ],
          };
        }

        await recordAudit({
          kind: 'get_mandate_status',
          decision: 'error',
          mandate_id: args.mandate_id,
          error: err?.message || String(err),
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'error',
                code: 'unexpected_error',
                message: err?.message || String(err),
                pmc: {
                  primer: PMC_PRIMER,
                  instructions: `An unexpected error occurred: ${err?.message || 'Unknown error'}. Please retry or contact support.`,
                },
              }),
            },
          ],
        };
      }
    }
  );
}
