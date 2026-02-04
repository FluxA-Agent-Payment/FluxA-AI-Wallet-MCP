import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hasAgentId, getEffectiveAgentId, hasRegistrationInfo, updateJWT } from '../../agent/agentId.js';
import { isJWTExpired, refreshJWT, listPaymentLinks, WalletApiError } from '../../wallet/client.js';
import { recordAudit } from '../../store/store.js';

const PMC_PRIMER = 'Please read and follow pmc.instructions to guide the user through the next steps.';

const RequestSchema = z
  .object({
    limit: z.number().int().positive().optional(),
  })
  .strict();

export type ListPaymentLinksInput = z.infer<typeof RequestSchema>;

export function registerListPaymentLinksTool(server: McpServer) {
  const description = 'List payment links created by this agent.';

  server.registerTool(
    'list_payment_links',
    {
      description,
      inputSchema: RequestSchema.shape,
    },
    async (rawArgs) => {
      const args = RequestSchema.parse(rawArgs) as ListPaymentLinksInput;

      try {
        if (!hasAgentId()) {
          const hasRegInfo = hasRegistrationInfo();
          const instructions = hasRegInfo
            ? 'Agent ID is not configured, but registration information is available from environment variables.\n\nCall init_agent_id with {} to complete registration, then retry.'
            : 'Agent ID is not configured. Please register first by calling init_agent_id with email, agent_name, and client_info.';

          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'error',
                code: 'agent_not_registered',
                message: 'FluxA Agent ID not configured. Please register first.',
                pmc: { primer: PMC_PRIMER, instructions },
              }),
            }],
          };
        }

        let agentId = getEffectiveAgentId();
        if (!agentId?.jwt) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({
                status: 'error',
                code: 'invalid_agent_config',
                message: 'Agent ID configuration is incomplete (missing JWT)',
                pmc: { primer: PMC_PRIMER, instructions: 'Please re-register using init_agent_id to obtain a valid JWT.' },
              }),
            }],
          };
        }

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
                  code: 'jwt_refresh_failed',
                  message: `JWT refresh failed: ${err?.message || 'Unknown error'}`,
                  pmc: { primer: PMC_PRIMER, instructions: 'JWT expired and automatic refresh failed. Please re-register using init_agent_id.' },
                }),
              }],
            };
          }
        }

        const resp = await listPaymentLinks(agentId.jwt, args.limit);

        await recordAudit({
          kind: 'list_payment_links',
          decision: 'ok',
          agent_id: agentId.agent_id,
          count: resp.paymentLinks?.length,
        });

        return {
          content: [{ type: 'text', text: JSON.stringify(resp) }],
        };
      } catch (err: any) {
        if (err instanceof WalletApiError) {
          await recordAudit({
            kind: 'list_payment_links',
            decision: 'error',
            error: err.message,
            metadata: { wallet_response: err.details },
          });
          return { content: [{ type: 'text', text: typeof err.details === 'string' ? err.details : err.message }] };
        }

        await recordAudit({
          kind: 'list_payment_links',
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
