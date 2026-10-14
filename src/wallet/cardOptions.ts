import type { CardholderProfile, CardholderProfilePatch, CardTypeSelector } from './client.js';

export function cardAmount(value: string): string {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('USD amount must be a positive decimal with at most two decimal places');
  const [whole, fraction = ''] = value.split('.');
  const amount = `${BigInt(whole)}.${fraction.padEnd(2, '0')}`;
  if (BigInt(whole) === 0n && Number(fraction) === 0) throw new Error('USD amount must be greater than zero');
  return amount;
}

export function cardSelector(options: Record<string, string>): CardTypeSelector {
  const selectors = ['card-type-id', 'bin-id', 'bin'].filter(key => options[key] !== undefined);
  if (selectors.length !== 1) throw new Error('Provide exactly one of --card-type-id, --bin-id, --bin; use "card types" to choose a product');
  const key = selectors[0];
  const value = options[key].trim();
  if (!value || value === 'true') throw new Error(`--${key} requires a string value`);
  if (key === 'bin' && !/^\d+$/.test(value)) throw new Error('--bin must contain digits only');
  return key === 'card-type-id' ? { cardTypeId: value } : key === 'bin-id' ? { binId: value } : { bin: value };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function cardProfile(value: unknown, partial: false): CardholderProfile;
export function cardProfile(value: unknown, partial: true): CardholderProfilePatch;
export function cardProfile(value: unknown, partial: boolean): CardholderProfile | CardholderProfilePatch {
  if (!object(value) || Object.keys(value).length === 0) throw new Error('Profile must be a non-empty JSON object');
  const fields = ['firstName', 'lastName', 'email', 'phone', 'address'];
  if (Object.keys(value).some(key => !fields.includes(key))) throw new Error('Unsupported profile field; use firstName, lastName, email, phone, address');
  for (const field of fields.slice(0, 4)) {
    if ((!partial || field in value) && (typeof value[field] !== 'string' || !(value[field] as string).trim())) {
      throw new Error(`Profile ${field} is required and must be a non-empty string`);
    }
  }
  if ('phone' in value && !/^\+[1-9]\d{6,14}$/.test(value.phone as string)) throw new Error('Profile phone must use E.164 format, e.g. +14155550123');
  if (!partial || 'address' in value) {
    if (!object(value.address) || Object.keys(value.address).length === 0) throw new Error('Profile address must be a non-empty object');
    const required = ['country', 'city', 'line1', 'postalCode'];
    const allowed = [...required, 'region', 'line2'];
    if (Object.keys(value.address).some(key => !allowed.includes(key))) throw new Error('Unsupported address field');
    for (const key of allowed) {
      const address = value.address;
      if ((!partial && required.includes(key)) || key in address) {
        if (typeof address[key] !== 'string' || !(address[key] as string).trim()) throw new Error(`Profile address.${key} must be a non-empty string`);
      }
    }
  }
  return value as unknown as CardholderProfile | CardholderProfilePatch;
}
