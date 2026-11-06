import { credentialFailure } from '../../agent/credentialError.js';
import { missingConnectionToolResult } from './connectWallet.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hasAgentId, getEffectiveAgentId, hasRegistrationInfo, updateJWT } from '../../agent/agentId.js';
import { isJWTExpired, refreshJWT, updatePaymentLink, WalletApiError } from '../../wallet/client.js';
import { recordAudit } from '../../store/store.js';

const PMC_PRIMER = 'Please read and follow pmc.instructions to guide the user through the next steps.';

const RequestSchema = z
  .object({
    link_id: z.string().min(1),
    description: z.string().optional(),
    resource_content: z.string().optional(),
    status: z.enum(['active', 'disabled']).optional(),
    expires_at: z.string().nullable().optional(),
    max_uses: z.number().int().positive().nullable().optional(),
  })
  .strict();

export type UpdatePaymentLinkInput = z.infer<typeof RequestSchema>;

export function registerUpdatePaymentLinkTool(server: McpServer) {
  const description = 'Update a payment link. Can modify description, resource_content, status (active/disabled), expires_at, and max_uses.';

  server.registerTool(
    'update_payment_link',
    {
      description,
      inputSchema: RequestSchema.shape,
    },
    async (rawArgs) => {
      const args = RequestSchema.parse(rawArgs) as UpdatePaymentLinkInput;

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

        const updateParams: Record<string, any> = {};
        if (args.description !== undefined) updateParams.description = args.description;
        if (args.resource_content !== undefined) updateParams.resourceContent = args.resource_content;
        if (args.status !== undefined) updateParams.status = args.status;
        if (args.expires_at !== undefined) updateParams.expiresAt = args.expires_at;
        if (args.max_uses !== undefined) updateParams.maxUses = args.max_uses;

        const resp = await updatePaymentLink(args.link_id, updateParams, agentId.jwt);

        await recordAudit({
          kind: 'update_payment_link',
          decision: 'ok',
          agent_id: agentId.agent_id,
          link_id: args.link_id,
          updates: updateParams,
          response: resp,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(resp) }],
        };
      } catch (err: any) {
        if (err instanceof WalletApiError) {
          await recordAudit({
            kind: 'update_payment_link',
            decision: 'error',
            link_id: args.link_id,
            error: err.message,
            metadata: { wallet_response: err.details },
          });
          return { content: [{ type: 'text', text: typeof err.details === 'string' ? err.details : err.message }] };
        }

        await recordAudit({
          kind: 'update_payment_link',
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
