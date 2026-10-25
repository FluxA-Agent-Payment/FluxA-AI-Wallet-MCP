# @fluxa-pay/fluxa-wallet

FluxA Agent Wallet CLI — x402 payments, payouts, payment links, refunds, prepaid cards, and account reads for AI agents.

## Install

```bash
npm install -g @fluxa-pay/fluxa-wallet
fluxa-wallet --version
```

## Usage

```bash
fluxa-wallet <command> [options]
fluxa-wallet <command> --help     # full options for any command
```

## Commands

### Account & status (read-only)

| Command | Description |
|---------|-------------|
| `status` | Local agent configuration status |
| `wallet-address` | Linked user's wallet address (prints the address) |
| `balance` | Linked wallet balances — USDC / XRP / credits |
| `mandates` | List mandates with limit / spent / remaining |
| `recent-transactions` | Recent transactions — USDC / XRP / credits spends (`--limit`, 1-100) |
| `check-wallet` | Whether the agent is linked to a user's wallet |
| `version` | Print the CLI version (also `--version`, `-v`) |

### Setup

| Command | Description |
|---------|-------------|
| `init` | Register a new agent ID (`--name`, `--client`) |
| `refreshJWT` | Refresh the JWT and print the new token |
| `link-wallet` | Get the wallet-linking URL (or confirm already linked) |

### x402 payments

| Command | Description |
|---------|-------------|
| `x402` | Execute an x402 payment (delegates to v3; `--mandate`, `--payload`) |
| `x402-v3` | Execute an x402 v2/v3 payment (`--mandate`, `--payload`) |
| `mandate-create` | Create an intent mandate (`--desc`, `--amount`; `--currency CARD_USD` plus merchant flags for a linked-card mandate) |
| `mandate-status` | Query a mandate by id (`--id`) |

### AgentMarket model Units

```bash
fluxa-wallet market model remainingUsage
fluxa-wallet market model usageHistory
# New mandate: wait for the user to approve the authorization URL
fluxa-wallet market model topup --bundle starter --usdc
# Existing approved mandate: pay without creating or signing another mandate
fluxa-wallet market model topup --bundle starter --mandate mand_xxx
```

With `--mandate`, the payment currency follows the mandate (USDC or Monetize
Credits). An explicit `--usdc` or `--credit` must match it. The command checks
mandate status, validity, and remaining allowance; the wallet enforces the
payment authorization. Invalid mandates fail without creating a replacement.
`--budget` and `--seconds` apply only to new mandates and cannot be combined
with `--mandate`. Without `--mandate`, the default remains Monetize Credits.

For scheduled top-ups, obtain approval of the trigger, bundle, currency, and
spending scope first. A mandate alone does not authorize unrelated purchases.
After an uncertain payment result, check usage history before retrying:
re-running this command creates a new top-up order.

### Linked cards (VIC)

The user links their own card in the wallet UI; the agent reads it and pays
with a signed `CARD_USD` mandate.

| Command | Description |
|---------|-------------|
| `linked-card list` | List the linked (source) cards in the user's wallet (`--limit`, `--cursor`) |
| `linked-card mandates` | List `CARD_USD` mandates: all, per card (`--card`), or eligible for an amount (`--host`, `--amount`) |
| `linked-card subcard` | Show the credential issued under one `CARD_USD` mandate (`--mandate`) |
| `headless-checkout` | Pay a WPE payment attempt with a signed `CARD_USD` mandate (`--mandate`, `--attempt`, `--billing`) |

### Payouts

| Command | Description |
|---------|-------------|
| `payout` | Send USDC to a wallet address (`--to`, `--amount`, `--id`) |
| `payout-status` | Query a payout (`--id`) |

### Payment links (receiving)

