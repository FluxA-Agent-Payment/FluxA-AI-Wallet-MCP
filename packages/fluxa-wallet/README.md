# @fluxa-pay/fluxa-wallet

FluxA Agent Wallet CLI — payments, payouts, and payment links for AI agents.

## Install

```bash
npm install -g @fluxa-pay/fluxa-wallet
```

## Usage

```bash
fluxa-wallet <command> [options]
```

## Commands

| Command | Description |
|---------|-------------|
| `status` | Check agent configuration status |
| `init` | Register a new agent ID |
| `refreshJWT` | Refresh expired JWT and print new token |
| `mandate-create` | Create an intent mandate |
| `mandate-status` | Query mandate status |
| `x402-v3` | Execute x402 v3 payment |
| `payout` | Create a payout |
| `payout-status` | Query payout status |
| `paymentlink-create` | Create a payment link |
| `paymentlink-list` | List payment links |
| `paymentlink-get` | Get payment link details |
| `paymentlink-update` | Update a payment link |
| `paymentlink-delete` | Delete a payment link |
| `paymentlink-payments` | Get payment records for a link |
| `help` | Show usage information |

## Quick Start

```bash
# Register your agent
fluxa-wallet init --name "My AI Agent" --client "Agent v1.0"

# Check status
fluxa-wallet status

# Create an intent mandate
fluxa-wallet mandate-create --desc "Spend up to 0.10 USDC" --amount 100000

# Make an x402 payment
fluxa-wallet x402-v3 --mandate mand_xxx --payload '{"accepts":[...]}'

# Send a payout
fluxa-wallet payout --to 0x... --amount 1000000 --id payout_001

# Create a payment link
fluxa-wallet paymentlink-create --amount 5000000 --desc "AI Report"
```

## Output Format

All commands output JSON to stdout:

```json
{ "success": true, "data": { ... } }
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
