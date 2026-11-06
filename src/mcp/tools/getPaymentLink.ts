import { credentialFailure } from '../../agent/credentialError.js';
import { missingConnectionToolResult } from './connectWallet.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hasAgentId, getEffectiveAgentId, hasRegistrationInfo, updateJWT } from '../../agent/agentId.js';
import { isJWTExpired, refreshJWT, getPaymentLink, getPaymentLinkPayments, WalletApiError } from '../../wallet/client.js';
import { recordAudit } from '../../store/store.js';

const PMC_PRIMER = 'Please read and follow pmc.instructions to guide the user through the next steps.';

const RequestSchema = z
  .object({
    link_id: z.string().min(1),
    include_payments: z.boolean().optional(),
    payments_limit: z.number().int().positive().optional(),
  })
  .strict();

export type GetPaymentLinkInput = z.infer<typeof RequestSchema>;

export function registerGetPaymentLinkTool(server: McpServer) {
  const description = 'Get payment link details. Optionally include payment records by setting include_payments to true.';

  server.registerTool(
    'get_payment_link',
    {
      description,
      inputSchema: RequestSchema.shape,
    },
    async (rawArgs) => {
      const args = RequestSchema.parse(rawArgs) as GetPaymentLinkInput;

      try {
        if (!hasAgentId()) { return missingConnectionToolResult(getEffectiveAgentId()?.agent_id); }

        let agentId = getEffectiveAgentId();
        if (!agentId?.jwt) { return missingConnectionToolResult(agentId?.agent_id); }

        if (isJWTExpired(agentId.jwt)) {
          try {
            const newJWT = await refreshJWT(agentId.agent_id, agentId.token);
            updateJWT(newJWT);
            agentId = getEffectiveAgentId()!;
          } catch (err: any) {
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({
                  status: 'error',
                  ...credentialFailure(err, agentId.agent_id),
                  message: `JWT refresh failed: ${err?.message || 'Unknown error'}`,
                  pmc: { primer: PMC_PRIMER, instructions: "If reconnect_required is true, call connect_wallet with the existing agent_id. Otherwise retry the service error. Never register a new identity to recover credentials." },
                }),
              }],
            };
          }
        }

        const resp = await getPaymentLink(args.link_id, agentId.jwt);

        let result: any = resp;

        if (args.include_payments) {
          const paymentsResp = await getPaymentLinkPayments(args.link_id, agentId.jwt, args.payments_limit);
          result = { ...resp, payments: paymentsResp.payments };
        }

        await recordAudit({
          kind: 'get_payment_link',
          decision: 'ok',
          agent_id: agentId.agent_id,
          link_id: args.link_id,
          include_payments: args.include_payments,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(result) }],
        };
      } catch (err: any) {
        if (err instanceof WalletApiError) {
          await recordAudit({
            kind: 'get_payment_link',
            decision: 'error',
            link_id: args.link_id,
            error: err.message,
            metadata: { wallet_response: err.details },
          });
          return { content: [{ type: 'text', text: typeof err.details === 'string' ? err.details : err.message }] };
        }

        await recordAudit({
          kind: 'get_payment_link',
          decision: 'error',
          link_id: args.link_id,
          error: err?.message || String(err),
        });

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ status: 'error', code: 'wallet_api_error', message: err?.message || String(err) }),
          }],
        };
      }
    }
  );
}
