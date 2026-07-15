#!/usr/bin/env node
/**
 * FluxA Wallet CLI
 * Standalone command-line interface for FluxA Wallet operations
 * Can be bundled into a single file with esbuild for distribution
 */

import { runMarketCommand, topupInitiate, topupFinalize } from './market/client.js';
import {
  registerAgent,
  createPayout,
  getPayoutStatus,
  refreshJWT,
  isJWTExpired,
  extractHost,
  getCurrencyFromAsset,
  createIntentMandate,
  getMandateStatus,
  requestX402V3Payment,
  requestX402V2Payment,
  createPaymentLink,
  listPaymentLinks,
  getPaymentLink,
  updatePaymentLink,
  deletePaymentLink,
  getPaymentLinkPayments,
  getCardServiceVc,
  listCards,
  initiateCard,
  completeCard,
  getCardDetails,
  getCardBalance,
  listCardTransactions,
  getLatestCard3ds,
  listLatestHourCard3ds,
  createCardholder,
  getCardholder,
  initiateCardRecharge,
  completeCardRecharge,
  requestCardWithdrawal,
  listCardWithdrawals,
  getCardWithdrawal,
  listReceivedPayments,
  getReceivedPayment,
  checkWalletLinked,
  buildLinkWalletUrl,
  resolveCurrency,
  SUPPORTED_CURRENCIES,
  initiateRefund,
  listRefunds,
  getRefund,
  cancelRefund,
  issueVC,
  getAgentSelfStatus,
} from './wallet/client.js';
import {
  getEffectiveAgentId,
  hasAgentId,
  saveAgentId,
  updateJWT,
  getRegistrationInfoFromEnv,
  hasRegistrationInfo,
} from './agent/agentId.js';
import { ensureDataDirs, loadConfig, recordAudit } from './store/store.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Default asset configuration
const DEFAULT_NETWORK = 'base';
const DEFAULT_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base

// CLI version, read at runtime from the package.json shipped alongside this file
// (packages/fluxa-wallet/package.json in the published bundle), so a single version
// bump there keeps `fluxa-wallet --version` in sync — no second place to update.
function resolveVersion(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}
const CLI_VERSION = resolveVersion();

interface CommandResult {
  success: boolean;
  data?: any;
  error?: string;
  code?: string;
  details?: any;
  // When set on a successful result, print this string verbatim instead of the
  // {success,data} JSON envelope — for human/agent-facing read commands.
  raw?: string;
}

function printUsage() {
  console.log(`
FluxA Wallet CLI - Standalone command-line tool for FluxA Wallet operations

USAGE:
  fluxa-wallet <command> [options]

COMMANDS:
  status                    Check agent configuration status
  init                      Initialize/register agent ID
  refreshJWT                Refresh expired JWT and print new token
  card list                 List cards created by this agent
  card create               Issue a funded card
  card details              Reveal full card details
  card balance              Refresh and query card balance
  card transactions         List card transaction history
  card 3ds latest           Show the latest 3DS challenge from the last 24 hours
  card 3ds latest_1h        Show 3DS challenges from the last hour
  card holder create        Set up the account cardholder once
  card holder me            Show the account cardholder
  card recharge             Add funds to an existing card
  card withdraw             Withdraw card balance back to the agent wallet
  card withdrawals          List withdrawals for a card
  card withdrawal           Get one withdrawal for a card
  payout                    Create a payout
  payout-status             Query payout status
  x402                      Generate x402 payment (delegates to x402-v3)
  mandate-create            Create an intent mandate for x402 v3
  mandate-status            Query mandate status
  x402-v3                   Generate x402 v2/v3 payment with mandate
  paymentlink-create        Create a payment link
  paymentlink-list          List payment links
  paymentlink-get           Get payment link details
  paymentlink-update        Update a payment link
  paymentlink-delete        Delete a payment link
  paymentlink-payments      Get payment records for a payment link
  paymentlink-refund-create Initiate a refund for a payment link payment
  paymentlink-refund-list   List all payment link refunds
  paymentlink-refund-get    Get payment link refund details
  paymentlink-refund-cancel Cancel a pending payment link refund
  received-records          List all received payment records
  received-record           Get a single received payment record detail
  check-wallet              Check if agent is linked to user's wallet
  link-wallet               Get wallet linking URL (or confirm already linked)
  agent-vc                  Issue an agent verifiable credential (VC) for a third party
  wallet-address            Show the linked user's wallet address
  balance                   Show the linked wallet's balances (USDC / XRP / credits)
  mandates                  List the agent's mandates with limit / spent / remaining
  recent-transactions       List recent transactions (USDC / XRP / credits spends)
  version                   Print the CLI version (also --version, -v)

MARKETPLACE COMMANDS:
  plan-tool-use "<task>"    Recommend the models, APIs and skills for a task
  market search "<q>"       Discover resources (add --models or --vendors to scope)
  market model remainingUsage [vendor]   Prepaid Units balance per merchant
  market model topup <vendor>            Prepay Units to a merchant (x402)
  market model usageHistory <vendor>     Spend and topup history
  market keys [create|update <id>|revoke <id>]   Manage fxa_live_ API keys (Agent VC only)
  market info [topic]       Explain how the marketplace works

OPTIONS FOR 'init':
  --name <name>             Agent name
  --client <info>           Client info description
  (Or set AGENT_NAME, CLIENT_INFO environment variables)

OPTIONS FOR 'payout':
  --to <address>            Recipient address (required)
  --amount <amount>         Amount in smallest units (required)
  --id <payout_id>          Unique payout ID (required)
  --network <network>       Network (default: base)
  --asset <address>         Asset contract address (default: USDC)
  --mandate <mandate_id>    Signed mandate ID for auto-approval (optional)
  --biz-id <biz_id>         External business ID for dedup (optional)
  --description <text>      Human-readable description (optional)

OPTIONS FOR 'card list':
  --global                  Show all cards in the linked account, not just this agent's cards

OPTIONS FOR 'card create':
  --amount <usd>            Card amount in USD, human-readable (required)
  --mandate <mandate_id>    Mandate ID for x402 payment (required)

OPTIONS FOR 'card details':
  --id <card_id>            Card ID (required)

OPTIONS FOR 'card balance':
  --id <card_id>            Card ID (required)

OPTIONS FOR 'card transactions':
  --id <card_id>            Card ID (required)
  --type <type>             purchase | refund | verification | reversal | fee
  --page <n>                Page number (alias: --page-num)
  --limit <n>               Page size, max 50 (alias: --page-size)
  --start-time <ms>         Start timestamp in milliseconds
  --end-time <ms>           End timestamp in milliseconds

OPTIONS FOR 'card 3ds latest':
  --id <card_id>            Card ID (required)

OPTIONS FOR 'card 3ds latest_1h':
  --id <card_id>            Card ID (required)

OPTIONS FOR 'card holder create':
  --first-name <name>       Cardholder first name (required, immutable after approval)
  --last-name <name>        Cardholder last name (required, immutable after approval)
  --country <country>       ISO 3166-1 alpha-2 country code (default: US)

OPTIONS FOR 'card recharge':
  --id <card_id>            Card ID (required)
  --amount <usd>            Recharge amount in USD, human-readable (required)
  --mandate <mandate_id>    Mandate ID for x402 payment (required)

OPTIONS FOR 'card withdraw':
  --id <card_id>            Card ID (required)
  --amount <usd>            Withdrawal amount in USD (optional; defaults to full remaining balance)

OPTIONS FOR 'card withdrawals':
  --id <card_id>            Card ID (required)

OPTIONS FOR 'card withdrawal':
  --id <card_id>            Card ID (required)
  --withdrawal-id <id>      Withdrawal ID (required)

OPTIONS FOR 'payout-status':
  --id <payout_id>          Payout ID to query (required)

OPTIONS FOR 'x402':
  --mandate <mandate_id>    Mandate ID (required)
  --payload <json>          Full x402 payment payload as JSON (required)
  (Same as x402-v3 — x402 now delegates to x402-v3)

OPTIONS FOR 'mandate-create':
  --desc <text>             Natural language description (required)
  --amount <amount>         Budget limit in atomic units (required)
  --seconds <duration>      Validity duration in seconds (default: 28800 = 8 hours)
  --category <category>     Category (default: general)
  --currency <currency>     Currency (default: USDC). Supported: USDC, XRP, FLUXA_MONETIZE_CREDITS

OPTIONS FOR 'mandate-status':
  --id <mandate_id>         Mandate ID to query (required)

OPTIONS FOR 'x402-v3':
  --mandate <mandate_id>    Mandate ID (required)
  --payload <json>          Full x402 payment payload as JSON (required)
                            If payload.x402Version === 2, uses v2 endpoint automatically

OPTIONS FOR 'paymentlink-create':
  --amount <amount>         Amount in smallest units (required)
  --desc <text>             Description
  --resource <content>      Resource content
  --expires <iso8601>       Expiry date (ISO 8601)
  --max-uses <number>       Maximum number of uses
  --network <network>       Network (default: base)

OPTIONS FOR 'paymentlink-list':
  --limit <number>          Max number of results

OPTIONS FOR 'paymentlink-get':
  --id <link_id>            Payment link ID (required)

OPTIONS FOR 'paymentlink-update':
  --id <link_id>            Payment link ID (required)
  --desc <text>             New description
  --resource <content>      New resource content
  --status <status>         Status: active or disabled
  --expires <iso8601>       New expiry date (ISO 8601), "null" to clear
  --max-uses <number>       New max uses, "null" to clear

OPTIONS FOR 'paymentlink-delete':
  --id <link_id>            Payment link ID (required)

OPTIONS FOR 'paymentlink-payments':
  --id <link_id>            Payment link ID (required)
  --limit <number>          Max number of results

OPTIONS FOR 'paymentlink-refund-create':
  --payment-id <id>         Payment record ID to refund (required)
  --amount <amount>         Amount in atomic units (omit for full refund)
  --reason <text>           Reason for refund

OPTIONS FOR 'paymentlink-refund-list':
  --limit <number>          Max number of results (default: 20, max: 100)
  --offset <number>         Pagination offset (default: 0)

OPTIONS FOR 'paymentlink-refund-get':
  --id <refund_id>          Refund ID (required)

OPTIONS FOR 'paymentlink-refund-cancel':
  --id <refund_id>          Refund ID (required)

OPTIONS FOR 'received-records':
  --limit <number>          Max number of results (default: 20, max: 100)
  --offset <number>         Pagination offset (default: 0)

OPTIONS FOR 'received-record':
  --id <payment_id>         Payment record ID (required)

OPTIONS FOR 'balance':
  --network <network>       Network for the USDC balance (default: base)

OPTIONS FOR 'recent-transactions':
  --limit <n>               Number of transactions, 1-100 (default: 20)

OPTIONS FOR 'agent-vc':
  --audience <url>          Third-party audience identifier (required)
  --challenge <text>        Opaque challenge (e.g. user id / nonce), UTF-8 ≤ 4096 bytes (required)
  --ttl <seconds>           Lifetime in seconds, 1..86400 (default: 3600)

ENVIRONMENT VARIABLES:
  AGENT_ID                  Pre-configured agent ID
  AGENT_TOKEN               Pre-configured agent token
  AGENT_JWT                 Pre-configured agent JWT
  AGENT_NAME                Agent name for auto-registration
  CLIENT_INFO               Client info for auto-registration
  FLUXA_DATA_DIR            Custom data directory path

EXAMPLES:
  # Check status
  fluxa-wallet status

  # Initialize with parameters
  fluxa-wallet init --name "My Agent" --client "CLI v1.0"

  # Create payout
  fluxa-wallet payout --to 0x1234...abcd --amount 1000000 --id pay_001

  # List cards
  fluxa-wallet card list
  fluxa-wallet card list --global

  # Set up the account cardholder once
  fluxa-wallet card holder create --first-name Alice --last-name Agent
  fluxa-wallet card holder me

  # Issue a card (requires mandate for x402 payment)
  fluxa-wallet card create --amount 25.00 --mandate mand_xxxxx

  # Reveal card details
  fluxa-wallet card details --id card_xxx
  fluxa-wallet card transactions --id card_xxx
  fluxa-wallet card 3ds latest --id card_xxx
  fluxa-wallet card 3ds latest_1h --id card_xxx

  # Recharge or withdraw a card
  fluxa-wallet card recharge --id card_xxx --amount 10.00 --mandate mand_xxxxx
  fluxa-wallet card withdraw --id card_xxx

  # Query payout status
  fluxa-wallet payout-status --id pay_001

  # Create intent mandate (x402 v3)
  fluxa-wallet mandate-create --desc "Spend up to 0.1 USDC for API calls" --amount 100000

  # Query mandate status
  fluxa-wallet mandate-status --id mand_xxxxx

  # Create a payment link
  fluxa-wallet paymentlink-create --amount 1000000 --desc "Test payment"

  # List payment links
  fluxa-wallet paymentlink-list --limit 10

  # Get payment link details
  fluxa-wallet paymentlink-get --id lnk_xxxxx

  # Delete a payment link
  fluxa-wallet paymentlink-delete --id lnk_xxxxx

  # List all received payment records
  fluxa-wallet received-records --limit 10

  # Initiate a full refund for a payment link payment
  fluxa-wallet paymentlink-refund-create --payment-id 42

  # Initiate a partial refund with reason
  fluxa-wallet paymentlink-refund-create --payment-id 42 --amount 500000 --reason "Partial refund"

  # List payment link refunds
  fluxa-wallet paymentlink-refund-list --limit 10

  # Get refund details
  fluxa-wallet paymentlink-refund-get --id 7

  # Cancel a pending refund
  fluxa-wallet paymentlink-refund-cancel --id 7

  # Get a single received payment record
  fluxa-wallet received-record --id 1

  # Issue an agent VC for a third-party service (default TTL 3600s)
  fluxa-wallet agent-vc --audience "https://thirdparty.example.com" --challenge "user-42"

  # VC with 10-minute TTL for a one-off SSO hand-off
  fluxa-wallet agent-vc --audience "https://sso.example.com" --challenge "nonce-abc" --ttl 600

  # Show the linked user's wallet address
  fluxa-wallet wallet-address

  # Show balances (USDC / XRP / credits)
  fluxa-wallet balance

  # List mandates with limit / spent / remaining
  fluxa-wallet mandates

  # List recent transactions (USDC / XRP / credits spends)
  fluxa-wallet recent-transactions --limit 50
`);
}

