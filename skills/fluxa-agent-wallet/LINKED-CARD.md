# Linked Card (VIC) Payments

Pay a merchant checkout with the **user's own card**, linked once in the FluxA
wallet UI. The agent never sees the card number. It creates a `CARD_USD` intent
mandate scoped to one merchant, the user approves it on a linked card, and the
agent pays a WPE payment attempt with `headless-checkout`.

## When to use

- A merchant / Monetize checkout hands you a **payment attempt id** (`wpa_...`)
  and the user wants to pay with their linked card.
- You need to know which cards the user has linked, or which `CARD_USD`
  mandates you already hold.

Not for: prepaid agent cards (`fluxa-wallet card ...`), x402 API payments
(`mandate-create` with USDC / credits + `x402`).

## Hard rules

- Confirm the purchase (merchant, amount, product) with the user before creating
  the mandate and before `headless-checkout`.
- Amounts are **cents**: `2000` = $20.00. `--amount` is the authorization ceiling.
- Scope the mandate to the real merchant: `--merchant-url` must be the merchant's
  HTTPS site, `--product` the item(s) the user asked for.
- Never ask the user for card numbers. Linking happens in the wallet UI only.

## Flow

```
1. fluxa-wallet linked-card list                          → user has ≥1 ACTIVE linked card?
   (none → ask the user to link a card on the wallet Cards page, then retry)
2. fluxa-wallet linked-card mandates --host <merchant host> --amount <cents>
   (an eligible signed mandate → skip to step 5)
3. fluxa-wallet mandate-create --currency CARD_USD --desc "..." --amount <cents> \
     --merchant-name "..." --merchant-url https://... --merchant-country US \
     --merchant-id <id> --merchant-category "..." --mcc <4 digits> --product <ref>:<qty>
   → returns mandateId + approvalUrl
4. Send approvalUrl to the user (see "Opening Authorization URLs" in SKILL.md).
   They pick a linked card and approve. Poll:
   fluxa-wallet linked-card subcard --mandate <mandateId>
   until status = "signed" and cardvault.canTransact = true (isReady: true)
5. fluxa-wallet headless-checkout --mandate <mandateId> --attempt <wpa_...> --billing @billing.json
   → attempt.status + attempt.actionUrl
6. If attempt.actionUrl is present: open it with the user to complete 3-D Secure.
   Then confirm the order on the merchant side.
```

Mandates default to 8 hours of validity (`--seconds` to change).

## Command reference

### `mandate-create --currency CARD_USD`

| Flag | Meaning |
|------|---------|
| `--desc` | What the user is buying (shown to the user at approval) |
| `--amount` | Ceiling in cents |
| `--merchant-name` | Merchant display name |
| `--merchant-url` | Full HTTPS URL of the merchant |
| `--merchant-country` | 2-letter country code, e.g. `US` |
| `--merchant-id` | Merchant id as known to the VIC network |
| `--merchant-category` | Merchant category label |
| `--mcc` | 4-digit merchant category code |
| `--product` | `ref:qty[,ref:qty...]`, 1-100 entries |
| `--ext` | Alternative to the flags above: JSON or `@file.json` with `{ "merchant": {...}, "vic": {...} }` |
| `--seconds` | Validity in seconds (default 28800 = 8h) |

Local validation rejects bad input before any call, with the field name in the
error. The response has `mandateId` and `approvalUrl`.

### `linked-card list [--limit <n>] [--cursor <c>]`

Prints `{ cards: [{ id, brand, last4, expMonth, expYear, status }], nextCursor }`.
Use `id` as `--card` below.

### `linked-card mandates [--card <id>] | [--host <host> --amount <cents>]`

- no flags: every `CARD_USD` mandate with status and remaining budget
- `--card`: only mandates approved on that linked card
- `--host --amount`: only signed mandates that can pay that amount now

### `linked-card subcard --mandate <id>`

Prints the credential issued under the mandate:

```json
{
  "mandateId": "mand_...",
  "status": "signed",
  "isReady": true,
  "approvalUrl": null,
  "sourceCardId": "…",
  "cardActivatedAt": "…",
  "remainingAmount": "2000",
  "validUntil": "…",
  "merchant": { "name": "…", "url": "…", "country_code": "US" },
  "cardvault": { "status": "MANDATE_ACTIVE", "canTransact": true, "canStartCredentialRequest": true, "validUntil": "…" }
}
```

`isReady` is true when the wallet mandate is signed and CardVault can transact.
`cardvault` is `null` when CardVault could not be reached; retry shortly.

### `headless-checkout --mandate <id> --attempt <wpa_...> [--billing <json | @file>]`

`billing` fields: `firstName, lastName, address1, address2, city, state,
country, zip, phone, email`. Result:

```json
{ "success": true, "data": { "mandateId": "mand_...", "attempt": { "attemptId": "wpa_...", "status": "PSP_PENDING", "actionUrl": null }, "nextStep": "..." } }
```

## Errors

| Error | What to do |
|-------|------------|
| `Linked cards are not available for this wallet` | The user's wallet is not enabled for linked cards. Ask them to check the Cards page in the FluxA wallet; do not retry blindly. |
| `card_mandate_not_active` (with `mandateStatus`, `approvalUrl`) | Mandate not signed / disabled / expired. Send `approvalUrl` to the user or create a new mandate. |
| `card_execution_mode_mismatch` | Not a linked-card mandate. Use `linked-card mandates` to pick one. |
| `invalid_attempt_id` | Pass the `wpa_...` id from the merchant checkout. |
| `Invalid CARD_USD mandate: <field> ...` | Fix the flag named in the message. |
