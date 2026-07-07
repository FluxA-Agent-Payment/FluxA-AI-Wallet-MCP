# FluxA Wallet CLI Guide for AI Agents

This guide explains how to use the FluxA Wallet CLI tool (`fluxa-wallet`) to perform wallet operations.

## Quick Start

```bash
# Install the CLI globally
npm install -g @fluxa-pay/fluxa-wallet

# Run commands
fluxa-wallet <command> [options]
```

## Commands Overview

Run `fluxa-wallet <command> --help` for the full option list of any command.

**Account & status (read-only)**

| Command | Description |
|---------|-------------|
| `status` | Local agent configuration status |
| `wallet-address` | Linked user's wallet address (prints the address) |
| `balance` | Linked wallet balances — USDC / XRP / credits |
| `mandates` | List mandates with limit / spent / remaining |
| `recent-transactions` | Recent transactions — USDC / XRP / credits spends (`--limit`, 1-100) |
| `check-wallet` | Whether the agent is linked to a user's wallet |
| `version` | Print the CLI version (also `--version`, `-v`) |

**Setup**

| Command | Description |
|---------|-------------|
| `init` | Register a new agent ID (`--name`, `--client`) |
| `refreshJWT` | Refresh the JWT and print the new token |
| `link-wallet` | Get the wallet-linking URL (or confirm already linked) |

**Payments & payouts**

| Command | Description |
|---------|-------------|
| `mandate-create` | Create an intent mandate (`--desc`, `--amount`) |
| `mandate-status` | Query a mandate by id (`--id`) |
| `x402` / `x402-v3` | Execute an x402 payment (`--mandate`, `--payload`) |
| `payout` | Send USDC to a wallet address (`--to`, `--amount`, `--id`) |
| `payout-status` | Query a payout (`--id`) |

**Receiving — payment links, records & refunds**

| Command | Description |
|---------|-------------|
| `paymentlink-create` / `-list` / `-get` / `-update` / `-delete` | Manage payment links |
| `paymentlink-payments` | Payments received on a link (`--id`) |
| `received-records` / `received-record` | List / get received payment records |
| `paymentlink-refund-create` / `-list` / `-get` / `-cancel` | Manage refunds |

**Prepaid cards & identity**

| Command | Description |
|---------|-------------|
| `card holder create` / `me` | Set up and inspect the account cardholder |
| `card create` / `list` / `details` / `balance` | Issue and inspect virtual cards |
| `card transactions` / `card 3ds latest` / `card 3ds latest_1h` | Inspect card transactions and 3DS challenges |
| `card recharge` / `withdraw` / `withdrawals` / `withdrawal` | Add funds and withdraw card balance |
| `agent-vc` | Issue a short-lived agent VC for a third party (`--audience`, `--challenge`) |
| `help` | Show usage information |

## Output Format

Most commands output a JSON envelope to stdout:

```json
{
  "success": true,
  "data": { ... }
}
```

The read commands `wallet-address`, `balance`, `mandates`, `recent-transactions`,
and successful `card ...` commands print their value **directly** — a bare
address string or bare JSON — without the `{success,data}` wrapper, so they pipe
cleanly. `card list` prints the cards array directly. `version` prints just the
version string.

On error, every command falls back to the envelope:

```json
{
  "success": false,
  "error": "Error message"
}
```

**Exit codes:** `0` for success, `1` for failure.

---

## Command Details

### 1. Check Status

Check if the agent is configured and ready to use.

```bash
fluxa-wallet status
```

**Output when configured:**
```json
{
  "success": true,
  "data": {
    "configured": true,
    "agent_id": "ag_xxxxxxxxxxxx",
    "has_token": true,
    "has_jwt": true,
    "jwt_expired": false,
    "agent_name": "My AI Agent"
  }
}
```

**Output when not configured:**
```json
{
  "success": true,
  "data": {
    "configured": false,
    "has_registration_info": false
  }
}
```

---

### 2. Initialize Agent

Register a new agent ID with FluxA. This is required before making payments or payouts.

