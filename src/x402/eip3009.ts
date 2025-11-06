import { Hex, bytesToHex, hexToBytes } from 'viem';

export const EIP3009_DOMAIN_TYPES = {
  EIP712Domain: [
    { name: 'name', type: 'string' },
    { name: 'version', type: 'string' },
    { name: 'chainId', type: 'uint256' },
    { name: 'verifyingContract', type: 'address' },
  ],
} as const;

export const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export type TransferWithAuthorization = {
  from: `0x${string}`;
  to: `0x${string}`;
  value: string; // uint256
  validAfter: string; // uint256 string (unix secs)
  validBefore: string; // uint256 string (unix secs)
  nonce: `0x${string}`; // 32 bytes hex
};

export function randomNonce32(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return bytesToHex(bytes);
}

