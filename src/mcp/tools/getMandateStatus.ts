import { credentialFailure } from '../../agent/credentialError.js';
import { missingConnectionToolResult } from './connectWallet.js';
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
        if (!hasAgentId()) { return missingConnectionToolResult(getEffectiveAgentId()?.agent_id); }

        let agentId = getEffectiveAgentId();
        if (!agentId?.jwt) { return missingConnectionToolResult(agentId?.agent_id); }

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
                    ...credentialFailure(err, agentId.agent_id),
                    message: `JWT refresh failed: ${err?.message || 'Unknown error'}`,
                    pmc: {
                      primer: PMC_PRIMER,
                      instructions: "If reconnect_required is true, call connect_wallet with the existing agent_id. Otherwise retry the service error. Never register a new identity to recover credentials.",
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
