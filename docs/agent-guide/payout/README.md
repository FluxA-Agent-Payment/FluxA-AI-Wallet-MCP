# Payout

## What It Does

Payout allows AI agents to send funds (USDC) to any wallet address on Base network. Unlike x402 payments (which pay merchants for API access), payouts are direct transfers — useful for rewarding users, settling invoices, distributing earnings, or any scenario where the agent needs to send money.

Payouts require **user authorization** via the FluxA Wallet UI before the onchain transaction is executed. This human-in-the-loop design ensures the agent cannot move funds without explicit user approval.

## What an Agent Can Do

- **Create a payout** — Initiate a transfer to a recipient wallet address
- **Check payout status** — Poll whether the payout is pending, approved, succeeded, or failed
- **Idempotent requests** — Each payout has a unique `payout_id` to prevent duplicate transfers

## Related APIs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/payouts` | Create a new payout |
| `GET` | `/api/payouts/:payoutId` | Query payout status |

**Base URL:** `https://walletapi.fluxapay.xyz`

## MCP Tools

| Tool | Description |
|------|-------------|
| `request_payout` | Create a payout (network/currency/asset hardcoded to Base USDC) |
| `get_payout_status` | Query payout status by payout ID |

## CLI Commands

| Command | Description |
|---------|-------------|
| `payout` | Create a payout |
| `payout-status` | Query payout status |

## Integration Flow

### Your Task

> Send 1 USDC to wallet address `0x4eb5b229d43c30fc629d92bf7ed415d6d7f0cabe` as a reward for completing a task.

---

### Step 1 — Create a Payout

Generate a unique `payout_id` for idempotency, then submit the payout request:

```bash
node fluxa-cli.bundle.js payout \
  --to "0x4eb5b229d43c30fc629d92bf7ed415d6d7f0cabe" \
  --amount "1000000" \
  --id "reward_task_20260204_001"
```

> **Amount is in smallest units:** 1 USDC = 1,000,000 (6 decimals)

**Via API:**

```bash
curl -X POST https://walletapi.fluxapay.xyz/api/payouts \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AGENT_JWT" \
  -H "x-agent-id: $AGENT_ID" \
  -d '{
    "agentId": "ag_xxxxxxxxxxxx",
    "toAddress": "0x4eb5b229d43c30fc629d92bf7ed415d6d7f0cabe",
    "amount": "1000000",
    "currency": "USDC",
    "network": "base",
    "assetAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payoutId": "reward_task_20260204_001"
  }'
```

**Response:**

```json
{
  "payoutId": "reward_task_20260204_001",
  "status": "pending_authorization",
  "txHash": null,
  "approvalUrl": "https://wallet.fluxapay.xyz/authorize-payout/reward_task_20260204_001",
  "expiresAt": 1738713600
}
```

### Step 2 — User Approves the Payout

The payout is now in `pending_authorization` status. Ask the user to open `approvalUrl` in their browser to review and authorize the transfer.

> "I've prepared a payout of 1 USDC to `0x4eb5...cabe`. Please open the following link to authorize it: [approvalUrl]"

### Step 3 — Poll Payout Status

After the user approves, check the status until the transaction completes:

```bash
node fluxa-cli.bundle.js payout-status --id "reward_task_20260204_001"
```

**Via API:**

```bash
curl https://walletapi.fluxapay.xyz/api/payouts/reward_task_20260204_001
```

**Response (completed):**

```json
{
  "payoutId": "reward_task_20260204_001",
  "status": "succeeded",
  "txHash": "0xabcdef1234567890..."
}
```

## Flow Diagram

```
Agent                         FluxA Wallet                    User
  │                               │                             │
  │── 1. POST /api/payouts ──────>│                             │
  │<── pending + approvalUrl ─────│                             │
  │                               │                             │
  │── 2. "Please approve" ───────────────────────────────────>  │
  │                               │<── 3. Authorize payout ──── │
  │                               │                             │
  │                               │── 4. Execute onchain tx ──> │
  │                               │                             │
  │── 5. GET /api/payouts/:id ──>│                             │
  │<── status: succeeded ─────── │                             │
```

## Payout Status Values

| Status | Description |
|--------|-------------|
| `pending_authorization` | Waiting for user approval via `approvalUrl` |
| `processing` | User approved; onchain transaction in progress |
| `succeeded` | Transaction confirmed; `txHash` is available |
| `failed` | Transaction failed |
| `expired` | User did not approve before the deadline |

## Important Notes

- **Idempotency** — The `payout_id` must be unique per payout. If you submit the same `payout_id` twice, the API returns the existing payout status instead of creating a duplicate.
- **Address validation** — Always validate the recipient address format (`0x` + 40 hex chars) before submitting.
- **Amount** — Always in smallest units. For USDC (6 decimals): `1000000` = 1 USDC, `10000` = 0.01 USDC.
- **Network** — Currently hardcoded to Base mainnet in MCP tools. The CLI supports `--network` for other networks.
- **No rollback** — Once a payout succeeds onchain, it cannot be reversed.