function parseArgs(args: string[]): { command: string; options: Record<string, string>; positionals: string[]; helpRequested: boolean } {
  let command = args[0] || 'help';
  const options: Record<string, string> = {};
  const positionals: string[] = [];
  let helpRequested = false;
  let optionStartIndex = 1;

  if (command === 'card') {
    const subcommand = args[1];
    if (subcommand && !subcommand.startsWith('-')) {
      if (subcommand === 'holder' || subcommand === '3ds') {
        const nestedSubcommand = args[2];
        if (nestedSubcommand && !nestedSubcommand.startsWith('-')) {
          command = `card ${subcommand} ${nestedSubcommand}`;
          optionStartIndex = 3;
        } else {
          command = `card ${subcommand}`;
          optionStartIndex = 2;
        }
      } else {
        command = `card ${subcommand}`;
        optionStartIndex = 2;
      }
    }
  } else if (command === 'market') {
    // `market model <verb>` and `market keys <verb>` resolve to three-word
    // commands (like `card holder <verb>`); `market search` / `market info`
    // stay two-word. Everything after is captured as positionals.
    const sub = args[1];
    if (sub && !sub.startsWith('-')) {
      if (sub === 'model' || sub === 'keys') {
        const nested = args[2];
        if (nested && !nested.startsWith('-')) {
          command = `market ${sub} ${nested}`;
          optionStartIndex = 3;
        } else {
          command = `market ${sub}`;
          optionStartIndex = 2;
        }
      } else {
        command = `market ${sub}`;
        optionStartIndex = 2;
      }
    }
  }

  for (let i = optionStartIndex; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      helpRequested = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = args[i + 1];
      if (value && !value.startsWith('--')) {
        options[key] = value;
        i++;
      } else {
        options[key] = 'true';
      }
    } else {
      positionals.push(arg);
    }
  }

  return { command, options, positionals, helpRequested };
}

