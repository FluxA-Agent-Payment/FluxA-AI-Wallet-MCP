/**
 * FluxA Wallet API Client
 * Handles communication with FluxA Agent ID and Wallet APIs
 */

const AGENT_ID_API = process.env.AGENT_ID_API || 'https://agentid.fluxapay.xyz';
const WALLET_API = process.env.WALLET_API || 'https://walletapi.fluxapay.xyz';

// JWT expiry buffer: refresh if expiring within 5 minutes
const JWT_EXPIRY_BUFFER_SECONDS = 300;

export interface RegisterAgentRequest {
  email: string;
  agent_name: string;
  client_info: string;
}

export interface RegisterAgentResponse {
  agent_id: string;
  token: string;
  jwt: string;
}

export interface X402PaymentRequest {
  scheme: string;
  network: string;
  amount: string;
  currency: string;
  assetAddress: string;
  payTo: string;
  host: string;
  resource: string;
  description: string;
  tokenName: string;
  tokenVersion: string;
  validityWindowSeconds: number;
  approvalId?: string;
}

export type X402PaymentResponse = string;

export class WalletApiError extends Error {
  status?: number;
  details?: any;

  constructor(message: string, status?: number, details?: any) {
    super(message);
    this.name = 'WalletApiError';
    this.status = status;
    this.details = details;
  }
}

/**
 * Register a new agent with FluxA Agent ID service
 */
export async function registerAgent(
  params: RegisterAgentRequest
): Promise<RegisterAgentResponse> {
  const url = `${AGENT_ID_API}/register`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(params),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Agent registration failed (${response.status}): ${errorText}`
    );
  }

  const data = await response.json();

  // Validate response has required fields
  if (!data.agent_id || !data.token || !data.jwt) {
    throw new Error(
      'Invalid registration response: missing agent_id, token, or jwt'
    );
  }

  return data as RegisterAgentResponse;
}

/**
 * Request x402 payment signature from FluxA Wallet API
 */
export async function requestX402Payment(
  params: X402PaymentRequest,
  jwt: string
): Promise<X402PaymentResponse> {
  const url = `${WALLET_API}/api/payment/x402V1Payment`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
    },
    body: JSON.stringify(params),
  });

  const responseText = await response.text();

  if (!response.ok) {
    const message =
      responseText ||
      `Wallet API request failed (${response.status})`;
    throw new WalletApiError(message, response.status, responseText || null);
  }

  if (!responseText) {
    throw new WalletApiError('Wallet API returned empty response', response.status, responseText);
  }

  return responseText;
}

/**
 * Extract host from URL
 */
export function extractHost(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.host;
  } catch (e) {
    // If URL parsing fails, try to extract domain manually
    const match = url.match(/^(?:https?:\/\/)?([^\/]+)/);
    return match ? match[1] : url;
  }
}

/**
 * Map asset address to currency symbol
 * Currently only supports USDC
 */
export function getCurrencyFromAsset(
  assetAddress: string,
  network: string
): string {
  const normalizedAddress = assetAddress.toLowerCase();

  // Base USDC
  if (
    normalizedAddress === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' &&
    network === 'base'
  ) {
    return 'USDC';
  }

  // Default to USDC for now
  // TODO: Add more token mappings as needed
  return 'USDC';
}

/**
 * Parse JWT and extract payload
 */
function parseJWT(jwt: string): any {
  try {
    const parts = jwt.split('.');
    if (parts.length !== 3) {
      return null;
    }
    const payload = parts[1];
    const decoded = Buffer.from(payload, 'base64').toString('utf-8');
    return JSON.parse(decoded);
  } catch (e) {
    return null;
  }
}

/**
 * Check if JWT is expired or will expire soon
 * Returns true if JWT is expired or expiring within buffer time
 */
export function isJWTExpired(jwt: string): boolean {
  const payload = parseJWT(jwt);
  if (!payload || !payload.exp) {
    return true; // Invalid JWT, treat as expired
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = payload.exp;

  // Check if expired or expiring within buffer time
  return expiresAt <= (now + JWT_EXPIRY_BUFFER_SECONDS);
}

/**
 * Refresh JWT token using agent_id and token
 */
export async function refreshJWT(
  agent_id: string,
  token: string
): Promise<string> {
  const url = `${AGENT_ID_API}/refresh`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ agent_id, token }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `JWT refresh failed (${response.status}): ${errorText}`
    );
  }

  const data = await response.json();

  if (!data.jwt) {
    throw new Error('Invalid refresh response: missing jwt');
  }

  return data.jwt;
}
