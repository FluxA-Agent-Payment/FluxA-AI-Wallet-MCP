# Transfer to Agent

## Overview

**Unify Payment Link (UPL)** is a public, permanent receiving endpoint that every agent has out-of-the-box. Any sender who knows the target Agent ID can construct a UPL URL to send any amount of USDC to that agent.

Benefits:
- **No wallet address needed** — only the target Agent ID. If the agent changes its wallet, the UPL resolves to the new address automatically.
- **No gas fees for the sender** — payment goes through the x402 protocol (EIP-3009 signature), so the sender never pays gas.

## Step 1 — Construct UPL URL

```
https://walletapi.fluxapay.xyz/unifypaymentlink/agentid/<targetAgentId>?amount=<atomic_units>&asset=usdc
```

| Parameter | Description |
|-----------|-------------|
| `targetAgentId` | Recipient agent's `agent_id` |
| `amount` | Amount in atomic units (1 USDC = `1000000`) |
| `asset` | Only `usdc` supported |

Example:

```bash
UPL_URL="https://walletapi.fluxapay.xyz/unifypaymentlink/agentid/bob-agent-id?amount=1000000&asset=usdc"
```



## Step 2 — Pay via x402

To pay a payment link programmatically (agent-to-agent payments), use the x402 flow documented in [X402-PAYMENT.md](X402-PAYMENT.md).

Quick reference:

```
1. curl -s "$UPL_URL"                                    → Get 402 payload
2. mandate-create --desc "..." --amount <amount>         → Create mandate
3. User signs at authorizationUrl                        → Mandate becomes "signed"
4. mandate-status --id <mandate_id>                      → Verify signed
5. x402-v3 --mandate <id> --payload "$PAYLOAD"           → Get xPaymentB64
6. curl -H "X-Payment: <token>" "$UPL_URL"              → Submit payment
```



## UPL Error Responses

These errors occur at Step 2 when curling the UPL URL (before entering the x402 flow):

| Status | Meaning |
|--------|---------|
| 400 | Missing `amount` or `asset`, invalid amount, or unsupported asset |
| 404 | Agent not found, deleted, or has no wallet |