const COMMAND_USAGE: Record<string, string> = {
  'plan-tool-use': `Usage: fluxa-wallet plan-tool-use "<task>"

Recommend the models, APIs and skills for a task. Prints a plan; run the
recommended calls yourself and settle any 402s via the wallet.

Example:
  fluxa-wallet plan-tool-use "scrape a site and summarize it"`,

  'market search': `Usage: fluxa-wallet market search "<query>" [--models | --vendors]

Discover marketplace resources. With no flag, searches APIs, skills and models.

Options:
  --models            Scope to models (with optional query as a vendor filter)
  --vendors           List fundable vendors instead of searching

Examples:
  fluxa-wallet market search "video"
  fluxa-wallet market search --models
  fluxa-wallet market search --vendors`,

  'market model remainingUsage': `Usage: fluxa-wallet market model remainingUsage [vendor]

Prepaid Units balance per merchant. Pass a vendor to scope to one.`,

  'market model topup': `Usage: fluxa-wallet market model topup <vendor> [--credits <N> | --bundle <slug>]

Prepay Units to a merchant via x402. Signs a Monetize Credits mandate.`,

  'market model usageHistory': `Usage: fluxa-wallet market model usageHistory <vendor>

Spend and topup history for a merchant.`,

  'market keys': `Usage: fluxa-wallet market keys [list | create | update <id> | revoke <id>]

Manage your fxa_live_ API keys (requires an Agent VC, not a metered key).

Options (create/update):
  --name <name>       Key name
  --cap <MC>          Spend cap in Monetize Credits (--cap 0 clears it)

Examples:
  fluxa-wallet market keys create --name ci --cap 50
  fluxa-wallet market keys revoke <id>`,

  'market info': `Usage: fluxa-wallet market info [topic]

Explain how the marketplace works. Topics: units, auth, pay, keys, models, skills.`,

  status: `Usage: fluxa-wallet status

Check agent configuration status. No options required.

Example:
  fluxa-wallet status`,

  init: `Usage: fluxa-wallet init [options]

Initialize/register agent ID.

Options:
  --name <name>       Agent name (or set AGENT_NAME env var)
  --client <info>     Client info description (or set CLIENT_INFO env var)

Example:
  fluxa-wallet init --name "My Agent" --client "CLI v1.0"`,

  'card list': `Usage: fluxa-wallet card list [--global]

List cards created by the current authorized agent.

Options:
  --global            Show all cards in the linked account, including cards created by sibling agents.

Example:
  fluxa-wallet card list
  fluxa-wallet card list --global`,

  'card create': `Usage: fluxa-wallet card create --amount <usd> --mandate <mandate_id>

Issue a funded card using the two-step x402 payment flow.

Options:
  --amount <usd>             Card amount in USD, human-readable (required)
  --mandate <mandate_id>     Mandate ID for x402 payment (required)

Example:
  fluxa-wallet card create --amount 25.00 --mandate mand_xxxxx`,

  'card details': `Usage: fluxa-wallet card details --id <card_id>

Reveal the full PAN, CVV, and expiry for a specific card.

Options:
  --id <card_id>       Card ID (required)

Example:
  fluxa-wallet card details --id card_xxx`,

  'card balance': `Usage: fluxa-wallet card balance --id <card_id>

Refresh and retrieve the current balance for a specific card.

Options:
  --id <card_id>       Card ID (required)

Example:
  fluxa-wallet card balance --id card_xxx`,

  'card transactions': `Usage: fluxa-wallet card transactions --id <card_id> [options]

List card transaction history from the card service.

Options:
  --id <card_id>           Card ID (required)
  --type <type>            purchase | refund | verification | reversal | fee
  --page <n>               Page number (alias: --page-num)
  --limit <n>              Page size, max 50 (alias: --page-size)
  --start-time <ms>        Start timestamp in milliseconds
  --end-time <ms>          End timestamp in milliseconds

Examples:
  fluxa-wallet card transactions --id card_xxx
  fluxa-wallet card transactions --id card_xxx --type purchase --limit 10`,

  'card 3ds latest': `Usage: fluxa-wallet card 3ds latest --id <card_id>

Show the newest 3DS challenge from the last 24 hours.

Options:
  --id <card_id>       Card ID (required)

Example:
  fluxa-wallet card 3ds latest --id card_xxx`,

  'card 3ds latest_1h': `Usage: fluxa-wallet card 3ds latest_1h --id <card_id>

Show all 3DS challenges from the last hour.

Options:
  --id <card_id>       Card ID (required)

Example:
  fluxa-wallet card 3ds latest_1h --id card_xxx`,

  'card holder create': `Usage: fluxa-wallet card holder create --first-name <name> --last-name <name> [--country <country>]

Set up the account cardholder once. The holder name is immutable after approval
and shared by every agent linked to the same wallet account.

Options:
  --first-name <name>   Cardholder first name (required)
  --last-name <name>    Cardholder last name (required)
  --country <country>   ISO 3166-1 alpha-2 country code (default: US)

Example:
  fluxa-wallet card holder create --first-name Alice --last-name Agent`,

  'card holder me': `Usage: fluxa-wallet card holder me

Show the account cardholder and review status.

Example:
  fluxa-wallet card holder me`,

  'card recharge': `Usage: fluxa-wallet card recharge --id <card_id> --amount <usd> --mandate <mandate_id>

Add funds to an existing card using the same two-step x402 payment flow as card creation.

Options:
  --id <card_id>             Card ID (required)
  --amount <usd>             Recharge amount in USD, human-readable (required)
  --mandate <mandate_id>     Mandate ID for x402 payment (required)

Example:
  fluxa-wallet card recharge --id card_xxx --amount 10.00 --mandate mand_xxxxx`,

  'card withdraw': `Usage: fluxa-wallet card withdraw --id <card_id> [--amount <usd>]

Withdraw card balance back to the requesting agent's linked wallet.

Options:
  --id <card_id>       Card ID (required)
  --amount <usd>       Amount in USD (optional; defaults to full remaining balance)

Example:
  fluxa-wallet card withdraw --id card_xxx`,

  'card withdrawals': `Usage: fluxa-wallet card withdrawals --id <card_id>

List withdrawal records for a card.

Options:
  --id <card_id>       Card ID (required)

Example:
  fluxa-wallet card withdrawals --id card_xxx`,

  'card withdrawal': `Usage: fluxa-wallet card withdrawal --id <card_id> --withdrawal-id <withdrawal_id>

Get one withdrawal record for a card.

Options:
  --id <card_id>              Card ID (required)
  --withdrawal-id <id>        Withdrawal ID (required)

Example:
  fluxa-wallet card withdrawal --id card_xxx --withdrawal-id wdr_xxxxx`,

  payout: `Usage: fluxa-wallet payout [options]

Create a payout to send funds to a wallet address.

Options:
  --to <address>         Recipient address (required)
  --amount <amount>      Amount in smallest units (required)
  --id <payout_id>       Unique payout ID / idempotency key (required)
  --network <network>    Network (default: base)
  --asset <address>      Asset contract address (default: USDC on Base)
  --mandate <mandate_id> Signed mandate ID for auto-approval (optional)
                         When provided and budget is sufficient, skips user approval
                         and payout goes directly to 'authorized' state.
  --biz-id <biz_id>      External business ID for dedup (optional)
                         Same biz-id cannot be reused while an active payout exists.
  --description <text>   Human-readable description (optional)

Examples:
  # Standard payout (requires user approval)
  fluxa-wallet payout --to 0x1234...abcd --amount 1000000 --id pay_001

  # Auto-approved payout via mandate
  fluxa-wallet payout --to 0x1234...abcd --amount 1000000 --id pay_002 --mandate mand_xxxxx

  # Payout with business dedup and description
  fluxa-wallet payout --to 0x1234...abcd --amount 1000000 --id pay_003 \\
    --biz-id order_20260416_001 --description "Refund for order #001"`,

  'payout-status': `Usage: fluxa-wallet payout-status --id <payout_id>

Query payout status.

Options:
  --id <payout_id>    Payout ID to query (required)

Example:
  fluxa-wallet payout-status --id pay_001`,

  x402: `Usage: fluxa-wallet x402 --mandate <mandate_id> --payload <json>

Generate x402 payment (delegates to x402-v3).

Options:
  --mandate <mandate_id>  Mandate ID (required)
  --payload <json>        Full x402 payment payload as JSON (required)

Same as x402-v3. If payload.x402Version === 2, uses v2 endpoint automatically.

Example:
  fluxa-wallet x402 --mandate mand_xxx --payload '{"accepts":[{...}]}'`,

  'mandate-create': `Usage: fluxa-wallet mandate-create [options]

Create an intent mandate for x402 v3 payments.

Options:
  --desc <text>           Natural language description (required)
  --amount <amount>       Budget limit in atomic units (required)
  --seconds <duration>    Validity duration in seconds (default: 28800 = 8h)
  --category <category>   Category (default: general)
  --currency <currency>   Currency (default: USDC)

Supported currencies: USDC, XRP, FLUXA_MONETIZE_CREDITS
  Aliases accepted: credits, fluxa-monetize-credits, fluxa-monetize-credit

Examples:
  fluxa-wallet mandate-create --desc "Spend up to 0.1 USDC" --amount 100000
  fluxa-wallet mandate-create --desc "Spend credits" --amount 500 --currency FLUXA_MONETIZE_CREDITS`,

  'mandate-status': `Usage: fluxa-wallet mandate-status --id <mandate_id>

Query mandate status.

Options:
  --id <mandate_id>   Mandate ID to query (required). Use --id, NOT --mandate.

Example:
  fluxa-wallet mandate-status --id mand_xxxxxxxxxxxxx`,

  'x402-v3': `Usage: fluxa-wallet x402-v3 --mandate <mandate_id> --payload <json>

Generate x402 v2/v3 payment using an intent mandate.

Options:
  --mandate <mandate_id>  Mandate ID (required)
  --payload <json>        Complete HTTP 402 response body (required, must include accepts array)

If payload.x402Version === 2, the command routes to the v2 endpoint
(POST /api/v2/payment/x402-payment) and passes the payload as paymentRequest.
Otherwise, the existing v3 logic is used.

The command automatically matches the accepts entry to the mandate's currency.

Examples:
  # v3 payment
  fluxa-wallet x402-v3 --mandate mand_xxx --payload '{"accepts":[{...}]}'

  # v2 payment (auto-detected by x402Version)
  fluxa-wallet x402-v3 --mandate mand_xxx --payload '{"x402Version":2,"resource":{"url":"https://...","description":"...","mimeType":"application/json"},"accepts":[{...}]}'`,

  'paymentlink-create': `Usage: fluxa-wallet paymentlink-create [options]

Create a payment link.

Options:
  --amount <amount>     Amount in smallest units (required)
  --desc <text>         Description
  --resource <content>  Resource content
  --expires <iso8601>   Expiry date (ISO 8601)
  --max-uses <number>   Maximum number of uses
  --network <network>   Network (default: base)

Example:
  fluxa-wallet paymentlink-create --amount 1000000 --desc "Test payment"`,

  'paymentlink-list': `Usage: fluxa-wallet paymentlink-list [options]

List payment links.

Options:
  --limit <number>    Max number of results

Example:
  fluxa-wallet paymentlink-list --limit 10`,

  'paymentlink-get': `Usage: fluxa-wallet paymentlink-get --id <link_id>

Get payment link details.

Options:
  --id <link_id>      Payment link ID (required)

Example:
  fluxa-wallet paymentlink-get --id lnk_xxxxx`,

  'paymentlink-update': `Usage: fluxa-wallet paymentlink-update --id <link_id> [options]

Update a payment link.

Options:
  --id <link_id>        Payment link ID (required)
  --desc <text>         New description
  --resource <content>  New resource content
  --status <status>     Status: active or disabled
  --expires <iso8601>   New expiry date (ISO 8601), "null" to clear
  --max-uses <number>   New max uses, "null" to clear

Example:
  fluxa-wallet paymentlink-update --id lnk_xxx --status disabled`,

  'paymentlink-delete': `Usage: fluxa-wallet paymentlink-delete --id <link_id>

Delete a payment link.

Options:
  --id <link_id>      Payment link ID (required)

Example:
  fluxa-wallet paymentlink-delete --id lnk_xxxxx`,

  'paymentlink-payments': `Usage: fluxa-wallet paymentlink-payments --id <link_id> [options]

Get payment records for a payment link.

Options:
  --id <link_id>      Payment link ID (required)
  --limit <number>    Max number of results

Example:
  fluxa-wallet paymentlink-payments --id lnk_xxxxx --limit 10`,

  'received-records': `Usage: fluxa-wallet received-records [options]

List all received payment records across all payment links.

Options:
  --limit <number>    Max number of results (default: 20, max: 100)
  --offset <number>   Pagination offset (default: 0)

Example:
  fluxa-wallet received-records --limit 10 --offset 0`,

  'received-record': `Usage: fluxa-wallet received-record --id <payment_id>

Get a single received payment record detail.

Options:
  --id <payment_id>   Payment record ID (required)

Example:
  fluxa-wallet received-record --id 1`,

  'paymentlink-refund-create': `Usage: fluxa-wallet paymentlink-refund-create --payment-id <id> [options]

Initiate a refund for a settled payment link payment.

Options:
  --payment-id <id>     Payment record ID to refund (required)
  --amount <amount>     Amount in atomic units (omit for full refund)
  --reason <text>       Reason for refund

Examples:
  fluxa-wallet paymentlink-refund-create --payment-id 42
  fluxa-wallet paymentlink-refund-create --payment-id 42 --amount 500000 --reason "Partial refund"`,

  'paymentlink-refund-list': `Usage: fluxa-wallet paymentlink-refund-list [options]

List all payment link refunds.

Options:
  --limit <number>    Max number of results (default: 20, max: 100)
  --offset <number>   Pagination offset (default: 0)

Example:
  fluxa-wallet paymentlink-refund-list --limit 10`,

  'paymentlink-refund-get': `Usage: fluxa-wallet paymentlink-refund-get --id <refund_id>

Get details of a single payment link refund.

Options:
  --id <refund_id>    Refund ID (required)

Example:
  fluxa-wallet paymentlink-refund-get --id 7`,

  'paymentlink-refund-cancel': `Usage: fluxa-wallet paymentlink-refund-cancel --id <refund_id>

Cancel a pending payment link refund.

Options:
  --id <refund_id>    Refund ID (required)

Example:
  fluxa-wallet paymentlink-refund-cancel --id 7`,

  'check-wallet': `Usage: fluxa-wallet check-wallet

Check if the agent is linked to a user's wallet.

No options required.

Example:
  fluxa-wallet check-wallet`,

  'link-wallet': `Usage: fluxa-wallet link-wallet

Get the wallet linking URL if not linked, or confirm already linked.

No options required.

Example:
  fluxa-wallet link-wallet`,

  'agent-vc': `Usage: fluxa-wallet agent-vc --audience <url> --challenge <text> [--ttl <seconds>]

Issue an agent verifiable credential (VC) scoped to a third-party audience.
The VC is signed with the same RS256 key as the login JWT but carries
header typ="agent-vc" and payload.aud=<audience>, so it cannot be used
to call protected FluxA endpoints. Third parties verify locally via JWKS.

Options:
  --audience <url>     Third-party audience identifier (required)
  --challenge <text>   Opaque challenge bound into the VC, UTF-8 ≤ 4096 bytes (required)
  --ttl <seconds>      Lifetime in seconds, 1..86400 (default: 3600)

Examples:
  fluxa-wallet agent-vc --audience "https://thirdparty.example.com" --challenge "user-42"
  fluxa-wallet agent-vc --audience "https://sso.example.com" --challenge "nonce-abc" --ttl 600`,

  'wallet-address': `Usage: fluxa-wallet wallet-address

Show the linked user's wallet address.

No options required.

Example:
  fluxa-wallet wallet-address`,

  balance: `Usage: fluxa-wallet balance [options]

Show the linked wallet's balances (USDC / XRP / credits). Each amount is an
atomic-unit string with a *Formatted decimal companion.

Options:
  --network <network>   Network for the USDC balance (default: base)

Examples:
  fluxa-wallet balance
  fluxa-wallet balance --network base`,

  mandates: `Usage: fluxa-wallet mandates

List the agent's intent mandates with per-mandate limit / spent / remaining,
plus open and total counts. Use this to check spending authority before paying.

No options required.

Example:
  fluxa-wallet mandates`,

  'recent-transactions': `Usage: fluxa-wallet recent-transactions [options]

List the agent's recent transactions (most recent first): USDC / XRP and
credits spends. Excludes credit top-ups / grants / redeems and received
payment-link payments.

Options:
  --limit <n>   Number of transactions, 1-100 (default: 20)

Examples:
  fluxa-wallet recent-transactions
  fluxa-wallet recent-transactions --limit 50`,
};

