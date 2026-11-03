import { getMandateStatus, requestX402V2Payment, type X402V2PaymentRequest } from './client.js';

// CLI payment policy. Card purchases use CARD_USD and the linked-card APIs;
// x402 payments (including prepaid-card funding) use USDC on Base.
export function isUsdcPayment(accept: any): boolean {
  return accept?.scheme === 'exact'
    && ['base', 'eip155:8453'].includes(String(accept.network).toLowerCase())
    && String(accept.asset).toLowerCase() === '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
}

export async function getUsdcMandate(mandateId: string, jwt: string) {
  const result = await getMandateStatus(mandateId, jwt);
  if (result.status !== 'ok' || !result.mandate) {
    throw new Error(result.message || `Cannot read mandate ${mandateId}.`);
  }
  if (result.mandate.currency !== 'USDC') {
    throw new Error('CLI x402 payments require a USDC mandate. Credits and other currencies are not supported; use linked-card commands for Card payments.');
  }
  return result.mandate;
}

export async function requestCliX402V2Payment(params: X402V2PaymentRequest, jwt: string) {
  const payload = params.paymentRequestB64
    ? JSON.parse(Buffer.from(params.paymentRequestB64, 'base64').toString('utf8'))
    : params.paymentRequest;
  const accepts = Array.isArray(payload?.accepts) ? payload.accepts.filter(isUsdcPayment) : [];
  if (!accepts.length) throw new Error('Payment request does not offer USDC on Base. Credits payments are not supported.');
  await getUsdcMandate(params.mandateId, jwt);
  // Do not forward a Credits offer for server-side selection, including in base64 input.
  return requestX402V2Payment({ mandateId: params.mandateId, paymentRequest: { ...payload, accepts } }, jwt);
}
