import { credentialFailure } from '../../agent/credentialError.js';
import { missingConnectionToolResult } from './connectWallet.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hasAgentId, getEffectiveAgentId, hasRegistrationInfo, updateJWT } from '../../agent/agentId.js';
import {
  requestX402Payment,
  extractHost,
  getCurrencyFromAsset,
  isJWTExpired,
  refreshJWT,
  WalletApiError,
} from '../../wallet/client.js';
import { recordAudit } from '../../store/store.js';

const PaymentRequirementSchema = z.object({
  scheme: z.string(),
  network: z.string(),
  maxAmountRequired: z.string(),
  resource: z.string(),
  description: z.string(),
  mimeType: z.string(),
  outputSchema: z.record(z.any()).nullable().optional(),
  payTo: z.string(),
  maxTimeoutSeconds: z.number().nonnegative(),
  asset: z.string(),
  extra: z
    .object({
      name: z.string().optional(),
      version: z.string().optional(),
    })
    .nullable()
    .optional(),
});

const PaymentRequiredSchema = z.object({
  x402Version: z.number(),
  error: z.string().optional(),
  accepts: z.array(PaymentRequirementSchema).min(1),
});

const SelectionSchema = z
  .object({
    acceptIndex: z.number().int().nonnegative().optional(),
    scheme: z.string().optional(),
    network: z.string().optional(),
    asset: z.string().optional(),
  })
  .strict();

const IntentSchema = z
  .object({
    why: z.string().min(1),
    http_method: z.string().min(1),
    http_url: z.string().min(1),
    caller: z.string().min(1),
    trace_id: z.string().optional(),
    prompt_summary: z.string().optional(),
  })
  .strict();

const OptionsSchema = z
  .object({
    validity_window_seconds: z.number().int().positive().optional(),
    preferred_network: z.string().optional(),
    preferred_asset: z.string().optional(),
    approval_id: z.string().optional(),
  })
  .strict();

const RequestSchema = z
  .object({
    payment_required: PaymentRequiredSchema,
    selection: SelectionSchema.optional(),
    intent: IntentSchema,
    options: OptionsSchema.optional(),
  })
  .strict();

export type RequestX402PaymentInput = z.infer<typeof RequestSchema>;

const PMC_PRIMER = 'Please read and follow pmc.instructions to guide the user through the next steps.';

/**
 * Select a payment requirement from the accepts array
 */
function selectRequirement(
  paymentRequired: z.infer<typeof PaymentRequiredSchema>,
  selection?: z.infer<typeof SelectionSchema>,
  options?: z.infer<typeof OptionsSchema>
): { requirement: z.infer<typeof PaymentRequirementSchema>; index: number } {
  const accepts = paymentRequired.accepts;

  // Use explicit index if provided
  if (selection?.acceptIndex != null && accepts[selection.acceptIndex]) {
    return { requirement: accepts[selection.acceptIndex], index: selection.acceptIndex };
  }

  const preferredNetwork = options?.preferred_network;
  const preferredAsset = options?.preferred_asset?.toLowerCase();

  // Find first exact scheme with matching network/asset preferences
  for (let i = 0; i < accepts.length; i++) {
    const req = accepts[i];
    if (req.scheme !== 'exact') continue;
    if (preferredNetwork && req.network !== preferredNetwork) continue;
    if (preferredAsset && req.asset.toLowerCase() !== preferredAsset) continue;
    return { requirement: req, index: i };
  }

  throw new Error('No supported payment requirement found (only "exact" scheme is supported)');
}

