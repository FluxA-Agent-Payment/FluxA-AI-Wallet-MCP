export type NetworkConfig = {
  id: string; // like 'base', 'base-sepolia'
  chainId: number;
  label: string;
  rpcUrlEnv?: string; // env var name to pick RPC when needed
};

export const NETWORKS: Record<string, NetworkConfig> = {
  base: { id: 'base', chainId: 8453, label: 'Base', rpcUrlEnv: 'RPC_BASE' },
  'base-sepolia': {
    id: 'base-sepolia',
    chainId: 84532,
    label: 'Base Sepolia',
    rpcUrlEnv: 'RPC_BASE_SEPOLIA',
  },
};

export function networkToChainId(network: string): number | null {
  const n = NETWORKS[network];
  return n?.chainId ?? null;
}

