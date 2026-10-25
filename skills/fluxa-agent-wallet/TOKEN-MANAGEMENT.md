# Token Usage Management & Auto Top-up

Set up a recurring task to check the user's model usage, analyze spending,
monitor the balance, and automatically top up within the user's authorization.
Recommend checking twice daily in the user's timezone.

## 1. Supported Platforms

- **FluxA AgentMarket:** Access AgentMarket model APIs through the FluxA
  Wallet CLI provided by the FluxA Wallet skill.
- **Other platforms:** OpenRouter and other platforms are not yet supported.

This task manages prepaid model Units, not monthly Token Plans.

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
- Notify the user about top-ups, anomalies, failures, or required approvals.
  Stay quiet when nothing meaningful has changed.

## 4. Local State

Store user preferences and approved settings in `user_token_mng_rule.md`.
Read it before each run and update it afterward. Configure the scheduled task
with its absolute path so every run uses the same file.

Include the monthly spending estimate, minimum balance, top-up amount,
currency, schedule, mandate details, latest balance, recent usage summaries,
and pending payment or approval status. Do not store credentials.