function output(result: CommandResult) {
  if (result.success && result.raw !== undefined) {
    console.log(result.raw);
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

function rawJson(data: any): CommandResult {
  return {
    success: true,
    raw: JSON.stringify(data, null, 2),
  };
}

/**
 * Ensure valid JWT, refreshing if needed
 */
async function ensureValidJWT(): Promise<{ agent_id: string; jwt: string } | null> {
  const agentConfig = getEffectiveAgentId();
  if (!agentConfig) {
    return null;
  }

  let jwt = agentConfig.jwt;

  // Check if JWT needs refresh
  if (isJWTExpired(jwt)) {
    console.error('[cli] JWT expired or expiring soon, refreshing...');
    try {
      jwt = await refreshJWT(agentConfig.agent_id, agentConfig.token);
      updateJWT(jwt);
      console.error('[cli] JWT refreshed successfully');
    } catch (err) {
      console.error('[cli] Failed to refresh JWT:', err);
      return null;
    }
  }

  return { agent_id: agentConfig.agent_id, jwt };
}

async function ensureCardServiceAuth(): Promise<{ agent_id: string; jwt: string; cardToken: string } | null> {
  const auth = await ensureValidJWT();
  if (!auth) return null;
  const cardToken = await getCardServiceVc(auth.jwt);
  return { ...auth, cardToken };
}

function apiErrorCode(err: any): string | undefined {
  const details = err?.details;
  if (details && typeof details === 'object' && typeof details.code === 'string') return details.code;
  return typeof err?.code === 'string' ? err.code : undefined;
}

function apiErrorDetails(err: any): any {
  const details = err?.details;
  if (details && typeof details === 'object' && 'details' in details) return details.details;
  return undefined;
}

function cardErrorHint(code?: string): string | undefined {
  switch (code) {
    case 'agent_not_linked':
      return 'Run "fluxa-wallet link-wallet", complete wallet linking, then retry.';
    case 'cardholder_required':
      return 'Run "fluxa-wallet card holder create --first-name <first> --last-name <last>" first.';
    case 'cardholder_not_approved':
      return 'Run "fluxa-wallet card holder me" to check the holder review status, then retry when approved.';
    case 'recharge_in_progress':
      return 'A recharge is already active for this card; wait for it to finish before starting another.';
    case 'withdrawal_in_progress':
      return 'A withdrawal is already active for this card; wait for it to finish before starting another.';
    case 'payment_payer_mismatch':
      return 'The payment was signed from a different wallet than this agent account; check the linked wallet and mandate.';
    default:
      return undefined;
  }
}

function commandError(err: any, fallback: string): CommandResult {
  const code = apiErrorCode(err);
  const details = apiErrorDetails(err);
  const hint = cardErrorHint(code);
  const base = err?.message || fallback;
  return {
    success: false,
    error: hint ? `${base} ${hint}` : base,
    ...(code ? { code } : {}),
    ...(details !== undefined ? { details } : {}),
  };
}

function withoutSuccessField<T extends Record<string, any>>(value: T): Omit<T, 'success'> {
  const { success: _success, ...rest } = value;
  return rest;
}

function extractPaymentPayloadB64(result: any): string | null {
  return (
    result?.paymentPayloadB64 ||
    result?.xPaymentB64 ||
    result?.data?.paymentPayloadB64 ||
    result?.data?.xPaymentB64 ||
    null
  );
}

async function signPaymentRequestWithMandate(
  paymentRequest: any,
  mandateId: string,
  jwt: string
): Promise<string> {
  if (!paymentRequest || typeof paymentRequest !== 'object') {
    throw new Error('Invalid payment request from card service');
  }

  if (paymentRequest.x402Version === 2) {
    const signed = await requestX402V2Payment({ mandateId, paymentRequest }, jwt);
    const payloadB64 = extractPaymentPayloadB64(signed);
    if (signed.status && signed.status !== 'ok') {
      throw new Error(signed.message || 'x402 v2 payment signing failed');
    }
    if (!payloadB64) {
      throw new Error('x402 v2 payment signing returned no paymentPayloadB64');
    }
    return payloadB64;
  }

  const accepts = paymentRequest.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    throw new Error('Invalid payment request: missing accepts array');
  }

  let mandateCurrency = 'USDC';
  try {
    const mandateInfo = await getMandateStatus(mandateId, jwt);
    if (mandateInfo.mandate?.currency) {
      mandateCurrency = mandateInfo.mandate.currency;
    }
  } catch (err: any) {
    console.error('[cli] Could not fetch mandate currency, defaulting to USDC:', err?.message);
  }

  const accept = accepts.find((a: any) => {
    if (a.scheme !== 'exact') return false;
    const currency = getCurrencyFromAsset(a.asset || DEFAULT_ASSET, a.network || DEFAULT_NETWORK);
    return currency === mandateCurrency;
  });

  if (!accept) {
    const availableCurrencies = accepts.map((a: any) =>
      getCurrencyFromAsset(a.asset || DEFAULT_ASSET, a.network || DEFAULT_NETWORK)
    );
    throw new Error(
      `No accepts entry matches mandate currency "${mandateCurrency}". Available currencies in accepts: [${availableCurrencies.join(', ')}]`
    );
  }

  const result = await requestX402V3Payment(
    {
      mandateId,
      scheme: accept.scheme || 'exact',
      network: accept.network || DEFAULT_NETWORK,
      amount: accept.maxAmountRequired || '0',
      currency: getCurrencyFromAsset(accept.asset || DEFAULT_ASSET, accept.network || DEFAULT_NETWORK),
      assetAddress: accept.asset || DEFAULT_ASSET,
      payTo: accept.payTo,
      host: extractHost(accept.resource || ''),
      resource: accept.resource || '',
      description: accept.description || '',
      tokenName: accept.extra?.name || 'USD Coin',
      tokenVersion: accept.extra?.version || '2',
      validityWindowSeconds: accept.maxTimeoutSeconds || 60,
    },
    jwt
  );

  const payloadB64 = extractPaymentPayloadB64(result);
  if (result.status !== 'ok') {
    throw new Error(result.message || 'x402 payment signing failed');
  }
  if (!payloadB64) {
    throw new Error('x402 payment signing returned no payment payload');
  }
  return payloadB64;
}

// Command handlers

async function cmdStatus(): Promise<CommandResult> {
  const hasConfig = hasAgentId();
  const agentConfig = getEffectiveAgentId();
  const regInfo = getRegistrationInfoFromEnv();

  if (hasConfig && agentConfig) {
    const data: any = {
      configured: true,
      agent_id: agentConfig.agent_id,
      has_token: !!agentConfig.token,
      has_jwt: !!agentConfig.jwt,
      jwt_expired: isJWTExpired(agentConfig.jwt),
      agent_name: agentConfig.agent_name,
    };

    // Check wallet linking if JWT is valid
    if (agentConfig.jwt && !isJWTExpired(agentConfig.jwt)) {
      try {
        const { linked } = await checkWalletLinked(agentConfig.jwt);
        data.wallet_linked = linked;
      } catch {
        data.wallet_linked = null; // unable to determine
      }
    }

    return { success: true, data };
  }

  return {
    success: true,
    data: {
      configured: false,
      has_registration_info: !!regInfo,
    },
  };
}

async function cmdInit(options: Record<string, string>): Promise<CommandResult> {
  // Check if already configured
  if (hasAgentId()) {
    const agentConfig = getEffectiveAgentId();
    return {
      success: true,
      data: {
        message: 'Agent ID already configured',
        agent_id: agentConfig?.agent_id,
      },
    };
  }

  // Get registration info from options or env
  const agentName = options.name || process.env.AGENT_NAME;
  const clientInfo = options.client || process.env.CLIENT_INFO;

  if (!agentName || !clientInfo) {
    return {
      success: false,
      error: 'Missing required parameters: --name, --client (or set AGENT_NAME, CLIENT_INFO)',
    };
  }

  try {
    const result = await registerAgent({ agent_name: agentName, client_info: clientInfo });

    // Save to config
    saveAgentId({
      agent_id: result.agent_id,
      token: result.token,
      jwt: result.jwt,
      agent_name: agentName,
      client_info: clientInfo,
    });

    await recordAudit({
      event: 'agent_registered',
      agent_id: result.agent_id,
    });

    return {
      success: true,
      data: {
        message: 'Agent registered successfully',
        agent_id: result.agent_id,
      },
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Registration failed',
    };
  }
}

async function cmdRefresh(): Promise<CommandResult> {
  const agentConfig = getEffectiveAgentId();
  if (!agentConfig) {
    return {
      success: false,
      error: 'FluxA Agent ID not initialized. Run "init" first.',
    };
  }

  try {
    const newJWT = await refreshJWT(agentConfig.agent_id, agentConfig.token);
    updateJWT(newJWT);

    await recordAudit({
      event: 'jwt_refreshed',
      agent_id: agentConfig.agent_id,
    });

    return {
      success: true,
      data: {
        message: 'JWT refreshed successfully',
        agent_id: agentConfig.agent_id,
        jwt: newJWT,
      },
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'JWT refresh failed',
    };
  }
}

async function cmdCardList(options: Record<string, string> = {}): Promise<CommandResult> {
  try {
    const auth = await ensureCardServiceAuth();
    if (!auth) {
      return {
        success: false,
        error: 'FluxA Agent ID not initialized. Run "init" first.',
      };
    }

    const includeGlobal = options.global === 'true';
    const result = await listCards(auth.cardToken, { global: includeGlobal });

    await recordAudit({
      event: 'card_list',
      count: result.cardCount,
      scope: includeGlobal ? 'account' : 'agent',
    });

    return rawJson(result.cards || []);
  } catch (err: any) {
    return commandError(err, 'Card list failed');
  }
}

async function cmdCardCreate(options: Record<string, string>): Promise<CommandResult> {
  const amountUsd = options.amount;
  const mandateId = options.mandate;

  if (!amountUsd) {
    return {
      success: false,
      error: 'Missing required parameter: --amount',
    };
  }

  if (!mandateId) {
    return {
      success: false,
      error: 'Missing required parameter: --mandate',
    };
  }

  try {
    const auth = await ensureCardServiceAuth();
    if (!auth) {
      return {
        success: false,
        error: 'FluxA Agent ID not initialized. Run "init" first.',
      };
    }

    // Step 1: Initiate card issuance → get payment request
    const initiated = await initiateCard({ amountUsd }, auth.cardToken);

    // Step 2: Sign payment via wallet backend using agent's mandate
    const paymentPayloadB64 = await signPaymentRequestWithMandate(
      initiated.paymentRequest,
      mandateId,
      auth.jwt
    );

    // Step 3: Complete card issuance with signed payment
    const result = await completeCard(
      {
        pendingRequestId: initiated.pendingRequestId,
        paymentPayloadB64,
      },
      auth.cardToken
    );

    await recordAudit({
      event: 'card_create',
      amount_usd: amountUsd,
      mandate_id: mandateId,
      card_id: result.success ? result.card?.id : undefined,
      status: result.success ? 'completed' : result.status,
    });

    return rawJson(result.success ? result.card : withoutSuccessField(result));
  } catch (err: any) {
    return commandError(err, 'Card creation failed');
  }
}

async function cmdCardDetails(options: Record<string, string>): Promise<CommandResult> {
  const cardId = options.id;

  if (!cardId) {
    return {
      success: false,
      error: 'Missing required parameter: --id',
    };
  }

  try {
    const auth = await ensureCardServiceAuth();
    if (!auth) {
      return {
        success: false,
        error: 'FluxA Agent ID not initialized. Run "init" first.',
      };
    }

    const result = await getCardDetails(cardId, auth.cardToken);

    await recordAudit({
      event: 'card_details',
      card_id: cardId,
    });

    return rawJson(result.details);
  } catch (err: any) {
    return commandError(err, 'Card details request failed');
  }
}

async function cmdCardBalance(options: Record<string, string>): Promise<CommandResult> {
  const cardId = options.id;

  if (!cardId) {
    return {
      success: false,
      error: 'Missing required parameter: --id',
    };
  }

  try {
    const auth = await ensureCardServiceAuth();
    if (!auth) {
      return {
        success: false,
        error: 'FluxA Agent ID not initialized. Run "init" first.',
      };
    }

    const result = await getCardBalance(cardId, auth.cardToken);

    await recordAudit({
      event: 'card_balance',
      card_id: cardId,
      remaining_amount_usd: result.balance?.remainingAmountUsd,
    });

    return rawJson(result.balance);
  } catch (err: any) {
    return commandError(err, 'Card balance request failed');
  }
}

async function cmdCardTransactions(options: Record<string, string>): Promise<CommandResult> {
  const cardId = options.id;

  if (!cardId) {
    return {
      success: false,
      error: 'Missing required parameter: --id',
    };
  }

  try {
    const auth = await ensureCardServiceAuth();
    if (!auth) {
      return {
        success: false,
        error: 'FluxA Agent ID not initialized. Run "init" first.',
      };
    }

    const result = await listCardTransactions(cardId, auth.cardToken, {
      ...(options.type ? { type: options.type } : {}),
      ...(options.page || options['page-num'] || options.pageNum
        ? { pageNum: options.page || options['page-num'] || options.pageNum }
        : {}),
      ...(options.limit || options['page-size'] || options.pageSize
        ? { pageSize: options.limit || options['page-size'] || options.pageSize }
        : {}),
      ...(options['start-time'] || options.startTime
        ? { startTime: options['start-time'] || options.startTime }
        : {}),
      ...(options['end-time'] || options.endTime
        ? { endTime: options['end-time'] || options.endTime }
        : {}),
    });

    await recordAudit({
      event: 'card_transactions',
      card_id: cardId,
      count: result.transactions?.length || 0,
      total: result.total,
    });

    return rawJson(result);
  } catch (err: any) {
    return commandError(err, 'Card transactions lookup failed');
  }
}

async function cmdCard3dsLatest(options: Record<string, string>): Promise<CommandResult> {
  const cardId = options.id;

  if (!cardId) {
    return {
      success: false,
      error: 'Missing required parameter: --id',
    };
  }

  try {
    const auth = await ensureCardServiceAuth();
    if (!auth) {
      return {
        success: false,
        error: 'FluxA Agent ID not initialized. Run "init" first.',
      };
    }

    const result = await getLatestCard3ds(cardId, auth.cardToken);

    await recordAudit({
      event: 'card_3ds_latest',
      card_id: cardId,
      found: result.threeDS ? true : false,
    });

    return rawJson(result.threeDS ?? null);
  } catch (err: any) {
    return commandError(err, 'Card 3DS latest lookup failed');
  }
}

async function cmdCard3dsLatest1h(options: Record<string, string>): Promise<CommandResult> {
  const cardId = options.id;

  if (!cardId) {
    return {
      success: false,
      error: 'Missing required parameter: --id',
    };
  }

  try {
    const auth = await ensureCardServiceAuth();
    if (!auth) {
      return {
        success: false,
        error: 'FluxA Agent ID not initialized. Run "init" first.',
      };
    }

    const result = await listLatestHourCard3ds(cardId, auth.cardToken);

    await recordAudit({
      event: 'card_3ds_latest_1h',
      card_id: cardId,
      count: result.threeDS?.length || 0,
      window_minutes: result.windowMinutes,
    });

    return rawJson(result.threeDS || []);
  } catch (err: any) {
    return commandError(err, 'Card 3DS latest_1h lookup failed');
  }
}

async function cmdCardHolderCreate(options: Record<string, string>): Promise<CommandResult> {
  const firstName = options['first-name'] || options.firstName;
  const lastName = options['last-name'] || options.lastName;
  const country = options.country;

  if (!firstName || !lastName) {
    return {
      success: false,
      error: 'Missing required parameters: --first-name, --last-name',
    };
  }

  try {
    const auth = await ensureCardServiceAuth();
    if (!auth) {
      return {
        success: false,
        error: 'FluxA Agent ID not initialized. Run "init" first.',
      };
    }

    const result = await createCardholder(
      {
        firstName,
        lastName,
        ...(country ? { country } : {}),
      },
      auth.cardToken
    );

    await recordAudit({
      event: 'card_holder_create',
      holder_status: result.cardholder?.status,
    });

    return rawJson(result.cardholder);
  } catch (err: any) {
    const details = apiErrorDetails(err);
    if (apiErrorCode(err) === 'cardholder_exists' && details?.cardholder) {
      return rawJson(details.cardholder);
    }
    return commandError(err, 'Card holder creation failed');
  }
}

async function cmdCardHolderMe(): Promise<CommandResult> {
  try {
    const auth = await ensureCardServiceAuth();
    if (!auth) {
      return {
        success: false,
        error: 'FluxA Agent ID not initialized. Run "init" first.',
      };
    }

    const result = await getCardholder(auth.cardToken);

    await recordAudit({
      event: 'card_holder_me',
      holder_status: result.cardholder?.status,
    });

    return rawJson(result.cardholder);
  } catch (err: any) {
    return commandError(err, 'Card holder lookup failed');
  }
}

async function cmdCardRecharge(options: Record<string, string>): Promise<CommandResult> {
  const cardId = options.id;
  const amountUsd = options.amount;
  const mandateId = options.mandate;

  if (!cardId || !amountUsd || !mandateId) {
    return {
      success: false,
      error: 'Missing required parameters: --id, --amount, --mandate',
    };
  }

  try {
    const auth = await ensureCardServiceAuth();
    if (!auth) {
      return {
        success: false,
        error: 'FluxA Agent ID not initialized. Run "init" first.',
      };
    }

    const initiated = await initiateCardRecharge(cardId, { amountUsd }, auth.cardToken);
    const paymentPayloadB64 = await signPaymentRequestWithMandate(
      initiated.paymentRequest,
      mandateId,
      auth.jwt
    );
    const result = await completeCardRecharge(
      cardId,
      {
        pendingRequestId: initiated.pendingRequestId,
        paymentPayloadB64,
      },
      auth.cardToken
    );

    await recordAudit({
      event: 'card_recharge',
      card_id: cardId,
      amount_usd: amountUsd,
      mandate_id: mandateId,
      status: result.success ? 'completed' : result.status,
    });

    return rawJson(result.success ? { card: result.card, recharge: result.recharge } : withoutSuccessField(result));
  } catch (err: any) {
    return commandError(err, 'Card recharge failed');
  }
}

async function cmdCardWithdraw(options: Record<string, string>): Promise<CommandResult> {
  const cardId = options.id;
  const amountUsd = options.amount;

  if (!cardId) {
    return {
      success: false,
      error: 'Missing required parameter: --id',
    };
  }

  try {
    const auth = await ensureCardServiceAuth();
    if (!auth) {
      return {
        success: false,
        error: 'FluxA Agent ID not initialized. Run "init" first.',
      };
    }

    const result = await requestCardWithdrawal(
      cardId,
      amountUsd ? { amountUsd } : {},
      auth.cardToken
    );

    await recordAudit({
      event: 'card_withdraw',
      card_id: cardId,
      amount_usd: amountUsd || null,
      withdrawal_id: result.withdrawalId,
    });

    return rawJson(result);
  } catch (err: any) {
    return commandError(err, 'Card withdrawal request failed');
  }
}

async function cmdCardWithdrawals(options: Record<string, string>): Promise<CommandResult> {
  const cardId = options.id;

  if (!cardId) {
    return {
      success: false,
      error: 'Missing required parameter: --id',
    };
  }

  try {
    const auth = await ensureCardServiceAuth();
    if (!auth) {
      return {
        success: false,
        error: 'FluxA Agent ID not initialized. Run "init" first.',
      };
    }

    const result = await listCardWithdrawals(cardId, auth.cardToken);

    await recordAudit({
      event: 'card_withdrawals',
      card_id: cardId,
      count: result.withdrawals?.length || 0,
    });

    return rawJson(result.withdrawals || []);
  } catch (err: any) {
    return commandError(err, 'Card withdrawals lookup failed');
  }
}

async function cmdCardWithdrawal(options: Record<string, string>): Promise<CommandResult> {
  const cardId = options.id;
  const withdrawalId = options['withdrawal-id'] || options.withdrawalId;

  if (!cardId || !withdrawalId) {
    return {
      success: false,
      error: 'Missing required parameters: --id, --withdrawal-id',
    };
  }

  try {
    const auth = await ensureCardServiceAuth();
    if (!auth) {
      return {
        success: false,
        error: 'FluxA Agent ID not initialized. Run "init" first.',
      };
    }

    const result = await getCardWithdrawal(cardId, withdrawalId, auth.cardToken);

    await recordAudit({
      event: 'card_withdrawal',
      card_id: cardId,
      withdrawal_id: withdrawalId,
      status: result.withdrawal?.status,
    });

    return rawJson(result.withdrawal);
  } catch (err: any) {
    return commandError(err, 'Card withdrawal lookup failed');
  }
}

async function cmdPayout(options: Record<string, string>): Promise<CommandResult> {
  const toAddress = options.to;
  const amount = options.amount;
  const payoutId = options.id;
  const network = options.network || DEFAULT_NETWORK;
  const assetAddress = options.asset || DEFAULT_ASSET;
  const mandateId = options.mandate;
  const bizId = options['biz-id'];
  const description = options.description;

  if (!toAddress || !amount || !payoutId) {
    return {
      success: false,
      error: 'Missing required parameters: --to, --amount, --id',
    };
  }

  // Validate address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(toAddress)) {
    return {
      success: false,
      error: 'Invalid recipient address format',
    };
  }

  // Validate amount is numeric
  if (!/^\d+$/.test(amount)) {
    return {
      success: false,
      error: 'Amount must be a positive integer (smallest units)',
    };
  }

  const auth = await ensureValidJWT();
  if (!auth) {
    return {
      success: false,
      error: 'FluxA Agent ID not initialized. Run "init" first.',
    };
  }

  const currency = getCurrencyFromAsset(assetAddress, network);

  try {
    const result = await createPayout(
      {
        agentId: auth.agent_id,
        toAddress,
        amount,
        currency,
        network,
        assetAddress,
        payoutId,
        ...(mandateId ? { mandateId } : {}),
        ...(bizId ? { bizId } : {}),
        ...(description ? { description } : {}),
      },
      auth.jwt
    );

    await recordAudit({
      event: 'payout_request',
      payout_id: payoutId,
      to: toAddress,
      amount,
      status: result.status,
      ...(mandateId ? { mandate_id: mandateId } : {}),
      ...(bizId ? { biz_id: bizId } : {}),
    });

    return {
      success: true,
      data: result,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Payout request failed',
    };
  }
}

