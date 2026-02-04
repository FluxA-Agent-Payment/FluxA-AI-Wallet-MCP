import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hasAgentId, getEffectiveAgentId, hasRegistrationInfo, updateJWT } from '../../agent/agentId.js';
import {
  createIntentMandate,
  isJWTExpired,
  refreshJWT,
  WalletApiError,
} from '../../wallet/client.js';
import { recordAudit } from '../../store/store.js';

// Default values
const DEFAULT_MANDATE_SECONDS = 8 * 3600; // 8 hours
const DEFAULT_MANDATE_CATEGORY = 'general';

const IntentSchema = z.object({
  naturalLanguage: z.string().min(1).describe('Natural language description of the intent, e.g., "I plan to spend up to 0.10 USDC to get Polymarket trading recommendations valid for 30 days."'),
  category: z.string().default(DEFAULT_MANDATE_CATEGORY).describe('Category of the intent (default: general)'),
  currency: z.string().default('USDC').describe('Currency for the mandate (default: USDC)'),
  limitAmount: z.string().describe('Total budget limit in atomic units (e.g., "100000" = 0.1 USDC)'),
  validForSeconds: z.number().int().positive().default(DEFAULT_MANDATE_SECONDS).describe('Validity duration in seconds (default: 28800 = 8 hours)'),
  hostAllowlist: z.array(z.string()).optional().describe('Optional list of allowed hosts'),
});

const RequestSchema = z.object({
  intent: IntentSchema,
});

export type CreateIntentMandateInput = z.infer<typeof RequestSchema>;

const PMC_PRIMER = 'Please read and follow pmc.instructions to guide the user through the next steps.';

export function registerCreateIntentMandateTool(server: McpServer) {
  const description = `Create an intent mandate for x402 v3 payments. Returns a mandateId and authorizationUrl for the user to sign.

This is the first step in x402 v3 payment flow:
1. Call create_intent_mandate to get mandateId and authorizationUrl
2. Ask user to open authorizationUrl to authorize and sign the mandate
3. Use the mandateId with request_x402_v3_payment for payments

Note: If Agent ID is not configured, call init_agent_id first.`;

  server.registerTool(
    'create_intent_mandate',
    {
      description,
      inputSchema: RequestSchema.shape,
    },
    async (rawArgs) => {
      const args = RequestSchema.parse(rawArgs) as CreateIntentMandateInput;

      try {
        // Check if Agent ID is configured
        if (!hasAgentId()) {
          const hasRegInfo = hasRegistrationInfo();

          const instructions = hasRegInfo
            ? `Agent ID is not configured, but registration information is available from environment variables.

Simply call the init_agent_id tool with empty parameters {} to complete registration using the configured information.

After successful registration, retry creating the intent mandate.`
            : `Agent ID is not configured. To use FluxA Wallet, you need to register an Agent ID first.

Please follow these steps:
1. Ask the user for their email address
2. Choose a meaningful agent name (e.g., "Claude Desktop - John's Computer")
3. Provide client information (e.g., "Claude Desktop v1.0 on macOS 14.1")
4. Call the init_agent_id tool with these parameters

After successful registration, retry creating the intent mandate.`;

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
          console.error('[create_intent_mandate] JWT expired or expiring soon, refreshing...');
          try {
            const newJWT = await refreshJWT(agentId.agent_id, agentId.token);
            updateJWT(newJWT);
            agentId = getEffectiveAgentId()!;
            console.error('[create_intent_mandate] JWT refreshed successfully');
          } catch (err: any) {
            console.error('[create_intent_mandate] JWT refresh failed:', err.message);
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

        // Call Wallet API to create intent mandate
        const response = await createIntentMandate(
          { intent: args.intent },
          agentId.jwt
        );

        // Record audit
        await recordAudit({
          kind: 'create_intent_mandate',
          decision: response.status === 'ok' ? 'ok' : 'error',
          intent: args.intent,
          agent_id: agentId.agent_id,
          mandate_id: response.mandateId,
        });

        // Return the response (includes mandateId and authorizationUrl)
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
            kind: 'create_intent_mandate',
            decision: 'error',
            intent: args.intent,
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
          kind: 'create_intent_mandate',
          decision: 'error',
          intent: args.intent,
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
