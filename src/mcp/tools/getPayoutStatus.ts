import { credentialFailure } from '../../agent/credentialError.js';
import { missingConnectionToolResult } from './connectWallet.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getEffectiveAgentId, updateJWT } from '../../agent/agentId.js';
import { getPayoutStatus as fetchPayoutStatus, isJWTExpired, refreshJWT, WalletApiError } from '../../wallet/client.js';
import { recordAudit } from '../../store/store.js';

const PMC_PRIMER = 'Please read and follow pmc.instructions to guide the user through the next steps.';

const RequestSchema = z
  .object({
    payout_id: z.string().min(1),
  })
  .strict();

export type GetPayoutStatusInput = z.infer<typeof RequestSchema>;

export function registerGetPayoutStatusTool(server: McpServer) {
  const description = 'Query payout status from Wallet Service using the session Agent JWT.';

  server.registerTool(
    'get_payout_status',
    {
      description,
      inputSchema: RequestSchema.shape,
    },
    async (rawArgs) => {
      const args = RequestSchema.parse(rawArgs) as GetPayoutStatusInput;

      let agentId = getEffectiveAgentId();
      if (!agentId?.jwt) { return missingConnectionToolResult(agentId?.agent_id); }

      // Refresh JWT if needed
      if (isJWTExpired(agentId.jwt)) {
        try {
          const newJWT = await refreshJWT(agentId.agent_id, agentId.token);
          updateJWT(newJWT);
          agentId = getEffectiveAgentId()!;
          agentId = getEffectiveAgentId()!;
        } catch (err: any) {
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

      try {
        const resp = await fetchPayoutStatus(args.payout_id, agentId.jwt);

        await recordAudit({
          kind: 'payout_status',
          decision: 'ok',
          payout_id: args.payout_id,
          response: resp,
        });

        return {
          content: [
            { type: 'text', text: JSON.stringify(resp) },
          ],
        };
      } catch (err: any) {
        if (err instanceof WalletApiError) {
          await recordAudit({
            kind: 'payout_status',
            decision: 'error',
            payout_id: args.payout_id,
            error: err.message,
            metadata: { wallet_response: err.details },
          });
          return { content: [{ type: 'text', text: typeof err.details === 'string' ? err.details : err.message }] };
        }

        await recordAudit({
          kind: 'payout_status',
          decision: 'error',
          payout_id: args.payout_id,
          error: err?.message || String(err),
        });

        return {
          content: [
            { type: 'text', text: JSON.stringify({ status: 'error', code: 'wallet_status_error', message: err?.message || String(err) }) },
          ],
        };
      }
    }
  );
}
