# Token Usage Management & Auto Top-up

Use only when the user explicitly requests TokenGo or token management. Do not
start this flow during wallet installation, onboarding or capability introductions.

Set up a recurring task to check the user's model usage, analyze spending,
manage API keys by business or function, recommend cost optimizations, and
automatically top up within the user's authorization.
Recommend checking twice daily in the user's timezone.

## 1. Platforms and onboarding

- **FluxA AgentMarket:** Wallet CLI account access, API keys, $1 initial trial,
  balance/usage sync and authorized top-ups.
- **OpenRouter:** Official account/keys/credits flow. Verify current minimums
  and supported checkout; AgentMarket top-up commands do not fund OpenRouter.

Start with [TOKENGO.md](TOKENGO.md). Check persisted onboarding first, explain
TokenGo's four capabilities on the first visit, link the wallet, let the user
choose a platform, and complete one small recharge and first API key. Only
then offer recurring top-ups and discuss a monthly estimate and schedule.
Do not start by requesting a monthly allowance or configuring scheduled tasks.
Use the user's existing choices and resume completed stages.

TokenGo stores all management records and encrypted provider/key credentials.
Saving them is part of setup and needs no separate upload confirmation.
Use settings records for preferences before a signed mandate exists. The first
AgentMarket recharge defaults to $1; update the Wallet CLI to the latest version
and use `fluxa-wallet market model topup --amount 1`. Reuse a suitable signed
mandate or send a trial-sized authorization link directly and wait for signing.
No extra "may I?" step is needed before the authorization link.

This task manages prepaid balances. For Baidu Token Plans through AgentMarket,
read [TOKENPLAN.md](TOKENPLAN.md); track allowance and expiry separately, and do
not treat a plan as prepaid Balance or claim automatic renewal.

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

### TokenGo checkin

Read TokenGo records and query live provider/wallet
state before payments. With the configured integration key, TokenGo can directly
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

## 4. Persistent State

TokenGo is the only persistent management store. Read /v1/onboarding and
/v1/overview before continuing; write preferences, rules and nonsecret run state
to records/settings. Store provider accounts and encrypted keys in their
dedicated account/key fields, signed authorization references in budgets,
verified payments in spending, and real runs in monitors/checkins.

Include monthly spending estimates, threshold/top-up amounts, currency/timezone,
key IDs and use cases, usage baselines, optimization estimates and pending
payment/approval IDs in settings. Never store credentials in settings or notes.
Scheduler instructions should identify the TokenGo service and record IDs and
read fresh state on every run. No local Markdown rule file is needed.
If the service is unavailable, resume and reconcile before another payment.
