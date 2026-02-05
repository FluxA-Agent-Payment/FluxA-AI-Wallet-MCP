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

## Paying TO a Payment Link (Programmatic x402)

To pay a payment link programmatically (agent-to-agent payments), use the x402 flow. This section covers both **CLI** and **REST API** methods.

### End-to-End Flow

```
1. Fetch the payment link URL → receive HTTP 402 with payment requirements
2. Create a mandate for the payment amount → user signs at authorizationUrl
3. Execute x402-v3 payment with the 402 payload → receive xPaymentB64 token
4. Submit payment with X-Payment header → payment completes
```

---

### Method 1: CLI (Recommended)

#### Step 1 — Fetch Payment Requirements

```bash
# Fetch the payment link to get the 402 payload
PAYMENT_LINK_URL="https://walletapi.fluxapay.xyz/paymentlink/pl_xxxxxxxxxxxxx"
PAYLOAD_402=$(curl -s "$PAYMENT_LINK_URL")
echo "$PAYLOAD_402"
```

**Example 402 response:**

```json
{
  "error": "Payment Required",
  "x402Version": 2,
  "accepts": [{
    "scheme": "exact",
    "network": "eip155:8453",
    "maxAmountRequired": "100000",
    "resource": "/paymentlink/pl_xxxxxxxxxxxxx",
    "description": "Payment link for 0.1 USDC",
    "payTo": "0x...",
    "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    "maxTimeoutSeconds": 60
  }]
}
```

Note the `maxAmountRequired` (in atomic units) — you'll need this for the mandate.

**Important:** Save the full response in a variable — you'll need the complete JSON (with `accepts` array) for Step 4:

```bash
PAYLOAD_402=$(curl -s "$PAYMENT_LINK_URL")
```

#### Step 2 — Create a Mandate

**Both `--desc` and `--amount` are required:**

```bash
node scripts/fluxa-cli.bundle.js mandate-create \
  --desc "Pay 0.1 USDC to payment link pl_xxxxxxxxxxxxx" \
  --amount 100000 \
  --seconds 3600 \
  --category payment_link
```

**Output:**

```json
{
  "success": true,
  "data": {
    "mandateId": "mand_xxxxxxxxxxxxx",
    "authorizationUrl": "https://agentwallet.fluxapay.xyz/onboard/intent?oid=...",
    "expiresAt": "2026-02-05T00:10:00.000Z"
  }
}
```

**Opening the authorization URL** (see [SKILL.md](SKILL.md) — "Opening Authorization URLs"):

1. Ask the user using `AskUserQuestion`:
   - Question: "I need to open the authorization URL to sign the mandate for this payment."
   - Options: ["Yes, open the link", "No, show me the URL"]

2. If YES: Run `open "<authorizationUrl>"` to open in their browser

3. Wait for user to confirm they've signed, then proceed to Step 3.

#### Step 3 — Verify Mandate is Signed

**Use `--id`, not `--mandate`:**

```bash
node scripts/fluxa-cli.bundle.js mandate-status --id mand_xxxxxxxxxxxxx
```

Wait until `mandate.status` is `"signed"`.

#### Step 4 — Execute x402 Payment

Pass the **complete** 402 response as `--payload` (must include `accepts` array):

```bash
node scripts/fluxa-cli.bundle.js x402-v3 \
  --mandate mand_xxxxxxxxxxxxx \
  --payload "$PAYLOAD_402"
```

**Critical:** The `$PAYLOAD_402` variable must contain the full JSON response from Step 1, including the `accepts` array. Do NOT pass just extracted fields like `{"maxAmountRequired":"100000"}` — this will fail with "Invalid payload: missing accepts array".

**Output:**

```json
{
  "success": true,
  "data": {
    "xPaymentB64": "eyJ4NDAyVmVyc2lvbi...",
    "paymentRecordId": "1234",
    "expiresAt": 1700000060
  }
}
```

#### Step 5 — Submit Payment to Link

```bash
curl -s -H "X-Payment: eyJ4NDAyVmVyc2lvbi..." \
  "https://walletapi.fluxapay.xyz/paymentlink/pl_xxxxxxxxxxxxx"
```

**Success response:**

```json
{
  "status": "success",
  "resource": null,
  "receipt": {
    "txHash": "0xabcdef...",
    "payer": "0x...",
    "amount": "100000",
    "currency": "USDC"
  }
}
```

---

### Method 2: REST API

#### Step 1 — Fetch Payment Requirements

