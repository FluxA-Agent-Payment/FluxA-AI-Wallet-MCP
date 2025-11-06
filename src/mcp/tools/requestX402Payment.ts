import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { selectRequirementAndSign, PMC_PRIMER } from '../../x402/handler.js';
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
    require_user_approval: z.boolean().optional(),
    approval_id: z.string().optional(),
    address_hint: z.string().optional(),
    validity_window_seconds: z.number().int().positive().optional(),
    preferred_network: z.string().optional(),
    preferred_asset: z.string().optional(),
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

export function registerRequestX402PaymentTool(server: McpServer) {
  const description =
    'Sign an x402 exact (EIP-3009) payment payload from a Payment Required response and return a base64 X-PAYMENT header. Uses configured wallet and policy; may require user approval.';

  server.registerTool(
    'request_x402_payment',
    {
      description,
      inputSchema: RequestSchema.shape,
    },
    async (rawArgs) => {
      const args = RequestSchema.parse(rawArgs) as RequestX402PaymentInput;
      try {
        const result = await selectRequirementAndSign({
          paymentRequired: args.payment_required,
          selection: args.selection,
          intent: args.intent,
          options: args.options,
        });

        const { audit, ...rest } = result as any;
        if (audit) {
          await recordAudit({ ...audit, intent: args.intent, kind: 'x402' });
        }
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(rest),
            },
          ],
        };
      } catch (err: any) {
        const payload = {
          status: 'error',
          code: 'internal_error',
          message: err?.message || String(err),
          pmc: {
            primer: PMC_PRIMER,
            instructions: '工具执行出现内部错误。请提示用户稍后重试，若持续失败请联系钱包维护者。',
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
    },
  );
}
