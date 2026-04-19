/**
 * FluxA Wallet API Client
 * Handles communication with FluxA Agent ID and Wallet APIs
 */

const AGENT_ID_API = process.env.AGENT_ID_API || 'https://agentid.fluxapay.xyz';
const WALLET_API = process.env.WALLET_API || 'https://walletapi.fluxapay.xyz';
const WALLET_APP = process.env.WALLET_APP || 'https://wallet.fluxapay.xyz';
const CARD_SERVICE_API = process.env.CARD_SERVICE_API || 'https://agentcard.fluxapay.xyz';
const AGENT_WALLET_APP = process.env.AGENT_WALLET_APP || 'https://agentwallet.fluxapay.xyz';

// JWT expiry buffer: refresh if expiring within 5 minutes
const JWT_EXPIRY_BUFFER_SECONDS = 300;

// Supported currencies
export const SUPPORTED_CURRENCIES = ['USDC', 'XRP', 'FLUXA_MONETIZE_CREDITS'] as const;
export type SupportedCurrency = typeof SUPPORTED_CURRENCIES[number];

const CURRENCY_ALIASES: Record<string, SupportedCurrency> = {
  'usdc': 'USDC',
  'xrp': 'XRP',
  'fluxa_monetize_credits': 'FLUXA_MONETIZE_CREDITS',
  'fluxa-monetize-credits': 'FLUXA_MONETIZE_CREDITS',
  'fluxa-monetize-credit': 'FLUXA_MONETIZE_CREDITS',
  'fluxa_monetize_credit': 'FLUXA_MONETIZE_CREDITS',
  'credits': 'FLUXA_MONETIZE_CREDITS',
};

/**
 * Resolve a currency string to a supported currency, handling aliases.
 * Returns the canonical currency name or null if not recognized.
 */
export function resolveCurrency(input: string): SupportedCurrency | null {
  // Exact match (case-sensitive)
  if ((SUPPORTED_CURRENCIES as readonly string[]).includes(input)) {
    return input as SupportedCurrency;
  }
  // Alias match (case-insensitive)
  const alias = CURRENCY_ALIASES[input.toLowerCase()];
  return alias ?? null;
}

export interface RegisterAgentRequest {
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

export interface PayoutRequest {
  agentId: string;
  toAddress: string;
  amount: string; // smallest unit string
  currency: string; // e.g., 'USDC'
  network: string; // e.g., 'base'
  assetAddress: string; // token contract address
  payoutId: string; // idempotency key provided by caller
  mandateId?: string; // optional signed mandate for auto-approval
  bizId?: string; // optional external business ID for dedup
  description?: string; // optional human-readable description
}

export interface PayoutResponse {
  payoutId: string;
  status: string; // e.g., 'pending_authorization' | 'authorized' | 'succeeded' | 'confirmed' | 'failed' | ...
  txHash: string | null;
  approvalUrl?: string | null;
  expiresAt?: number;
  mandateId?: string | null;
  bizId?: string | null;
  // allow unknown fields as well
  [key: string]: any;
}

export interface CardRecord {
  id: number;
  provider: string;
  externalCardId: string;
  ownerUserId: number;
  ownerAgentId: number | null;
  ownerExternalAgentId: string | null;
  maskedPan: string | null;
  lastFour: string | null;
  brand: string | null;
  expiryMonth: string | null;
  expiryYear: string | null;
  fundedAmountUsd: string;
  remainingAmountUsd: string;
  currency: string;
  status: string;
  lastBalanceSyncedAt: string | null;
  lastRevealedAt: string | null;
  metadata?: any;
  createdAt: string;
  updatedAt: string;
}

export interface CardDetailsResponse {
  success: boolean;
  details: {
    cardId: number;
    pan: string;
    cvv: string;
    expiryMonth: string;
    expiryYear: string;
    holderName?: string;
    billingAddress?: any | null;
  };
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

async function requestCardService<T>(
  path: string,
  jwt: string,
  options: {
    method?: string;
    body?: Record<string, unknown>;
  } = {}
): Promise<T> {
  const response = await fetch(`${CARD_SERVICE_API}${path}`, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const text = await response.text();
  let data: any = null;

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = text;
  }

  if (!response.ok) {
    const message =
      typeof data === 'object' && data?.error
        ? data.error
        : text || `Card service request failed (${response.status})`;
    throw new WalletApiError(message, response.status, data);
  }

  return data as T;
}

/**
 * Create a payout via FluxA Wallet API
 */
export async function createPayout(
  params: PayoutRequest,
  jwt: string
): Promise<PayoutResponse> {
  const url = `${WALLET_API}/api/payouts`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
      'x-agent-id': params.agentId,
    },
    body: JSON.stringify(params),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new WalletApiError(text || `Wallet API request failed (${response.status})`, response.status, text || null);
  }

