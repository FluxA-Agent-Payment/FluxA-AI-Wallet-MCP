import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { getPayoutStatus as fetchPayoutStatus, WalletApiError } from '../../wallet/client.js';
import { recordAudit } from '../../store/store.js';

const RequestSchema = z
  .object({
    payout_id: z.string().min(1),
  })
  .strict();

export type GetPayoutStatusInput = z.infer<typeof RequestSchema>;

export function registerGetPayoutStatusTool(server: McpServer) {
  const description = 'Query payout status from Wallet App public endpoint. Optionally override base URL via wallet_app_base.';

  server.registerTool(
    'get_payout_status',
    {
      description,
      inputSchema: RequestSchema.shape,
    },
    async (rawArgs) => {
      const args = RequestSchema.parse(rawArgs) as GetPayoutStatusInput;
      try {
        const resp = await fetchPayoutStatus(args.payout_id);

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
