# Linked Card (Visa AgentCard) Payments

Pay a merchant checkout with the **user's own card**, linked once in the FluxA
wallet UI. The user approves a `CARD_USD` mandate scoped to one merchant. The
agent can pay a WPE attempt with `headless-checkout` or issue a single-use card
under the mandate for a checkout that accepts CardVault credentials.

## When to use

- A merchant / Monetize checkout hands you a **payment attempt id** (`wpa_...`)
  and the purchase supports Card. Recommend this route by default unless the
  user has chosen another payment method.
- You need to know which cards the user has linked, or which `CARD_USD`
  mandates you already hold.
- The user authorized a card purchase and the merchant supports single-use
  credentials, for example when entering card details in a browser checkout.

Not for: prepaid agent cards (`fluxa-wallet prepaid-card ...`), x402 API payments
(`mandate-create` with USDC + `x402`).

## Hard rules

- Present the purchase (merchant, amount, product) in the mandate approval
  request. Send the approval link directly and wait for signing; the signed
  mandate authorizes payments within that scope without another chat confirmation.
- Amounts are **cents**: `2000` = $20.00. `--amount` is the authorization ceiling.
- Scope the mandate to the real merchant: `--merchant-url` must be the merchant's
  HTTPS site and `--merchant-name` the name approved for it on the CardVault side.
- Never ask the user for card numbers. Linking happens in the wallet UI only.

## Flow

```
1. fluxa-wallet linked-card list                          → inspect available cards
   (if none, the mandate approval UI can bind a card; recommend USDC second
    when the user has no usable card, and obtain matching authorization)
2. fluxa-wallet linked-card mandates --host <merchant host> --amount <cents>
   (an eligible signed mandate → skip to step 5)
3. fluxa-wallet mandate-create --currency CARD_USD --desc "..." --amount <cents> \
     --merchant-name Amazon --merchant-url https://www.amazon.com --merchant-country US
   → returns mandateId + approvalUrl
4. Send approvalUrl to the user (see "Opening Authorization URLs" in SKILL.md).
   They pick a linked card and approve. Poll:
   fluxa-wallet mandate-status --id <mandateId>
   until mandate.status is "signed" and mandate.cardvault.canTransact is true
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
| `--desc` | What the user is buying. Sent to CardVault as the purpose: max 255 bytes, no line breaks |
| `--amount` | Ceiling in cents (`3000` = $30.00) |
| `--merchant-name` | Merchant name, max 40 bytes. Must match the merchant profile approved on the CardVault side (e.g. `Amazon`) |
| `--merchant-url` | Full HTTPS URL of the merchant site (e.g. `https://www.amazon.com`) |
| `--merchant-country` | 2-letter country code, e.g. `US` |
| `--transaction-ref` | Optional order / transaction reference, max 50 bytes |
| `--ext` | Alternative to the flags above: JSON or `@file.json` with `{ "merchant": { "name", "url", "country_code" }, "transaction_reference_id"? }` |
| `--seconds` | Validity in seconds (default 28800 = 8h) |

Local validation rejects bad input before any call, with the flag name in the
error. The response has `mandateId` and `approvalUrl`. If approval fails with
`MERCHANT_DETAILS_MISMATCH` / `MERCHANT_NOT_AVAILABLE`, the merchant name / URL /
country do not match a profile approved on the CardVault side.

### `linked-card list [--limit <n>] [--cursor <c>]`

Prints `{ cards: [{ id, brand, last4, expMonth, expYear, status }], nextCursor }`.
Use `id` as `--card` below.

### `linked-card mandates [--card <id>] | [--host <host> --amount <cents>]`

- no flags: every `CARD_USD` mandate with status and remaining budget
- `--card`: only mandates approved on that linked card
- `--host --amount`: only signed mandates that can pay that amount now

### `linked-card single-use-card create`

```bash
fluxa-wallet linked-card single-use-card create --mandate mand_xxx --amount 1234 \
  --transaction-ref order-1 --output-file /tmp/linked-card.json
```

Pass a signed VIC `CARD_USD` mandate and the purchase amount in cents. Omit
`--transaction-ref` to generate a reference. Keep the returned reference and
original amount for retries. Each new reference reserves the amount again.

Prefer `--output-file` with a new path. The CLI writes the credential as JSON
with mode `0600` and prints the path and card metadata. Pass the file path to the
authorized consumer and keep the credential out of chat and logs. Without a file
path, stdout includes a `credential` object with `pan`, `exp_month`, `exp_year`,
`dynamic_value`, `dynamic_data_type` and `credential_expires_at`. The current
`dynamic_value` is an encrypted DAVV.

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
