import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hasAgentId, getEffectiveAgentId, hasRegistrationInfo, updateJWT } from '../../agent/agentId.js';
import { isJWTExpired, refreshJWT, createPayout, WalletApiError } from '../../wallet/client.js';
import { recordAudit } from '../../store/store.js';
import { isAddress } from 'viem';

const PMC_PRIMER = 'Please read and follow pmc.instructions to guide the user through the next steps.';

// Hardcoded payout settings per requirements
const DEFAULT_PAYOUT_NETWORK = 'base';
const DEFAULT_PAYOUT_CURRENCY = 'USDC';
const DEFAULT_PAYOUT_ASSET_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const RequestSchema = z
  .object({
    to_address: z.string().min(1),
    amount: z
      .string()
      .regex(/^\d+$/u, 'amount must be smallest unit integer string (no decimals)')
      .refine((v) => BigInt(v) > 0n, 'amount must be greater than 0'),
    payout_id: z.string().min(1),
  })
  .strict();

export type RequestPayoutInput = z.infer<typeof RequestSchema>;

export function registerRequestPayoutTool(server: McpServer) {
  const description = 'Create a payout via FluxA Wallet API. Requires Agent ID to be configured. Amount must be in smallest units.';

  server.registerTool(
    'request_payout',
    {
      description,
      inputSchema: RequestSchema.shape,
    },
    async (rawArgs) => {
      const args = RequestSchema.parse(rawArgs) as RequestPayoutInput;

      try {
        // Basic validation for address
        if (!isAddress(args.to_address)) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'error',
                  code: 'invalid_address',
                  message: 'to_address is not a valid EVM address',
                }),
              },
            ],
          };
        }

        // Ensure Agent ID configured
        if (!hasAgentId()) {
          const hasRegInfo = hasRegistrationInfo();
          const instructions = hasRegInfo
            ? `Agent ID is not configured, but registration information is available from environment variables.\n\nCall init_agent_id with {} to complete registration, then retry request_payout.`
            : `Agent ID is not configured. Please register first by calling init_agent_id with email, agent_name, and client_info.`;

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'error',
                  code: 'agent_not_registered',
                  message: 'FluxA Agent ID not configured. Please register first.',
                  pmc: { primer: PMC_PRIMER, instructions },
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
                    instructions: 'Please re-register using init_agent_id to obtain a valid JWT.',
                  },
                }),
              },
            ],
          };
        }

        // Refresh JWT if needed
        if (isJWTExpired(agentId.jwt)) {
          try {
            const newJWT = await refreshJWT(agentId.agent_id, agentId.token);
            updateJWT(newJWT);
            agentId = getEffectiveAgentId()!;
          } catch (err: any) {
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
                      instructions: 'JWT expired and automatic refresh failed. Please re-register using init_agent_id.',
                    },
                  }),
                },
              ],
            };
          }
        }

        // Build payout request with hardcoded Base USDC
        const payoutReq = {
          agentId: agentId.agent_id,
          toAddress: args.to_address,
          amount: args.amount,
          currency: DEFAULT_PAYOUT_CURRENCY,
          network: DEFAULT_PAYOUT_NETWORK,
          assetAddress: DEFAULT_PAYOUT_ASSET_ADDRESS,
          payoutId: args.payout_id,
        } as const;

        const resp = await createPayout(payoutReq, agentId.jwt);

        // Audit
        await recordAudit({
          kind: 'payout_request',
          decision: 'ok',
          agent_id: agentId.agent_id,
          request: {
            to: args.to_address,
            amount: args.amount,
            payout_id: args.payout_id,
          },
          response: resp,
        });

        // Add pmc guidance when approval is pending
        if (resp?.status === 'pending_authorization' && resp?.approvalUrl) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  ...resp,
                  pmc: {
                    primer: PMC_PRIMER,
                    instructions: 'Please open approvalUrl in a browser to authorize the payout. After approval, the payout will finalize automatically.',
                  },
                }),
              },
            ],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(resp),
            },
          ],
        };
      } catch (err: any) {
        if (err instanceof WalletApiError) {
          await recordAudit({
            kind: 'payout_request',
            decision: 'error',
            error: err.message,
            metadata: { wallet_response: err.details },
          });

          return {
            content: [
              {
                type: 'text',
                text: typeof err.details === 'string' ? err.details : err.message,
              },
            ],
          };
        }

        await recordAudit({
          kind: 'payout_request',
          decision: 'error',
          error: err?.message || String(err),
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                status: 'error',
                code: 'wallet_api_error',
                message: err?.message || String(err),
              }),
            },
          ],
        };
      }
    }
  );
}

