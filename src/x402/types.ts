export type PaymentRequirements = {
  scheme: string;
  network: string;
  maxAmountRequired: string; // uint256 string in atomic units
  resource: string;
  description: string;
  mimeType: string;
  outputSchema?: object | null;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string; // EIP-3009 token
  extra?: { name?: string; version?: string } | null;
};

export type PaymentRequired = {
  x402Version: number;
  error?: string;
  accepts: PaymentRequirements[];
};

export type XPaymentAuthorization = {
  from: string;
  to: string;
  value: string; // uint256
  validAfter: string; // unix seconds string
  validBefore: string; // unix seconds string
  nonce: `0x${string}`; // bytes32
};

export type XPaymentPayload = {
  signature: `0x${string}`;
  authorization: XPaymentAuthorization;
};

export type XPayment = {
  x402Version: number;
  scheme: 'exact';
  network: string;
  payload: XPaymentPayload;
};

// --- DACS-Standard (§9.5.7 X402-1..X402-4 & §14.4 DACS-4 Settle) Pre-Flight Guardrail ---
export interface DacsMandateMeta {
  dacsMandate?: string
  dacsSessionId?: string
  dacsMaxAmount?: string | bigint
}

export function assertDacsPaymentCeiling(
  requestedAmount: bigint | string,
  meta?: DacsMandateMeta
): void {
  if (!meta?.dacsMandate && !meta?.dacsSessionId) return // Unmanaged standard calls pass through
  
  const reqAmt = BigInt(requestedAmount)
  const maxAllowed = BigInt(meta.dacsMaxAmount ?? '0')

  if (meta.dacsMaxAmount !== undefined && reqAmt > maxAllowed) {
    throw new Error(
      `[DACS-Standard §9.5.7] Payment settlement aborted: requested amount (${reqAmt}) exceeds authorized mandate ceiling (${maxAllowed}).`
    )
  }
}