```bash
fluxa-wallet init --name <agent_name> --client <client_info>
```

**Parameters:**
| Parameter | Required | Description |
|-----------|----------|-------------|
| `--name` | Yes | A descriptive name for the agent |
| `--client` | Yes | Client/environment information |

**Example:**
```bash
fluxa-wallet init \
  --name "Claude Assistant Agent" \
  --client "Claude Code CLI on macOS"
```

**Success output:**
```json
{
  "success": true,
  "data": {
    "message": "Agent registered successfully",
    "agent_id": "ag_xxxxxxxxxxxx"
  }
}
```

**Alternative: Use environment variables**
```bash
export AGENT_NAME="Claude Assistant Agent"
export CLIENT_INFO="Claude Code CLI on macOS"
fluxa-wallet init
```

---

### 3. Refresh JWT

Manually refresh an expired JWT and get a new token.

```bash
fluxa-wallet refreshJWT
```

**Success output:**
```json
{
  "success": true,
  "data": {
    "message": "JWT refreshed successfully",
    "agent_id": "ag_xxxxxxxxxxxx",
    "jwt": "eyJhbGciOiJ..."
  }
}
```

> **Note:** Other commands (payout, x402, etc.) auto-refresh the JWT before each call. Use `refreshJWT` when you need the new token explicitly (e.g., for external scripts or debugging).

---

### 4. Create Payout

Send funds to a recipient address. Requires agent to be initialized first.

```bash
fluxa-wallet payout --to <address> --amount <amount> --id <payout_id>
```

**Parameters:**
| Parameter | Required | Default | Description |
|-----------|----------|---------|-------------|
| `--to` | Yes | - | Recipient wallet address (0x...) |
| `--amount` | Yes | - | Amount in smallest units (e.g., 1000000 = 1 USDC) |
| `--id` | Yes | - | Unique payout ID for idempotency |
| `--network` | No | `base` | Network name |
| `--asset` | No | USDC address | Token contract address |

**Example:**
```bash
# Send 1 USDC (1000000 in smallest units)
fluxa-wallet payout \
  --to "0x1234567890abcdef1234567890abcdef12345678" \
  --amount "1000000" \
  --id "payout_unique_001"
```

**Success output:**
```json
{
  "success": true,
  "data": {
    "payoutId": "payout_unique_001",
    "status": "pending_authorization",
    "txHash": null,
    "approvalUrl": "https://wallet.fluxapay.xyz/approve/...",
    "expiresAt": 1700000000
  }
}
```

**Important notes:**
- Amount is in **smallest units**: 1 USDC = 1,000,000 (6 decimals)
- The `--id` must be unique for each payout (used for idempotency)
- Status `pending_authorization` means user approval is needed via `approvalUrl`

---

### 4. Query Payout Status

Check the current status of a payout.

```bash
fluxa-wallet payout-status --id <payout_id>
```

**Example:**
```bash
fluxa-wallet payout-status --id "payout_unique_001"
```

**Output:**
```json
{
  "success": true,
  "data": {
    "payoutId": "payout_unique_001",
    "status": "succeeded",
    "txHash": "0xabcdef..."
  }
}
```

**Possible status values:**
| Status | Description |
|--------|-------------|
| `pending_authorization` | Waiting for user approval |
| `processing` | Transaction is being processed |
| `succeeded` | Payout completed successfully |
| `failed` | Payout failed |
| `expired` | Authorization expired |

---

### 5. Generate x402 Payment Header

Generate an x402 payment authorization header for HTTP requests to paid APIs.

```bash
fluxa-wallet x402 --payload '<json>'
```

**Example:**
```bash
fluxa-wallet x402 --payload '{
  "x402Version": 1,
  "accepts": [{
    "scheme": "exact",
    "network": "base",
    "maxAmountRequired": "100000",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0xRecipientAddress...",
    "resource": "https://api.example.com/paid-endpoint",
    "description": "API call payment",
    "mimeType": "application/json",
    "maxTimeoutSeconds": 60,
    "extra": {
      "name": "USD Coin",
      "version": "2"
    }
  }]
}'
```