async function cmdPayoutStatus(options: Record<string, string>): Promise<CommandResult> {
  const payoutId = options.id;

  if (!payoutId) {
    return {
      success: false,
      error: 'Missing required parameter: --id',
    };
  }

  try {
    const result = await getPayoutStatus(payoutId);

    await recordAudit({
      event: 'payout_status_query',
      payout_id: payoutId,
      status: result.status,
    });

    return {
      success: true,
      data: result,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Payout status query failed',
    };
  }
}

async function cmdX402(options: Record<string, string>): Promise<CommandResult> {
  // Deprecated: x402 now delegates to x402-v3 logic (requires --mandate)
  return cmdX402V3(options);
}

// Default values for mandate creation
const DEFAULT_MANDATE_SECONDS = 8 * 3600; // 8 hours
const DEFAULT_MANDATE_CATEGORY = 'general';

async function cmdMandateCreate(options: Record<string, string>): Promise<CommandResult> {
  const description = options.desc;
  const limitAmount = options.amount;
  const validForSeconds = options.seconds;
  const category = options.category || DEFAULT_MANDATE_CATEGORY;
  const rawCurrency = options.currency || 'USDC';
  const currency = resolveCurrency(rawCurrency);

  if (!description || !limitAmount) {
    return {
      success: false,
      error: 'Missing required parameters: --desc, --amount',
    };
  }

  if (!currency) {
    return {
      success: false,
      error: `Unsupported currency: "${rawCurrency}". Supported currencies: ${SUPPORTED_CURRENCIES.join(', ')}`,
    };
  }

  // Validate limitAmount is numeric
  if (!/^\d+$/.test(limitAmount)) {
    return {
      success: false,
      error: 'Amount must be a positive integer (atomic units)',
    };
  }

  // Use default seconds if not provided
  let seconds = DEFAULT_MANDATE_SECONDS;
  if (validForSeconds) {
    seconds = parseInt(validForSeconds, 10);
    if (!Number.isFinite(seconds) || seconds <= 0) {
      return {
        success: false,
        error: 'Seconds must be a positive integer',
      };
    }
  }

  const auth = await ensureValidJWT();
  if (!auth) {
    return {
      success: false,
      error: 'FluxA Agent ID not initialized. Run "init" first.',
    };
  }

  try {
    const result = await createIntentMandate(
      {
        intent: {
          naturalLanguage: description,
          category: category,
          currency: currency,
          limitAmount: limitAmount,
          validForSeconds: seconds,
          hostAllowlist: [],
        },
      },
      auth.jwt
    );

    await recordAudit({
      event: 'mandate_create',
      mandate_id: result.mandateId,
      limit: limitAmount,
      seconds: seconds,
    });

    return {
      success: result.status === 'ok',
      data: result,
      error: result.status !== 'ok' ? result.message : undefined,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Mandate creation failed',
    };
  }
}

