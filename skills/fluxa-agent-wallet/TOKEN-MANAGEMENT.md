# Token Usage Management & Auto Top-up

Set up a recurring task to check the user's model usage, analyze spending,
manage API keys by business or function, recommend cost optimizations, and
automatically top up within the user's authorization.
Recommend checking twice daily in the user's timezone.

## 1. Supported Platforms

- **FluxA AgentMarket:** Access AgentMarket model APIs through the FluxA
  Wallet CLI provided by the FluxA Wallet skill.
- **Other platforms:** OpenRouter and other platforms are not yet supported.

This task manages the prepaid AgentMarket Balance, not monthly Token Plans.

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

## 3. Recurring Checks

### Balance and Auto Top-up

- Check the AgentMarket Balance with
  `fluxa-wallet market model remainingUsage`.
- $1 = 1 Balance. The Balance is prepaid model and API spend, not token
  counts or wallet USDC.
- If the balance is below the approved minimum, purchase the configured
  top-up bundle using the user's authorized mandate:
  `fluxa-wallet market model topup --bundle <bundle> --mandate <id>`.
  The payment currency follows the mandate.
- Verify the updated balance and payment result. Resolve any uncertain
  payment status before retrying to avoid duplicate charges.

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
- Read the [AgentMarket Balance Guide](https://agentmarket.fluxapay.xyz/api/llm/skills.md).
  With an Agent VC, query `GET https://router.fluxapay.xyz/llm/keys` for key
  IDs and names, and `GET https://router.fluxapay.xyz/llm/wallet/ledger?kind=spend&limit=100&offset=0`
  for raw usage records. Page through the reporting period using `offset` and
  `total`; group metering entries by `metadata.api_key_id` and `metadata.model`,
  then map key IDs to businesses. Read tokens from `metadata.usage` and the charged
  amount from the metering entry's negative `change` (in Balance, $1 = 1 Balance).
- Keep cache usage separate and do not double-count reasoning tokens already
  included in output tokens. Settlements and adjustments are not new model calls.
  Records without a key ID must remain separately attributed, for example to
  `metadata.agent_id`; mark missing metadata or partial coverage explicitly.
- The CLI's `usageHistory` omits this metadata. Use the raw API for this report.
  Key API fields `spent` and `spendLimit` are in Balance ($1 = 1 Balance).

### Token Usage Optimization

- Assess each business's task type, usage volume, quality requirements, and
  current models. Identify work that a lower-cost model could handle well.
  For example, routine customer support may suit an appropriately capable
  DeepSeek model instead of a more expensive Claude model; verify the specific
  models' capabilities and current prices rather than assuming by brand.
- Check current AgentMarket rates with `fluxa-wallet market search --models`.
  Rates are quoted in dollars per 1M tokens.
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

## 4. Local State

Store user preferences and approved settings in `user_token_mng_rule.md`.
Read it before each run and update it afterward. Configure the scheduled task
with its absolute path so every run uses the same file.

Include the monthly spending estimate, minimum balance, top-up amount,
currency, schedule, mandate details, latest balance, recent usage summaries,
key IDs and business mappings, per-key/model usage baselines, optimization
estimates, and pending payment or approval status. Do not store credentials.
