# Payment Link

## Overview

Payment Links allow the agent to create shareable payment URLs to **receive** USDC. Useful for invoicing, selling content, collecting tips, or any scenario where the agent needs to get paid. Each link has a fixed amount, a unique URL, and optional constraints (expiry, max uses).

## End-to-End Flow

```
1. Agent calls POST /api/payment-links to create a link
2. Agent shares the returned url with payers
3. Payers open the URL and pay
4. Agent checks GET /api/payment-links/:linkId/payments to see who paid
```

## API Reference

### Create Payment Link

**POST** `https://walletapi.fluxapay.xyz/api/payment-links`

```bash
curl -X POST https://walletapi.fluxapay.xyz/api/payment-links \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AGENT_JWT" \
  -d '{
    "amount": "5000000",
    "currency": "USDC",
    "network": "base",
    "description": "AI Research Report",
    "maxUses": 100,
    "expiresAt": "2026-02-11T00:00:00.000Z"
  }'
```

**Fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `amount` | Yes | Amount in atomic units |
| `currency` | No | Default: `"USDC"` |
| `network` | No | Default: `"base"` |
| `description` | No | Human-readable label |
| `resourceContent` | No | Content delivered after payment |
| `expiresAt` | No | ISO 8601 expiration date, or omit for no expiry |
| `maxUses` | No | Max number of payments, or omit for unlimited |

**Response:**

```json
{
  "success": true,
  "paymentLink": {
    "id": 42,
    "linkId": "lnk_a1b2c3d4e5",
    "amount": "5000000",
    "currency": "USDC",
    "network": "base",
    "payTo": "0x...",
    "assetAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "scheme": "exact",
    "description": "AI Research Report",
    "resourceContent": "",
    "status": "active",
    "expiresAt": "2026-02-11T00:00:00.000Z",
    "maxUses": 100,
    "useCount": 0,
    "url": "https://wallet.fluxapay.xyz/pay/lnk_a1b2c3d4e5",
    "createdAt": "2026-02-04T12:00:00.000Z",
    "updatedAt": "2026-02-04T12:00:00.000Z"
  }
}
```

Share the `url` value with payers.

### List Payment Links

**GET** `https://walletapi.fluxapay.xyz/api/payment-links?limit=20`

```bash
curl -H "Authorization: Bearer $AGENT_JWT" \
  "https://walletapi.fluxapay.xyz/api/payment-links?limit=20"
```

### Get Payment Link Details

**GET** `https://walletapi.fluxapay.xyz/api/payment-links/:linkId`

```bash
curl -H "Authorization: Bearer $AGENT_JWT" \
  https://walletapi.fluxapay.xyz/api/payment-links/lnk_a1b2c3d4e5
```

### Update Payment Link

**PATCH** `https://walletapi.fluxapay.xyz/api/payment-links/:linkId`

```bash
curl -X PATCH https://walletapi.fluxapay.xyz/api/payment-links/lnk_a1b2c3d4e5 \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AGENT_JWT" \
  -d '{
    "status": "disabled",
    "description": "SOLD OUT"
  }'
```

**Updatable fields:**

| Field | Type | Description |
|-------|------|-------------|
| `description` | string | New description |
| `resourceContent` | string | New resource content |
| `status` | `"active"` / `"disabled"` | Enable or disable the link |
| `expiresAt` | string / null | New expiry or `null` to remove |
| `maxUses` | number / null | New limit or `null` to remove |

### Delete Payment Link

**DELETE** `https://walletapi.fluxapay.xyz/api/payment-links/:linkId`

```bash
curl -X DELETE -H "Authorization: Bearer $AGENT_JWT" \
  https://walletapi.fluxapay.xyz/api/payment-links/lnk_a1b2c3d4e5
```

### List Payments Received

**GET** `https://walletapi.fluxapay.xyz/api/payment-links/:linkId/payments?limit=10`

```bash
curl -H "Authorization: Bearer $AGENT_JWT" \
  "https://walletapi.fluxapay.xyz/api/payment-links/lnk_a1b2c3d4e5/payments?limit=10"
```

**Response:**

```json
{
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

## Use Cases

| Scenario | Configuration |
|----------|--------------|
| One-time invoice | `maxUses: 1` |
| Limited-time sale | Set `expiresAt` |
| Tip jar / donation | No limits |
| Digital goods | Set `resourceContent` with delivery info |
| Batch collection | High `maxUses`, monitor via payment records |
