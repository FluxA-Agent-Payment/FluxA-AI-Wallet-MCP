# Fluxa Skill Restructure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the flat fluxa-agent-wallet skill into three `fluxa:`-prefixed agent-native skills with platform manifests.

**Architecture:** Three skills (`supercharge`, `improving-abilities`, `fluxa-agent-wallet`) in separate directories under `skills/`. Entry point `supercharge` routes to the other two. Current wallet skill stays at `skills/fluxa-agent-wallet/` (unchanged). Platform manifests and tool mapping references ported from superpowers.

**Tech Stack:** Markdown (skill definitions), JSON (manifests), Bash (CLI references)

---

## File Structure

**Create:**
- `skills/supercharge/SKILL.md` — entry point skill
- `skills/supercharge/references/copilot-tools.md` — Copilot CLI tool mapping
- `skills/supercharge/references/codex-tools.md` — Codex tool mapping
- `skills/supercharge/references/gemini-tools.md` — Gemini CLI tool mapping
- `skills/improving-abilities/SKILL.md` — capability discovery skill
- `skills/improving-abilities/x402-SERVICES.md` — bazaar fallback reference (copied from fluxa-agent-wallet)
- `.claude-plugin/plugin.json` — Claude Code manifest
- `.cursor-plugin/plugin.json` — Cursor manifest
- `.codex/INSTALL.md` — Codex setup instructions
- `GEMINI.md` — Gemini auto-load config

**Keep unchanged:**
- `skills/fluxa-agent-wallet/*` — wallet skill stays completely in place, no files removed or renamed

---

### Task 1: Create the `skills/supercharge/` entry point skill

**Files:**
- Create: `skills/supercharge/SKILL.md`

- [ ] **Step 1: Create the supercharge SKILL.md**

```markdown
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
```

- [ ] **Step 2: Verify the file exists and content is correct**

Run: `cat skills/supercharge/SKILL.md | wc -w`
Expected: ~100 words (under 150)

- [ ] **Step 3: Commit**

```bash
git add skills/supercharge/SKILL.md
git commit -m "feat: add fluxa:supercharge entry point skill"
```

---

### Task 2: Create the `skills/improving-abilities/` capability discovery skill

**Files:**
- Create: `skills/improving-abilities/SKILL.md`
- Move: `skills/fluxa-agent-wallet/x402-SERVICES.md` → `skills/improving-abilities/x402-SERVICES.md`

- [ ] **Step 1: Create the improving-abilities SKILL.md**

This skill's content is framed around what capabilities the agent gains, not API documentation. Primary discovery goes through Monetize. Bazaar is fallback.

```markdown
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

If an API requires payment, `fluxa:fluxa-agent-wallet` handles it. The agent requests a budget, the user approves, and fluxa pays the API automatically.
```

- [ ] **Step 2: Copy x402-SERVICES.md to the new location**

Run: `cp skills/fluxa-agent-wallet/x402-SERVICES.md skills/improving-abilities/x402-SERVICES.md`

- [ ] **Step 3: Verify file structure**

Run: `ls -la skills/improving-abilities/`
Expected: `SKILL.md` and `x402-SERVICES.md`

- [ ] **Step 4: Commit**

```bash
git add skills/improving-abilities/
git commit -m "feat: add fluxa:improving-abilities capability discovery skill"
```

---