**Output:**
```json
{
  "success": true,
  "data": {
    "X-PAYMENT": "base64-encoded-payment-header..."
  }
}
```

**Usage with curl:**
```bash
# Get the payment header
PAYMENT=$(fluxa-wallet x402 --payload '...' | jq -r '.data["X-PAYMENT"]')

# Make the paid API request
curl -H "X-PAYMENT: $PAYMENT" https://api.example.com/paid-endpoint
```

---

### 6. Account & Read Commands

These read the agent's own account state. They print their value **directly** (no
`{success,data}` wrapper) so they're easy to pipe.

```bash
# Linked user's wallet address — prints just the address
fluxa-wallet wallet-address
# 0xe63E151504DA0a1b07a31a72dbABda6240359893

# Balances — bare JSON object (USDC / XRP / credits; only present currencies shown)
fluxa-wallet balance
# { "usdc": { "available": "4115834", "availableFormatted": "4.115834", ... },
#   "credits": { "availableFormatted": "69.68", ... } }

# Mandates — open/total counts plus per-mandate limit / spent / remaining
fluxa-wallet mandates

# Recent transactions — bare array; USDC / XRP and credits spends. Excludes credit
# top-ups / grants / redeems and received payment-link payments.
fluxa-wallet recent-transactions --limit 50

# CLI version
fluxa-wallet --version    # or: -v, or: fluxa-wallet version
```

> **Auth:** these call `GET /api/agent/self/status` with the agent JWT (auto-refreshed).
> Amounts are atomic-unit strings paired with a `*Formatted` decimal (USDC/XRP: 6
> decimals, credits: 2).

---

### 7. AgentCard Commands

Card-service requests use a short-lived Agent VC automatically. The CLI first
fetches a card-service challenge, issues a VC with `agent-vc`, then calls the
card API. The linked wallet must be present; otherwise card commands return
`agent_not_linked` and you should run `fluxa-wallet link-wallet`.

```bash
# One-time immutable cardholder setup for the linked account
fluxa-wallet card holder create --first-name Alice --last-name Agent
fluxa-wallet card holder me

# Cards: default list is current-agent only; --global shows all cards in the linked account
fluxa-wallet card list
fluxa-wallet card list --global
fluxa-wallet card create --amount 25.00 --mandate mand_xxx
fluxa-wallet card details --id card_xxx
fluxa-wallet card balance --id card_xxx
fluxa-wallet card transactions --id card_xxx
fluxa-wallet card transactions --id card_xxx --type purchase --limit 10
fluxa-wallet card 3ds latest --id card_xxx
fluxa-wallet card 3ds latest_1h --id card_xxx

# Add or withdraw funds
fluxa-wallet card recharge --id card_xxx --amount 10.00 --mandate mand_xxx
fluxa-wallet card withdraw --id card_xxx
fluxa-wallet card withdraw --id card_xxx --amount 5.00
fluxa-wallet card withdrawals --id card_xxx
fluxa-wallet card withdrawal --id card_xxx --withdrawal-id wdr_xxx
```

`card create` and `card recharge` use the same mandate-backed x402 signing
flow as `x402-v3`. A `payment_submitted` result means the payment was accepted
and card service will finish issuance/recharge asynchronously; poll `card list`
or `card balance`.

Successful `card ...` commands print card-service business data directly, not a
CLI envelope. For example, `card list` prints the cards array, `card holder me`
prints the cardholder object, and `card withdrawals` prints the withdrawals
array. `card 3ds latest` prints the latest challenge object or `null`, while
`card 3ds latest_1h` prints the one-hour challenge array. Error output remains
`{ "success": false, "error": "..." }`.

---

## Environment Variables

The CLI supports the following environment variables:

