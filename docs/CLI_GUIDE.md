# FluxA Wallet CLI Guide for AI Agents

This guide explains how to use the FluxA Wallet CLI tool (`fluxa-cli.bundle.js`) to perform wallet operations. The CLI is a standalone JavaScript file that requires only Node.js (v18+) to run - no npm installation needed.

## Quick Start

```bash
# Download the bundle file
curl -O https://example.com/fluxa-cli.bundle.js

# Make it executable (optional)
chmod +x fluxa-cli.bundle.js

# Run commands
node fluxa-cli.bundle.js <command> [options]
```

## Commands Overview

| Command | Description |
|---------|-------------|
| `status` | Check agent configuration status |
| `init` | Initialize/register a new agent ID |
| `payout` | Create a payout to a recipient address |
| `payout-status` | Query the status of a payout |
| `x402` | Generate x402 payment header for HTTP requests |
| `help` | Show usage information |

## Output Format

All commands output JSON to stdout with the following structure:

```json
{
  "success": true,
  "data": { ... }
}
```

Or on error:

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
node fluxa-cli.bundle.js status
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
    "email": "agent@example.com",
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
node fluxa-cli.bundle.js init --email <email> --name <agent_name> --client <client_info>
```

**Parameters:**
| Parameter | Required | Description |
|-----------|----------|-------------|
| `--email` | Yes | Email address for the agent |
| `--name` | Yes | A descriptive name for the agent |
| `--client` | Yes | Client/environment information |

**Example:**
```bash
node fluxa-cli.bundle.js init \
  --email "myagent@example.com" \
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
export AGENT_EMAIL="myagent@example.com"
export AGENT_NAME="Claude Assistant Agent"
export CLIENT_INFO="Claude Code CLI on macOS"
node fluxa-cli.bundle.js init
```

---

### 3. Create Payout

Send funds to a recipient address. Requires agent to be initialized first.

```bash
node fluxa-cli.bundle.js payout --to <address> --amount <amount> --id <payout_id>
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
node fluxa-cli.bundle.js payout \
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
node fluxa-cli.bundle.js payout-status --id <payout_id>
```

**Example:**
```bash
node fluxa-cli.bundle.js payout-status --id "payout_unique_001"
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
node fluxa-cli.bundle.js x402 --payload '<json>'
```

**Example:**
```bash
node fluxa-cli.bundle.js x402 --payload '{
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
PAYMENT=$(node fluxa-cli.bundle.js x402 --payload '...' | jq -r '.data["X-PAYMENT"]')

# Make the paid API request
curl -H "X-PAYMENT: $PAYMENT" https://api.example.com/paid-endpoint
```

---

## Environment Variables

The CLI supports the following environment variables:

| Variable | Description |
|----------|-------------|
| `AGENT_ID` | Pre-configured agent ID (skips registration) |
| `AGENT_TOKEN` | Pre-configured agent token |
| `AGENT_JWT` | Pre-configured agent JWT |
| `AGENT_EMAIL` | Email for auto-registration |
| `AGENT_NAME` | Agent name for auto-registration |
| `CLIENT_INFO` | Client info for auto-registration |
| `FLUXA_DATA_DIR` | Custom data directory (default: `~/.fluxa-ai-wallet-mcp`) |

**Using pre-configured credentials:**
```bash
export AGENT_ID="ag_xxxxxxxxxxxx"
export AGENT_TOKEN="tok_xxxxxxxxxxxx"
export AGENT_JWT="eyJhbGciOiJ..."

# Now all commands work without initialization
node fluxa-cli.bundle.js payout --to 0x... --amount 1000000 --id pay_001
```

---

## Workflow Examples

### Example 1: First-time Setup and Payout

```bash
# Step 1: Initialize agent
node fluxa-cli.bundle.js init \
  --email "agent@company.com" \
  --name "Payment Bot" \
  --client "Automated System v1.0"

# Step 2: Verify status
node fluxa-cli.bundle.js status

# Step 3: Create payout
node fluxa-cli.bundle.js payout \
  --to "0x1234567890abcdef1234567890abcdef12345678" \
  --amount "5000000" \
  --id "order_12345_payout"

# Step 4: Check payout status
node fluxa-cli.bundle.js payout-status --id "order_12345_payout"
```

### Example 2: Scripted Payout with Status Check

```bash
#!/bin/bash

RECIPIENT="0x1234567890abcdef1234567890abcdef12345678"
AMOUNT="1000000"
PAYOUT_ID="payout_$(date +%s)"

# Create payout
RESULT=$(node fluxa-cli.bundle.js payout --to "$RECIPIENT" --amount "$AMOUNT" --id "$PAYOUT_ID")

if echo "$RESULT" | jq -e '.success' > /dev/null; then
  echo "Payout created: $PAYOUT_ID"

  # Poll for completion
  while true; do
    STATUS=$(node fluxa-cli.bundle.js payout-status --id "$PAYOUT_ID" | jq -r '.data.status')
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
  PAYMENT=$(node fluxa-cli.bundle.js x402 --payload "$PAYMENT_REQ" | jq -r '.data["X-PAYMENT"]')

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
| `JWT refresh failed` | Token expired or invalid | Re-run `init` with credentials |
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
