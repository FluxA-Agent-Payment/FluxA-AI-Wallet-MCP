#!/usr/bin/env node
/**
 * FluxA Wallet CLI
 * Standalone command-line interface for FluxA Wallet operations
 * Can be bundled into a single file with esbuild for distribution
 */

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
  listCards,
  initiateCard,
  completeCard,
  getCardDetails,
  getCardBalance,
  listReceivedPayments,
  getReceivedPayment,
  checkWalletLinked,
  buildLinkWalletUrl,
  resolveCurrency,
  SUPPORTED_CURRENCIES,
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

// Default asset configuration
const DEFAULT_NETWORK = 'base';
const DEFAULT_ASSET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // USDC on Base

interface CommandResult {
  success: boolean;
  data?: any;
  error?: string;
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
  card list                 List issued cards
  card create               Issue a funded card
  card details              Reveal full card details
  card balance              Refresh and query card balance
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
  received-records          List all received payment records
  received-record           Get a single received payment record detail
  check-wallet              Check if agent is linked to user's wallet
  link-wallet               Get wallet linking URL (or confirm already linked)

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

OPTIONS FOR 'card create':
  --amount <usd>            Card amount in USD, human-readable (required)
  --mandate <mandate_id>    Mandate ID for x402 payment (required)

OPTIONS FOR 'card details':
  --id <card_id>            Card ID (required)

OPTIONS FOR 'card balance':
  --id <card_id>            Card ID (required)

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

OPTIONS FOR 'received-records':
  --limit <number>          Max number of results (default: 20, max: 100)
  --offset <number>         Pagination offset (default: 0)

OPTIONS FOR 'received-record':
  --id <payment_id>         Payment record ID (required)

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

  # Issue a card (requires mandate for x402 payment)
  fluxa-wallet card create --amount 25.00 --mandate mand_xxxxx

  # Reveal card details
  fluxa-wallet card details --id 12

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

  # Get a single received payment record
  fluxa-wallet received-record --id 1
`);
}

function parseArgs(args: string[]): { command: string; options: Record<string, string>; helpRequested: boolean } {
  let command = args[0] || 'help';
  const options: Record<string, string> = {};
  let helpRequested = false;
  let optionStartIndex = 1;

  if (command === 'card') {
    const subcommand = args[1];
    if (subcommand && !subcommand.startsWith('-')) {
      command = `card ${subcommand}`;
      optionStartIndex = 2;
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
    }
  }

  return { command, options, helpRequested };
}

const COMMAND_USAGE: Record<string, string> = {
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

  'card list': `Usage: fluxa-wallet card list

List cards owned by the current authorized agent.

Example:
  fluxa-wallet card list`,

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
  fluxa-wallet card details --id 12`,

  'card balance': `Usage: fluxa-wallet card balance --id <card_id>

Refresh and retrieve the current balance for a specific card.

Options:
  --id <card_id>       Card ID (required)

Example:
  fluxa-wallet card balance --id 12`,

  payout: `Usage: fluxa-wallet payout [options]

Create a payout to send funds to a wallet address.

Options:
  --to <address>      Recipient address (required)
  --amount <amount>   Amount in smallest units (required)
  --id <payout_id>    Unique payout ID (required)
  --network <network> Network (default: base)
  --asset <address>   Asset contract address (default: USDC on Base)

Example:
  fluxa-wallet payout --to 0x1234...abcd --amount 1000000 --id pay_001`,

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
};

function output(result: CommandResult) {
  console.log(JSON.stringify(result, null, 2));
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
      card_service_api: process.env.CARD_SERVICE_API || 'http://localhost:3002',
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

async function cmdCardList(): Promise<CommandResult> {
  const auth = await ensureValidJWT();
  if (!auth) {
    return {
      success: false,
      error: 'FluxA Agent ID not initialized. Run "init" first.',
    };
  }

  try {
    const result = await listCards(auth.jwt);

    await recordAudit({
      event: 'card_list',
      count: result.cardCount,
    });

    return {
      success: true,
      data: result,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Card list failed',
    };
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

  const auth = await ensureValidJWT();
  if (!auth) {
    return {
      success: false,
      error: 'FluxA Agent ID not initialized. Run "init" first.',
    };
  }

  try {
    // Step 1: Initiate card issuance → get payment request
    const initiated = await initiateCard({ amountUsd }, auth.jwt);

    // Step 2: Sign payment via wallet backend using agent's mandate
    const signed = await requestX402V2Payment(
      { mandateId, paymentRequest: initiated.paymentRequest },
      auth.jwt
    );

    if (signed.status !== 'ok' || !signed.paymentPayloadB64) {
      return {
        success: false,
        error: signed.message || 'x402 payment signing failed',
      };
    }

    // Step 3: Complete card issuance with signed payment
    const result = await completeCard(
      {
        pendingRequestId: initiated.pendingRequestId,
        paymentPayloadB64: signed.paymentPayloadB64,
      },
      auth.jwt
    );

    await recordAudit({
      event: 'card_create',
      amount_usd: amountUsd,
      mandate_id: mandateId,
      card_id: result.card?.id,
    });

    return {
      success: true,
      data: result,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Card creation failed',
    };
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

  const auth = await ensureValidJWT();
  if (!auth) {
    return {
      success: false,
      error: 'FluxA Agent ID not initialized. Run "init" first.',
    };
  }

  try {
    const result = await getCardDetails(cardId, auth.jwt);

    await recordAudit({
      event: 'card_details',
      card_id: cardId,
    });

    return {
      success: true,
      data: result,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Card details request failed',
    };
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

  const auth = await ensureValidJWT();
  if (!auth) {
    return {
      success: false,
      error: 'FluxA Agent ID not initialized. Run "init" first.',
    };
  }

  try {
    const result = await getCardBalance(cardId, auth.jwt);

    await recordAudit({
      event: 'card_balance',
      card_id: cardId,
      remaining_amount_usd: result.balance?.remainingAmountUsd,
    });

    return {
      success: true,
      data: result,
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'Card balance request failed',
    };
  }
}

async function cmdPayout(options: Record<string, string>): Promise<CommandResult> {
  const toAddress = options.to;
  const amount = options.amount;
  const payoutId = options.id;
  const network = options.network || DEFAULT_NETWORK;
  const assetAddress = options.asset || DEFAULT_ASSET;

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
      },
      auth.jwt
    );

    await recordAudit({
      event: 'payout_request',
      payout_id: payoutId,
      to: toAddress,
      amount,
      status: result.status,
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

// Main entry point
async function main() {
  const args = process.argv.slice(2);
  const { command, options, helpRequested } = parseArgs(args);

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
      result = await cmdCardList();
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
    case 'check-wallet':
      result = await cmdCheckWallet();
      break;
    case 'link-wallet':
      result = await cmdLinkWallet();
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