  try {
    return JSON.parse(text) as PayoutResponse;
  } catch (e) {
    throw new WalletApiError('Invalid payout API response (not JSON)', response.status, text);
  }
}

export async function listCards(jwt: string): Promise<{ cards: CardRecord[]; cardCount: number }> {
  return requestCardService('/api/cards', jwt);
}

export async function initiateCard(
  params: { amountUsd: string },
  jwt: string
): Promise<{ pendingRequestId: string; paymentRequest: any; expiresAt: string; status: string }> {
  return requestCardService('/api/cards/initiate', jwt, {
    method: 'POST',
    body: params,
  });
}

export async function completeCard(
  params: { pendingRequestId: string; paymentPayloadB64: string },
  jwt: string
): Promise<{ success: boolean; card: CardRecord }> {
  return requestCardService('/api/cards/complete', jwt, {
    method: 'POST',
    body: params,
  });
}

export async function getCardDetails(cardId: string, jwt: string): Promise<CardDetailsResponse> {
  return requestCardService(`/api/cards/${encodeURIComponent(cardId)}/details`, jwt, {
    method: 'POST',
  });
}

export async function getCardBalance(
  cardId: string,
  jwt: string
): Promise<{
  card: CardRecord;
  balance: {
    fundedAmountUsd: string;
    remainingAmountUsd: string;
    currency: string;
    status: string;
    lastBalanceSyncedAt: string | null;
  };
}> {
  return requestCardService(`/api/cards/${encodeURIComponent(cardId)}/balance`, jwt);
}

/**
 * Query payout status from Wallet App public endpoint
 */
export async function getPayoutStatus(
  payoutId: string
): Promise<PayoutResponse> {
  const url = `${WALLET_API}/api/payouts/${encodeURIComponent(payoutId)}`;

  const response = await fetch(url, { method: 'GET' });
  const text = await response.text();

  if (!response.ok) {
    throw new WalletApiError(text || `Wallet App status request failed (${response.status})`, response.status, text || null);
  }

  // Some dev servers may append stray characters (e.g., '%'). Try a lenient parse.
  try {
    return JSON.parse(text) as PayoutResponse;
  } catch {
    const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
    if (end >= 0) {
      const sliced = text.slice(0, end + 1);
      try {
        return JSON.parse(sliced) as PayoutResponse;
      } catch {
        // fallthrough
      }
    }
    throw new WalletApiError('Invalid payout status response (not JSON)', response.status, text);
  }
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
 * Map asset address + network to currency symbol.
 * Returns the canonical currency name.
 */
export function getCurrencyFromAsset(
  assetAddress: string,
  network: string
): string {
  const normalizedAddress = assetAddress.toLowerCase();
  const normalizedNetwork = network.toLowerCase();

  // Base USDC
  if (
    normalizedAddress === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' &&
    (normalizedNetwork === 'base' || normalizedNetwork === 'eip155:8453')
  ) {
    return 'USDC';
  }

  // FLUXA_MONETIZE_CREDITS — identified by network prefix
  if (
    normalizedNetwork === 'fluxa-monetize-credits' ||
    normalizedNetwork.startsWith('fluxa-monetize')
  ) {
    return 'FLUXA_MONETIZE_CREDITS';
  }

  // Default to USDC for unrecognized assets on known EVM networks
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

// ==================== Intent Mandate APIs ====================

export interface IntentMandateIntent {
  naturalLanguage: string;
  category?: string;
  currency?: string;
  limitAmount: string;
  validForSeconds: number;
  hostAllowlist?: string[];
}

export interface CreateIntentMandateRequest {
  intent: IntentMandateIntent;
}

export interface CreateIntentMandateResponse {
  status: string;
  mandateId: string;
  authorizationUrl: string;
  expiresAt?: string;
  agentStatus?: string;
  // Error fields
  code?: string;
  message?: string;
  payment_model_context?: {
    primer: string;
    instructions: string;
  };
}

/**
 * Create an intent mandate draft
 * Returns mandateId and authorizationUrl for user to sign
 */
export async function createIntentMandate(
  params: CreateIntentMandateRequest,
  jwt?: string
): Promise<CreateIntentMandateResponse> {
  const url = `${WALLET_API}/api/mandates/create-intent`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (jwt) {
    headers['Authorization'] = `Bearer ${jwt}`;
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(params),
  });

  const text = await response.text();

  try {
    return JSON.parse(text) as CreateIntentMandateResponse;
  } catch {
    throw new WalletApiError(
      `Invalid create-intent response (not JSON): ${text}`,
      response.status,
      text
    );
  }
}

export interface X402V3PaymentRequest {
  mandateId: string;
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
  validityWindowSeconds?: number;
}

export interface X402V3PaymentResponse {
  status: string;
  xPaymentB64?: string;
  xPayment?: {
    x402Version: number;
    scheme: string;
    network: string;
    payload: {
      signature: string;
      authorization: {
        from: string;
        to: string;
        value: string;
        validAfter: string;
        validBefore: string;
        nonce: string;
      };
    };
  };
  paymentRecordId?: number;
  expiresAt?: number;
  message?: string;
  // Error fields
  code?: string;
  authorizationUrl?: string;
  intentOnboardUrl?: string;
  payment_model_context?: {
    primer: string;
    instructions: string;
  };
}

/**
 * Request x402 v3 payment with intent mandate
 */
export async function requestX402V3Payment(
  params: X402V3PaymentRequest,
  jwt: string
): Promise<X402V3PaymentResponse> {
  const url = `${WALLET_API}/api/payment/x402V3Payment`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
    },
    body: JSON.stringify(params),
  });

  const text = await response.text();

  try {
    return JSON.parse(text) as X402V3PaymentResponse;
  } catch {
    throw new WalletApiError(
      `Invalid x402V3Payment response (not JSON): ${text}`,
      response.status,
      text
    );
  }
}

