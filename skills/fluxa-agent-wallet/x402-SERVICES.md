# Overview

There are three sources for searching x402 resource

# 1. Searching FluxA Oneshot API

Public x402 services published by FluxA Monetize product.

https://monetize.fluxapay.xyz/api/discover?type=api

# 2. Searching the x402 Bazaar

Use the `npx awal@2.0.3 x402` commands to discover and inspect paid API endpoints available on the x402 bazaar marketplace. No authentication or balance is required for searching.

## Commands

### Search the Bazaar

Find paid services by keyword using BM25 relevance search:

```bash
npx awal@2.0.3 x402 bazaar search <query> [-k <n>] [--force-refresh] [--json]
```

| Option            | Description                          |
| ----------------- | ------------------------------------ |
| `-k, --top <n>`   | Number of results (default: 5)       |
| `--force-refresh` | Re-fetch resource index from CDP API |
| `--json`          | Output as JSON                       |

Results are cached locally at `~/.config/awal/bazaar/` and auto-refresh after 12 hours.

### List Bazaar Resources

Browse all available resources:

```bash
npx awal@2.0.3 x402 bazaar list [--network <network>] [--full] [--json]
```

| Option             | Description                             |
| ------------------ | --------------------------------------- |
| `--network <name>` | Filter by network (base, base-sepolia)  |
| `--full`           | Show complete details including schemas |
| `--json`           | Output as JSON                          |

### Discover Payment Requirements

Inspect an endpoint's x402 payment requirements without paying:

```bash
npx awal@2.0.3 x402 details <url> [--json]
```

Auto-detects the correct HTTP method (GET, POST, PUT, DELETE, PATCH) by trying each until it gets a 402 response, then displays price, accepted payment schemes, network, and input/output schemas.

## Examples

```bash
# Search for weather-related paid APIs
npx awal@2.0.3 x402 bazaar search "weather"

# Search with more results
npx awal@2.0.3 x402 bazaar search "sentiment analysis" -k 10

# Browse all bazaar resources with full details
npx awal@2.0.3 x402 bazaar list --full

# Check what an endpoint costs
npx awal@2.0.3 x402 details https://example.com/api/weather
```

## Prerequisites

- No authentication needed for search, list, or details commands

## Next Steps

Once you've found a service you want to use, use the `pay-for-service` skill to make a paid request to the endpoint.

## Error Handling

- "CDP API returned 429" - Rate limited; cached data will be used if available
- "No X402 payment requirements found" - URL may not be an x402 endpoint

# 3. Searching FluxA Monetize Models (LLMs)

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

- `<credential>` = a human key `fxa_live_...`, or an **Agent VC** for agents (see [VC-ISSUE.md](VC-ISSUE.md)).
- Non-streaming responses return `X-LLM-Cost-Credits` (Units charged) and `X-LLM-Balance` (Units remaining) headers. Streaming calls are metered after the stream closes (no headers).

## Billing Model (prepaid Units, not per-call x402)

Unlike a Bazaar endpoint (one x402 signature per call), UnifyLLM meters against a **prepaid Units balance**. Calls succeed until unsettled debt crosses a threshold, at which point the **next call returns HTTP 402** — then settle or top up.

```bash
# Balance
curl -H "Authorization: Bearer <credential>" \
  https://proxy-monetize.fluxapay.xyz/llm/wallet/balances/unify-llm

# Spending history
curl -H "Authorization: Bearer <credential>" \
  "https://proxy-monetize.fluxapay.xyz/llm/wallet/ledger/unify-llm?kind=spend&limit=20"

# Top up (ONLY after explicit user confirmation)
curl -X POST -H "Authorization: Bearer <credential>" -H "Content-Type: application/json" \
  -d '{"vendorSlug":"unify-llm","packageSlug":"<bundle-slug>"}' \
  https://proxy-monetize.fluxapay.xyz/llm/topup/initiate
```

Top-up bundles: `starter` (5 MC / $5 → 500,000 Units), `mid` ($10 → 1,000,000), `pro` ($25 → 2,500,000). **Always confirm a top-up with the user first.**

Full credential setup, operations, top-up protocol, and error handling:

```bash
curl https://monetize.fluxapay.xyz/api/llm/skills.md
```
