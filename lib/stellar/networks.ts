export type StellarNetwork = 'testnet' | 'mainnet'

export interface NetworkConfig {
  name: StellarNetwork
  horizonUrl: string
  rpcUrl: string
  passphrase: string
  explorerUrl: string
}

export const NETWORKS: Record<StellarNetwork, NetworkConfig> = {
  testnet: {
    name: 'testnet',
    horizonUrl: 'https://horizon-testnet.stellar.org',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    passphrase: 'Test SDF Network ; September 2015',
    explorerUrl: 'https://stellar.expert/explorer/testnet',
  },
  mainnet: {
    name: 'mainnet',
    horizonUrl: 'https://horizon.stellar.org',
    rpcUrl: 'https://soroban-rpc.stellar.org',
    passphrase: 'Public Global Stellar Network ; September 2015',
    explorerUrl: 'https://stellar.expert/explorer/public',
  },
}

export function getNetwork(network: StellarNetwork): NetworkConfig {
  return NETWORKS[network]
}

export function getDefaultNetwork(): StellarNetwork {
  return 'testnet'
}
