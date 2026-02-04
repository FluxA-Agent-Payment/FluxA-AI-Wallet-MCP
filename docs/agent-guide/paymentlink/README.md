# Payment Link

## What It Does

Payment Links allow AI agents to create shareable payment URLs that anyone can use to send crypto payments. Unlike payouts (where the agent sends funds), payment links are for **receiving** funds — useful for invoicing, collecting tips, charging for AI-generated content, selling digital goods, or any scenario where the agent needs to get paid.

Each payment link has a fixed amount, a unique URL, and can optionally be limited by expiration date or maximum number of uses.

## What an Agent Can Do

- **Create payment links** — Generate a URL with a specific amount, description, and optional constraints
- **List payment links** — View all payment links created by the agent
- **Get link details** — Fetch full details and status of a specific payment link
- **Update payment links** — Modify description, status, expiry, or max uses
- **Delete payment links** — Remove a payment link permanently
- **View payment records** — See who has paid via a specific link, including settlement status and transaction hashes

## Related APIs

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/payment-links` | Create a payment link |
| `GET` | `/api/payment-links` | List all payment links |
| `GET` | `/api/payment-links/:linkId` | Get payment link details |
| `PATCH` | `/api/payment-links/:linkId` | Update a payment link |
| `DELETE` | `/api/payment-links/:linkId` | Delete a payment link |
| `GET` | `/api/payment-links/:linkId/payments` | List payments received via a link |

**Base URL:** `https://walletapi.fluxapay.xyz`

## MCP Tools

| Tool | Description |
|------|-------------|
| `create_payment_link` | Create a new payment link |
| `list_payment_links` | List all payment links |
| `get_payment_link` | Get link details (optionally include payment records via `include_payments`) |
| `update_payment_link` | Update a payment link |
| `delete_payment_link` | Delete a payment link |

## CLI Commands

| Command | Description |
|---------|-------------|
| `paymentlink-create` | Create a payment link |
| `paymentlink-list` | List all payment links |
| `paymentlink-get` | Get payment link details |
| `paymentlink-update` | Update a payment link |
| `paymentlink-delete` | Delete a payment link |
| `paymentlink-payments` | View payments received via a link |

## Integration Flow

### Your Task

> I want to sell an AI-generated research report for 5 USDC. Create a payment link that can be used up to 100 times and expires in 7 days.

---

### Step 1 — Create a Payment Link

```bash
node fluxa-cli.bundle.js paymentlink-create \
  --amount "5000000" \
  --desc "AI Research Report - Crypto Market Analysis Q1 2026" \
  --max-uses 100 \
  --expires "2026-02-11T00:00:00.000Z"
```

> **Amount is in smallest units:** 5 USDC = 5,000,000 (6 decimals)

**Via API:**

```bash
curl -X POST https://walletapi.fluxapay.xyz/api/payment-links \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $AGENT_JWT" \
  -d '{
    "amount": "5000000",
    "currency": "USDC",
    "network": "base",
    "description": "AI Research Report - Crypto Market Analysis Q1 2026",
    "maxUses": 100,
    "expiresAt": "2026-02-11T00:00:00.000Z"
  }'
```

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
    "description": "AI Research Report - Crypto Market Analysis Q1 2026",
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

### Step 2 — Share the Payment Link

Give the `url` to your users:

> "Here is your payment link: https://wallet.fluxapay.xyz/pay/lnk_a1b2c3d4e5
> Price: 5 USDC. Valid until Feb 11, 2026."

### Step 3 — Check Payment Records

After users pay, check who has paid:

```bash
node fluxa-cli.bundle.js paymentlink-payments --id "lnk_a1b2c3d4e5" --limit 10
```

**Via API:**

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
      "payerAddress": "0xBuyerAddress...",
      "amount": "5000000",
      "currency": "USDC",
      "settlementStatus": "settled",
      "settlementTxHash": "0xabcdef...",
      "createdAt": "2026-02-05T10:30:00.000Z"
    }
  ]
}
```

### Step 4 — Manage the Payment Link

**Disable the link** (stop accepting new payments):

```bash
node fluxa-cli.bundle.js paymentlink-update --id "lnk_a1b2c3d4e5" --status disabled
```

**Update the description:**

```bash
node fluxa-cli.bundle.js paymentlink-update --id "lnk_a1b2c3d4e5" --desc "SOLD OUT - Report no longer available"
```

**Remove the expiry limit:**

```bash
node fluxa-cli.bundle.js paymentlink-update --id "lnk_a1b2c3d4e5" --expires null
```

**Delete the link entirely:**

```bash
node fluxa-cli.bundle.js paymentlink-delete --id "lnk_a1b2c3d4e5"
```

**List all your payment links:**

```bash
node fluxa-cli.bundle.js paymentlink-list --limit 20
```

## Flow Diagram

```
Agent                         FluxA Wallet                    Payer
  │                               │                             │
  │── 1. POST /payment-links ───>│                             │
  │<── paymentLink + url ────────│                             │
  │                               │                             │
  │── 2. Share url ──────────────────────────────────────────>  │
  │                               │<── 3. Open url & pay ────── │
  │                               │── 4. Settle onchain ──────> │
  │                               │                             │
  │── 5. GET /payments ─────────>│                             │
  │<── payment records ──────────│                             │
```

## Payment Link Fields

| Field | Type | Description |
|-------|------|-------------|
| `linkId` | string | Unique identifier for the payment link |
| `amount` | string | Payment amount in smallest units |
| `currency` | string | Currency (e.g., "USDC") |
| `network` | string | Network (e.g., "base") |
| `description` | string | Human-readable description |
| `resourceContent` | string | Optional content delivered after payment |
| `status` | string | `active` or `disabled` |
| `expiresAt` | string/null | Expiration date (ISO 8601) or null for no expiry |
| `maxUses` | number/null | Maximum payment count or null for unlimited |
| `useCount` | number | How many payments have been made |
| `url` | string | The shareable payment URL |

## Use Cases

| Scenario | Configuration |
|----------|--------------|
| **One-time invoice** | `maxUses: 1`, specific amount |
| **Subscription / recurring** | No `maxUses`, no `expiresAt` |
| **Limited-time sale** | Set `expiresAt` to sale end date |
| **Tip jar** | Small amount, no limits |
| **Digital goods** | Set `resourceContent` to delivery instructions |
| **Batch collection** | High `maxUses`, track via payment records |

## Important Notes

- **Amount** — Always in smallest units. For USDC (6 decimals): `5000000` = 5 USDC.
- **Status** — Links are `active` by default. Set to `disabled` to stop accepting payments without deleting.
- **Clearing limits** — Pass `"null"` to `--expires` or `--max-uses` in the CLI to remove the constraint.
- **Payment records** — Use `paymentlink-payments` or the `include_payments` flag in the MCP `get_payment_link` tool to view who has paid.