| Variable | Description |
|----------|-------------|
| `AGENT_ID` | Pre-configured agent ID (skips registration) |
| `AGENT_TOKEN` | Pre-configured agent token |
| `AGENT_JWT` | Pre-configured agent JWT |
| `AGENT_NAME` | Agent name for auto-registration |
| `CLIENT_INFO` | Client info for auto-registration |
| `FLUXA_DATA_DIR` | Custom data directory (default: `~/.fluxa-ai-wallet-mcp`) |
| `CARD_SERVICE_API` | AgentCard API base URL (default: `https://agentcard.fluxapay.xyz`) |

**Using pre-configured credentials:**
```bash
export AGENT_ID="ag_xxxxxxxxxxxx"
export AGENT_TOKEN="tok_xxxxxxxxxxxx"
export AGENT_JWT="eyJhbGciOiJ..."

# Now all commands work without initialization
fluxa-wallet payout --to 0x... --amount 1000000 --id pay_001
```

---

## Workflow Examples

### Example 1: First-time Setup and Payout

```bash
# Step 1: Initialize agent
fluxa-wallet init \
  --name "Payment Bot" \
  --client "Automated System v1.0"

# Step 2: Verify status
fluxa-wallet status

# Step 3: Create payout
fluxa-wallet payout \
  --to "0x1234567890abcdef1234567890abcdef12345678" \
  --amount "5000000" \
  --id "order_12345_payout"

# Step 4: Check payout status
fluxa-wallet payout-status --id "order_12345_payout"
```

### Example 2: Scripted Payout with Status Check

```bash
#!/bin/bash

RECIPIENT="0x1234567890abcdef1234567890abcdef12345678"
AMOUNT="1000000"
PAYOUT_ID="payout_$(date +%s)"

# Create payout
RESULT=$(fluxa-wallet payout --to "$RECIPIENT" --amount "$AMOUNT" --id "$PAYOUT_ID")

if echo "$RESULT" | jq -e '.success' > /dev/null; then
  echo "Payout created: $PAYOUT_ID"

  # Poll for completion
  while true; do
    STATUS=$(fluxa-wallet payout-status --id "$PAYOUT_ID" | jq -r '.data.status')
    echo "Status: $STATUS"

    if [ "$STATUS" = "succeeded" ] || [ "$STATUS" = "failed" ]; then
      break
    fi
    sleep 5
  done
else
  echo "Error: $(echo "$RESULT" | jq -r '.error')"
fi
```

### Example 3: Making x402 Paid API Requests

```bash
#!/bin/bash

API_URL="https://api.example.com/paid-endpoint"

# First request - will get 402 Payment Required
RESPONSE=$(curl -s -w "\n%{http_code}" "$API_URL")
HTTP_CODE=$(echo "$RESPONSE" | tail -n1)

if [ "$HTTP_CODE" = "402" ]; then
  # Extract payment requirements from response body
  PAYMENT_REQ=$(echo "$RESPONSE" | head -n -1)

  # Generate payment header
  PAYMENT=$(fluxa-wallet x402 --payload "$PAYMENT_REQ" | jq -r '.data["X-PAYMENT"]')

  # Retry with payment header
  curl -H "X-PAYMENT: $PAYMENT" "$API_URL"
fi
```

---

## Error Handling

Common errors and solutions:

| Error | Cause | Solution |
|-------|-------|----------|
| `Agent not configured` | No agent ID registered | Run `init` command first |
| `JWT refresh failed` | Token expired or invalid | Run `refreshJWT` to get a new JWT, or re-run `init` |
| `Invalid recipient address` | Address not in 0x format | Use valid Ethereum address |
| `Amount must be positive integer` | Invalid amount format | Use smallest units (no decimals) |

---

## Data Storage

The CLI stores configuration in:
- **Default:** `~/.fluxa-ai-wallet-mcp/config.json`
- **Custom:** Set `FLUXA_DATA_DIR` environment variable

Audit logs are stored in:
- `~/.fluxa-ai-wallet-mcp/audit.log`

---

## Security Notes

1. **Never share your `AGENT_TOKEN` or `AGENT_JWT`** - these are credentials
2. The JWT expires periodically - the CLI handles refresh automatically
3. Each `payout_id` should be unique to prevent duplicate payments
4. Always verify recipient addresses before sending payouts
