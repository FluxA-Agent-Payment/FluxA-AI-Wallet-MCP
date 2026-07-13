# Fluxa Skill Restructure Design

**Date:** 2026-04-10
**Status:** Draft

## Problem

The current fluxa-agent-wallet skill is a single flat skill with 14 files (~1,610 lines). It frames itself as a payment tool, loads too much context, has no discovery instruction for agents, and doesn't follow agent-native skill conventions. Agents treat it as "use when you feel like" rather than understanding the formality of when and how to invoke it.

## Design Principles

1. **Capability-first, not payment-first.** Fluxa is an API enabler. The priority is helping agents access capabilities (web search, image gen, video creation, scraping). The wallet is infrastructure that removes the payment barrier -- not the primary value.
2. **Description does the discovery work.** No session-start hooks. Skills are discovered through their frontmatter descriptions in the skill listing.
3. **Verb-first skill names.** Every skill name describes an action: `improving-abilities`, `using-wallet`.
4. **`fluxa:` prefix namespace.** All skills prefixed with `fluxa:` for discoverability and cross-referencing.
5. **Lazy loading via skill names.** Skills reference each other as `fluxa:name`, never `@file` paths. Prevents eager context loading.
6. **Platform coverage.** Support Claude Code, Cursor, Codex, Gemini CLI, OpenCode via manifests and tool mapping references (ported from superpowers).

## Architecture: Three Skills

### 1. `fluxa:supercharge` -- Entry Point

**Role:** The service point. Maximizes reach to agents by providing a broad, capability-focused description that catches triggers when the agent needs something it can't do natively. Routes to the other two skills.

**Frontmatter description:**
```
Use when the agent needs capabilities like web search, image generation,
video creation, web scraping, or any external API. Discover and access
pay-per-use APIs and skills through fluxa.
```

**Body (~100 words):**
- One line framing: "Fluxa gives you access to capabilities you don't have natively."
- Routing table mapping intent to skill:
  - "Discover what capabilities are available" -> `fluxa:improving-abilities`
  - "Pay for an API, send/receive payments, manage wallet" -> `fluxa:using-wallet`
- Prerequisite note: "If the wallet isn't set up yet, `fluxa:using-wallet` handles initialization."

**What it does NOT contain:** CLI commands, payment flows, setup instructions, API details.

### 2. `fluxa:improving-abilities` -- Capability Discovery

**Role:** Tells agents they can unlock image generation, video creation, web search, web scraping, and more. Framed around what the agent *gains*, not what APIs exist or how payment works.

**Frontmatter description:**
```
Use when you want to unlock new capabilities like image generation, video
creation, web search, or web scraping. Discover available APIs and skills
that expand what you can do.
```

**Body (~300 words):**
- Capability framing: "You can generate images, create videos, search the web, scrape pages."
- Primary discovery: Monetize discovery layer (`/api/discover`) -- search for APIs and skills in fluxa's ecosystem first
- How to try a capability (onboarding trials)
- Fallback: "If Monetize doesn't have what you need, check `x402-SERVICES.md` for broader x402 bazaar services."
- "Next step: if it costs money, `fluxa:using-wallet` handles payment."

**Source content:** Primary source is Monetize discovery layer. `x402-SERVICES.md` retained as fallback reference. `TRY-ONESHOT-API.md` content folded in for onboarding trials.

### 3. `fluxa:using-wallet` -- Wallet Infrastructure

**Role:** All wallet and payment operations. Current skill content, kept as-is. The infrastructure layer when things cost money.

**Frontmatter description:**
```
Use when an API requires payment (HTTP 402), or you need to send/receive
USDC, manage mandates, create payment links, or set up the agent wallet.
```

**Body and reference files:** Current SKILL.md and all reference files, unchanged:
- SKILL.md (entry point and CLI reference)
- X402-PAYMENT.md
- PAYOUT.md
- PAYMENT-LINK.md
- TRANSFER-TO-AGENT.md
- MANDATE-PLANNING.md
- CLAWPI.md
- SCHEDULED-CHECKIN.md
- INTEGRATION-GUIDE-AGENTID.md
- INTEGRATION-GUIDE-PAY-TO-AGENT.md
- INTEGRATION-GUIDE-CHARGE-AGENT.md
- INTEGRATION-GUIDE-PAYOUT.md

## Directory Structure

```
skills/
  supercharge/
    SKILL.md                        # Entry point (~100 words)
    references/
      copilot-tools.md              # Tool mapping for Copilot CLI
      codex-tools.md                # Tool mapping for Codex
      gemini-tools.md               # Tool mapping for Gemini CLI
  improving-abilities/
    SKILL.md                        # Capability discovery (~300 words)
  using-wallet/
    SKILL.md                        # Current SKILL.md (unchanged)
    X402-PAYMENT.md                 # Unchanged
    PAYOUT.md                       # Unchanged
    PAYMENT-LINK.md                 # Unchanged
    TRANSFER-TO-AGENT.md            # Unchanged
    MANDATE-PLANNING.md             # Unchanged
    CLAWPI.md                       # Unchanged
    SCHEDULED-CHECKIN.md            # Unchanged
    INTEGRATION-GUIDE-AGENTID.md    # Unchanged
    INTEGRATION-GUIDE-PAY-TO-AGENT.md   # Unchanged
    INTEGRATION-GUIDE-CHARGE-AGENT.md   # Unchanged
    INTEGRATION-GUIDE-PAYOUT.md     # Unchanged
.claude-plugin/
  plugin.json                       # Claude Code manifest
.cursor-plugin/
  plugin.json                       # Cursor manifest
.codex/
  INSTALL.md                        # Codex setup instructions
GEMINI.md                           # Auto-loads supercharge + gemini tool refs
CLAUDE.md                           # Contributor guidelines
AGENTS.md                           # Alias for CLAUDE.md
```

## Agent Mental Model

```
"I need to do something I can't do natively"
  -> fluxa:supercharge told me fluxa can help
    -> fluxa:improving-abilities to discover what's available
      -> fluxa:using-wallet if it costs money
```

## Platform Adaptation

Tool mapping references are ported from the superpowers project. Skills use Claude Code tool names as baseline. Platform-specific files translate:

- **Claude Code:** Baseline, no mapping needed
- **Cursor:** `.cursor-plugin/plugin.json` manifest, tool refs in `supercharge/references/`
- **Codex:** `.codex/INSTALL.md` setup, tool refs in `supercharge/references/codex-tools.md`
- **Gemini CLI:** `GEMINI.md` auto-loads supercharge + `supercharge/references/gemini-tools.md`
- **Copilot CLI:** Tool refs in `supercharge/references/copilot-tools.md`
- **OpenCode:** Bootstrap plugin if needed (future)

Manifests and tool mapping files are largely portable from superpowers with `superpowers:` references replaced by `fluxa:`.

## Cross-Reference Convention

Skills reference each other by name, never by file path:

```markdown
# Good -- lazy loaded via Skill tool when needed
If payment is required, see fluxa:using-wallet.

# Bad -- eagerly loads entire file into context
@./skills/using-wallet/SKILL.md
```

## Scope

**In scope:**
- Restructure current skill into three `fluxa:` prefixed skills
- Write new `supercharge` and `improving-abilities` SKILL.md files
- Move current wallet content into `using-wallet/` directory (as-is)
- Create platform manifests and tool mapping references (ported from superpowers)
- Create GEMINI.md, CLAUDE.md, AGENTS.md

**Out of scope (future work):**
- Content rewrite of wallet skill docs
- Monetize `/api/discover` API redesign
- Context length optimization within `using-wallet`
- Hook-based session-start injection
