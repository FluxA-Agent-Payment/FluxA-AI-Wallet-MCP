#!/usr/bin/env node
/**
 * FluxA Wallet CLI
 * Standalone command-line interface for FluxA Wallet operations
 * Can be bundled into a single file with esbuild for distribution
 */

import {
  registerAgent,
  requestX402Payment,
  createPayout,
  getPayoutStatus,
  refreshJWT,
  isJWTExpired,
  extractHost,
  getCurrencyFromAsset,
  type X402PaymentRequest,
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
  node fluxa-cli.bundle.js <command> [options]

COMMANDS:
  status                    Check agent configuration status
  init                      Initialize/register agent ID
  payout                    Create a payout
  payout-status             Query payout status
  x402                      Generate x402 payment header

OPTIONS FOR 'init':
  --email <email>           Email address for registration
  --name <name>             Agent name
  --client <info>           Client info description
  (Or set AGENT_EMAIL, AGENT_NAME, CLIENT_INFO environment variables)

OPTIONS FOR 'payout':
  --to <address>            Recipient address (required)
  --amount <amount>         Amount in smallest units (required)
  --id <payout_id>          Unique payout ID (required)
  --network <network>       Network (default: base)
  --asset <address>         Asset contract address (default: USDC)

OPTIONS FOR 'payout-status':
  --id <payout_id>          Payout ID to query (required)

OPTIONS FOR 'x402':
  --payload <json>          Full x402 payment payload as JSON (required)

ENVIRONMENT VARIABLES:
  AGENT_ID                  Pre-configured agent ID
  AGENT_TOKEN               Pre-configured agent token
  AGENT_JWT                 Pre-configured agent JWT
  AGENT_EMAIL               Email for auto-registration
  AGENT_NAME                Agent name for auto-registration
  CLIENT_INFO               Client info for auto-registration
  FLUXA_DATA_DIR            Custom data directory path

EXAMPLES:
  # Check status
  node fluxa-cli.bundle.js status

  # Initialize with parameters
  node fluxa-cli.bundle.js init --email user@example.com --name "My Agent" --client "CLI v1.0"

  # Create payout
  node fluxa-cli.bundle.js payout --to 0x1234...abcd --amount 1000000 --id pay_001

  # Query payout status
  node fluxa-cli.bundle.js payout-status --id pay_001
`);
}

function parseArgs(args: string[]): { command: string; options: Record<string, string> } {
  const command = args[0] || 'help';
  const options: Record<string, string> = {};

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
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

  return { command, options };
}

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
    return {
      success: true,
      data: {
        configured: true,
        agent_id: agentConfig.agent_id,
        has_token: !!agentConfig.token,
        has_jwt: !!agentConfig.jwt,
        jwt_expired: isJWTExpired(agentConfig.jwt),
        email: agentConfig.email,
        agent_name: agentConfig.agent_name,
      },
    };
  }

  return {
    success: true,
    data: {
      configured: false,
      has_registration_info: !!regInfo,
      registration_email: regInfo?.email,
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
  const email = options.email || process.env.AGENT_EMAIL;
  const agentName = options.name || process.env.AGENT_NAME;
  const clientInfo = options.client || process.env.CLIENT_INFO;

  if (!email || !agentName || !clientInfo) {
    return {
      success: false,
      error: 'Missing required parameters: --email, --name, --client (or set AGENT_EMAIL, AGENT_NAME, CLIENT_INFO)',
    };
  }

  try {
    const result = await registerAgent({ email, agent_name: agentName, client_info: clientInfo });

    // Save to config
    saveAgentId({
      agent_id: result.agent_id,
      token: result.token,
      jwt: result.jwt,
      email,
      agent_name: agentName,
      client_info: clientInfo,
    });

    await recordAudit({
      event: 'agent_registered',
      agent_id: result.agent_id,
      email,
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
  const payloadJson = options.payload;

  if (!payloadJson) {
    return {
      success: false,
      error: 'Missing required parameter: --payload (JSON string)',
    };
  }

  let payload: any;
  try {
    payload = JSON.parse(payloadJson);
  } catch {
    return {
      success: false,
      error: 'Invalid JSON in --payload',
    };
  }

  const auth = await ensureValidJWT();
  if (!auth) {
    return {
      success: false,
      error: 'FluxA Agent ID not initialized. Run "init" first.',
    };
  }

  // Build x402 payment request
  const accept = payload.accepts?.[0];
  if (!accept) {
    return {
      success: false,
      error: 'Invalid payload: missing accepts array',
    };
  }

  const request: X402PaymentRequest = {
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
    approvalId: payload.approvalId,
  };

  try {
    const xPaymentHeader = await requestX402Payment(request, auth.jwt);

    await recordAudit({
      event: 'x402_payment',
      resource: request.resource,
      amount: request.amount,
    });

    return {
      success: true,
      data: {
        'X-PAYMENT': xPaymentHeader,
      },
    };
  } catch (err: any) {
    return {
      success: false,
      error: err.message || 'x402 payment request failed',
    };
  }
}

// Main entry point
async function main() {
  const args = process.argv.slice(2);
  const { command, options } = parseArgs(args);

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
    case 'payout':
      result = await cmdPayout(options);
      break;
    case 'payout-status':
      result = await cmdPayoutStatus(options);
      break;
    case 'x402':
      result = await cmdX402(options);
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
