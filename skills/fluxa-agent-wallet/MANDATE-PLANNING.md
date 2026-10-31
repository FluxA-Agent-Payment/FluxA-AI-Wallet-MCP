# Mandate Planning Policy

## Core Principle

When using fluxa agent wallet for payments, a mandate must be requested. This is a spending budget, subsequent payment requests must reference this mandate id so the wallet can automatically approve them.

You **MUST** to clearly define the purpose of this budget so the user knows what the funds will be used for, and so the fluxa agent wallet risk control module can verify whether actual payment requests match the intended use.

When applying for the budget, you may already know the exact number of payments and amounts (for example, calling an image generation api three times). or you may not know the exact payments in advance, and the spending will only be determined dynamically during task execution, including the number of transactions and total cost. both cases are allowed. you just need to apply for a reasonable budget.

You must avoid applying for a budget for each individual payment, as this creates a poor user experience. Plan one budget for the whole task, and reuse it for later tasks while it lasts.

## Budget Rule for x402 / AgentMarket API Calls

One rule for every paid API call (FluxA AgentMarket listings and any other x402 API):

> Budget = 3x the task estimate, at least $1, at most $5, valid 7 days. Go above $5 only if the user asks or the task estimate itself is above $5. Reuse any signed, unexpired mandate that has enough remaining before you create a new one.

- **Task estimate** = the price of every call the task needs, summed (from the API's price table or its 402 `accepts`). The 3x covers retries and calls that fail or get rejected.
- **Above $5**: when the estimate itself is above $5, budget the estimate plus one retry of the most expensive call.
- **Validity**: `--seconds 604800` (7 days).
- **Amounts**: USDC atomic units, 6 decimals. $1 = `1000000`, $5 = `5000000`.
- **Reuse first**: run `fluxa-wallet mandates` and take a mandate that is `signed`, not expired, in the currency the API accepts, with `remaining` at least the task estimate. If one fits, use it and send no link at all.

Examples:

| Task | Estimate | Budget |
|------|----------|--------|
| 2 lookups at $0.10 | $0.20 | $1 (3x = $0.60, raised to the $1 minimum) |
| Forager search $0.02 + email lookup $0.10 | $0.12 | $1 |
| 20 calls at $0.15 | $3.00 | $5 (3x = $9, capped at $5) |
| One video at $8 | $8.00 | $16 (estimate is above $5: $8 + one retry) |

## Payment Message Format

When a new mandate is needed, create it right away and send the user exactly this, and nothing else:

```
{Provider} charges ${unit_price} per {unit}. This task needs about ${estimate}.
Approve a ${budget} budget (valid 7 days): {authorizationUrl}
I'll continue as soon as you approve.
```

Then, in the same turn, wait for the signature (`fluxa-wallet mandate-status --id <mandateId> --wait 100`, repeated until signed, see [X402-PAYMENT.md](X402-PAYMENT.md)) and run the calls. Do not ask "may I spend?" first: signing the link is the approval. Do not offer several budget options, and do not explain this policy unless the user asks.

After the task, report what was actually spent (sum of the calls made), not the budget.

## Other Payments (transfers, payouts, payment links)

The rule above is for API calls. For a one-off transfer, payout, or payment link with a known amount, request the exact amount, no buffer: the user should see what is being sent. For recurring transfers the user asks for (for example a weekly payout), create one reusable mandate covering the expected period (`--seconds`, e.g. 7 days = 604800, 30 days = 2592000).

## Mandate Reuse Protocol

**MUST check for reusable mandates before creating a new one.**

Check these sources, in order:

### Source 1 — Current Conversation Context

Check if any mandate has already been created or used in the current conversation. If a mandateId is available in context and was recently signed, verify it's still valid before creating a new one.

### Source 2 — The wallet

Run `fluxa-wallet mandates`. It lists every mandate of this agent with limit / spent / remaining, across conversations. Take one that is `signed`, not expired, in the right currency, with enough `remaining`.

### Source 3 — Local State File

Read `~/.fluxa-ai-wallet-mcp/mandates.json` and look for a mandate where:
- `status` is `"signed"`
- `validUntil` is in the future
- `currency` matches the required currency
- `scope` matches the target host/service (if set)

If a match is found, query its latest status via `mandate-status --id <mandateId>` to confirm it's still valid and has sufficient remaining budget. If confirmed → **reuse it**.

If no source has a match → create a new mandate.

## Mandate State Persistence

The agent MUST persist mandate state to `~/.fluxa-ai-wallet-mcp/mandates.json` so that mandates survive across conversations.

**If the file does not exist**, create it with `{"mandates": []}`.

**Schema:**

```json
{
  "mandates": [
    {
      "mandateId": "mand_xxxxxxxxxxxxx",
      "status": "signed",
      "purpose": "Laso auth and card ordering",
      "scope": "laso.finance",
      "taskType": "multi-step",
      "currency": "USDC",
      "limitAmount": "21000000",
      "validUntil": "2026-03-24T00:00:00Z",
      "createdAt": "2026-03-23T10:00:00Z"
    }
  ]
}
```

**Agent responsibilities:**

1. **After `mandate-create`**: Add entry with status `pending_signature`
2. **After user signs** (confirmed via `mandate-status`): Update status to `signed`, populate `validUntil`
3. **On `mandate_expired` or `mandate_budget_exceeded` error**: Update status to `expired` or `exhausted`
4. **On conversation start** (if payment task expected): Read the file and check for reusable mandates
