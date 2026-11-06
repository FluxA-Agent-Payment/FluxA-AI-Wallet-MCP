import { credentialFailure } from '../../agent/credentialError.js';
import { missingConnectionToolResult } from './connectWallet.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hasAgentId, getEffectiveAgentId, hasRegistrationInfo, updateJWT } from '../../agent/agentId.js';
import { isJWTExpired, refreshJWT, createPaymentLink, WalletApiError } from '../../wallet/client.js';
import { recordAudit } from '../../store/store.js';

const PMC_PRIMER = 'Please read and follow pmc.instructions to guide the user through the next steps.';

const RequestSchema = z
  .object({
    amount: z
      .string()
      .regex(/^\d+$/u, 'amount must be smallest unit integer string (no decimals)')
      .refine((v) => BigInt(v) > 0n, 'amount must be greater than 0'),
    currency: z.string().optional(),
    network: z.string().optional(),
    description: z.string().optional(),
    resource_content: z.string().optional(),
    expires_at: z.string().optional(),
    max_uses: z.number().int().positive().optional(),
  })
  .strict();

export type CreatePaymentLinkInput = z.infer<typeof RequestSchema>;

export function registerCreatePaymentLinkTool(server: McpServer) {
  const description = 'Create a payment link via FluxA Wallet API. Amount must be in smallest units (e.g., 1000000 = 1 USDC).';

  server.registerTool(
    'create_payment_link',
    {
      description,
      inputSchema: RequestSchema.shape,
    },
    async (rawArgs) => {
      const args = RequestSchema.parse(rawArgs) as CreatePaymentLinkInput;

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

        const resp = await createPaymentLink(
          {
            amount: args.amount,
            currency: args.currency,
            network: args.network,
            description: args.description,
            resourceContent: args.resource_content,
            expiresAt: args.expires_at,
            maxUses: args.max_uses,
          },
          agentId.jwt
        );

        await recordAudit({
          kind: 'create_payment_link',
          decision: 'ok',
          agent_id: agentId.agent_id,
          request: { amount: args.amount, description: args.description },
          response: resp,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(resp) }],
        };
      } catch (err: any) {
        if (err instanceof WalletApiError) {
          await recordAudit({
            kind: 'create_payment_link',
            decision: 'error',
            error: err.message,
            metadata: { wallet_response: err.details },
          });
          return { content: [{ type: 'text', text: typeof err.details === 'string' ? err.details : err.message }] };
        }

        await recordAudit({
          kind: 'create_payment_link',
          decision: 'error',
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
