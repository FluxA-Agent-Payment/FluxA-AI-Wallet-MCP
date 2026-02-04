# x402 Payment (v3 — Intent Mandate)

## What It Does

x402 is an HTTP-native payment protocol that allows AI agents to pay for API access in real time. When an agent requests a paid API endpoint, the server responds with HTTP `402 Payment Required` along with payment details. The agent then signs a payment authorization via FluxA Wallet and retries the request with an `X-Payment` header.

**x402 v3** improves on v1 by introducing **intent mandates** — a pre-authorized spending plan that the user reviews and signs once, allowing the agent to make multiple payments autonomously within the approved budget and time window.

## What an Agent Can Do

- **Create an intent mandate** — Define a spending plan (budget, duration, description) for user approval
- **Check mandate status** — Verify if a mandate is signed and how much budget remains
- **Make x402 v3 payments** — Sign payment authorizations using an approved mandate
- **Access paid APIs** — Fetch data from x402-protected endpoints by attaching the `X-Payment` header

## Related APIs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/mandates/create-intent` | Create an intent mandate |
| `GET` | `/api/mandates/agent/:mandateId` | Query mandate status |
| `POST` | `/api/payment/x402V3Payment` | Sign an x402 v3 payment |

**Base URL:** `https://walletapi.fluxapay.xyz`

## MCP Tools

| Tool | Description |
|------|-------------|
| `create_intent_mandate` | Create a new intent mandate for user to sign |
| `get_mandate_status` | Query mandate status and remaining budget |
| `request_x402_v3_payment` | Sign an x402 v3 payment using a signed mandate |

## CLI Commands

| Command | Description |
|---------|-------------|
| `mandate-create` | Create an intent mandate |
| `mandate-status` | Query mandate status |
| `x402-v3` | Execute an x402 v3 payment |

## Integration Flow

The following is an end-to-end example of an agent fetching paid data from a Polymarket recommendations API.

---

### Your Task

> Get Polymarket trading recommendations for the last hour based on news trends and onchain smart money signals from this API:
> `https://fluxa-x402-api.gmlgtm.workers.dev/polymarket_recommendations_last_1h`

### User Intent (Spend Plan)

> I want you to complete this task end-to-end. My total budget is 0.10 USDC and it should be valid for 30 days starting now.
> If an intent mandate is required, use this intent to create the mandate (budget + time window), then have me review and sign it in the FluxA Wallet UI.

---

### Step 1 — Create an Intent Mandate

Define the spending plan and submit it to FluxA:

```bash
node fluxa-cli.bundle.js mandate-create \
  --desc "Spend up to 0.10 USDC for Polymarket trading recommendations valid for 30 days" \
  --amount 100000 \
  --seconds 2592000 \
  --category trading_data
```

**Via API:**

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

> **Note:** If you do NOT have an Agent JWT yet, call this endpoint without the Authorization header. The response will include `payment_model_context` with instructions on how to register first.

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

### Step 2 — User Signs the Mandate

Ask the user to open `authorizationUrl` in their browser. This short link has a 10-minute TTL.

The user will:
1. Review the spending plan (amount, duration, description)
2. Authorize the agent
3. Sign the mandate onchain

### Step 3 — Verify Mandate Status

Confirm the mandate is signed before proceeding:

```bash
node fluxa-cli.bundle.js mandate-status --id mand_xxxxxxxxxxxxx
```

**Via API:**

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

### Step 4 — Make the x402 v3 Payment

When the agent hits the paid API and receives HTTP 402, extract the payment requirements and sign a payment:

```bash
node fluxa-cli.bundle.js x402-v3 \
  --mandate mand_xxxxxxxxxxxxx \
  --payload '{"accepts":[{"scheme":"exact","network":"base","maxAmountRequired":"10000","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","payTo":"0xFf319473ba1a09272B37c34717f6993b3F385CD3","resource":"https://fluxa-x402-api.gmlgtm.workers.dev/polymarket_recommendations_last_1h","description":"Get Polymarket trading recommendations","extra":{"name":"USD Coin","version":"2"},"maxTimeoutSeconds":60}]}'
```

**Via API:**

```bash
curl -X POST https://walletapi.fluxapay.xyz/api/payment/x402V3Payment \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AGENT_JWT" \
  -d '{
    "mandateId": "mand_xxxxxxxxxxxxx",
    "scheme": "exact",
    "network": "base",
    "amount": "10000",
    "currency": "USDC",
    "assetAddress": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "payTo": "0xFf319473ba1a09272B37c34717f6993b3F385CD3",
    "host": "fluxa-x402-api.gmlgtm.workers.dev",
    "resource": "https://fluxa-x402-api.gmlgtm.workers.dev/polymarket_recommendations_last_1h",
    "description": "Get Polymarket trading recommendations",
    "tokenName": "USD Coin",
    "tokenVersion": "2",
    "validityWindowSeconds": 60
  }'
```

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
      "authorization": {
        "from": "0x...",
        "to": "0x...",
        "value": "10000",
        "validAfter": "1700000000",
        "validBefore": "1700000060",
        "nonce": "0x..."
      }
    }
  },
  "paymentRecordId": 123,
  "expiresAt": 1700000060
}
```

### Step 5 — Retry the API Request with X-Payment Header

Use the `xPaymentB64` value as the `X-Payment` header and retry the original request:

```bash
curl -H "X-Payment: eyJ4NDAyVmVyc2lvbi..." \
  https://fluxa-x402-api.gmlgtm.workers.dev/polymarket_recommendations_last_1h
```

The API will validate the payment and return the data.

## Flow Diagram

```
Agent                         FluxA Wallet                    User
  │                               │                             │
  │── 1. create-intent ──────────>│                             │
  │<── mandateId + authUrl ───────│                             │
  │                               │                             │
  │── 2. "Please open authUrl" ──────────────────────────────>  │
  │                               │<── 3. Sign mandate ─────── │
  │                               │                             │
  │── 4. mandate-status ─────────>│                             │
  │<── status: signed ────────────│                             │
  │                               │                             │
  │── 5. x402V3Payment ─────────>│                             │
  │<── xPaymentB64 ──────────────│                             │
  │                               │                             │
  │── 6. X-Payment: ... ────────> Merchant API                  │
  │<── 200 OK + data ──────────── Merchant API                  │
```

## Key Concepts

- **Intent Mandate** — A pre-authorized spending plan. The user signs once; the agent can make multiple payments within the approved limits.
- **Budget tracking** — FluxA tracks `spentAmount` / `remainingAmount` so the agent stays within budget.
- **Time window** — Mandates have a `validFrom` / `validUntil` window. After expiry, no further payments can be made.
- **Host allowlist** — Optionally restrict which API hosts the mandate can be used with.