async function cmdMandateStatus(options: Record<string, string>): Promise<CommandResult> {
  const mandateId = options.id;

  if (!mandateId) {
    return {
      success: false,
      error: 'Missing required parameter: --id',
    };
  }

  const auth = await ensureValidJWT();
  if (!auth) {
    return {
      success: false,
      error: 'FluxA Agent ID not initialized. Run "init" first.',
    };
  }

  try {
    const result = await getMandateStatus(mandateId, auth.jwt);

    await recordAudit({
      event: 'mandate_status_query',
      mandate_id: mandateId,
      status: result.mandate?.status,
    });

    return {
      success: result.status === 'ok',
      data: result,
      error: result.status !== 'ok' ? result.message : undefined,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Mandate status query failed',
    };
  }
}

async function cmdX402V3(options: Record<string, string>): Promise<CommandResult> {
  const mandateId = options.mandate;
  const payloadJson = options.payload;

  if (!mandateId || !payloadJson) {
    return {
      success: false,
      error: 'Missing required parameters: --mandate, --payload',
    };
  }

  let payload: any;
  let payloadIsB64 = false;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    // Not valid JSON — try base64 decode (e.g. raw PAYMENT-REQUIRED header value)
    try {
      const decoded = Buffer.from(payloadJson, 'base64').toString('utf-8');
      payload = JSON.parse(decoded);
      payloadIsB64 = true;
    } catch {
      return {
        success: false,
        error: 'Invalid --payload: not valid JSON or base64-encoded JSON',
      };
    }
  }

  // x402 v2 branch: if x402Version === 2, route to v2 endpoint
  if (payload.x402Version === 2) {
    return cmdX402V2(mandateId, payload, payloadIsB64 ? payloadJson : undefined);
  }

  // --- existing v3 logic below ---

  const auth = await ensureValidJWT();
  if (!auth) {
    return {
      success: false,
      error: 'FluxA Agent ID not initialized. Run "init" first.',
    };
  }

  // Validate accepts array
  const accepts = payload.accepts;
  if (!Array.isArray(accepts) || accepts.length === 0) {
    return {
      success: false,
      error: 'Invalid payload: missing accepts array',
    };
  }

  // Fetch mandate to determine its currency
  let mandateCurrency = 'USDC';
  try {
    const mandateInfo = await getMandateStatus(mandateId, auth.jwt);
    if (mandateInfo.mandate?.currency) {
      mandateCurrency = mandateInfo.mandate.currency;
    }
  } catch (err: any) {
    console.error('[cli] Could not fetch mandate currency, defaulting to USDC:', err?.message);
  }

  // Find accepts entry matching mandate currency
  const accept = accepts.find((a: any) => {
    if (a.scheme !== 'exact') return false;
    const currency = getCurrencyFromAsset(a.asset || DEFAULT_ASSET, a.network || DEFAULT_NETWORK);
    return currency === mandateCurrency;
  });

  if (!accept) {
    const availableCurrencies = accepts.map((a: any) =>
      getCurrencyFromAsset(a.asset || DEFAULT_ASSET, a.network || DEFAULT_NETWORK)
    );
    return {
      success: false,
      error: `No accepts entry matches mandate currency "${mandateCurrency}". Available currencies in accepts: [${availableCurrencies.join(', ')}]`,
    };
  }

  try {
    const result = await requestX402V3Payment(
      {
        mandateId: mandateId,
        scheme: accept.scheme || 'exact',
        network: accept.network || DEFAULT_NETWORK,
        amount: accept.maxAmountRequired || '0',
        currency: getCurrencyFromAsset(accept.asset || DEFAULT_ASSET, accept.network || DEFAULT_NETWORK),
        assetAddress: accept.asset || DEFAULT_ASSET,
        payTo: accept.payTo,
        host: extractHost(accept.resource || ''),
        resource: accept.resource || '',
        description: accept.description || '',
        tokenName: accept.extra?.name || 'USD Coin',
        tokenVersion: accept.extra?.version || '2',
        validityWindowSeconds: accept.maxTimeoutSeconds || 60,
      },
      auth.jwt
    );

    await recordAudit({
      event: 'x402_v3_payment',
      mandate_id: mandateId,
      resource: accept.resource,
      amount: accept.maxAmountRequired,
    });

    return {
      success: result.status === 'ok',
      data: result,
      error: result.status !== 'ok' ? result.message : undefined,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'x402 v3 payment request failed',
    };
  }
}

// Prepay Units to a merchant. Orchestrates the marketplace proxy legs
// (initiate/finalize in src/market/client) around the wallet's own proven
// mandate + x402-v3 primitives — the in-process replacement for the planner's
// shell-out to `fluxa-wallet`.
async function cmdMarketTopup(positionals: string[], options: Record<string, string>): Promise<CommandResult> {
  const vendor = positionals[0];
  if (!vendor) {
    return { success: false, error: 'usage: fluxa-wallet market model topup <vendor> [--credits <N> | --bundle <slug>]' };
  }
  const auth = await ensureValidJWT();
  if (!auth) {
    return { success: false, error: 'FluxA Agent ID not initialized. Run "init" first.' };
  }

  try {
    // 1. initiate — answers HTTP 402 with the x402 challenge on success
    const init = await topupInitiate(vendor, { credits: options.credits, bundle: options.bundle });
    console.error(`· order ${init.orderId}: ${init.costCredits} Monetize Credits -> ${Number(init.creditsToGrant).toLocaleString()} Units to ${vendor}`);

    // 2. mandate (Monetize Credits) — budget must cover the cost (credits unit = MC x 100)
    const budget = options.budget ? Number(options.budget) : Math.max(500, Math.ceil(Number(init.costCredits) * 100));
    const seconds = options.seconds ? Number(options.seconds) : 28800;
    const mc = await cmdMandateCreate({
      desc: `Prepay ${init.costCredits} MC of Units for ${vendor}`,
      amount: String(budget),
      seconds: String(seconds),
      currency: 'FLUXA_MONETIZE_CREDITS',
    });
    if (!mc.success) return mc;
    const mandateId: string = mc.data.mandateId;
    const authUrl: string | undefined = mc.data.authorizationUrl;

    // 3. sign — the human approves the mandate URL; we poll until it's signed
    console.error(`\n  Sign the spending mandate (budget ${budget} FLUXA_MONETIZE_CREDITS, valid ${seconds}s)`);
    if (authUrl) console.error(`  ${authUrl}`);
    console.error('  open the link, approve, then this continues automatically...\n');
    const READY = new Set(['signed', 'active', 'authorized', 'approved']);
    let signed = false;
    for (let i = 0; i < 60; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const s = await getMandateStatus(mandateId, auth.jwt);
        const st = s.mandate?.status;
        if (st && READY.has(st)) { signed = true; break; }
      } catch { /* transient — keep polling */ }
    }
    if (!signed) {
      return { success: false, error: 'mandate not signed in time — re-run once you have approved the link.' };
    }
    console.error('  mandate signed');

    // 4. sign the payment over the FULL 402 body via the wallet's proven x402-v3
    const paid = await cmdX402V3({ mandate: mandateId, payload: init.rawBody });
    if (!paid.success) return paid;
    const xPayment: string | undefined = paid.data?.xPaymentB64;
    if (!xPayment) return { success: false, error: 'x402-v3 did not return a payment token (xPaymentB64).' };

    // 5. finalize — POST the resource URL with the payment token (no bearer)
    const fin = await topupFinalize(init.resource, xPayment);
    const added = Number(fin.creditsAdded ?? init.creditsToGrant);
    await recordAudit({ event: 'market_topup', vendor, order_id: init.orderId, mandate_id: mandateId, units_added: added });
    return {
      success: true,
      raw: `topped up ${vendor} · +${added.toLocaleString()} Units · balance ${Number(fin.balance ?? 0).toLocaleString()} Units`,
    };
  } catch (err: any) {
    return { success: false, error: err?.message || 'topup failed' };
  }
}

