# x402 Payment (v3 — Intent Mandate)

## Overview

x402 is an HTTP-native payment protocol. When an agent requests a paid API, the server responds with HTTP 402 and payment requirements. The agent signs a payment via FluxA Wallet and retries with an `X-Payment` header.

**x402 v3** uses **intent mandates**: the user pre-approves a spending plan (budget + time window), then the agent can make autonomous payments within those limits.

## End-to-End Flow

```
1. Agent creates an intent mandate (budget, duration)
2. User opens authorizationUrl to review & sign the mandate
3. Agent hits the paid API → receives HTTP 402
4. Agent calls x402V3Payment with mandateId + payment details
5. Agent retries the API with X-Payment header → gets data
```

## API Reference

### Step 1 — Create Intent Mandate

**POST** `https://walletapi.fluxapay.xyz/api/mandates/create-intent`

```bash
curl -X POST https://walletapi.fluxapay.xyz/api/mandates/create-intent \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AGENT_JWT" \
  -d '{
    "intent": {
      "naturalLanguage": "I plan to spend up to 0.10 USDC to get Polymarket trading recommendations valid for 30 days.",
      "category": "trading_data",
      "currency": "USDC",
      "limitAmount": "100000",
      "validForSeconds": 2592000,
      "hostAllowlist": []
    }
  }'
```

**Intent fields:**

| Field | Required | Description |
|-------|----------|-------------|
| `naturalLanguage` | Yes | Human-readable description of the spending plan |
| `category` | No | Category tag (e.g., `trading_data`, `general`) |
| `currency` | No | Currency (default: `USDC`) |
| `limitAmount` | Yes | Maximum budget in atomic units |
| `validForSeconds` | Yes | Duration in seconds |
| `hostAllowlist` | No | Restrict to specific API hosts (empty = any) |

**Response:**

```json
{
  "status": "ok",
  "mandateId": "mand_xxxxxxxxxxxxx",
  "authorizationUrl": "https://wallet.fluxapay.xyz/onboard/intent?oid=...",
  "expiresAt": "2026-02-04T00:10:00.000Z",
  "agentStatus": "ready"
}
```

> If called **without** `Authorization`, the response includes `payment_model_context` with instructions on how to register first.

Ask the user to open `authorizationUrl` (TTL: 10 minutes) to authorize and sign.

### Step 2 — Check Mandate Status

**GET** `https://walletapi.fluxapay.xyz/api/mandates/agent/:mandateId`

```bash
curl -H "Authorization: Bearer $AGENT_JWT" \
  https://walletapi.fluxapay.xyz/api/mandates/agent/mand_xxxxxxxxxxxxx
```

**Response:**

```json
{
  "status": "ok",
  "mandate": {
    "mandateId": "mand_xxxxxxxxxxxxx",
    "status": "signed",
    "naturalLanguage": "I plan to spend up to 0.10 USDC...",
    "currency": "USDC",
    "limitAmount": "100000",
    "spentAmount": "0",
    "remainingAmount": "100000",
    "validFrom": "2026-02-04T00:00:00.000Z",
    "validUntil": "2026-03-06T00:00:00.000Z"
  }
}
```

Wait until `mandate.status` is `"signed"` before making payments.

### Step 3 — Make x402 v3 Payment

**POST** `https://walletapi.fluxapay.xyz/api/payment/x402V3Payment`

```bash
curl -X POST https://walletapi.fluxapay.xyz/api/payment/x402V3Payment \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AGENT_JWT" \
  -d '{
    "mandateId": "<MANDATE_ID>",
    "scheme": "exact",
    "network": "base",
    "amount": "10000",
    "currency": "USDC",
    "assetAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "<MERCHANT_ADDRESS>",
    "host": "api.example.com",
    "resource": "https://api.example.com/paid-endpoint",
    "description": "API call payment",
    "tokenName": "USD Coin",
    "tokenVersion": "2",
    "validityWindowSeconds": 60
  }'
```

**Payment fields (from HTTP 402 response):**

| Field | Description |
|-------|-------------|
| `mandateId` | From Step 1 |
| `scheme` | Usually `"exact"` |
| `network` | `"base"` |
| `amount` | From 402 `accepts[0].maxAmountRequired` |
| `currency` | `"USDC"` |
| `assetAddress` | From 402 `accepts[0].asset` |
| `payTo` | From 402 `accepts[0].payTo` |
| `host` | Hostname of the API |
| `resource` | Full URL of the API endpoint |
| `description` | From 402 `accepts[0].description` |
| `tokenName` | From 402 `accepts[0].extra.name` (usually `"USD Coin"`) |
| `tokenVersion` | From 402 `accepts[0].extra.version` (usually `"2"`) |
| `validityWindowSeconds` | From 402 `accepts[0].maxTimeoutSeconds` |

**Response:**

```json
{
  "status": "ok",
  "xPaymentB64": "eyJ4NDAyVmVyc2lvbi...",
  "xPayment": {
    "x402Version": 1,
    "scheme": "exact",
    "network": "base",
    "payload": {
      "signature": "0x...",
      "authorization": { "from": "0x...", "to": "0x...", "value": "10000", "validAfter": "...", "validBefore": "...", "nonce": "0x..." }
    }
  },
  "paymentRecordId": 123,
  "expiresAt": 1700000060
}
```

### Step 4 — Retry with X-Payment Header

```bash
curl -H "X-Payment: <xPaymentB64>" \
  https://api.example.com/paid-endpoint
```

## Concrete Example

**Task:** Get Polymarket trading recommendations from `https://fluxa-x402-api.gmlgtm.workers.dev/polymarket_recommendations_last_1h`

1. Create mandate: `limitAmount: "100000"` (0.10 USDC), `validForSeconds: 2592000` (30 days)
2. User signs at `authorizationUrl`
3. Agent hits the API, gets 402
4. Agent calls `x402V3Payment` with `mandateId`, `amount: "10000"`, `payTo: "0xFf319473ba1a09272B37c34717f6993b3F385CD3"`, `host: "fluxa-x402-api.gmlgtm.workers.dev"`
5. Agent retries with `X-Payment: <xPaymentB64>` → gets the data

## Error Handling

| Error code | Meaning | Action |
|------------|---------|--------|
| `mandate_not_signed` | User hasn't signed yet | Ask user to open `signUrl` |
| `mandate_expired` | Mandate time window has passed | Create a new mandate |
| `mandate_budget_exceeded` | Remaining budget too low | Create a new mandate with higher limit |
| `agent_not_registered` | No Agent ID configured | Register first via `/register` |
| `jwt_refresh_failed` | JWT expired and refresh failed | Re-register agent |