| Command | Description |
|---------|-------------|
| `paymentlink-create` | Create a payment link (`--amount`) |
| `paymentlink-list` | List payment links |
| `paymentlink-get` | Get a payment link (`--id`) |
| `paymentlink-update` | Update a payment link (`--id`) |
| `paymentlink-delete` | Delete a payment link (`--id`) |
| `paymentlink-payments` | Payments received on a link (`--id`) |
| `received-records` | All received payment records |
| `received-record` | A single received record (`--id`) |
| `paymentlink-refund-create` | Initiate a refund (`--payment-id`) |
| `paymentlink-refund-list` | List refunds |
| `paymentlink-refund-get` | Get a refund (`--id`) |
| `paymentlink-refund-cancel` | Cancel a pending refund (`--id`) |

### Prepaid cards

| Command | Description |
|---------|-------------|
| `card types` | List published products, BINs, fees, limits, and availability |
| `card create` | Issue a card with one product selector, `--amount`, `--mandate`; continue with `--request-id` |
| `card list` | List cards created by this agent (`--global` for the linked account) |
| `card details` | Reveal PAN / CVV / expiry (`--id`) |
| `card balance` | Refresh & show card balance (`--id`) |
| `card transactions` | List card transaction history (`--id`, optional filters) |
| `card 3ds latest` | Show the latest 3DS challenge (`--id`) |
| `card 3ds latest_1h` | Show 3DS challenges from the last hour (`--id`) |
| `card holder create` | Create a complete account profile and start KYC (`--profile @profile.json` or individual fields) |
| `card holder update` | Partially update the profile (`--profile @patch.json`, optional `--revision`) |
| `card holder me` | Show the account profile, KYC status, verification URL, and next action |
| `card recharge` | Add funds (`--id`, `--amount`, `--mandate`); continue with `--request-id` |
| `card withdraw` | Withdraw card balance (`--id`, optional `--amount`) |
| `card withdrawals` | List card withdrawals (`--id`) |
| `card withdrawal` | Get one card withdrawal (`--id`, `--withdrawal-id`) |

Card calls use `/api/v2` with a challenge-bound Agent VC. A new issuance must
select exactly one of `--card-type-id`, `--bin-id`, or `--bin`; get string IDs
from `card types`. Unknown fees remain unknown. Catalog availability does not
grant account Prepaid access, and Visa approval does not grant Prepaid access.

Create/recharge wait for up to 30 seconds by default (`--wait 0..300`). `--wait 0`
skips waiting; a payable request still gets signed and completed. If review or
settlement remains pending, output contains `pendingRequestId`, `status`, and
`continueCommand`. Continue with the same command and `--request-id`; omit the
original amount/product selector. Recharge infers its card ID from the request,
or accepts the original `--id`. A submitted payment is only polled, never signed
again automatically. Use `card list` to see issued cards and `card balance` to
refresh a recharge result. Card lists contain cards, not pending applications.

A `card_waitlist_required` error returns the application URL when available.
Apply once in Wallet and retry after Prepaid approval/synchronization. A
`card_access_unavailable` error means retry later. Neither error starts payment.

`profile.json` contains `firstName`, `lastName`, `email`, E.164 `phone`, and
`address:{country,city,line1,postalCode,region?,line2?}`. Use the real account
owner's materials. Creation starts KYC; complete the returned `verificationUrl`
and check `card holder me`. An approved legacy holder (`source:"legacy"`,
`kycStatus:"not_recorded"`) can continue with its approved product without
creating a new profile. Updates are partial; `--revision` sends `If-Match`.

### Identity

| Command | Description |
|---------|-------------|
| `agent-vc` | Issue a short-lived agent VC for a third party (`--audience`, `--challenge`) |

Run `fluxa-wallet <command> --help` for the complete option list of any command.

## Quick Start

