// CARD_USD (linked card / VIC) intent mandate extension.
//
// Mirrors the Wallet backend's validateCardExt so the CLI rejects a bad
// `intent.ext` locally with a field-level message instead of a round trip.
// Only the VIC_DYNAMIC_CREDENTIAL execution mode is exposed here.

export const CARD_USD_CURRENCY = 'CARD_USD';
export const VIC_EXECUTION_MODE = 'VIC_DYNAMIC_CREDENTIAL';

export interface CardMandateProduct {
  productReference: string;
  maxQuantity: number;
}

export interface CardMandateExt {
  cardExecutionMode: typeof VIC_EXECUTION_MODE;
  merchant: {
    name: string;
    url: string;
    country_code: string;
  };
  vic: {
    merchantId: string;
    merchantCategory: string;
    merchantCategoryCode: string;
    productScope: CardMandateProduct[];
  };
}

export class CardMandateExtError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CardMandateExtError';
  }
}

const MERCHANT_COUNTRY_RE = /^[A-Z]{2}$/;
const MCC_RE = /^[0-9]{4}$/;
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

function boundedText(value: unknown, label: string, maxLength: number): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new CardMandateExtError(`${label} is required`);
  if (Buffer.byteLength(text, 'utf8') > maxLength) {
    throw new CardMandateExtError(`${label} must be at most ${maxLength} bytes`);
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
    throw new CardMandateExtError('merchant.url must be a full HTTPS URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname.includes('.')) {
    throw new CardMandateExtError('merchant.url must be a full HTTPS URL');
  }
  return raw;
}

/** Parse `ref:qty[,ref:qty...]` (the --product flag) into a product scope. */
export function parseProductScopeFlag(raw: string): CardMandateProduct[] {
  return String(raw)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const idx = entry.lastIndexOf(':');
      if (idx <= 0) {
        throw new CardMandateExtError(
          `--product entries must look like <productReference>:<maxQuantity> (got "${entry}")`
        );
      }
      return { productReference: entry.slice(0, idx), maxQuantity: Number(entry.slice(idx + 1)) };
    });
}

function validateProductScope(raw: unknown): CardMandateProduct[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100) {
    throw new CardMandateExtError(
      'vic.productScope must contain 1-100 products (use --product <ref>:<qty>[,<ref>:<qty>])'
    );
  }
  return raw.map((product, index) => {
    if (!product || typeof product !== 'object' || Array.isArray(product)) {
      throw new CardMandateExtError(`vic.productScope[${index}] is invalid`);
    }
    const p = product as Record<string, unknown>;
    const productReference = boundedText(p.productReference, `vic.productScope[${index}].productReference`, 128);
    const maxQuantity = Number(p.maxQuantity);
    if (!Number.isInteger(maxQuantity) || maxQuantity < 1 || maxQuantity > 100000) {
      throw new CardMandateExtError(
        `vic.productScope[${index}].maxQuantity must be an integer between 1 and 100000`
      );
    }
    return { productReference, maxQuantity };
  });
}

/** Validate a full ext object (from --ext) and return the canonical shape. */
export function validateCardMandateExt(raw: unknown): CardMandateExt {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new CardMandateExtError('intent.ext must be a JSON object');
  }
  const ext = raw as Record<string, any>;
  const mode = String(ext.cardExecutionMode || VIC_EXECUTION_MODE).trim();
  if (mode !== VIC_EXECUTION_MODE) {
    throw new CardMandateExtError(`cardExecutionMode must be ${VIC_EXECUTION_MODE}`);
  }
  const merchantRaw = ext.merchant;
  if (!merchantRaw || typeof merchantRaw !== 'object' || Array.isArray(merchantRaw)) {
    throw new CardMandateExtError('merchant is required (--merchant-name, --merchant-url, --merchant-country)');
  }
  const merchant = {
    name: boundedText(merchantRaw.name, 'merchant.name', 128),
    url: validateMerchantUrl(boundedText(merchantRaw.url, 'merchant.url', 255)),
    country_code: boundedText(merchantRaw.country_code, 'merchant.country_code', 2),
  };
  if (!MERCHANT_COUNTRY_RE.test(merchant.country_code)) {
    throw new CardMandateExtError('merchant.country_code must be a 2-letter uppercase code (e.g. US)');
  }
  const vicRaw = ext.vic;
  if (!vicRaw || typeof vicRaw !== 'object' || Array.isArray(vicRaw)) {
    throw new CardMandateExtError('vic is required (--merchant-id, --merchant-category, --mcc, --product)');
  }
  const merchantCategoryCode = boundedText(vicRaw.merchantCategoryCode, 'vic.merchantCategoryCode', 4);
  if (!MCC_RE.test(merchantCategoryCode)) {
    throw new CardMandateExtError('vic.merchantCategoryCode (--mcc) must be a 4-digit MCC');
  }
  return {
    cardExecutionMode: VIC_EXECUTION_MODE,
    merchant,
    vic: {
      merchantId: boundedText(vicRaw.merchantId, 'vic.merchantId', 255),
      merchantCategory: boundedText(vicRaw.merchantCategory, 'vic.merchantCategory', 128),
      merchantCategoryCode,
      productScope: validateProductScope(vicRaw.productScope),
    },
  };
}

export interface CardMandateFlagOptions {
  'merchant-name'?: string;
  'merchant-url'?: string;
  'merchant-country'?: string;
  'merchant-id'?: string;
  'merchant-category'?: string;
  mcc?: string;
  product?: string;
}

/** Build the ext from the individual mandate-create flags. */
export function buildCardMandateExtFromFlags(options: CardMandateFlagOptions): CardMandateExt {
  return validateCardMandateExt({
    cardExecutionMode: VIC_EXECUTION_MODE,
    merchant: {
      name: options['merchant-name'],
      url: options['merchant-url'],
      country_code: options['merchant-country']?.toUpperCase(),
    },
    vic: {
      merchantId: options['merchant-id'],
      merchantCategory: options['merchant-category'],
      merchantCategoryCode: options.mcc,
      productScope: options.product ? parseProductScopeFlag(options.product) : [],
    },
  });
}

export function hasAnyCardMandateFlag(options: Record<string, string>): boolean {
  return ['merchant-name', 'merchant-url', 'merchant-country', 'merchant-id', 'merchant-category', 'mcc', 'product']
    .some((key) => options[key] !== undefined);
}
