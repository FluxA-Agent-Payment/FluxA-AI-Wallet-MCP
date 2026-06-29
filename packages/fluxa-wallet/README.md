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
| `mandate-create` | Create an intent mandate (`--desc`, `--amount`) |
| `mandate-status` | Query a mandate by id (`--id`) |

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
| `card create` | Issue a funded virtual card (`--amount`, `--mandate`) |
| `card list` | List cards |
| `card details` | Reveal PAN / CVV / expiry (`--id`) |
| `card balance` | Refresh & show card balance (`--id`) |

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

# Create an intent mandate, then pay an x402 API
fluxa-wallet mandate-create --desc "Spend up to 0.10 USDC" --amount 100000
fluxa-wallet x402 --mandate mand_xxx --payload '{"accepts":[...]}'

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

The read commands `wallet-address`, `balance`, `mandates`, and `recent-transactions`
print their value **directly** — a bare address string or bare JSON — without the
`{success,data}` wrapper, so they're easy to pipe. `version` prints just the version
string. On error, every command falls back to:

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

## Related

- [`@fluxa-pay/fluxa-wallet-mcp`](https://www.npmjs.com/package/@fluxa-pay/fluxa-wallet-mcp) — MCP server for AI agent frameworks (Claude Desktop, etc.)

## License

Apache-2.0