// ==================== x402 V2 Payment ====================

export interface X402V2PaymentRequest {
  mandateId: string;
  paymentRequest?: any;
  paymentRequestB64?: string;
  preferredAssets?: Array<{ network: string; asset: string }>;
}

/**
 * Request x402 v2 payment with intent mandate
 */
export async function requestX402V2Payment(
  params: X402V2PaymentRequest,
  jwt: string
): Promise<any> {
  const url = `${WALLET_API}/api/v2/payment/x402-payment`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
    },
    body: JSON.stringify(params),
  });

  const text = await response.text();

  try {
    return JSON.parse(text);
  } catch {
    throw new WalletApiError(
      `Invalid x402V2 payment response (not JSON): ${text}`,
      response.status,
      text
    );
  }
}

// ==================== Payment Link APIs ====================

export interface CreatePaymentLinkRequest {
  amount: string;         // atomic units
  currency?: string;      // default "USDC"
  network?: string;       // "base" | "base-sepolia"
  description?: string;
  resourceContent?: string;
  expiresAt?: string;     // ISO 8601
  maxUses?: number;
}

export interface PaymentLinkResponse {
  id: number;
  linkId: string;
  amount: string;
  currency: string;
  network: string;
  payTo: string;
  assetAddress: string;
  scheme: string;
  description: string;
  resourceContent: string;
  status: string;
  expiresAt: string | null;
  maxUses: number | null;
  useCount: number;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface UpdatePaymentLinkRequest {
  description?: string;
  resourceContent?: string;
  status?: 'active' | 'disabled';
  expiresAt?: string | null;
  maxUses?: number | null;
}

export interface PaymentLinkPayment {
  id: number;
  payerAddress: string;
  amount: string;
  currency: string;
  settlementStatus: string;
  settlementTxHash: string | null;
  createdAt: string;
}

/**
 * Create a payment link
 */
export async function createPaymentLink(
  params: CreatePaymentLinkRequest,
  jwt: string
): Promise<{ success: boolean; paymentLink: PaymentLinkResponse }> {
  const url = `${WALLET_API}/api/payment-links`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
    },
    body: JSON.stringify(params),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new WalletApiError(text || `Create payment link failed (${response.status})`, response.status, text || null);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new WalletApiError('Invalid create payment link response (not JSON)', response.status, text);
  }
}

/**
 * List payment links
 */
