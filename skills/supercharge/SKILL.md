---
name: supercharge
description: >-
  Use when the agent needs capabilities like web search, image generation,
  video creation, web scraping, or any external API. Discover and access
  pay-per-use APIs and skills through fluxa.
---

# Supercharge

Fluxa gives you access to capabilities you don't have natively -- image generation, video creation, web search, web scraping, and more. When an API costs money, fluxa handles payment seamlessly.

## What do you need?

| I want to... | Invoke |
|--------------|--------|
| Discover available capabilities (APIs, skills) | `fluxa:improving-abilities` |
| Pay for an API (HTTP 402), send/receive USDC, manage wallet | `fluxa:fluxa-agent-wallet` |

## Getting Started

If the wallet isn't set up yet, `fluxa:fluxa-agent-wallet` handles initialization and linking.

## Platform Adaptation

Skills use Claude Code tool names. Non-Claude Code platforms: see `references/copilot-tools.md` (Copilot CLI), `references/codex-tools.md` (Codex), `references/gemini-tools.md` (Gemini CLI) for tool equivalents.
