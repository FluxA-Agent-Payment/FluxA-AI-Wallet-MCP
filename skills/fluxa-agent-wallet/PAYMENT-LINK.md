# Payment Link — REST API Reference

## Overview

Payment Links allow the agent to create shareable payment URLs to **receive** USDC. Useful for invoicing, selling content, collecting tips, or any scenario where the agent needs to get paid.

**Important**: Payment link operations require the REST API. The CLI does not support payment link commands.

## Prerequisites

Retrieve the JWT from your agent config:

```bash
# Replace <email> and <agent_name> with your values
JWT=$(cat ~/.fluxa-ai-wallet-mcp/.agent-config.json | jq -r '.agents["<email>"]["<agent_name>"].jwt')
```

Base URL: `https://walletapi.fluxapay.xyz`

## End-to-End Flow

```
1. Agent creates a payment link via REST API
2. Agent shares the returned URL with payers
3. Payers open the URL and pay (or agent pays programmatically via x402)
4. Agent checks payments received via API
```

## API Reference

### Create Payment Link

```bash
curl -X POST "https://walletapi.fluxapay.xyz/api/payment-links" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{
    "amount": "5000000",
    "currency": "USDC",
    "network": "base",
    "description": "AI Research Report",
    "maxUses": 100,
    "expiresAt": "2026-02-11T00:00:00.000Z"
  }'
```

**Request Body:**

| Field | Required | Default | Description |
|-------|----------|---------|-------------|
| `amount` | Yes | — | Amount in atomic units |
| `currency` | No | `USDC` | Currency |
| `network` | No | `base` | Network |
| `description` | No | — | Description |
| `resource` | No | — | Resource content delivered after payment |
| `expiresAt` | No | — | Expiry date (ISO 8601) |
| `maxUses` | No | — | Maximum number of payments |

**Response:**

```json
{
  "success": true,
  "paymentLink": {
    "linkId": "lnk_a1b2c3d4e5",
    "amount": "5000000",
    "currency": "USDC",
    "network": "base",
    "description": "AI Research Report",
    "status": "active",
    "expiresAt": "2026-02-11T00:00:00.000Z",
    "maxUses": 100,
    "useCount": 0,
    "url": "https://wallet.fluxapay.xyz/pay/lnk_a1b2c3d4e5",
    "createdAt": "2026-02-04T12:00:00.000Z"
  }
}
```

Share the `url` value with payers.

### List Payment Links

```bash
curl -X GET "https://walletapi.fluxapay.xyz/api/payment-links?limit=20" \
  -H "Authorization: Bearer $JWT"
```

### Get Payment Link Details

```bash
curl -X GET "https://walletapi.fluxapay.xyz/api/payment-links/lnk_a1b2c3d4e5" \
  -H "Authorization: Bearer $JWT"
```

### Update Payment Link

```bash
# Disable a link
curl -X PATCH "https://walletapi.fluxapay.xyz/api/payment-links/lnk_a1b2c3d4e5" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{"status": "disabled"}'

# Update description
curl -X PATCH "https://walletapi.fluxapay.xyz/api/payment-links/lnk_a1b2c3d4e5" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{"description": "SOLD OUT"}'

# Remove expiry limit
curl -X PATCH "https://walletapi.fluxapay.xyz/api/payment-links/lnk_a1b2c3d4e5" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{"expiresAt": null}'
```

**Request Body (all fields optional):**

| Field | Description |
|-------|-------------|
| `description` | New description |
| `resource` | New resource content |
| `status` | `active` or `disabled` |
| `expiresAt` | New expiry (ISO 8601), `null` to clear |
| `maxUses` | New max uses, `null` to clear |

### Delete Payment Link

```bash
curl -X DELETE "https://walletapi.fluxapay.xyz/api/payment-links/lnk_a1b2c3d4e5" \
  -H "Authorization: Bearer $JWT"
```

### View Payments Received

```bash
curl -X GET "https://walletapi.fluxapay.xyz/api/payment-links/lnk_a1b2c3d4e5/payments?limit=10" \
  -H "Authorization: Bearer $JWT"
```

**Response:**

```json
{
  "success": true,
  "payments": [
    {
      "id": 1,
      "payerAddress": "0xBuyerAddr...",
      "amount": "5000000",
      "currency": "USDC",
      "settlementStatus": "settled",
      "settlementTxHash": "0xabcdef...",
      "createdAt": "2026-02-05T10:30:00.000Z"
    }
  ]
}
```

## Paying TO a Payment Link

To pay a payment link programmatically (agent-to-agent payments), use the x402 flow documented in [X402-PAYMENT.md](X402-PAYMENT.md).

**Quick reference:**
```
1. curl -s <payment_link_url>                    → Get 402 payload
2. mandate-create --desc "..." --amount <amount> → Create mandate
3. User signs at authorizationUrl                → Mandate becomes "signed"
4. x402-v3 --mandate <id> --payload "$PAYLOAD"   → Get xPaymentB64
5. curl -H "X-Payment: <token>" <url>            → Submit payment
```

Payment link URL format: `https://walletapi.fluxapay.xyz/paymentlink/<link_id>`

## Scripted Example

```bash
#!/bin/bash
JWT=$(cat ~/.fluxa-ai-wallet-mcp/.agent-config.json | jq -r '.agents["agent@example.com"]["My AI Agent"].jwt')
API="https://walletapi.fluxapay.xyz"

# Create a payment link
RESULT=$(curl -s -X POST "$API/api/payment-links" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{
    "amount": "1000000",
    "currency": "USDC",
    "network": "base",
    "description": "Test payment link"
  }')

LINK_ID=$(echo "$RESULT" | jq -r '.paymentLink.linkId')
URL=$(echo "$RESULT" | jq -r '.paymentLink.url')

echo "Created payment link: $URL"

# Check for payments
curl -s -X GET "$API/api/payment-links/$LINK_ID/payments" \
  -H "Authorization: Bearer $JWT" | jq
```

## Use Cases

| Scenario | Configuration |
|----------|--------------|
| One-time invoice | `"maxUses": 1` |
| Limited-time sale | `"expiresAt": "<date>"` |
| Tip jar / donation | No limits |
| Digital goods | `"resource": "Download link: ..."` |
| Batch collection | High `maxUses`, track via `/payments` endpoint |
| Agent-to-agent payment | Use x402 flow above |