export async function listPaymentLinks(
  jwt: string,
  limit?: number
): Promise<{ paymentLinks: PaymentLinkResponse[] }> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', String(limit));
  const qs = params.toString();
  const url = `${WALLET_API}/api/payment-links${qs ? `?${qs}` : ''}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${jwt}`,
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new WalletApiError(text || `List payment links failed (${response.status})`, response.status, text || null);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new WalletApiError('Invalid list payment links response (not JSON)', response.status, text);
  }
}

/**
 * Get payment link details
 */
export async function getPaymentLink(
  linkId: string,
  jwt: string
): Promise<{ paymentLink: PaymentLinkResponse }> {
  const url = `${WALLET_API}/api/payment-links/${encodeURIComponent(linkId)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${jwt}`,
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new WalletApiError(text || `Get payment link failed (${response.status})`, response.status, text || null);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new WalletApiError('Invalid get payment link response (not JSON)', response.status, text);
  }
}

/**
 * Update a payment link
 */
export async function updatePaymentLink(
  linkId: string,
  params: UpdatePaymentLinkRequest,
  jwt: string
): Promise<{ success: boolean; paymentLink: PaymentLinkResponse }> {
  const url = `${WALLET_API}/api/payment-links/${encodeURIComponent(linkId)}`;

  const response = await fetch(url, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
    },
    body: JSON.stringify(params),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new WalletApiError(text || `Update payment link failed (${response.status})`, response.status, text || null);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new WalletApiError('Invalid update payment link response (not JSON)', response.status, text);
  }
}

/**
 * Delete a payment link
 */
export async function deletePaymentLink(
  linkId: string,
  jwt: string
): Promise<{ success: boolean; message: string }> {
  const url = `${WALLET_API}/api/payment-links/${encodeURIComponent(linkId)}`;

  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${jwt}`,
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new WalletApiError(text || `Delete payment link failed (${response.status})`, response.status, text || null);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new WalletApiError('Invalid delete payment link response (not JSON)', response.status, text);
  }
}

/**
 * Get payments for a payment link
 */
export async function getPaymentLinkPayments(
  linkId: string,
  jwt: string,
  limit?: number
): Promise<{ payments: PaymentLinkPayment[] }> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', String(limit));
  const qs = params.toString();
  const url = `${WALLET_API}/api/payment-links/${encodeURIComponent(linkId)}/payments${qs ? `?${qs}` : ''}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${jwt}`,
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new WalletApiError(text || `Get payment link payments failed (${response.status})`, response.status, text || null);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new WalletApiError('Invalid payment link payments response (not JSON)', response.status, text);
  }
}

export interface ReceivedPayment {
  id: number;
  payerAddress: string;
  amount: string;
  currency: string;
  settlementStatus: string;
  settlementTxHash: string | null;
  sourceType: string;
  description: string | null;
  paymentLinkId: string | null;
  payerEmail: string | null;
  createdAt: string;
}

export interface ReceivedPaymentDetail extends ReceivedPayment {
  network: string | null;
  payTo: string | null;
}

/**
 * List all received payments across all payment links
 */
export async function listReceivedPayments(
  jwt: string,
  limit?: number,
  offset?: number
): Promise<{ payments: ReceivedPayment[] }> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', String(limit));
  if (offset !== undefined) params.set('offset', String(offset));
  const qs = params.toString();
  const url = `${WALLET_API}/api/received-payments${qs ? `?${qs}` : ''}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${jwt}`,
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new WalletApiError(text || `List received payments failed (${response.status})`, response.status, text || null);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new WalletApiError('Invalid received payments response (not JSON)', response.status, text);
  }
}

/**
 * Get a single received payment detail
 */
export async function getReceivedPayment(
  paymentId: number,
  jwt: string
): Promise<{ payment: ReceivedPaymentDetail }> {
  const url = `${WALLET_API}/api/received-payments/${encodeURIComponent(paymentId)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${jwt}`,
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new WalletApiError(text || `Get received payment failed (${response.status})`, response.status, text || null);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new WalletApiError('Invalid received payment response (not JSON)', response.status, text);
  }
}

/**
 * Check if agent is linked to a user's wallet
 * Returns linked: true on 200, linked: false on 403
 */
export async function checkWalletLinked(
  jwt: string
): Promise<{ linked: boolean }> {
  const url = `${WALLET_API}/api/mandates`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${jwt}`,
    },
  });

  if (response.ok) {
    return { linked: true };
  }

  if (response.status === 403) {
    return { linked: false };
  }

  const text = await response.text();
  throw new WalletApiError(text || `Check wallet linked failed (${response.status})`, response.status, text || null);
}