async function cmdX402V2(mandateId: string, payload: any, rawB64?: string): Promise<CommandResult> {
  const auth = await ensureValidJWT();
  if (!auth) {
    return {
      success: false,
      error: 'FluxA Agent ID not initialized. Run "init" first.',
    };
  }

  // Validate: v2 requires resource as object with url
  if (!payload.resource || typeof payload.resource.url !== 'string') {
    return {
      success: false,
      error: 'Invalid v2 payload: missing resource.url',
    };
  }

  // Validate accepts array
  if (!Array.isArray(payload.accepts) || payload.accepts.length === 0) {
    return {
      success: false,
      error: 'Invalid v2 payload: missing accepts array',
    };
  }

  try {
    // If input was base64, pass as paymentRequestB64; otherwise pass decoded JSON
    const request: any = { mandateId };
    if (rawB64) {
      request.paymentRequestB64 = rawB64;
    } else {
      request.paymentRequest = payload;
    }

    const result = await requestX402V2Payment(request, auth.jwt);

    await recordAudit({
      event: 'x402_v2_payment',
      mandate_id: mandateId,
      resource: payload.resource?.url,
      x402Version: 2,
    });

    // Filter out paymentPayload, only keep paymentPayloadB64
    const { paymentPayload, ...filtered } = result;

    return {
      success: filtered.status === 'ok',
      data: filtered,
      error: filtered.status !== 'ok' ? filtered.message : undefined,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'x402 v2 payment request failed',
    };
  }
}

// ==================== Payment Link Commands ====================

async function cmdPaymentLinkCreate(options: Record<string, string>): Promise<CommandResult> {
  const amount = options.amount;
  if (!amount) {
    return { success: false, error: 'Missing required parameter: --amount' };
  }
  if (!/^\d+$/.test(amount)) {
    return { success: false, error: 'Amount must be a positive integer (smallest units)' };
  }

  const auth = await ensureValidJWT();
  if (!auth) {
    return { success: false, error: 'FluxA Agent ID not initialized. Run "init" first.' };
  }

  try {
    const result = await createPaymentLink(
      {
        amount,
        description: options.desc,
        resourceContent: options.resource,
        expiresAt: options.expires,
        maxUses: options['max-uses'] ? parseInt(options['max-uses'], 10) : undefined,
        network: options.network,
      },
      auth.jwt
    );

    await recordAudit({ event: 'paymentlink_create', amount, description: options.desc });

    return { success: true, data: result };
  } catch (err: any) {
    return { success: false, error: err.message || 'Payment link creation failed' };
  }
}

async function cmdPaymentLinkList(options: Record<string, string>): Promise<CommandResult> {
  const auth = await ensureValidJWT();
  if (!auth) {
    return { success: false, error: 'FluxA Agent ID not initialized. Run "init" first.' };
  }

  try {
    const limit = options.limit ? parseInt(options.limit, 10) : undefined;
    const result = await listPaymentLinks(auth.jwt, limit);

    await recordAudit({ event: 'paymentlink_list', count: result.paymentLinks?.length });

    return { success: true, data: result };
  } catch (err: any) {
    return { success: false, error: err.message || 'List payment links failed' };
  }
}

async function cmdPaymentLinkGet(options: Record<string, string>): Promise<CommandResult> {
  const linkId = options.id;
  if (!linkId) {
    return { success: false, error: 'Missing required parameter: --id' };
  }

  const auth = await ensureValidJWT();
  if (!auth) {
    return { success: false, error: 'FluxA Agent ID not initialized. Run "init" first.' };
  }

  try {
    const result = await getPaymentLink(linkId, auth.jwt);

    await recordAudit({ event: 'paymentlink_get', link_id: linkId });

    return { success: true, data: result };
  } catch (err: any) {
    return { success: false, error: err.message || 'Get payment link failed' };
  }
}

async function cmdPaymentLinkUpdate(options: Record<string, string>): Promise<CommandResult> {
  const linkId = options.id;
  if (!linkId) {
    return { success: false, error: 'Missing required parameter: --id' };
  }

  const auth = await ensureValidJWT();
  if (!auth) {
    return { success: false, error: 'FluxA Agent ID not initialized. Run "init" first.' };
  }

  const updateParams: Record<string, any> = {};
  if (options.desc !== undefined) updateParams.description = options.desc;
  if (options.resource !== undefined) updateParams.resourceContent = options.resource;
  if (options.status !== undefined) updateParams.status = options.status;
  if (options.expires !== undefined) updateParams.expiresAt = options.expires === 'null' ? null : options.expires;
  if (options['max-uses'] !== undefined) updateParams.maxUses = options['max-uses'] === 'null' ? null : parseInt(options['max-uses'], 10);

  try {
    const result = await updatePaymentLink(linkId, updateParams, auth.jwt);

    await recordAudit({ event: 'paymentlink_update', link_id: linkId, updates: updateParams });

    return { success: true, data: result };
  } catch (err: any) {
    return { success: false, error: err.message || 'Update payment link failed' };
  }
}

async function cmdPaymentLinkDelete(options: Record<string, string>): Promise<CommandResult> {
  const linkId = options.id;
  if (!linkId) {
    return { success: false, error: 'Missing required parameter: --id' };
  }

  const auth = await ensureValidJWT();
  if (!auth) {
    return { success: false, error: 'FluxA Agent ID not initialized. Run "init" first.' };
  }

  try {
    const result = await deletePaymentLink(linkId, auth.jwt);

    await recordAudit({ event: 'paymentlink_delete', link_id: linkId });

    return { success: true, data: result };
  } catch (err: any) {
    return { success: false, error: err.message || 'Delete payment link failed' };
  }
}

async function cmdPaymentLinkPayments(options: Record<string, string>): Promise<CommandResult> {
  const linkId = options.id;
  if (!linkId) {
    return { success: false, error: 'Missing required parameter: --id' };
  }

  const auth = await ensureValidJWT();
  if (!auth) {
    return { success: false, error: 'FluxA Agent ID not initialized. Run "init" first.' };
  }

  try {
    const limit = options.limit ? parseInt(options.limit, 10) : undefined;
    const result = await getPaymentLinkPayments(linkId, auth.jwt, limit);

    await recordAudit({ event: 'paymentlink_payments', link_id: linkId });

    return { success: true, data: result };
  } catch (err: any) {
    return { success: false, error: err.message || 'Get payment link payments failed' };
  }
}

async function cmdCheckWallet(): Promise<CommandResult> {
  const auth = await ensureValidJWT();
  if (!auth) {
    return { success: false, error: 'FluxA Agent ID not initialized. Run "init" first.' };
  }

  try {
    const { linked } = await checkWalletLinked(auth.jwt);
    const agentConfig = getEffectiveAgentId();

    if (linked) {
      return { success: true, data: { linked: true } };
    }

    const linkUrl = agentConfig?.agent_id
      ? buildLinkWalletUrl(agentConfig.agent_id, agentConfig.agent_name || '')
      : undefined;

    return { success: true, data: { linked: false, linkUrl } };
  } catch (err: any) {
    return { success: false, error: err.message || 'Check wallet linking failed' };
  }
}

