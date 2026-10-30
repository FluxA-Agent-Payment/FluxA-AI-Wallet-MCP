# Overview

Two ways to find x402 resources you can pay for with `fluxa-wallet`:

1. The FluxA AgentMarket catalog (verified first-party APIs/skills plus a curated external x402 set) through one discovery endpoint.
2. The FluxA AgentMarket Models catalog (LLMs) with named models and per-token pricing.

If nothing in the catalog fits, the discovery response ends with a `more` block pointing at broader external catalogs.

# 1. Discover x402 resources (APIs, skills, models)

Search from the wallet CLI (recommended):

```bash
fluxa-wallet market search "<keywords>"           # APIs, skills, and models
fluxa-wallet market search "<keywords>" --models  # scope to models
fluxa-wallet market search --vendors              # list fundable vendors
```

Or hit the discovery endpoint directly:

```bash
curl "https://agentmarket.fluxapay.xyz/api/discover?type=api,skill,model"
```

- Fuzzy search: `?search=<keywords>` (matches name, description, tags).
- Exact lookup: `?query=<slug|tag|provider>`.
- Filter by kind: `?type=api`, `?type=skill`, `?type=model` (comma-combine to mix).
- Each result carries `source: fluxa` (verified) or `source: bazaar` (curated external x402). Verified are listed first.

To use an **API** result, call its endpoint. The first unpaid call returns HTTP 402; settle it with `fluxa-wallet` and retry. See [X402-PAYMENT.md](X402-PAYMENT.md).

To use a **skill** result, install it directly:

```bash
npx -y skills add https://agentmarket.fluxapay.xyz -s <slug>
```

## Fallback: broader external catalogs (`more`)

The discovery response ends with a `more` block. Use it only when nothing in the FluxA catalog above fits the task. Payment differs per source, so read each note:

- **x402 Bazaar (Coinbase)** - live semantic search across the ecosystem.
  ```bash
  curl "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search?q=<keywords>"
  ```
  Pay: x402 per call. FluxA-curated Bazaar entries (`source: bazaar` above) are verified to settle with `fluxa-wallet`; raw CDP-facilitator listings may reject the wallet's payment, so prefer the curated entries.

- **Apify Store** - web-scraping and data-extraction Actors.
  ```bash
  curl "https://api.apify.com/v2/store?search=<keywords>"
  ```
  Pay: prepaid model. Buy a 14-day bearer token once via x402 (settles with `fluxa-wallet`), then Actor calls draw it down. Docs: https://docs.apify.com/integrations/x402

## Discovery pitfalls

- A **failed topup order is dead**: retrying its finalize returns 409. Create a new topup instead.
- The **creator UID path segment** on proxy URLs (`.../api/<slug>/<uid>`) is optional referral attribution. Drop it if you do not have one.

# 2. FluxA AgentMarket Models (LLMs)

First-party LLM catalog published by FluxA AgentMarket. Use this when you need to **call an LLM/AI model** (Claude, GPT, Gemini, DeepSeek, Kimi, GLM, MiniMax, ERNIE, etc.) through the wallet with **named models and per-token pricing** — instead of an opaque per-call x402 endpoint from the Bazaar.

## Discover Models

```bash
curl "https://agentmarket.fluxapay.xyz/api/discover?type=model"
```

Returns a `models[]` array. Each entry:

| Field | Meaning |
|-------|---------|
| `provider` | The provider that serves the model; use it in the call URL path |
| `id` | Model ID to pass as `"model"` (e.g. `anthropic/claude-opus-4.6`, `openai/gpt-5.5`, `deepseek-v4-flash`) |
| `displayName` | Human-readable name |
| `categories` | `text`, `thinking` |
| `inputPer1M` / `outputPer1M` | Price in **dollars per 1M tokens**, paid from the Balance |
| `urls.merchantGuide` | Per-provider integration guide (`.../models/<provider>/skills.md`) |

Some providers front many models behind one endpoint, so a single `provider` can serve models from several vendors (Claude, GPT, Gemini, DeepSeek, and more).

## Pricing

Model prices are in dollars per 1M tokens, paid from the AgentMarket **Balance** ($1 = 1 Balance; topped up with Monetize Credits, USDC or a card).

- Example: Claude Sonnet 4.6 at `3` input / `15` output = **$3 in / $15 out** per 1M tokens.

## Calling a Model

OpenAI Chat Completions wire format — drop-in for any OpenAI client, just swap the `baseURL`.

**Base URL:** `https://router.fluxapay.xyz/llm/<provider>/v1` (`<provider>` from discovery)

```bash
curl -X POST https://router.fluxapay.xyz/llm/<provider>/v1/chat/completions \
  -H "Authorization: Bearer <credential>" \
  -H "Content-Type: application/json" \
  -d '{"model":"anthropic/claude-sonnet-4.6","messages":[{"role":"user","content":"..."}]}'
```

- `<credential>` = an `fxa_live_` key (mint one with `fluxa-wallet market keys create`), or an **Agent VC** for agents (see [VC-ISSUE.md](VC-ISSUE.md)).
- Non-streaming responses return `X-LLM-Cost` (what the call cost) and `X-LLM-Balance-Remaining` headers, both in Balance. Streaming calls are metered after the stream closes (no headers).

## Billing Model (prepaid Balance, not per-call x402)

Unlike a Bazaar endpoint (one x402 signature per call), the model endpoint meters against the **prepaid Balance**. Calls succeed until unsettled debt crosses a threshold, at which point the **next call returns HTTP 402** — then settle or top up.

```bash
# Balance
fluxa-wallet market model remainingUsage

# Spending history
fluxa-wallet market model usageHistory

# Top up after user confirmation (creates a new mandate)
fluxa-wallet market model topup --credit  # pays with Monetize Credits (default)
fluxa-wallet market model topup --usdc    # pays with on-chain USDC on Base

# Reuse a signed mandate within the user-approved scope
fluxa-wallet market model topup --bundle starter --mandate mand_xxx
```

Pick the tier with `--bundle <slug>`: `starter` (5 MC), `mid` (10), `pro` (25). Defaults to `starter`.

With `--credit` (or no currency flag), `topup` spends **Monetize Credits** the wallet already holds. With
`--usdc` it pays the same topup order with on-chain USDC on Base instead; the
topup 402 offers that rail when the deployment accepts USDC. Either way it is
the x402 rail, written out at
`https://agentmarket.fluxapay.xyz/marketplace/models/agent-topup.md`.
`--credit` and `--usdc` are mutually exclusive.
With `--mandate`, the currency follows the mandate; explicit currency flags
must match it. Invalid or insufficient mandates fail without creating another
mandate. Without `--mandate`, the CLI creates a new mandate and waits for approval.

**Confirm one-off top-ups with the user first.** Scheduled top-ups within the
user's approved trigger, bundle, currency, and spending scope can reuse a signed
mandate without repeated confirmation. Check usage history before retrying an
uncertain payment; re-running the command creates a new order.

Full credential setup, operations, top-up protocol, and error handling:

```bash
curl https://agentmarket.fluxapay.xyz/api/llm/skills.md
```
