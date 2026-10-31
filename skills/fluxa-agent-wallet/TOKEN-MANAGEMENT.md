# Token Usage Management & Auto Top-up

Set up a recurring task to check the user's model usage, analyze spending,
manage API keys by business or function, recommend cost optimizations, and
automatically top up within the user's authorization.
Recommend checking twice daily in the user's timezone.

## 1. Supported Platforms

- **FluxA AgentMarket:** Access AgentMarket model APIs through the FluxA
  Wallet CLI provided by the FluxA Wallet skill.
- **Other platforms:** OpenRouter and other platforms are not yet supported.

This task manages prepaid model Units, not monthly Token Plans. For Baidu AI
Cloud Token Plans through AgentMarket, use [TOKENPLAN.md](TOKENPLAN.md); track
allowance and expiry separately, and do not apply prepaid-balance top-ups or
claim automatic plan renewal. TokenGo can record either product; its initial
direct usage sync supports AgentMarket prepaid balance only.

## 2. First Run

1. Install or update the FluxA Wallet skill and CLI to the latest version:
   https://fluxapay.xyz/skill.md

2. Ask about expected monthly model spending in USD, such as $10 or $100.
   If the user is unsure, recommend starting with $20 per month and adjusting
   the estimate automatically based on actual usage.

3. Confirm the user's management preferences. Recommend automatically
   topping up $5 when the balance falls below $10. For higher monthly usage,
   suggest a suitable minimum balance and top-up amount based on expected
   daily spending and available top-up bundles.

4. Obtain approval for the auto-top-up settings before enabling payments.
   Payments within those settings and a signed mandate do not require
   confirmation on every run.

5. Recommend a separate AgentMarket API key for each business or function,
   named clearly, such as `customer-support` or `document-extraction`.
   Review `fluxa-wallet market keys list` first; reuse suitable keys or help
   the user create one with `fluxa-wallet market keys create --name <name>`.
   Record each key ID's purpose and confirm that the corresponding application
   uses that key so its usage can be attributed correctly. Store the raw key
   securely, never in the task's Markdown state or reports.

If the handoff specifies an initial recharge, verify the requested amount against
current provider bundles, obtain the required rule confirmation and signed mandate,
then perform and verify that first payment before recurring top-ups. TokenGo's
form defaults the initial amount to USD 10; the user's actual input takes precedence.
Record the first completed recharge with trigger=initial and scheduled recharges
with trigger=automatic, using stable payment/order IDs. Keep budget purpose,
initial amount, recharge threshold and recurring amount with the budget record.

### Optional TokenGo memory

Before uploading anything, honor the user's storage choice: local-only or
TokenGo. Local-only workflows need no TokenGo connection. If the user chooses
TokenGo, follow [TOKENGO.md](TOKENGO.md): access directly using this agent's Agent ID / Agent VC (first access automatically
opens an account; no connection code), then register accounts, business Key metadata,
and the signed mandate reference and total allowance. Raw keys and provider
query credentials are separately opt-in; keep credentials out of account JSON.

Create the actual scheduler in the agent runtime first. Only then register its
scheduler ID, interval, timezone and approved rules in TokenGo. Registration
does not create a schedule. If scheduling is unavailable, explain that monitoring
is not running instead of marking it active.

## 3. Recurring Checks

### Balance and Auto Top-up

- Check the AgentMarket Units balance with
  `fluxa-wallet market model remainingUsage`.
- Convert Units into USD using the current official conversion rate.
  Units are model consumption credits, not token counts or wallet USDC.
- If the balance is below the approved minimum, purchase the configured
  top-up bundle using the user's authorized mandate:
  `fluxa-wallet market model topup --bundle <bundle> --mandate <id>`.
  The payment currency follows the mandate.
- Verify the updated balance and payment result. Resolve any uncertain
  payment status before retrying to avoid duplicate charges.

### TokenGo checkin (when connected)

Read TokenGo records together with local state, and query live provider/wallet
state before payments. With a user-approved integration Key, TokenGo can directly
sync AgentMarket balances and recent per-Key/model usage; respect timestamps and
partial-coverage flags. Record each scheduler run with a stable run ID, actual
balance/status and errors. Record purchases/top-ups with their stable payment or
order ID once, and keep those distinct from model-usage costs. Update mandate
references when authorization changes; stored budget metadata is not proof of
remaining wallet allowance. Do not let a TokenGo outage trigger another payment.

