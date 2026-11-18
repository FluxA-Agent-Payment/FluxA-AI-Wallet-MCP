# TokenGo — Token Provider Account Management

TokenGo helps AI agents manage users' token provider accounts in one place.
It brings together accounts, API keys, balances, usage, costs and management
preferences, so users do not need to track keys across tools, check balances
manually or reconstruct their setup every time an agent session changes.

The AI agent is responsible for setting up provider accounts and API keys,
tracking usage and costs, helping users top up, and maintaining scheduled
balance checks and automatic top-ups within the user's approved rules.
TokenGo supplies persistent memory; the agent performs the work, verifies the
results and records them for the next run. The default setup uses FluxA
AgentMarket. Users can also ask their agent to set up a supported external
provider through its browser console.

Use this capability when the user requests TokenGo or token management.
It is separate from the wallet's own installation and onboarding.

Wallet: https://agentwallet.fluxapay.xyz/?tab=tokengo
API guide: https://tokengo.fluxapay.xyz/llms.txt

## Progressive onboarding

For an explicitly requested external provider, check [Supported providers](#supported-providers)
and follow [Browser setup for external providers](#browser-setup-for-external-providers).
The steps below describe the default AgentMarket workflow.

Initialize an Agent ID if needed, then make `GET /v1/onboarding` the first
TokenGo request, authenticated with that agent's VC. Read `firstVisit` to learn
whether the agent was registered before this request; first access registers
automatically, so `registered: true` alone cannot distinguish a new agent.

- **`firstVisit: true`: onboarding is required.** Introduce TokenGo and guide
  the user through the steps below.
- **`firstVisit: false`: handle the user's request directly.** Read their
  existing records and reuse their configuration. Do not repeat onboarding or
  require them to complete unrelated setup steps.

For a new user, introduce the capability in their language using this example:

> TokenGo helps you manage your token provider accounts in one place. I can help you:
> 1. Set up FluxA AgentMarket accounts.
> 2. Create and manage API keys.
> 3. Top up your balance and track usage and costs.
> 4. Schedule balance checks and automatic top-ups within your chosen rules.
>
> Let's get started.

Proceed one decision at a time, reusing anything the user has already specified:

1. **Link the wallet if needed.** Check `fluxa-wallet status` and
   `fluxa-wallet check-wallet`. If unlinked, send the `link-wallet` URL and
   poll until linked. Continue without asking the user to reply "done".
2. **Use FluxA AgentMarket.** Reuse any existing AgentMarket account. Save
   `provider: "agentmarket"` and `stage: "trial"` for the default setup.
3. **Try the first top-up and key.** Offer "Let's start with a $1 top-up and
   your first API key so you can try it out." Recommend FluxA Card first
   as described below, unless the user has already chosen a payment method.
   Reuse existing accounts, keys and suitable signed
   authorizations. Verify the top-up and first key, save the results in
   TokenGo, and show the user what is ready.
4. **Offer automation after the trial.** Ask whether they want automatic
   balance top-ups. If yes, progressively discuss monthly usage, the balance
   threshold, amount per top-up and check schedule. Obtain any required
   spending authorization, create the actual scheduled task, and record its
   ID and rules in TokenGo. If declined, finish with the usable account/key.

Save completed stages with `PUT /v1/onboarding`. Do not request a monthly
allowance or create recurring tasks before the initial experience.

## TokenGo as Agent Memory

Use TokenGo as the persistent memory for this capability. Read it before
acting to recover accounts, keys, preferences, budgets and earlier results;
write back changes and verified outcomes so future sessions and scheduled runs
can continue with the same context. Keep management rules in TokenGo rather
than local Markdown files. Save AgentMarket keys in their dedicated encrypted
fields as part of configuration, without a separate upload-confirmation step.
For external providers, record account and key metadata and keep the secrets
in the user's local credential store.

Authenticate with your own Agent ID and a request-bound VC; follow the API
guide for the exchange. Stored records provide context, while live provider
balances and wallet authorizations determine what can be done now. Record real
scheduler runs and payment results, and reconcile uncertain payments before
retrying.

## AgentMarket usage notes

AgentMarket supports two top-up payment methods:

- **Card (recommended default):** Reuse a suitable signed `CARD_USD` mandate
  or request `mandate-create --currency CARD_USD` with the merchant flags
  and the budget in cents ($1 = 100). Send its
  approval link directly. The authorization UI guides the user through binding
  a card when needed; do not require a separate card-binding step beforehand.
  After approval, continue through the linked-card checkout flow.
- **USDC (fallback when no usable card):** Run `fluxa-wallet balance` first.
  If the wallet has insufficient USDC on Base, tell the user to deposit stablecoins into their wallet and
  continue after the balance is sufficient. Reuse a suitable signed USDC
  authorization or send a new approval link, then execute the top-up.

`fluxa-wallet market model topup --amount 1` uses the USDC route. Card payments
use the linked-card checkout flow in [LINKED-CARD.md](LINKED-CARD.md); the
AgentMarket order and its attempt id come from
`https://agentmarket.fluxapay.xyz/marketplace/topup.md`, which covers both
routes step by step (a package or any amount from $1 to $1,000). Reuse the
user's chosen method; otherwise recommend Card without asking a payment-method
question. Recommend USDC only when there is no usable card. Do not silently
switch an approved Card workflow to USDC. Verify the resulting AgentMarket
balance and order, then record the completed top-up and API key in TokenGo.
For recurring top-ups, use the approved method, rules and spending limit.
TokenGo settings/budget records use `currency: "USD"` for Card payments and
`"USDC"` for USDC payments; `CARD_USD` is the wallet mandate currency, not a
TokenGo record currency.

## Supported providers

- **Native integration:** FluxA AgentMarket supports the trial, wallet payment,
  API-key management, direct balance/usage sync and authorized scheduled top-ups.
- **Browser setup:** OpenRouter, OpenCode Console (Zen / Go), AiHubMix,
  Fireworks AI, Anthropic API, TypeSafe AI, Runware and Venice. The agent can help with account setup,
  billing and API keys using the provider's console. Card acceptance is checked
  at checkout for the user's card and account.
- **Platform links:** OpenAI API, Google Gemini API and Together AI have
  prepaid-card restrictions. DeepSeek API, GroqCloud and direct Baidu AI Cloud are listed as
  platform links. Baidu Token Plans are available through
  [AgentMarket](TOKENPLAN.md).

## Browser setup for external providers

Run this workflow when the user explicitly names a supported browser provider.
Start with `GET /v1/onboarding` and read `GET /v1/overview`. On first visit,
introduce TokenGo and link the wallet if needed for Prepaid access or to show
records in the wallet. The AgentMarket trial and its onboarding progress
remain separate from the external account.

| Provider (TokenGo ID) | Official console instructions |
| --- | --- |
| OpenRouter (`openrouter`) | [Getting started and credits](https://openrouter.ai/support/), [API keys](https://openrouter.ai/settings/keys) |
| OpenCode Console (`opencode`) | [Console](https://opencode.ai/console), [Pay-as-you-go (Zen)](https://opencode.ai/docs/console/models), [Go subscriptions](https://opencode.ai/docs/console/go/), [Billing](https://opencode.ai/docs/console/billing/), [API keys](https://opencode.ai/docs/console/api/#api-keys) |
| AiHubMix (`aihubmix`) | [Quick start](https://docs.aihubmix.com/en/quick-start), [Payment methods](https://docs.aihubmix.com/en/console/payment-methods) |
| Fireworks AI (`fireworks`) | [Billing](https://docs.fireworks.ai/faq-new/billing-pricing/how-does-billing-and-credit-usage-work), [API key setup](https://docs.fireworks.ai/getting-started/quickstart) |
| Anthropic API (`anthropic`) | [Console](https://platform.claude.com/), [Billing](https://support.claude.com/en/articles/8977456-how-do-i-pay-for-my-claude-api-usage), [Console roles](https://support.claude.com/en/articles/10186004-api-console-roles-and-permissions) |
| TypeSafe AI (`typesafe`) | [Billing](https://help.typesafe.ai/articles/5505198974), [API keys](https://help.typesafe.ai/articles/8310295754-who-can-create-and-manage-api-keys) |
| Runware (`runware`) | [Console](https://my.runware.ai/), [API keys and account roles](https://runware.ai/docs/models-api/account-management) |
| Venice (`venice`) | [API settings](https://venice.ai/settings/api), [API billing and keys](https://learn.venice.ai/guides/getting-started-with-the-venice-api-staking-keys-and-pricing) |

1. **Open the provider console with a browser-use tool.** Use the user's local
   browser profile and reuse an existing provider account when possible.
   If signup is needed, use the email address the user chooses and access
   verification mail only through their authorized mailbox. Hand control to
   the user for CAPTCHA, MFA, SSO consent or other required manual verification.
   Keep passwords, passkeys, recovery codes and session data in the user's local
   password manager or browser profile. Never ask for them in chat or send them
   to TokenGo.
2. **Register the confirmed provider email.** Reuse the matching provider account
   record if it exists. Otherwise create an `accounts` record with the provider
   ID, alias, and `accountInfo: { "email": "user@example.com" }`. This email is
   account metadata. TokenGo ownership still comes from verified wallet claims.
3. **Activate billing in the console if needed.** Inspect the current payment
   options, required initial charge, and any recurring charges. Confirm the
   user's approval for the merchant, amount and any recurring terms before
   submitting a payment or enabling recurring billing. Reuse a suitable
   authorized, active FluxA Prepaid card if available. Otherwise use
   `fluxa-wallet card types` and `card holder me` to select an available,
   reloadable virtual card and complete any required holder verification.
   Follow the Wallet Skill's `card create` / `card recharge` flow with the
   applicable approved funding mandate. These operations fund the card.
   Use the provider's official billing UI to add the card and pay for the
   required credits or activate paid billing. Enter card details only in the
   provider's checkout and handle any 3DS challenge through the card flow.
   Keep card details and verification codes out of logs, chat and TokenGo.
   If the card is rejected or the payment is pending, report the actual state
   and check billing history before attempting another charge. Leave automatic
   reload off unless the user approves it explicitly.
4. **Create the API key in the provider UI.** Reuse an appropriate key if its
   secret is available in the user's local store. Otherwise create a named,
   least-privilege key and save it on the user's device when it is revealed.
   Configure the requested app with a local secret reference, or tell the user
   where to retrieve it. Register key metadata in TokenGo with `accountId`,
   `alias`, `purpose`, `businessType` and `providerKeyId` when available.
   Leave `rawKey` and `integrationKey` unset for this browser workflow.
   Verify billing and key status in the console, and record a confirmed
   provider payment once using its actual receipt or order ID.

External providers use their own console for billing and usage. TokenGo's direct
sync endpoint and the scheduled top-up procedure in
[TOKEN-MANAGEMENT.md](TOKEN-MANAGEMENT.md) apply to AgentMarket.

In OpenCode Console, use the requested workspace for billing and the API key.
For Zen pay-as-you-go, add credits under Settings → Billing. Start a Go
subscription only when requested, after confirming the plan and monthly renewal.
Create a personal key under Account →
Personal API keys and select the same workspace. When configuring the OpenCode
client, use `/connect` with the selected plan and enter the key locally.

## TokenGo API overview

Base URL: `https://tokengo.fluxapay.xyz`

| API | Purpose |
| --- | --- |
| `POST /v1/auth/challenge` | Obtain a request-bound authentication challenge. |
| `GET /v1/onboarding` | Check first registration and onboarding state. |
| `PUT /v1/onboarding` | Save onboarding progress. |
| `GET /v1/overview` | Read accounts, keys, settings, budgets and activity. |
| `POST /v1/records/{kind}` | Add a management record. |
| `PUT /v1/records/{kind}/{id}` | Update a mutable record. |
| `DELETE /v1/records/{kind}/{id}` | Delete a mutable record. |
| `POST /v1/accounts/{id}/sync` | Sync AgentMarket balance and usage. |

Record kinds: `accounts`, `keys`, `settings`, `budgets`, `spending`, `monitors`,
`checkins`. Spending and checkins are append-only. See the API guide for fields.
