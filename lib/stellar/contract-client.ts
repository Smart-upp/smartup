/**
 * lib/stellar/contract-client.ts
 *
 * Soroban contract client for the SmartUp Subscription Registry.
 *
 * Uses the modern @stellar/stellar-sdk v13+ API:
 *   - Server from "@stellar/stellar-sdk/rpc"
 *   - rpc.assembleTransaction (not SorobanRpc.assembleTransaction)
 *   - Contract / TransactionBuilder / Networks from "@stellar/stellar-sdk"
 *
 * The signXdr callback is provided by the wallet layer (Freighter) so this
 * module stays framework-agnostic and can also be used in scripts.
 */

import {
  Contract,
  Networks,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  Address,
  rpc,
  xdr,
} from '@stellar/stellar-sdk'
import { Server } from '@stellar/stellar-sdk/rpc'
import type { StellarNetwork } from './networks'
import { NETWORKS } from './networks'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ContractClientOptions {
  network: StellarNetwork
  /** Deployed contract address (C...) */
  contractAddress: string
  /** Public key of the transaction source account (G...) */
  callerPublicKey: string
  /**
   * Provided by the wallet layer — receives a base64 XDR envelope string,
   * signs it, and returns the signed XDR string.
   */
  signXdr: (xdrEnvelope: string, network: StellarNetwork) => Promise<string>
}

export interface RegisterParams {
  id: string
  /** Soroban contract address to monitor (C...) */
  contract: string
  eventFilter: string
  destination: string
}

export interface UpdateParams {
  id: string
  eventFilter: string
  destination: string
}

// ── Client ────────────────────────────────────────────────────────────────────

export class SubscriptionRegistryClient {
  private readonly opts: ContractClientOptions
  private readonly server: Server
  private readonly passphrase: string
  private readonly contract: Contract

  constructor(opts: ContractClientOptions) {
    this.opts = opts
    this.server = new Server(NETWORKS[opts.network].rpcUrl, { allowHttp: false })
    this.passphrase = opts.network === 'mainnet' ? Networks.PUBLIC : Networks.TESTNET
    this.contract = new Contract(opts.contractAddress)
  }

  // ── Public contract methods ─────────────────────────────────────────────────

  /** Register a new subscription on-chain. Returns the confirmed tx hash. */
  async register(params: RegisterParams): Promise<string> {
    return this.invoke('register', [
      nativeToScVal(params.id, { type: 'string' }),
      new Address(this.opts.callerPublicKey).toScVal(),
      new Address(params.contract).toScVal(),
      nativeToScVal(this.opts.network, { type: 'string' }),
      nativeToScVal(params.eventFilter, { type: 'string' }),
      nativeToScVal(params.destination, { type: 'string' }),
    ])
  }

  /** Update event filter and delivery destination. Returns the tx hash. */
  async update(params: UpdateParams): Promise<string> {
    return this.invoke('update', [
      nativeToScVal(params.id, { type: 'string' }),
      nativeToScVal(params.eventFilter, { type: 'string' }),
      nativeToScVal(params.destination, { type: 'string' }),
    ])
  }

  /** Pause or resume a subscription. Returns the tx hash. */
  async setActive(id: string, active: boolean): Promise<string> {
    return this.invoke('set_active', [
      nativeToScVal(id, { type: 'string' }),
      nativeToScVal(active, { type: 'bool' }),
    ])
  }

  /** Permanently remove a subscription. Returns the tx hash. */
  async remove(id: string): Promise<string> {
    return this.invoke('remove', [nativeToScVal(id, { type: 'string' })])
  }

  // ── Core invocation pipeline ────────────────────────────────────────────────

  /**
   * Build → simulate → assemble → sign → submit → poll.
   * Returns the confirmed transaction hash.
   */
  private async invoke(method: string, args: xdr.ScVal[]): Promise<string> {
    // 1. Load source account (gets current sequence number from RPC)
    const account = await this.server.getAccount(this.opts.callerPublicKey)

    // 2. Build an unsigned transaction
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.passphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build()

    // 3. Simulate to get resource footprint and fees
    const simResult = await this.server.simulateTransaction(tx)
    if (rpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation failed: ${simResult.error}`)
    }

    // 4. Assemble — injects Soroban resource fees and auth entries
    const assembled = rpc.assembleTransaction(tx, simResult).build()

    // 5. Hand off to wallet for signing
    const signedXdr = await this.opts.signXdr(assembled.toXDR(), this.opts.network)

    // 6. Submit the signed transaction
    const submitResult = await this.server.sendTransaction(
      TransactionBuilder.fromXDR(signedXdr, this.passphrase),
    )

    if (submitResult.status === 'ERROR') {
      throw new Error(
        `Transaction submission failed: ${JSON.stringify(submitResult.errorResult)}`,
      )
    }

    // 7. Poll for ledger confirmation
    const { hash } = submitResult
    await this.awaitConfirmation(hash)
    return hash
  }

  private async awaitConfirmation(
    hash: string,
    maxAttempts = 20,
    intervalMs = 1500,
  ): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      await sleep(intervalMs)
      const result = await this.server.getTransaction(hash)
      if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return
      if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new Error(`Transaction failed on-chain. Hash: ${hash}`)
      }
      // NOT_FOUND = still pending, keep polling
    }
    throw new Error(`Transaction not confirmed after ${maxAttempts} attempts. Hash: ${hash}`)
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Convenience factory used by the dashboard.
 * Reads the contract address from env vars set after `pnpm deploy:contract`.
 */
export function createContractClient(
  network: StellarNetwork,
  callerPublicKey: string,
  signXdr: (xdrEnvelope: string, network: StellarNetwork) => Promise<string>,
): SubscriptionRegistryClient {
  const contractAddress =
    network === 'mainnet'
      ? process.env.NEXT_PUBLIC_CONTRACT_ADDRESS_MAINNET
      : process.env.NEXT_PUBLIC_CONTRACT_ADDRESS_TESTNET

  if (!contractAddress) {
    throw new Error(
      `NEXT_PUBLIC_CONTRACT_ADDRESS_${network.toUpperCase()} is not set. ` +
      `Run 'pnpm deploy:contract' first.`,
    )
  }

  return new SubscriptionRegistryClient({ network, contractAddress, callerPublicKey, signXdr })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
