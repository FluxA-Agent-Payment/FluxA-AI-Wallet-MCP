# Overview

Two ways to find x402 resources you can pay for with `fluxa-wallet`:

1. The FluxA Monetize catalog (verified first-party APIs/skills plus a curated external x402 set) through one discovery endpoint.
2. The FluxA Monetize Models catalog (LLMs) with named models and per-token pricing.

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
curl "https://monetize.fluxapay.xyz/api/discover?type=api,skill,model"
```

- Fuzzy search: `?search=<keywords>` (matches name, description, tags).
- Exact lookup: `?query=<slug|tag|provider>`.
- Filter by kind: `?type=api`, `?type=skill`, `?type=model` (comma-combine to mix).
- Each result carries `source: fluxa` (verified) or `source: bazaar` (curated external x402). Verified are listed first.

To use an **API** result, call its endpoint. The first unpaid call returns HTTP 402; settle it with `fluxa-wallet` and retry. See [X402-PAYMENT.md](X402-PAYMENT.md).

To use a **skill** result, install it directly:

```bash
npx -y skills add https://monetize.fluxapay.xyz -s <slug>
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

# 2. FluxA Monetize Models (LLMs)

First-party LLM catalog published by FluxA Monetize. Use this when you need to **call an LLM/AI model** (Claude, GPT, Gemini, DeepSeek, Kimi, GLM, MiniMax, ERNIE, etc.) through the wallet with **named models and per-token pricing** — instead of an opaque per-call x402 endpoint from the Bazaar.

## Discover Models

```bash
curl "https://monetize.fluxapay.xyz/api/discover?type=model"
```

Returns a `models[]` array. Each entry:

| Field | Meaning |
|-------|---------|
| `provider` | Merchant that serves the model (e.g. `unify-llm`, `baidu-ai-cloud`) |
| `id` | Model ID to pass as `"model"` (e.g. `anthropic/claude-opus-4.6`, `openai/gpt-5.5`, `deepseek-v4-flash`) |
| `displayName` | Human-readable name |
| `categories` | `text`, `thinking` |
| `inputUnitsPer1M` / `outputUnitsPer1M` | Price in **Units per 1M tokens** |
| `urls.merchantGuide` | Per-provider integration guide (`.../models/<provider>/skills.md`) |

`unify-llm` is the unified endpoint fronting all major models (Claude, GPT, Gemini, DeepSeek, MiniMax, and more).

## Pricing Units

Model pricing is denominated in **Units** (a.k.a. FLUXA_MONETIZE_CREDITS), **not** raw USDC:

- `1 Unit = $0.00001` → `100,000 Units = $1`
- Example: Claude Sonnet 4.6 at `300,000` input / `1,500,000` output Units per 1M tokens = **$3 in / $15 out** per 1M tokens.

## Calling a Model (UnifyLLM)

OpenAI Chat Completions wire format — drop-in for any OpenAI client, just swap the `baseURL`.

**Base URL:** `https://proxy-monetize.fluxapay.xyz/llm/unify-llm/v1`

```bash
curl -X POST https://proxy-monetize.fluxapay.xyz/llm/unify-llm/v1/chat/completions \
  -H "Authorization: Bearer <credential>" \
  -H "Content-Type: application/json" \
  -d '{"model":"anthropic/claude-sonnet-4.6","messages":[{"role":"user","content":"..."}]}'
```

- `<credential>` = an `fxa_live_` key (mint one with `fluxa-wallet market keys create`), or an **Agent VC** for agents (see [VC-ISSUE.md](VC-ISSUE.md)).
- Non-streaming responses return `X-LLM-Cost-Credits` (Units charged) and `X-LLM-Balance` (Units remaining) headers. Streaming calls are metered after the stream closes (no headers).

## Billing Model (prepaid Units, not per-call x402)

Unlike a Bazaar endpoint (one x402 signature per call), UnifyLLM meters against a **prepaid Units balance**. Calls succeed until unsettled debt crosses a threshold, at which point the **next call returns HTTP 402** — then settle or top up.

```bash
# Balance
fluxa-wallet market model remainingUsage <vendor>

# Spending history
fluxa-wallet market model usageHistory <vendor>

# Top up (ONLY after explicit user confirmation)
fluxa-wallet market model topup <vendor>
```

Optionally scope the amount with `--bundle <slug>` or `--credits <N>`. **Always confirm a top-up with the user first.**

Full credential setup, operations, top-up protocol, and error handling:

```bash
curl https://monetize.fluxapay.xyz/api/llm/skills.md
```