### Task 3: Create platform manifests

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.cursor-plugin/plugin.json`
- Create: `.codex/INSTALL.md`
- Create: `GEMINI.md`

- [ ] **Step 1: Create Claude Code plugin manifest**

```json
{
  "name": "fluxa",
  "description": "Supercharge your agent with pay-per-use APIs: image generation, video creation, web search, web scraping, and more",
  "version": "0.5.0",
  "author": {
    "name": "FluxA"
  },
  "homepage": "https://fluxapay.xyz",
  "license": "MIT",
  "keywords": [
    "skills",
    "x402",
    "payments",
    "apis",
    "capabilities",
    "wallet"
  ]
}
```

Write to: `.claude-plugin/plugin.json`

- [ ] **Step 2: Create Cursor plugin manifest**

```json
{
  "name": "fluxa",
  "displayName": "Fluxa",
  "description": "Supercharge your agent with pay-per-use APIs: image generation, video creation, web search, web scraping, and more",
  "version": "0.5.0",
  "author": {
    "name": "FluxA"
  },
  "homepage": "https://fluxapay.xyz",
  "license": "MIT",
  "keywords": [
    "skills",
    "x402",
    "payments",
    "apis",
    "capabilities",
    "wallet"
  ],
  "skills": "./skills/",
  "agents": "./agents/",
  "commands": "./commands/"
}
```

Write to: `.cursor-plugin/plugin.json`

- [ ] **Step 3: Create Codex install instructions**

```markdown
# Installing Fluxa for Codex

Enable fluxa skills in Codex via native skill discovery. Clone and symlink.

## Installation

1. **Clone the fluxa repository:**
   ```bash
   git clone https://github.com/anthropics/fluxa.git ~/.codex/fluxa
   ```

2. **Create the skills symlink:**
   ```bash
   mkdir -p ~/.agents/skills
   ln -s ~/.codex/fluxa/skills ~/.agents/skills/fluxa
   ```

3. **Restart Codex** to discover the skills.

## Verify

```bash
ls -la ~/.agents/skills/fluxa
```

You should see a symlink pointing to your fluxa skills directory.

## Updating

```bash
cd ~/.codex/fluxa && git pull
```

## Uninstalling

```bash
rm ~/.agents/skills/fluxa
rm -rf ~/.codex/fluxa
```
```

Write to: `.codex/INSTALL.md`

- [ ] **Step 4: Create GEMINI.md**

```markdown
@./skills/supercharge/SKILL.md
@./skills/supercharge/references/gemini-tools.md
```

Write to: `GEMINI.md`

- [ ] **Step 5: Verify all manifests exist**

Run: `ls .claude-plugin/plugin.json .cursor-plugin/plugin.json .codex/INSTALL.md GEMINI.md`
Expected: All four files listed

- [ ] **Step 6: Commit**

```bash
git add .claude-plugin/ .cursor-plugin/ .codex/ GEMINI.md
git commit -m "feat: add platform manifests for Claude Code, Cursor, Codex, Gemini"
```

---

### Task 4: Create tool mapping references

**Files:**
- Create: `skills/supercharge/references/copilot-tools.md`
- Create: `skills/supercharge/references/codex-tools.md`
- Create: `skills/supercharge/references/gemini-tools.md`

- [ ] **Step 1: Create Copilot CLI tool mapping**

Adapted from superpowers with `superpowers:` references replaced by `fluxa:`.

```markdown
# Copilot CLI Tool Mapping

Skills use Claude Code tool names. When you encounter these in a skill, use your platform equivalent:

| Skill references | Copilot CLI equivalent |
|-----------------|----------------------|
| `Read` (file reading) | `view` |
| `Write` (file creation) | `create` |
| `Edit` (file editing) | `edit` |
| `Bash` (run commands) | `bash` |
| `Grep` (search file content) | `grep` |
| `Glob` (search files by name) | `glob` |
| `Skill` tool (invoke a skill) | `skill` |
| `WebFetch` | `web_fetch` |

## Additional Copilot CLI tools

| Tool | Purpose |
|------|---------|
| `store_memory` | Persist facts about the codebase for future sessions |
| `report_intent` | Update the UI status line with current intent |
| GitHub MCP tools (`github-mcp-server-*`) | Native GitHub API access |
```

Write to: `skills/supercharge/references/copilot-tools.md`

- [ ] **Step 2: Create Codex tool mapping**

```markdown
# Codex Tool Mapping

Skills use Claude Code tool names. When you encounter these in a skill, use your platform equivalent:

| Skill references | Codex equivalent |
|-----------------|------------------|
| `Skill` tool (invoke a skill) | Skills load natively -- just follow the instructions |
| `Read`, `Write`, `Edit` (files) | Use your native file tools |
| `Bash` (run commands) | Use your native shell tools |

