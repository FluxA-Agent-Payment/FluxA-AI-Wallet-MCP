# FluxA AI Agent Guide

This guide explains how AI agents can leverage FluxA Wallet to perform onchain financial operations — without managing private keys, seed phrases, or complex blockchain interactions.

## What is FluxA Wallet?

FluxA Wallet is a managed wallet infrastructure designed for AI agents. It provides:

- **No-key signing** — All onchain signing is handled by FluxA Wallet; agents never touch private keys.
- **Human-in-the-loop authorization** — Sensitive operations (payouts, mandate signing) require user approval via a web UI.
- **x402 payment protocol** — A standard HTTP-based payment protocol that lets agents pay for API access in real time.
- **Payment Links** — Create shareable payment links to receive crypto payments.
- **Audit logging** — Every action is recorded for transparency and compliance.

## Feature Modules

| Module | Description | Guide |
|--------|-------------|-------|
| [Agent ID](./agent-id/) | Register and authenticate your agent | [Read](./agent-id/README.md) |
| [x402 Payment (v3)](./x402payment/) | Pay for APIs using the x402 protocol with intent mandates | [Read](./x402payment/README.md) |
| [Payout](./payout/) | Send funds to any wallet address | [Read](./payout/README.md) |
| [Payment Link](./paymentlink/) | Create and manage payment links to receive payments | [Read](./paymentlink/README.md) |

## Integration Methods

FluxA provides two integration paths:

### 1. MCP Server (for AI agent frameworks)

Connect via MCP (Model Context Protocol) for seamless integration with Claude, GPT, and other AI frameworks. The MCP server exposes tools that agents can call directly.

```bash
npm install
npm run build
npm start   # starts the MCP stdio server
```

### 2. CLI (for scripts and automation)

A standalone CLI tool that outputs JSON — ideal for shell scripts, CI/CD, and non-MCP environments.

```bash
node fluxa-cli.bundle.js <command> [options]
```

## Quick Start

Every agent interaction starts with **Agent ID registration**. Once registered, you can use any feature module.

```
1. Register Agent ID  ──>  Get agent_id + token + JWT
2. Use any feature:
   ├── x402 Payment   ──>  Pay for paid APIs in real time
   ├── Payout          ──>  Send funds to a wallet address
   └── Payment Link    ──>  Create links to receive payments
```

See each module's guide for detailed integration flows.

## API Base URLs

| Service | URL |
|---------|-----|
| Agent ID API | `https://agentid.fluxapay.xyz` |
| Wallet API | `https://walletapi.fluxapay.xyz` |
| Wallet App (UI) | `https://wallet.fluxapay.xyz` |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `AGENT_ID` | Pre-configured agent ID | — |
| `AGENT_TOKEN` | Pre-configured agent token | — |
| `AGENT_JWT` | Pre-configured agent JWT | — |
| `AGENT_EMAIL` | Email for auto-registration | — |
| `AGENT_NAME` | Agent name for auto-registration | — |
| `CLIENT_INFO` | Client info for auto-registration | — |
| `FLUXA_DATA_DIR` | Custom data directory path | `~/.fluxa-ai-wallet-mcp` |
| `AGENT_ID_API` | Agent ID API base URL | `https://agentid.fluxapay.xyz` |
| `WALLET_API` | Wallet API base URL | `https://walletapi.fluxapay.xyz` |

## Supported Networks & Assets

| Network | Chain ID | Supported Assets |
|---------|----------|-----------------|
| Base | 8453 | USDC (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) |
| Base Sepolia | 84532 | USDC (testnet) |