/**
 * Build the URL for linking an agent to a user's wallet
 */
export function buildLinkWalletUrl(agentId: string, agentName: string): string {
  const params = new URLSearchParams({ agentId, name: agentName });
  return `${AGENT_WALLET_APP}/add-agent?${params.toString()}`;
}

export interface MandateStatusResponse {
  status: string;
  mandate?: {
    mandateId: string;
    status: string;
    naturalLanguage: string;
    category?: string;
    currency: string;
    limitAmount: string;
    spentAmount: string;
    pendingSpentAmount: string;
    remainingAmount: string;
    validFrom: string;
    validUntil: string;
    hostAllowlist?: string[];
    maxAmountPerTx?: string;
    mandateHash: string;
    signedAt?: string;
    createdAt: string;
    updatedAt: string;
    signUrl?: string;
  };
  // Error fields
  code?: string;
  message?: string;
  payment_model_context?: {
    primer: string;
    instructions: string;
  };
}

/**
 * Get mandate status by mandateId
 */
export async function getMandateStatus(
  mandateId: string,
  jwt: string
): Promise<MandateStatusResponse> {
  const url = `${WALLET_API}/api/mandates/agent/${encodeURIComponent(mandateId)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${jwt}`,
    },
  });

  const text = await response.text();

  try {
    return JSON.parse(text) as MandateStatusResponse;
  } catch {
    throw new WalletApiError(
      `Invalid mandate status response (not JSON): ${text}`,
      response.status,
      text
    );
  }
}

// ==================== Payment-Link Refund APIs ====================

export interface InitiateRefundRequest {
  paymentId: number;
  amount?: string;   // atomic units; omit for full refund
  reason?: string;
}

export interface RefundResponse {
  refundId: string;
  refundUrl: string;
  paymentId: number;
  linkId: string;
  sourceType: string;
  amount: string;
  currency: string;
  network: string;
  refundFrom: string;
  refundTo: string;
  status: string;          // pending | settled | failed | expired | cancelled
  refundTxHash: string | null;
  refundType: string;
  reason: string | null;
  originalAmount: string;
  originalTxHash: string | null;
  agentName: string;
  expiresAt: string;
  createdAt: string;
}

/**
 * Initiate a refund for a payment-link payment
 */
export async function initiateRefund(
  params: InitiateRefundRequest,
  jwt: string
): Promise<RefundResponse> {
  const url = `${WALLET_API}/api/payment-links/refunds/initiate`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${jwt}`,
    },
    body: JSON.stringify(params),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new WalletApiError(text || `Initiate refund failed (${response.status})`, response.status, text || null);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new WalletApiError('Invalid initiate refund response (not JSON)', response.status, text);
  }
}

/**
 * List all payment-link refunds
 */
export async function listRefunds(
  jwt: string,
  limit?: number,
  offset?: number
): Promise<{ refunds: RefundResponse[] }> {
  const params = new URLSearchParams();
  if (limit !== undefined) params.set('limit', String(limit));
  if (offset !== undefined) params.set('offset', String(offset));
  const qs = params.toString();
  const url = `${WALLET_API}/api/payment-links/refunds${qs ? `?${qs}` : ''}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${jwt}`,
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new WalletApiError(text || `List refunds failed (${response.status})`, response.status, text || null);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new WalletApiError('Invalid list refunds response (not JSON)', response.status, text);
  }
}

/**
 * Get a single payment-link refund by ID
 */
export async function getRefund(
  refundId: string,
  jwt: string
): Promise<RefundResponse> {
  const url = `${WALLET_API}/api/payment-links/refunds/${encodeURIComponent(refundId)}`;

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${jwt}`,
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new WalletApiError(text || `Get refund failed (${response.status})`, response.status, text || null);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new WalletApiError('Invalid get refund response (not JSON)', response.status, text);
  }
}

/**
 * Cancel a pending payment-link refund
 */
export async function cancelRefund(
  refundId: string,
  jwt: string
): Promise<RefundResponse> {
  const url = `${WALLET_API}/api/payment-links/refunds/${encodeURIComponent(refundId)}/cancel`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${jwt}`,
    },
  });

  const text = await response.text();

  if (!response.ok) {
    throw new WalletApiError(text || `Cancel refund failed (${response.status})`, response.status, text || null);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new WalletApiError('Invalid cancel refund response (not JSON)', response.status, text);
  }
}
