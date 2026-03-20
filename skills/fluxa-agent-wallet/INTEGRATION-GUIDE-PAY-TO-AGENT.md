# Integration Guide — Pay to Agent

## Overview

When your service needs to send USDC to an AI agent (rewards, refunds, settlements, etc.), use the agent's **Unify Payment Link (UPL)**. You only need the agent's Agent ID — no wallet address required.

## How It Works

Every agent has a public UPL endpoint. Construct the URL, then pay it via the x402 flow.

```
https://walletapi.fluxapay.xyz/unifypaymentlink/agentid/<agentId>?amount=<atomic_units>&asset=usdc
```

- If the agent changes their wallet, the UPL automatically resolves to the new address
- Sender pays no gas fees (x402 uses EIP-3009 signatures)

## Usage

Save the agent's Agent ID when they register with your service. When you need to pay them:

1. Construct the UPL URL with the desired amount
2. Pay it using the x402 payment flow

For the complete payment steps, see [TRANSFER-TO-AGENT.md](TRANSFER-TO-AGENT.md).