```bash
PAYMENT_LINK_URL="https://walletapi.fluxapay.xyz/paymentlink/pl_xxxxxxxxxxxxx"
PAYLOAD_402=$(curl -s "$PAYMENT_LINK_URL")
```

#### Step 2 — Create a Mandate

```bash
curl -X POST "https://walletapi.fluxapay.xyz/api/mandates/create-intent" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{
    "naturalLanguage": "Pay up to 0.1 USDC to payment link",
    "limitAmount": "100000",
    "validForSeconds": 3600,
    "category": "payment_link"
  }'
```

**Response:**

```json
{
  "status": "ok",
  "mandateId": "mand_xxxxxxxxxxxxx",
  "authorizationUrl": "https://agentwallet.fluxapay.xyz/onboard/intent?oid=...",
  "expiresAt": "2026-02-04T00:10:00.000Z"
}
```

**Opening the authorization URL** (see [SKILL.md](SKILL.md) — "Opening Authorization URLs"):

1. Ask the user using `AskUserQuestion`:
   - Question: "I need to open the authorization URL to sign the mandate for this payment."
   - Options: ["Yes, open the link", "No, show me the URL"]

2. If YES: Run `open "<authorizationUrl>"` to open in their browser

3. Wait for user to confirm they've signed, then proceed to Step 3.

#### Step 3 — Get X-Payment Token

Once the mandate is signed, generate an x402 payment token. Extract the `accepts` array from the 402 payload:

```bash
curl -X POST "https://walletapi.fluxapay.xyz/api/payment/x402V3Payment" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $JWT" \
  -d '{
    "mandateId": "mand_xxxxxxxxxxxxx",
    "payload402": {
      "accepts": [{
        "scheme": "exact",
        "network": "eip155:8453",
        "maxAmountRequired": "100000",
        "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
        "payTo": "0xRecipientAddress...",
        "resource": "/paymentlink/pl_xxxxxxxxxxxxx",
        "description": "Payment link for 0.1 USDC",
        "maxTimeoutSeconds": 60
      }]
    }
  }'
```

**Response:**

```json
{
  "status": "ok",
  "xPaymentB64": "eyJ4NDAyVmVyc2lvbi...",
  "xPayment": { "x402Version": 1, "scheme": "exact", "..." },
  "paymentRecordId": 123,
  "expiresAt": 1700000060
}
```

#### Step 4 — Submit Payment to Link

```bash
curl -s -H "X-Payment: eyJ4NDAyVmVyc2lvbi..." \
  "https://walletapi.fluxapay.xyz/paymentlink/pl_xxxxxxxxxxxxx"
```

The payment link will process the x402 payment and deliver any `resource` content.

---

### Complete CLI Script

```bash
#!/bin/bash
CLI="node scripts/fluxa-cli.bundle.js"
PAYMENT_LINK_URL="https://walletapi.fluxapay.xyz/paymentlink/pl_xxxxxxxxxxxxx"

# Step 1: Fetch 402 payload
PAYLOAD_402=$(curl -s "$PAYMENT_LINK_URL")
AMOUNT=$(echo "$PAYLOAD_402" | jq -r '.accepts[0].maxAmountRequired')

echo "Payment required: $AMOUNT atomic units"

# Step 2: Create mandate
MANDATE_RESULT=$($CLI mandate-create \
  --desc "Pay to payment link" \
  --amount "$AMOUNT" \
  --seconds 3600 \
  --category payment_link)

MANDATE_ID=$(echo "$MANDATE_RESULT" | jq -r '.data.mandateId')
AUTH_URL=$(echo "$MANDATE_RESULT" | jq -r '.data.authorizationUrl')

echo "Please authorize at: $AUTH_URL"
echo "Press Enter after signing..."
read

# Step 3: Verify mandate is signed
STATUS=$($CLI mandate-status --id "$MANDATE_ID" | jq -r '.data.mandate.status')
if [ "$STATUS" != "signed" ]; then
  echo "Mandate not signed. Status: $STATUS"
  exit 1
fi

# Step 4: Execute x402 payment
PAYMENT_RESULT=$($CLI x402-v3 --mandate "$MANDATE_ID" --payload "$PAYLOAD_402")
XPAYMENT=$(echo "$PAYMENT_RESULT" | jq -r '.data.xPaymentB64')

# Step 5: Submit payment
RECEIPT=$(curl -s -H "X-Payment: $XPAYMENT" "$PAYMENT_LINK_URL")
echo "Payment result:"
echo "$RECEIPT" | jq
```

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