## Codex Setup

Add to your Codex config (`~/.codex/config.toml`) if using multi-agent features:

```toml
[features]
multi_agent = true
```
```

Write to: `skills/supercharge/references/codex-tools.md`

- [ ] **Step 3: Create Gemini CLI tool mapping**

```markdown
# Gemini CLI Tool Mapping

Skills use Claude Code tool names. When you encounter these in a skill, use your platform equivalent:

| Skill references | Gemini CLI equivalent |
|-----------------|----------------------|
| `Read` (file reading) | `read_file` |
| `Write` (file creation) | `write_file` |
| `Edit` (file editing) | `replace` |
| `Bash` (run commands) | `run_shell_command` |
| `Grep` (search file content) | `grep_search` |
| `Glob` (search files by name) | `glob` |
| `Skill` tool (invoke a skill) | `activate_skill` |
| `WebSearch` | `google_web_search` |
| `WebFetch` | `web_fetch` |

## Additional Gemini CLI tools

| Tool | Purpose |
|------|---------|
| `list_directory` | List files and subdirectories |
| `save_memory` | Persist facts to GEMINI.md across sessions |
| `ask_user` | Request structured input from the user |
```

Write to: `skills/supercharge/references/gemini-tools.md`

- [ ] **Step 4: Verify reference files exist**

Run: `ls skills/supercharge/references/`
Expected: `copilot-tools.md`, `codex-tools.md`, `gemini-tools.md`

- [ ] **Step 5: Commit**

```bash
git add skills/supercharge/references/
git commit -m "feat: add platform tool mapping references"
```

---

### Task 5: Final verification

- [ ] **Step 1: Verify complete directory structure**

Run: `find skills/ .claude-plugin/ .cursor-plugin/ .codex/ GEMINI.md -type f | sort`

Expected:
```
.claude-plugin/plugin.json
.codex/INSTALL.md
.cursor-plugin/plugin.json
GEMINI.md
skills/fluxa-agent-wallet/CLAWPI.md
skills/fluxa-agent-wallet/INTEGRATION-GUIDE-AGENTID.md
skills/fluxa-agent-wallet/INTEGRATION-GUIDE-CHARGE-AGENT.md
skills/fluxa-agent-wallet/INTEGRATION-GUIDE-PAY-TO-AGENT.md
skills/fluxa-agent-wallet/INTEGRATION-GUIDE-PAYOUT.md
skills/fluxa-agent-wallet/MANDATE-PLANNING.md
skills/fluxa-agent-wallet/PAYMENT-LINK.md
skills/fluxa-agent-wallet/PAYOUT.md
skills/fluxa-agent-wallet/SCHEDULED-CHECKIN.md
skills/fluxa-agent-wallet/SKILL.md
skills/fluxa-agent-wallet/TRANSFER-TO-AGENT.md
skills/fluxa-agent-wallet/X402-PAYMENT.md
skills/improving-abilities/SKILL.md
skills/improving-abilities/x402-SERVICES.md
skills/supercharge/SKILL.md
skills/supercharge/references/codex-tools.md
skills/supercharge/references/copilot-tools.md
skills/supercharge/references/gemini-tools.md
```

- [ ] **Step 2: Verify no cross-references use `@file` syntax**

Run: `grep -r "^@\." skills/`
Expected: No output (no eager file loading)

- [ ] **Step 3: Verify skill frontmatter format**

Run: `head -6 skills/supercharge/SKILL.md skills/improving-abilities/SKILL.md`
Expected: Each starts with `---` / `name:` / `description:` / `---`

- [ ] **Step 4: Verify fluxa-agent-wallet is untouched**

Run: `ls skills/fluxa-agent-wallet/ | wc -l`
Expected: 14 files (all original files intact)

- [ ] **Step 5: Word count check on entry point**

Run: `cat skills/supercharge/SKILL.md | wc -w`
Expected: Under 150 words
