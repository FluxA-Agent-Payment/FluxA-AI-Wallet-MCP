import { WALLET_API } from './client.js';

type Stage = 'Wallet' | 'CardVault';

interface ErrorDetails {
  httpStatus?: number;
  retryable?: boolean;
  upstreamCode?: string;
  upstreamStatus?: number;
  requestId?: string;
  mandateStatus?: string;
  approvalUrl?: string;
}

export class SingleUseCardError extends Error {
  constructor(message: string, readonly code: string, readonly details: ErrorDetails = {}) {
    super(message);
  }
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : undefined;
}

function localHost(url: URL): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function serviceUrl(value: unknown): URL | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash ? url : null;
  } catch {
    return null;
  }
}

async function postJson(stage: Stage, url: string, init: RequestInit = {}) {
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      ...init, method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(20_000),
    });
    text = await response.text();
  } catch {
    throw new SingleUseCardError(`${stage} request failed or timed out.`, 'card_request_failed');
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function walletError(status: number, body: any, mandateId: string): SingleUseCardError {
  const code = safeIdentifier(body?.code ?? body?.error) ?? 'wallet_request_failed';
  const details: ErrorDetails = {
    httpStatus: status,
    retryable: typeof body?.retryable === 'boolean' ? body.retryable : undefined,
    upstreamCode: safeIdentifier(body?.upstreamCode),
    upstreamStatus: Number.isInteger(body?.upstreamStatus) ? body.upstreamStatus : undefined,
    requestId: safeIdentifier(body?.requestId),
    mandateStatus: safeIdentifier(body?.mandateStatus),
  };
  const approval = serviceUrl(body?.approvalUrl);
  if (code === 'card_mandate_not_active' && approval &&
      (approval.protocol === 'https:' || (approval.protocol === 'http:' && localHost(approval))) &&
      approval.pathname === '/onboard/intent' && approval.searchParams.get('mandateId') === mandateId) {
    details.approvalUrl = `${approval.origin}${approval.pathname}?${new URLSearchParams({ mandateId })}`;
  }
  switch (details.upstreamCode ?? code) {
    case 'VIRTUAL_CARD_NOT_FOUND':
      return new SingleUseCardError(
        'CardVault could not open a new redemption session. If the credential expired, a new reference issues another card and reserves the amount again.',
        code, details,
      );
    case 'invalid_amount':
      return new SingleUseCardError('Amount must be a positive integer in cents.', code, details);
    case 'invalid_transaction_reference':
      return new SingleUseCardError('Transaction reference must use 1–50 letters, digits, dots, underscores, colons or hyphens.', code, details);
    case 'agent_auth_failed':
    case 'agent_not_authorized':
    case 'wrong_token_type':
      return new SingleUseCardError('The connected Agent is not authorized to issue this card.', code, details);
    case 'feature_not_enabled':
      return new SingleUseCardError('Single-use cards are not enabled for this Agent.', code, details);
    case 'mandate_not_found':
      return new SingleUseCardError('Mandate not found for this Agent.', code, details);
    case 'mandate_type_mismatch':
    case 'card_mode_mismatch':
      return new SingleUseCardError('Choose a VIC-enabled CARD_USD mandate.', code, details);
    case 'card_mandate_not_active':
      return new SingleUseCardError('The mandate is not active. Check its status or use the approval link if one is available.', code, details);
    case 'INSTRUCTION_LIMIT_EXCEEDED':
      return new SingleUseCardError('The amount exceeds the mandate’s available balance.', code, details);
    case 'IDEMPOTENCY_CONFLICT':
      return new SingleUseCardError('This reference was used with different parameters. Use the original amount to retry, or a new reference for a separate card.', code, details);
    case 'MERCHANT_BLOCKED':
      return new SingleUseCardError('CardVault blocked this merchant.', code, details);
    default:
      return new SingleUseCardError('Wallet could not issue the single-use card.', code, details);
  }
}

function money(value: any) {
  if (typeof value?.value !== 'string' || !/^\d+\.\d{2}$/.test(value.value) ||
      typeof value.currency !== 'string' || !/^[A-Z]{3}$/.test(value.currency)) return null;
  return { value: value.value as string, currency: value.currency as string };
}

export async function createSingleUseCard(
  jwt: string,
  mandateId: string,
  amount: string,
  transactionReference: string,
) {
  const base = serviceUrl(WALLET_API);
  const local = base !== null && localHost(base);
  if (!base || (base.protocol !== 'https:' && !(base.protocol === 'http:' && local))) {
    throw new SingleUseCardError('WALLET_API must use HTTPS or loopback HTTP.', 'invalid_wallet_url');
  }
  const issueUrl = `${base.origin}${base.pathname.replace(/\/$/, '')}/api/mandates/agent/${encodeURIComponent(mandateId)}/subcard`;
  const issueRequest = {
    headers: { Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ amount, transactionReference }),
  };
  const cents = amount.padStart(3, '0');
  const expectedAmount = `${cents.slice(0, -2)}.${cents.slice(-2)}`;

  async function issue() {
    let result = await postJson('Wallet', issueUrl, issueRequest).catch(() => null);
    // The original request may have completed upstream. Keep its reference and amount.
    if (!result || (result.status >= 500 && result.body?.retryable !== false)) {
      result = await postJson('Wallet', issueUrl, issueRequest);
    }
    const { status, body } = result;
    if (status !== 201 || body?.status === 'error') throw walletError(status, body, mandateId);

    const subcard = body?.subcard;
    const virtualCardId = safeIdentifier(subcard?.virtualCardId);
    const issuedAmount = money(subcard?.amount);
    const available = money(subcard?.mandateAmounts?.available);
    if (body?.status !== 'ok' || body.mandateId !== mandateId ||
        subcard?.transactionReference !== transactionReference || !virtualCardId ||
        issuedAmount?.value !== expectedAmount || issuedAmount.currency !== 'USD' || !available ||
        typeof subcard.status !== 'string' || typeof subcard.spendStatus !== 'string') {
      throw new SingleUseCardError('Wallet returned invalid card metadata.', 'invalid_wallet_response');
    }
    const url = serviceUrl(body.redeem?.url);
    if (body.redeem?.method !== 'POST' || !url ||
        (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && localHost(url)))) {
      throw new SingleUseCardError('Wallet returned an invalid or insecure redemption link.', 'invalid_redeem_url');
    }
    const merchant = subcard.merchant;
    const card = {
      mandateId, transactionReference, virtualCardId,
      amount: issuedAmount, status: subcard.status as string, spendStatus: subcard.spendStatus as string,
      merchant: merchant ? {
        name: typeof merchant.name === 'string' ? merchant.name : null,
        url: typeof merchant.url === 'string' ? merchant.url : null,
        country_code: typeof merchant.country_code === 'string' ? merchant.country_code : null,
      } : null,
      mandateAmounts: {
        reserved: money(subcard.mandateAmounts.reserved),
        spent: money(subcard.mandateAmounts.spent),
        available,
      },
    };
    return { card, url: body.redeem.url as string };
  }

  let issued = await issue();
  let redeemed = await postJson('CardVault', issued.url);
  if (redeemed.status === 410 || redeemed.status === 502) {
    const refreshed = await issue();
    if (refreshed.card.virtualCardId !== issued.card.virtualCardId) {
      throw new SingleUseCardError('Wallet returned a different card for the same reference.', 'card_id_mismatch');
    }
    if (refreshed.url === issued.url) {
      throw new SingleUseCardError('Wallet did not return a fresh redemption link.', 'stale_redeem_url');
    }
    issued = refreshed;
    redeemed = await postJson('CardVault', issued.url);
  }
  const credential = redeemed.body?.data;
  if (redeemed.status !== 200 || redeemed.body?.success !== true) {
    const code = safeIdentifier(redeemed.body?.error?.code) ?? 'cardvault_redeem_failed';
    const error = redeemed.status === 429
      ? 'CardVault rate limited the request. Try again later with the same reference.'
      : 'CardVault could not redeem the credential. Retry with the same reference.';
    throw new SingleUseCardError(error, code, { httpStatus: redeemed.status });
  }
  if (credential?.virtual_card_id !== issued.card.virtualCardId ||
      typeof credential.payment_token !== 'string' || !/^[0-9]{13,19}$/.test(credential.payment_token) ||
      typeof credential.dynamic_value !== 'string' || !credential.dynamic_value ||
      typeof credential.dynamic_data_type !== 'string' || !credential.dynamic_data_type ||
      !Number.isInteger(credential.exp_month) || credential.exp_month < 1 || credential.exp_month > 12 ||
      !Number.isInteger(credential.exp_year) || typeof credential.credential_expires_at !== 'string' ||
      !Number.isFinite(Date.parse(credential.credential_expires_at))) {
    throw new SingleUseCardError('CardVault returned an invalid credential.', 'invalid_credential_response');
  }
  if (Date.parse(credential.credential_expires_at) <= Date.now()) {
    throw new SingleUseCardError('The credential expired. A new reference issues another card and reserves the amount again.', 'credential_expired');
  }
  return {
    card: issued.card,
    credential: {
      pan: credential.payment_token as string,
      exp_month: credential.exp_month as number,
      exp_year: credential.exp_year as number,
      dynamic_value: credential.dynamic_value as string,
      dynamic_data_type: credential.dynamic_data_type as string,
      credential_expires_at: credential.credential_expires_at as string,
    },
  };
}