```bash
# Register your agent
fluxa-wallet init --name "My AI Agent" --client "Agent v1.0"

# Check the linked wallet and balances
fluxa-wallet wallet-address
fluxa-wallet balance
fluxa-wallet check-wallet

# Create an intent mandate, then pay an x402 API
fluxa-wallet mandate-create --desc "Spend up to 0.10 USDC" --amount 100000
fluxa-wallet x402 --mandate mand_xxx --payload '{"accepts":[...]}'

# Linked card: CARD_USD mandate for one merchant, user approves in the wallet, then pay
fluxa-wallet mandate-create --currency CARD_USD --desc "Buy a USB-C cable on Amazon, up to $30" --amount 3000 \
  --merchant-name Amazon --merchant-url https://www.amazon.com --merchant-country US
fluxa-wallet linked-card list
fluxa-wallet linked-card mandates --host www.amazon.com --amount 3000
fluxa-wallet linked-card subcard --mandate mand_xxx
fluxa-wallet headless-checkout --mandate mand_xxx --attempt wpa_xxx --billing @billing.json

# AgentCard v2: inspect the existing holder before creating a profile
fluxa-wallet card holder me
# Only if absent: use the real account owner's profile and complete verificationUrl
fluxa-wallet card holder create --profile @profile.json
fluxa-wallet card types
fluxa-wallet card create --card-type-id <cardTypeId> --amount 25.00 --mandate mand_xxx
# If still pending, continue the original request (no new purchase intent)
fluxa-wallet card create --request-id <pendingRequestId> --mandate mand_xxx
fluxa-wallet card list
fluxa-wallet card list --global
fluxa-wallet card transactions --id card_xxx
fluxa-wallet card 3ds latest --id card_xxx
fluxa-wallet card 3ds latest_1h --id card_xxx

# Send a payout
fluxa-wallet payout --to 0x... --amount 1000000 --id payout_001

# Receive: create a payment link
fluxa-wallet paymentlink-create --amount 5000000 --desc "AI Report"
```

## Output Format

Most commands print a JSON envelope:

```json
{ "success": true, "data": { ... } }
```

The read commands `wallet-address`, `balance`, `mandates`, `recent-transactions`,
and successful `card ...` commands print their value **directly** — a bare
address string or bare JSON — without the `{success,data}` wrapper, so they're
easy to pipe. `card list` prints the cards array directly. `version` prints just
the version string. On error, every command falls back to:

```json
{ "success": false, "error": "..." }
```

Exit code `0` = success, `1` = failure.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AGENT_ID` | Pre-configured agent ID |
| `AGENT_TOKEN` | Pre-configured agent token |
| `AGENT_JWT` | Pre-configured agent JWT |
| `AGENT_NAME` | Agent name for auto-registration |
| `CLIENT_INFO` | Client info for auto-registration |
| `FLUXA_DATA_DIR` | Custom data directory (default: `~/.fluxa-ai-wallet-mcp`) |
| `WALLET_API` | Wallet API base URL |
| `AGENT_ID_API` | Agent ID API base URL |
| `CARD_SERVICE_API` | AgentCard API base URL (default: `https://agentcard.fluxapay.xyz`) |

## Related

- [`@fluxa-pay/fluxa-wallet-mcp`](https://www.npmjs.com/package/@fluxa-pay/fluxa-wallet-mcp) — MCP server for AI agent frameworks (Claude Desktop, etc.)

## License

Apache-2.0

## Manual npm release

Run from the repository root. The CLI package version is in
`packages/fluxa-wallet/package.json`; the root package is the separate MCP package.

```bash
npm ci
npm test
node packages/fluxa-wallet/bin/fluxa-wallet.js --version
cd packages/fluxa-wallet
npm pack --dry-run
npm whoami --registry https://registry.npmjs.org
# If not logged in:
npm login --registry https://registry.npmjs.org
npm publish --access public --registry https://registry.npmjs.org
npm view @fluxa-pay/fluxa-wallet@0.5.3 version --registry https://registry.npmjs.org
npm install -g @fluxa-pay/fluxa-wallet@0.5.3 --registry https://registry.npmjs.org
fluxa-wallet --version
fluxa-wallet card create --help
```

`npm test` builds both packages and runs mocked card-flow and CLI tests, including model top-ups. Verify the
pack output contains `bin/fluxa-wallet.js` before publishing. This releases
`@fluxa-pay/fluxa-wallet` only; MCP publication and wallet Skill installation
updates are separate. Repository Skill changes must also be installed by consumers.
