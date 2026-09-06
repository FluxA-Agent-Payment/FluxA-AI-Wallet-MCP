// CARD_USD (linked card / VIC) intent mandate extension.
//
// Mirrors the Wallet backend's validateCardExt so the CLI rejects a bad
// `intent.ext` locally with a field-level message instead of a round trip.
//
// Contract (wallet dev, 2026-09): `merchant { name, url, country_code }` plus
// an optional `transaction_reference_id`. `cardExecutionMode` defaults to
// VIC_DYNAMIC_CREDENTIAL on the wallet side; the old `ext.vic` block is
// rejected by the wallet, so it is rejected here too.

export const CARD_USD_CURRENCY = 'CARD_USD';
export const VIC_EXECUTION_MODE = 'VIC_DYNAMIC_CREDENTIAL';

// CardVault simple merchant instruction limits (UTF-8 bytes).
export const MERCHANT_NAME_MAX_BYTES = 40;
export const MERCHANT_URL_MAX_BYTES = 255;
export const TRANSACTION_REFERENCE_MAX_BYTES = 50;
export const INSTRUCTION_PURPOSE_MAX_BYTES = 255;

export interface CardMandateExt {
  cardExecutionMode: typeof VIC_EXECUTION_MODE;
  merchant: {
    name: string;
    url: string;
    country_code: string;
  };
  transaction_reference_id?: string;
}

export class CardMandateExtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardMandateExtError';
  }
}

const MERCHANT_COUNTRY_RE = /^[A-Z]{2}$/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

function boundedText(value: unknown, label: string, maxBytes: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new CardMandateExtError(`${label} is required`);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    throw new CardMandateExtError(`${label} must be at most ${maxBytes} bytes`);
  }
  if (CONTROL_CHAR_RE.test(text)) {
    throw new CardMandateExtError(`${label} must not contain control characters`);
  }
  return text;
}

function validateMerchantUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new CardMandateExtError('merchant.url (--merchant-url) must be a full HTTPS URL, e.g. https://www.amazon.com');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname.includes('.')) {
    throw new CardMandateExtError('merchant.url (--merchant-url) must be a full HTTPS URL, e.g. https://www.amazon.com');
  }
  return raw;
}

/** Validate a full ext object (from --ext) and return the canonical shape. */
export function validateCardMandateExt(raw: unknown): CardMandateExt {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CardMandateExtError('intent.ext must be a JSON object');
  }
  const ext = raw as Record<string, any>;
  if ('vic' in ext) {
    throw new CardMandateExtError(
      'ext.vic is no longer supported by the wallet. Send merchant {name, url, country_code} and optionally transaction_reference_id.'
    );
  }
  const mode = String(ext.cardExecutionMode ?? '').trim() || VIC_EXECUTION_MODE;
  if (mode !== VIC_EXECUTION_MODE) {
    throw new CardMandateExtError(`cardExecutionMode must be ${VIC_EXECUTION_MODE} (Manual Direct is not supported by the CLI)`);
  }
  const merchantRaw = ext.merchant;
  if (!merchantRaw || typeof merchantRaw !== 'object' || Array.isArray(merchantRaw)) {
    throw new CardMandateExtError('merchant is required (--merchant-name, --merchant-url, --merchant-country)');
  }
  const merchant = {
    name: boundedText(merchantRaw.name, 'merchant.name (--merchant-name)', MERCHANT_NAME_MAX_BYTES),
    url: validateMerchantUrl(boundedText(merchantRaw.url, 'merchant.url (--merchant-url)', MERCHANT_URL_MAX_BYTES)),
    country_code: boundedText(merchantRaw.country_code, 'merchant.country_code (--merchant-country)', 2),
  };
  if (!MERCHANT_COUNTRY_RE.test(merchant.country_code)) {
    throw new CardMandateExtError('merchant.country_code (--merchant-country) must be a 2-letter uppercase code, e.g. US');
  }
  const out: CardMandateExt = { cardExecutionMode: VIC_EXECUTION_MODE, merchant };
  const ref = ext.transaction_reference_id;
  if (ref !== undefined && ref !== null && String(ref).trim() !== '') {
    out.transaction_reference_id = boundedText(
      ref,
      'transaction_reference_id (--transaction-ref)',
      TRANSACTION_REFERENCE_MAX_BYTES
    );
  }
  return out;
}

export interface CardMandateFlagOptions {
  'merchant-name'?: string;
  'merchant-url'?: string;
  'merchant-country'?: string;
  'transaction-ref'?: string;
}

export const CARD_MANDATE_FLAGS = ['merchant-name', 'merchant-url', 'merchant-country', 'transaction-ref'] as const;

/** Build the ext from the individual mandate-create flags. */
export function buildCardMandateExtFromFlags(options: CardMandateFlagOptions): CardMandateExt {
  return validateCardMandateExt({
    cardExecutionMode: VIC_EXECUTION_MODE,
    merchant: {
      name: options['merchant-name'],
      url: options['merchant-url'],
      country_code: options['merchant-country']?.toUpperCase(),
    },
    ...(options['transaction-ref'] !== undefined ? { transaction_reference_id: options['transaction-ref'] } : {}),
  });
}

export function hasAnyCardMandateFlag(options: Record<string, string>): boolean {
  return CARD_MANDATE_FLAGS.some((key) => options[key] !== undefined);
}

/**
 * The natural-language description becomes the CardVault instruction purpose
 * for VIC mandates: 1-255 bytes, no line breaks.
 */
export function validateCardMandatePurpose(desc: string): void {
  const text = String(desc ?? '').trim();
  if (!text) throw new CardMandateExtError('--desc is required');
  if (Buffer.byteLength(text, 'utf8') > INSTRUCTION_PURPOSE_MAX_BYTES) {
    throw new CardMandateExtError(`--desc must be at most ${INSTRUCTION_PURPOSE_MAX_BYTES} bytes for CARD_USD mandates`);
  }
  if (/[\r\n\0]/.test(text)) {
    throw new CardMandateExtError('--desc must not contain line breaks for CARD_USD mandates');
  }
}