### Mandate Availability

- Check for an existing valid mandate using `fluxa-wallet mandates`.
- If none is available, request a USDC mandate covering one month of
  estimated model spending, valid for three months.
- Explain that mandate approval does not itself deduct funds; it authorizes
  future payments up to the approved amount. This allowance does not reset
  monthly.
- If the remaining allowance covers fewer than three configured top-ups,
  ask the user to approve a new mandate. Reuse any pending approval request.
- Do not increase payment limits or change payment currency without approval.

### Usage Analysis

- Review `fluxa-wallet market model usageHistory` and compare consumption
  with the previous check and historical usage.
- Account for different check intervals and exclude top-ups from consumption.
- Flag unusual spending, explain available usage trends, and recommend
  adjustments when needed. Updating the monthly estimate does not
  automatically increase spending authorization.

### API Key and Business Usage Report

- Review named keys and report usage since the last check by business or
  function: key name, models used, input/output token counts, and USD cost.
  Break out each model when a business uses more than one.
- Read the [AgentMarket Units Wallet Guide](https://agentmarket.fluxapay.xyz/api/llm/skills.md).
  With an Agent VC, query `GET https://router.fluxapay.xyz/llm/keys` for key
  IDs and names, and `GET https://router.fluxapay.xyz/llm/wallet/ledger?kind=spend&limit=100&offset=0`
  for raw usage records. Page through the reporting period using `offset` and
  `total`; group metering entries by `metadata.api_key_id` and `metadata.model`,
  then map key IDs to businesses. Read tokens from `metadata.usage` and charged
  Units from the metering entry's negative `amount` or `metadata.cost_breakdown.cost_credits`.
- Keep cache usage separate and do not double-count reasoning tokens already
  included in output tokens. Settlements and adjustments are not new model calls.
  Records without a key ID must remain separately attributed, for example to
  `metadata.agent_id`; mark missing metadata or partial coverage explicitly.
- The CLI's `usageHistory` omits this metadata. Use the raw API for this report.
  Despite their names, key API fields `spentCredits` and `spendCapCredits` are
  Units, not MC; convert them using the official Units-to-USD rate.

### Token Usage Optimization

- Assess each business's task type, usage volume, quality requirements, and
  current models. Identify work that a lower-cost model could handle well.
  For example, routine customer support may suit an appropriately capable
  DeepSeek model instead of a more expensive Claude model; verify the specific
  models' capabilities and current prices rather than assuming by brand.
- Check current AgentMarket rates with `fluxa-wallet market search --models`.
  Convert the quoted Units rates into USD using the current conversion rate.
  For each recommendation, compare costs for the same observed workload:
  `estimated cost = input tokens / 1M × input USD rate + output tokens / 1M × output USD rate`.
  Account for caching and other billed usage when available. Show current cost,
  estimated alternative cost, savings in USD and percent, and a monthly
  projection based on the observed usage rate. State the period and assumptions;
  if token mix or prices are missing, explain what is needed for a reliable estimate.
- Recommend a small quality evaluation before switching. Cost estimates assume
  comparable workload and output quality; retries or longer outputs may reduce
  savings. Suggest model changes to the user; do not switch applications automatically.

Include the business usage report and actionable optimization suggestions in
check-in updates, together with top-ups, anomalies, failures, or required approvals.
Stay quiet when there is no new usage or other meaningful change.

## 4. Persistent State

Store user preferences and approved settings in `user_token_mng_rule.md`.
Read it before each run and update it afterward. For TokenGo users, also keep
the service URL and nonsecret record IDs here; reconcile remote records after
each run. Do not store VCs in recurring task state. Configure the scheduled task
with its absolute path so every run uses the same file.

Include the monthly spending estimate, minimum balance, top-up amount,
currency, schedule, mandate details, latest balance, recent usage summaries,
key IDs and business mappings, per-key/model usage baselines, optimization
estimates, and pending payment or approval status. Do not store credentials.
