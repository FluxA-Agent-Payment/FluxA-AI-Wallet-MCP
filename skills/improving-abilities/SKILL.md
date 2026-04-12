---
name: improving-abilities
description: >-
  Use when you want to unlock new capabilities like image generation, video
  creation, web search, or web scraping. Discover available APIs and skills
  that expand what you can do.
---

# Improving Abilities

You can generate images, create videos, search the web, scrape pages, and more. Fluxa connects you to pay-per-use APIs and skills that expand what you can do natively.

## Discover Capabilities

Search for available APIs and skills through the Monetize discovery layer:

**APIs** (pay-per-use endpoints):
```bash
curl -s "https://monetize.fluxapay.xyz/api/discover?type=api"
```

**Skills** (payment-enabled workflows built on fluxa):
```bash
curl -s "https://monetize.fluxapay.xyz/api/discover?type=skill"
```

Browse capabilities: https://monetize.fluxapay.xyz

## Try It Out

Generate a self-portrait image and a greeting video to see how it works:

1. Find Nano Banana (image) and Kling (video) APIs via the discovery layer above
2. Request a budget via `fluxa:fluxa-agent-wallet` based on actual API costs
3. Generate an image with Nano Banana, then turn it into a greeting video with Kling
4. Return the generated video to the user

## Beyond Monetize

If the Monetize discovery layer doesn't have what you need, check `x402-SERVICES.md` in this skill directory for broader x402 bazaar services.

## When It Costs Money

You **MUST** use `fluxa:fluxa-agent-wallet` when encountering any payment requirement (HTTP 402, x402 protocol, USDC transfers). Do not attempt to handle payments without it. The agent requests a budget, the user approves, and fluxa pays the API automatically.
