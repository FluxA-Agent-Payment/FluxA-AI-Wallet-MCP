# Payout

## Overview

Payout lets the agent send USDC to any wallet address on Base network. Every payout requires **user authorization** via the FluxA Wallet UI before the onchain transaction executes.

## End-to-End Flow

```
1. Agent calls POST /api/payouts with recipient, amount, and a unique payout_id
2. API returns status "pending_authorization" + approvalUrl
3. User opens approvalUrl to authorize
4. Agent polls GET /api/payouts/:payoutId until status is "succeeded"
```

## API Reference

### Create Payout

**POST** `https://walletapi.fluxapay.xyz/api/payouts`

```bash
curl -X POST https://walletapi.fluxapay.xyz/api/payouts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AGENT_JWT" \
  -H "x-agent-id: $AGENT_ID" \
  -d '{
    "agentId": "<AGENT_ID>",
    "toAddress": "0x4eb5b229d43c30fc629d92bf7ed415d6d7f0cabe",
    "amount": "1000000",
    "currency": "USDC",
    "network": "base",
    "assetAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payoutId": "reward_20260204_001"
  }'
```

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `agentId` | Yes | Your agent ID |
| `toAddress` | Yes | Recipient wallet address (0x + 40 hex chars) |
| `amount` | Yes | Amount in atomic units (1 USDC = `1000000`) |
| `currency` | Yes | `"USDC"` |
| `network` | Yes | `"base"` |
| `assetAddress` | Yes | `"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"` |
| `payoutId` | Yes | Unique idempotency key (your choice) |

**Response:**

```json
{
  "payoutId": "reward_20260204_001",
  "status": "pending_authorization",
  "txHash": null,
  "approvalUrl": "https://wallet.fluxapay.xyz/authorize-payout/reward_20260204_001",
  "expiresAt": 1738713600
}
```

Ask the user to open `approvalUrl` to authorize.

### Query Payout Status

**GET** `https://walletapi.fluxapay.xyz/api/payouts/:payoutId`

```bash
curl https://walletapi.fluxapay.xyz/api/payouts/reward_20260204_001
```

**Response:**

```json
{
  "payoutId": "reward_20260204_001",
  "status": "succeeded",
  "txHash": "0xabcdef1234567890..."
}
```

### Payout Status Values

| Status | Meaning |
|--------|---------|
| `pending_authorization` | Waiting for user approval |
| `processing` | Approved, onchain tx in progress |
| `succeeded` | Done, `txHash` available |
| `failed` | Transaction failed |
| `expired` | User didn't approve in time |

## Important Notes

- **Idempotency**: Using the same `payoutId` returns the existing payout status, not a duplicate.
- **Validate addresses**: Ensure `toAddress` matches `0x[a-fA-F0-9]{40}` before calling.
- **No rollback**: Once succeeded onchain, payouts cannot be reversed.
- **Amount**: Always atomic units. 1 USDC = `1000000`, 0.01 USDC = `10000`.
