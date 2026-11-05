# TokenGo — Token Provider Account Management

TokenGo helps AI agents manage users' token provider accounts in one place.
It brings together accounts, API keys, balances, usage, costs and management
preferences, so users do not need to track keys across tools, check balances
manually or reconstruct their setup every time an agent session changes.

The AI agent is responsible for setting up provider accounts and API keys,
tracking usage and costs, helping users top up, and maintaining scheduled
balance checks and automatic top-ups within the user's approved rules.
TokenGo supplies persistent memory; the agent performs the work, verifies the
results and records them for the next run. AgentMarket is supported now;
OpenRouter is not supported yet; support is planned for the next version.

Use this capability when the user requests TokenGo or token management.
It is separate from the wallet's own installation and onboarding.

Wallet: https://agentwallet.fluxapay.xyz/?tab=tokengo
API guide: https://tokengo.fluxapay.xyz/llms.txt

## Supported providers

**Only FluxA AgentMarket is supported for TokenGo management in this version.**
OpenRouter, Baidu AI Cloud, AiHubMix and other providers are not supported yet.
This applies to the entire management workflow, not just direct usage sync.

If the user asks to manage an unsupported provider, reply with:

> 暂时无法替你在这些平台进行管理，需要等待tokengo服务和skill更新。

English equivalent: "I cannot manage these platforms for you yet. Please wait
for updates to the TokenGo service and Skill."

Then stop that provider's workflow. Do not offer official-API, browser,
manual-recording or user-self-payment workarounds. Do not describe its signup,
keys, prices or top-up procedures, request credentials, register its accounts,
set it as the selected onboarding provider, or create budgets or schedules.
A previous unsupported-provider selection or record does not enable support.
Continue with AgentMarket only if the user chooses it.

## Progressive onboarding

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
2. **Choose a provider.** Ask "Which provider would you like to start with:
   FluxA AgentMarket or OpenRouter (not supported yet; coming in the next version)?"
   If the user chooses an unsupported provider, use the response above and
   stop. Do not save it as the selected provider or advance its onboarding.
3. **Try the first top-up and key.** Offer "Let's start with a $1 top-up and
   your first API key so you can try it out." Use the chosen payment method
   as described below. Reuse existing accounts, keys and suitable signed
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
than local Markdown files. Save provider keys in the dedicated encrypted
fields as part of configuration, without a separate upload-confirmation step.

Authenticate with your own Agent ID and a request-bound VC; follow the API
guide for the exchange. Stored records provide context, while live provider
balances and wallet authorizations determine what can be done now. Record real
scheduler runs and payment results, and reconcile uncertain payments before
retrying.

## AgentMarket usage notes

AgentMarket supports two top-up payment methods:

- **Card:** Request the appropriate card spending authorization and send its
  approval link directly. The authorization UI guides the user through binding
  a card when needed; do not require a separate card-binding step beforehand.
  After approval, continue through the linked-card checkout flow.
- **USDC:** Run `fluxa-wallet balance` first. If the wallet has insufficient
  USDC on Base, tell the user to deposit stablecoins into their wallet and
  continue after the balance is sufficient. Reuse a suitable signed USDC
  authorization or send a new approval link, then execute the top-up.

`fluxa-wallet market model topup --amount 1` uses the USDC route. Card payments
use the linked-card checkout flow. Reuse the user's chosen method; ask which
method they prefer only when it is missing. Verify the resulting AgentMarket
balance and order, then record the completed top-up and API key in TokenGo.
For recurring top-ups, use the approved method, rules and spending limit.

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