export function registerRequestX402PaymentTool(server: McpServer) {
  const description =
    'Sign an x402 exact (EIP-3009) payment by calling FluxA Wallet API. Returns X-PAYMENT header for the HTTP request. Requires Agent ID to be configured first (use connect_wallet tool).';

  server.registerTool(
    'request_x402_payment',
    {
      description,
      inputSchema: RequestSchema.shape,
    },
    async (rawArgs) => {
      const args = RequestSchema.parse(rawArgs) as RequestX402PaymentInput;

      try {
        // Check if Agent ID is configured
        if (!hasAgentId()) { return missingConnectionToolResult(getEffectiveAgentId()?.agent_id); }

        let agentId = getEffectiveAgentId();
        if (!agentId?.jwt) { return missingConnectionToolResult(agentId?.agent_id); }

        // Check if JWT is expired and refresh if needed
        if (isJWTExpired(agentId.jwt)) {
          console.error('[request_x402_payment] JWT expired or expiring soon, refreshing...');
          try {
            const newJWT = await refreshJWT(agentId.agent_id, agentId.token);
            updateJWT(newJWT);
            // Get updated agent ID with new JWT
            agentId = getEffectiveAgentId()!;
            console.error('[request_x402_payment] JWT refreshed successfully');
          } catch (err: any) {
            console.error('[request_x402_payment] JWT refresh failed:', err.message);
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

        // Select payment requirement
        let selected;
        try {
          selected = selectRequirement(args.payment_required, args.selection, args.options);
        } catch (err: any) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'error',
                  code: 'no_supported_requirement',
                  message: err?.message || String(err),
                  pmc: {
                    primer: PMC_PRIMER,
                    instructions: 'No supported payment method found in the 402 response. FluxA Wallet currently only supports "exact" scheme with EIP-3009. Please verify that the service supports Base USDC payments.',
                  },
                }),
              },
            ],
          };
        }

        const req = selected.requirement;

        // Validate required fields
        if (!req.extra?.name || !req.extra?.version) {
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  status: 'error',
                  code: 'invalid_payment_requirement',
                  message: 'Payment requirement is missing token name or version (required for EIP-3009)',
                  pmc: {
                    primer: PMC_PRIMER,
                    instructions: 'The x402 payment requirement is incomplete. The server must provide token name and version in the extra field. Please contact the service provider to fix their x402 implementation.',
                  },
                }),
              },
            ],
          };
        }

        // Build Wallet API request
        const currency = getCurrencyFromAsset(req.asset, req.network);
        const validityWindowSeconds = args.options?.validity_window_seconds || 60;

        const walletRequest = {
          scheme: 'exact',
          network: req.network,
          amount: req.maxAmountRequired,
          currency: currency,
          assetAddress: req.asset,
          payTo: req.payTo,
          host: extractHost(req.resource),
          resource: req.resource,
          description: req.description,
          tokenName: req.extra.name,
          tokenVersion: req.extra.version,
          validityWindowSeconds: Math.min(validityWindowSeconds, req.maxTimeoutSeconds),
          approvalId: args.options?.approval_id,
        };

        // Call Wallet API
        const walletResponse = await requestX402Payment(walletRequest, agentId.jwt);

        // Build X-Payment header (base64 encoded)
        // const xPaymentObject = {
        //   x402Version: args.payment_required.x402Version,
        //   scheme: 'exact',
        //   network: req.network,
        //   payload: walletResponse,
        // };

        // const xPaymentB64 = Buffer.from(JSON.stringify(xPaymentObject)).toString('base64');

        // Record audit
        await recordAudit({
          kind: 'x402_payment',
          decision: 'ok',
          intent: args.intent,
          requirement: req,
          agent_id: agentId.agent_id,
        });

        return {
          content: [
            {
              type: 'text',
              text: typeof walletResponse === 'string' ? walletResponse : JSON.stringify(walletResponse),
            },
          ],
        };
      } catch (err: any) {
        if (err instanceof WalletApiError) {
          await recordAudit({
            kind: 'x402_payment',
            decision: 'error',
            intent: args.intent,
            error: err.message,
            metadata: {
              wallet_response: err.details,
            },
          });

          const rawResponse = err.details ?? err.message ?? 'Wallet API error';
          const textResponse = typeof rawResponse === 'string' ? rawResponse : JSON.stringify(rawResponse);

          return {
            content: [
              {
                type: 'text',
                text: textResponse,
              },
            ],
          };
        }

        // Record audit for unexpected errors
        await recordAudit({
          kind: 'x402_payment',
          decision: 'error',
          intent: args.intent,
          error: err?.message || String(err),
        });

        const payload = {
          status: 'error',
          code: 'wallet_api_error',
          message: err?.message || String(err),
          pmc: {
            primer: PMC_PRIMER,
            instructions: "If reconnect_required is true, call connect_wallet with the existing agent_id. Otherwise retry the service error. Never register a new identity to recover credentials.",
          },
        };

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(payload),
            },
          ],
        };
      }
    }
  );
}