async function cmdLinkWallet(): Promise<CommandResult> {
  const auth = await ensureValidJWT();
  if (!auth) {
    return { success: false, error: 'FluxA Agent ID not initialized. Run "init" first.' };
  }

  try {
    const { linked } = await checkWalletLinked(auth.jwt);

    if (linked) {
      return { success: true, data: { linked: true, message: "Agent is already linked to user's wallet." } };
    }

    const agentConfig = getEffectiveAgentId();
    const linkUrl = agentConfig?.agent_id
      ? buildLinkWalletUrl(agentConfig.agent_id, agentConfig.agent_name || '')
      : undefined;

    return {
      success: true,
      data: {
        linked: false,
        linkUrl,
        message: 'Please ask user to open this URL to authorize wallet access.',
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message || 'Link wallet failed' };
  }
}

async function cmdReceivedRecords(options: Record<string, string>): Promise<CommandResult> {
  const auth = await ensureValidJWT();
  if (!auth) {
    return { success: false, error: 'FluxA Agent ID not initialized. Run "init" first.' };
  }

  try {
    const limit = options.limit ? parseInt(options.limit, 10) : undefined;
    const offset = options.offset ? parseInt(options.offset, 10) : undefined;
    const result = await listReceivedPayments(auth.jwt, limit, offset);

    await recordAudit({ event: 'received_records_list' });

    return { success: true, data: result };
  } catch (err: any) {
    return { success: false, error: err.message || 'List received records failed' };
  }
}

async function cmdReceivedRecord(options: Record<string, string>): Promise<CommandResult> {
  const paymentId = options.id;
  if (!paymentId) {
    return { success: false, error: 'Missing required parameter: --id' };
  }

  const id = parseInt(paymentId, 10);
  if (isNaN(id)) {
    return { success: false, error: 'Invalid payment ID: must be a number' };
  }

  const auth = await ensureValidJWT();
  if (!auth) {
    return { success: false, error: 'FluxA Agent ID not initialized. Run "init" first.' };
  }

  try {
    const result = await getReceivedPayment(id, auth.jwt);

    await recordAudit({ event: 'received_record_get', payment_id: id });

    return { success: true, data: result };
  } catch (err: any) {
    return { success: false, error: err.message || 'Get received record failed' };
  }
}

async function cmdPaymentLinkRefundCreate(options: Record<string, string>): Promise<CommandResult> {
  const paymentIdStr = options['payment-id'];
  if (!paymentIdStr) {
    return { success: false, error: 'Missing required parameter: --payment-id' };
  }

  const paymentId = parseInt(paymentIdStr, 10);
  if (isNaN(paymentId)) {
    return { success: false, error: 'Invalid payment ID: must be a number' };
  }

  if (options.amount !== undefined && !/^\d+$/.test(options.amount)) {
    return { success: false, error: 'Amount must be a positive integer (atomic units)' };
  }

  const auth = await ensureValidJWT();
  if (!auth) {
    return { success: false, error: 'FluxA Agent ID not initialized. Run "init" first.' };
  }

  try {
    const result = await initiateRefund(
      {
        paymentId,
        amount: options.amount,
        reason: options.reason,
      },
      auth.jwt
    );

    await recordAudit({ event: 'paymentlink_refund_create', payment_id: paymentId, amount: options.amount, reason: options.reason });

    return { success: true, data: result };
  } catch (err: any) {
    return { success: false, error: err.message || 'Initiate refund failed' };
  }
}

async function cmdPaymentLinkRefundList(options: Record<string, string>): Promise<CommandResult> {
  const auth = await ensureValidJWT();
  if (!auth) {
    return { success: false, error: 'FluxA Agent ID not initialized. Run "init" first.' };
  }

  try {
    const limit = options.limit ? parseInt(options.limit, 10) : undefined;
    const offset = options.offset ? parseInt(options.offset, 10) : undefined;
    const result = await listRefunds(auth.jwt, limit, offset);

    await recordAudit({ event: 'paymentlink_refund_list' });

    return { success: true, data: result };
  } catch (err: any) {
    return { success: false, error: err.message || 'List refunds failed' };
  }
}

async function cmdPaymentLinkRefundGet(options: Record<string, string>): Promise<CommandResult> {
  const refundId = options.id;
  if (!refundId) {
    return { success: false, error: 'Missing required parameter: --id' };
  }

  const auth = await ensureValidJWT();
  if (!auth) {
    return { success: false, error: 'FluxA Agent ID not initialized. Run "init" first.' };
  }

  try {
    const result = await getRefund(refundId, auth.jwt);

    await recordAudit({ event: 'paymentlink_refund_get', refund_id: refundId });

    return { success: true, data: result };
  } catch (err: any) {
    return { success: false, error: err.message || 'Get refund failed' };
  }
}

async function cmdPaymentLinkRefundCancel(options: Record<string, string>): Promise<CommandResult> {
  const refundId = options.id;
  if (!refundId) {
    return { success: false, error: 'Missing required parameter: --id' };
  }

  const auth = await ensureValidJWT();
  if (!auth) {
    return { success: false, error: 'FluxA Agent ID not initialized. Run "init" first.' };
  }

  try {
    const result = await cancelRefund(refundId, auth.jwt);

    await recordAudit({ event: 'paymentlink_refund_cancel', refund_id: refundId });

    return { success: true, data: result };
  } catch (err: any) {
    return { success: false, error: err.message || 'Cancel refund failed' };
  }
}

async function cmdAgentVC(options: Record<string, string>): Promise<CommandResult> {
  const audience = options.audience;
  const challenge = options.challenge;
  if (!audience) {
    return { success: false, error: 'Missing required parameter: --audience' };
  }
  if (!challenge) {
    return { success: false, error: 'Missing required parameter: --challenge' };
  }
  if (Buffer.byteLength(challenge, 'utf8') > 4096) {
    return { success: false, error: 'challenge too large (max 4096 bytes)' };
  }

  const ttlRaw = options.ttl;
  const ttlSeconds = ttlRaw === undefined ? 3600 : parseInt(ttlRaw, 10);
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 86400) {
    return { success: false, error: 'ttl must be an integer in [1, 86400]' };
  }

  const auth = await ensureValidJWT();
  if (!auth) {
    return { success: false, error: 'FluxA Agent ID not initialized. Run "init" first.' };
  }

  try {
    const result = await issueVC(
      { audience, challenge, ttl_seconds: ttlSeconds },
      auth.jwt
    );

    await recordAudit({
      event: 'agent_vc_issue',
      audience,
      ttl_seconds: ttlSeconds,
      jti: result.jti,
    });

    return { success: true, data: result };
  } catch (err: any) {
    return { success: false, error: err.message || 'Issue VC failed' };
  }
}

async function cmdWalletAddress(): Promise<CommandResult> {
  const auth = await ensureValidJWT();
  if (!auth) {
    return { success: false, error: 'FluxA Agent ID not initialized. Run "init" first.' };
  }

  try {
    const status = await getAgentSelfStatus(auth.jwt);

    await recordAudit({ event: 'wallet_address' });

    return { success: true, raw: status.agent.walletAddress };
  } catch (err: any) {
    return { success: false, error: err.message || 'Get wallet address failed' };
  }
}

async function cmdBalance(options: Record<string, string>): Promise<CommandResult> {
  const auth = await ensureValidJWT();
  if (!auth) {
    return { success: false, error: 'FluxA Agent ID not initialized. Run "init" first.' };
  }

  try {
    const network = options.network;
    const status = await getAgentSelfStatus(auth.jwt, network);

    await recordAudit({ event: 'balance' });

    return { success: true, raw: JSON.stringify(status.balances, null, 2) };
  } catch (err: any) {
    return { success: false, error: err.message || 'Get balance failed' };
  }
}

async function cmdMandates(): Promise<CommandResult> {
  const auth = await ensureValidJWT();
  if (!auth) {
    return { success: false, error: 'FluxA Agent ID not initialized. Run "init" first.' };
  }

  try {
    const status = await getAgentSelfStatus(auth.jwt);

    await recordAudit({ event: 'mandates_list' });

    return { success: true, raw: JSON.stringify(status.mandates, null, 2) };
  } catch (err: any) {
    return { success: false, error: err.message || 'List mandates failed' };
  }
}

async function cmdRecentTransactions(options: Record<string, string>): Promise<CommandResult> {
  const auth = await ensureValidJWT();
  if (!auth) {
    return { success: false, error: 'FluxA Agent ID not initialized. Run "init" first.' };
  }

  const txLimit = options.limit ? parseInt(options.limit, 10) : undefined;
  if (txLimit !== undefined && (isNaN(txLimit) || txLimit < 1 || txLimit > 100)) {
    return { success: false, error: '--limit must be an integer in [1, 100]' };
  }

  try {
    const status = await getAgentSelfStatus(auth.jwt, undefined, txLimit);

    await recordAudit({ event: 'recent_transactions' });

    return { success: true, raw: JSON.stringify(status.recentTransactions.items, null, 2) };
  } catch (err: any) {
    return { success: false, error: err.message || 'List recent transactions failed' };
  }
}

// Main entry point
async function main() {
  const args = process.argv.slice(2);
  const { command, options, positionals, helpRequested } = parseArgs(args);

  // Version: `fluxa-wallet --version` / `-v` / `version`
  if (command === '--version' || command === '-v' || command === 'version') {
    console.log(CLI_VERSION);
    process.exit(0);
  }

  // Per-command help: `fluxa-wallet <command> --help`
  if (helpRequested && command !== 'help' && command !== '--help' && command !== '-h') {
    const usage = COMMAND_USAGE[command];
    if (usage) {
      console.log(usage);
      process.exit(0);
    }
    // Unknown command with --help, fall through to global help
    printUsage();
    process.exit(0);
  }

  // Initialize storage
  ensureDataDirs();
  await loadConfig();

  let result: CommandResult;

  switch (command) {
    // FluxA marketplace commands (ported from the planner CLI). All resolved
    // multi-word command strings route through one handler in src/market/client.
    case 'plan-tool-use':
    case 'market search':
    case 'market model remainingUsage':
    case 'market model usageHistory':
    case 'market keys':
    case 'market keys list':
    case 'market keys create':
    case 'market keys update':
    case 'market keys revoke':
    case 'market info':
      result = await runMarketCommand(command, positionals, options);
      break;
    case 'market model topup':
      result = await cmdMarketTopup(positionals, options);
      break;
    case 'market':
    case 'market model':
      result = { success: false, error: `incomplete command: ${command}. See \`fluxa-wallet market info\`.` };
      break;
    case 'status':
      result = await cmdStatus();
      break;
    case 'init':
      result = await cmdInit(options);
      break;
    case 'refreshJWT':
      result = await cmdRefresh();
      break;
    case 'card list':
      result = await cmdCardList(options);
      break;
    case 'card create':
      result = await cmdCardCreate(options);
      break;
    case 'card details':
      result = await cmdCardDetails(options);
      break;
    case 'card balance':
      result = await cmdCardBalance(options);
      break;
    case 'card transactions':
      result = await cmdCardTransactions(options);
      break;
    case 'card 3ds latest':
      result = await cmdCard3dsLatest(options);
      break;
    case 'card 3ds latest_1h':
      result = await cmdCard3dsLatest1h(options);
      break;
    case 'card holder create':
      result = await cmdCardHolderCreate(options);
      break;
    case 'card holder me':
      result = await cmdCardHolderMe();
      break;
    case 'card recharge':
      result = await cmdCardRecharge(options);
      break;
    case 'card withdraw':
      result = await cmdCardWithdraw(options);
      break;
    case 'card withdrawals':
      result = await cmdCardWithdrawals(options);
      break;
    case 'card withdrawal':
      result = await cmdCardWithdrawal(options);
      break;
    case 'payout':
      result = await cmdPayout(options);
      break;
    case 'payout-status':
      result = await cmdPayoutStatus(options);
      break;
    case 'x402':
      result = await cmdX402(options);
      break;
    case 'mandate-create':
      result = await cmdMandateCreate(options);
      break;
    case 'mandate-status':
      result = await cmdMandateStatus(options);
      break;
    case 'x402-v3':
      result = await cmdX402V3(options);
      break;
    case 'paymentlink-create':
      result = await cmdPaymentLinkCreate(options);
      break;
    case 'paymentlink-list':
      result = await cmdPaymentLinkList(options);
      break;
    case 'paymentlink-get':
      result = await cmdPaymentLinkGet(options);
      break;
    case 'paymentlink-update':
      result = await cmdPaymentLinkUpdate(options);
      break;
    case 'paymentlink-delete':
      result = await cmdPaymentLinkDelete(options);
      break;
    case 'paymentlink-payments':
      result = await cmdPaymentLinkPayments(options);
      break;
    case 'received-records':
      result = await cmdReceivedRecords(options);
      break;
    case 'received-record':
      result = await cmdReceivedRecord(options);
      break;
    case 'paymentlink-refund-create':
      result = await cmdPaymentLinkRefundCreate(options);
      break;
    case 'paymentlink-refund-list':
      result = await cmdPaymentLinkRefundList(options);
      break;
    case 'paymentlink-refund-get':
      result = await cmdPaymentLinkRefundGet(options);
      break;
    case 'paymentlink-refund-cancel':
      result = await cmdPaymentLinkRefundCancel(options);
      break;
    case 'check-wallet':
      result = await cmdCheckWallet();
      break;
    case 'link-wallet':
      result = await cmdLinkWallet();
      break;
    case 'agent-vc':
      result = await cmdAgentVC(options);
      break;
    case 'wallet-address':
      result = await cmdWalletAddress();
      break;
    case 'balance':
      result = await cmdBalance(options);
      break;
    case 'mandates':
      result = await cmdMandates();
      break;
    case 'recent-transactions':
      result = await cmdRecentTransactions(options);
      break;
    case 'help':
    case '--help':
    case '-h':
      printUsage();
      process.exit(0);
    default:
      console.error(`Unknown command: ${command}`);
      printUsage();
      process.exit(1);
  }

  output(result);
  process.exit(result.success ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
