import { credentialFailure } from '../../agent/credentialError.js';
import { missingConnectionToolResult } from './connectWallet.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { hasAgentId, getEffectiveAgentId, hasRegistrationInfo, updateJWT } from '../../agent/agentId.js';
import {
  requestX402V3Payment,
  extractHost,
  getCurrencyFromAsset,
  getMandateStatus,
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
  })
  .strict();

const RequestSchema = z
  .object({
    mandate_id: z.string().min(1).describe('The mandateId from create_intent_mandate (required for x402 v3)'),
    payment_required: PaymentRequiredSchema,
    selection: SelectionSchema.optional(),
    intent: IntentSchema,
    options: OptionsSchema.optional(),
  })
  .strict();

export type RequestX402V3PaymentInput = z.infer<typeof RequestSchema>;

const PMC_PRIMER = 'Please read and follow pmc.instructions to guide the user through the next steps.';

/**
 * Select a payment requirement from the accepts array.
 * Always matches against mandateCurrency to prevent currency_mismatch errors.
 */
function selectRequirement(
  paymentRequired: z.infer<typeof PaymentRequiredSchema>,
  mandateCurrency: string,
  selection?: z.infer<typeof SelectionSchema>,
  options?: z.infer<typeof OptionsSchema>
): { requirement: z.infer<typeof PaymentRequirementSchema>; index: number } {
  const accepts = paymentRequired.accepts;

  // If explicit index given, validate it matches the mandate currency
  if (selection?.acceptIndex != null && accepts[selection.acceptIndex]) {
    const req = accepts[selection.acceptIndex];
    const reqCurrency = getCurrencyFromAsset(req.asset, req.network);
    if (reqCurrency !== mandateCurrency) {
      throw new Error(
        `Currency mismatch: accepts[${selection.acceptIndex}] is ${reqCurrency} but mandate currency is ${mandateCurrency}. ` +
        `Available currencies in accepts: ${accepts.map((a, i) => `[${i}]=${getCurrencyFromAsset(a.asset, a.network)}`).join(', ')}`
      );
    }
    return { requirement: req, index: selection.acceptIndex };
  }

  const preferredNetwork = options?.preferred_network;
  const preferredAsset = options?.preferred_asset?.toLowerCase();

  for (let i = 0; i < accepts.length; i++) {
    const req = accepts[i];
    if (req.scheme !== 'exact') continue;
    // Always filter by mandate currency
    const reqCurrency = getCurrencyFromAsset(req.asset, req.network);
    if (reqCurrency !== mandateCurrency) continue;
    if (preferredNetwork && req.network !== preferredNetwork) continue;
    if (preferredAsset && req.asset.toLowerCase() !== preferredAsset) continue;
    return { requirement: req, index: i };
  }

  const availableCurrencies = accepts.map(a => getCurrencyFromAsset(a.asset, a.network));
  throw new Error(
    `No matching payment requirement found for mandate currency "${mandateCurrency}". ` +
    `Available currencies in accepts: [${availableCurrencies.join(', ')}]. ` +
    `Only "exact" scheme is supported.`
  );
}

export function registerRequestX402V3PaymentTool(server: McpServer) {
  const description = `Sign an x402 v3 payment using an intent mandate. Requires a valid mandateId from create_intent_mandate.

x402 v3 payment flow:
1. First call create_intent_mandate to get a mandateId
2. User signs the mandate via authorizationUrl
3. Call this tool with the mandateId to make payments

The mandate acts as a pre-authorized spending budget. Payments will succeed as long as:
- The mandate is signed
- The mandate has sufficient remaining budget
- The mandate is within its validity window

Returns X-PAYMENT header (xPaymentB64) for the HTTP request.`;

  server.registerTool(
    'request_x402_v3_payment',
    {
      description,
      inputSchema: RequestSchema.shape,
    },
    async (rawArgs) => {
      const args = RequestSchema.parse(rawArgs) as RequestX402V3PaymentInput;

      try {
        // Check if Agent ID is configured
        if (!hasAgentId()) { return missingConnectionToolResult(getEffectiveAgentId()?.agent_id); }

        let agentId = getEffectiveAgentId();
        if (!agentId?.jwt) { return missingConnectionToolResult(agentId?.agent_id); }

        // Check if JWT is expired and refresh if needed
        if (isJWTExpired(agentId.jwt)) {
          console.error('[request_x402_v3_payment] JWT expired or expiring soon, refreshing...');
          try {
            const newJWT = await refreshJWT(agentId.agent_id, agentId.token);
            updateJWT(newJWT);
            agentId = getEffectiveAgentId()!;
            console.error('[request_x402_v3_payment] JWT refreshed successfully');
          } catch (err: any) {
            console.error('[request_x402_v3_payment] JWT refresh failed:', err.message);
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

        // Fetch mandate currency for matching
        let mandateCurrency = 'USDC';
        try {
          const mandateInfo = await getMandateStatus(args.mandate_id, agentId.jwt);
          if (mandateInfo.mandate?.currency) {
            mandateCurrency = mandateInfo.mandate.currency;
          }
        } catch (err: any) {
          console.error('[request_x402_v3_payment] Could not fetch mandate currency, defaulting to USDC:', err?.message);
        }

        // Select payment requirement matching mandate currency
        let selected;
        try {
          selected = selectRequirement(args.payment_required, mandateCurrency, args.selection, args.options);
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
                    instructions: `No matching payment requirement found for mandate currency "${mandateCurrency}". ` +
                      'Check that the 402 response includes an accepts entry matching your mandate currency, ' +
                      'and that only "exact" scheme entries are present.',
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
          mandateId: args.mandate_id,
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
        };

        // Call Wallet API
        const walletResponse = await requestX402V3Payment(walletRequest, agentId.jwt);

        // Record audit
        await recordAudit({
          kind: 'x402_v3_payment',
          decision: walletResponse.status === 'ok' ? 'ok' : walletResponse.status,
          intent: args.intent,
          requirement: req,
          agent_id: agentId.agent_id,
          mandate_id: args.mandate_id,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(walletResponse),
            },
          ],
        };
      } catch (err: any) {
        if (err instanceof WalletApiError) {
          await recordAudit({
            kind: 'x402_v3_payment',
            decision: 'error',
            intent: args.intent,
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
          kind: 'x402_v3_payment',
          decision: 'error',
          intent: args.intent,
          mandate_id: args.mandate_id,
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
  );
}
