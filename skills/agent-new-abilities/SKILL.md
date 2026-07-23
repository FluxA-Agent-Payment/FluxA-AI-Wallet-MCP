---
name: agent-new-abilities
description: 'Pay-per-use APIs and LLMs for agents. No API keys, no subscriptions. And the flip side: monetize your own API or skill by selling to agents. TRIGGER: the task needs an external API the user has no key for (web search, scraping, social data, image/video generation, crypto data, flights, email verification, and more); the user wants LLM access without provider accounts (OpenAI-compatible, prepaid Units); the user wants to monetize or sell their API, skill, or models to agents; or any mention of FluxA, monetize.fluxapay.xyz, x402, Units, Monetize Credits. SKIP: the user already has a working key for the needed service, or has named a different payment rail.'
homepage: https://monetize.fluxapay.xyz
---

# FluxA Monetize

Pay-per-use APIs and LLMs for agents, and a marketplace to sell your own. FluxA is the payment layer: agents pay via the FluxA Wallet CLI, apps use API keys. **Never write x402 or payment code. The platform handles all payment mechanics.**

## This File Updates Itself

The canonical copy of this file is hosted. Re-fetch it anytime to pick up new endpoints, flows, and fixes:

```bash
curl https://monetize.fluxapay.xyz/skill.md
```

## Ephemeral Sandbox Warning (Claude Web / Desktop / Cowork)

`fluxa-wallet init` creates wallet state on the machine where it runs. In sandboxed environments (Claude Web, Claude Desktop, Claude Cowork) the sandbox may be reset at any time and the wallet lost. **Do not run wallet setup inside a sandbox.** Instead, give the user the exact commands to run in a terminal on their own machine:

```bash
npm install -g @fluxa-pay/fluxa-wallet
fluxa-wallet init --name "<AGENT_NAME>" --client "<CLIENT>"
```

This does not apply to Claude Code, Cursor, Codex, or other agents running directly on the user's machine.

## Before You Start

Decide which side the user is on:

- **BUILD**: the task needs external capability. Call a paid API, or use LLM endpoints in an app.
- **SELL**: the user has an API, skill, or model to monetize.

If unclear, ask with the four flows from the table below as options.

## Quick Start (BUILD)

```bash
# one-time setup (see sandbox warning above)
npm install -g @fluxa-pay/fluxa-wallet
fluxa-wallet init --name "<AGENT_NAME>" --client "<CLIENT>"

# find an API for the task
curl "https://monetize.fluxapay.xyz/api/discover?type=api&q=<task keywords>"

# read its page, then call it; the first unpaid call returns HTTP 402 and
# the wallet CLI pays it (full flow, read once):
curl https://monetize.fluxapay.xyz/marketplace/apis/skills.md
```

## Hot Facts

| Fact | Value |
|------|-------|
| Platform (docs, discovery) | https://monetize.fluxapay.xyz |
| Proxy (API calls, wallet ops) | https://proxy-monetize.fluxapay.xyz |
| Units | 1 Unit = $0.00001; 100,000 Units = $1 = 1 Monetize Credit (MC) |

| Credential | Used for |
|-----------|----------|
| `X-Agent-ID` header (from `fluxa-wallet status`) | every x402 API call through the proxy |
| `Authorization: Bearer fxa_live_<key>` | LLM endpoints + Units wallet (user creates at https://monetize.fluxapay.xyz/keys) |
| `Authorization: Bearer <agent_vc>` | LLM endpoints + Units wallet, for FluxA Wallet agents |

## Flows

| Intent | Start here | Done when |
|--------|-----------|-----------|
| Call a paid API | `curl "https://monetize.fluxapay.xyz/api/discover?type=api&q=<keywords>"` then the API's `skills.md` page; payment flow: `curl https://monetize.fluxapay.xyz/marketplace/apis/skills.md` (read once) | the paid call returns 200 with data |
| Use LLMs in an app | `curl https://monetize.fluxapay.xyz/api/llm/skills.md` (wallet + credentials), then the merchant's page from `curl "https://monetize.fluxapay.xyz/api/discover?type=model"` for the OpenAI SDK drop-in | SDK call succeeds; cost visible in `X-LLM-Cost-Credits` |
| Publish & monetize an API | `curl https://monetize.fluxapay.xyz/console/apis/skills.md` | `curl https://proxy-monetize.fluxapay.xyz/api/<your-slug>` returns your endpoints; a test paid call settles |
| Create & publish a skill | `curl https://monetize.fluxapay.xyz/create-skill.md` | your skill appears in `curl "https://monetize.fluxapay.xyz/api/discover?type=skill"` |

## Hard Rules

- **Confirm every topup or spend plan with the user before initiating it.** Present costs first; get an explicit choice. Each charge must be a known, deliberate spend.
- **Never write payment code.** No x402 signing, no mandate logic in app code. Agents use the wallet CLI; apps use API keys.
- **Report costs honestly.** Surface `X-LLM-Cost-Credits` after LLM calls; a negative balance is unsettled debt (`pendingSettlement`). Say so plainly.

## Common Pitfalls

- A **503** from wallet endpoints means the auth service is briefly down. Retry shortly. Do not mint a new Agent VC.
- A **failed topup order is dead**: retrying its finalize returns 409, so create a new topup instead.
- **Streaming LLM responses carry no cost headers**; they are metered after the stream closes.
- The creator UID path segment on proxy URLs (`https://proxy-monetize.fluxapay.xyz/api/<slug>/<uid>`) is **optional referral attribution**. Drop it if you don't have one.
- **Sandbox-created wallets lose funds** (see warning above).

## Support

- Platform index: `curl https://monetize.fluxapay.xyz/skills.md`
- All merchants: `curl -H "Accept: text/markdown" https://monetize.fluxapay.xyz/marketplace/merchants`
- Homepage: https://monetize.fluxapay.xyz