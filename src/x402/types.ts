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
