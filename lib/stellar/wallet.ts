'use client'

/**
 * lib/stellar/wallet.ts
 *
 * Freighter wallet integration — compatible with @stellar/freighter-api v3–v6.
 *
 * API history that matters:
 *   v3–v5  exported requestAccess(), getPublicKey(), isConnected(), signTransaction()
 *   v6     replaced requestAccess() with getAddress() which both connects and returns
 *          the address in one call.  getPublicKey() still exists as an alias.
 *
 * We detect which API is available at runtime so the code works with either
 * version installed.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from 'react'
import type { StellarNetwork } from './networks'
import { NETWORKS } from './networks'

// ── Runtime import helpers ────────────────────────────────────────────────────
// Freighter injects into the page; we import the library lazily to avoid
// SSR errors (it accesses window at import time in some versions).

type FreighterModule = typeof import('@stellar/freighter-api')

let _mod: FreighterModule | null = null

async function freighter(): Promise<FreighterModule> {
  if (_mod) return _mod
  _mod = await import('@stellar/freighter-api')
  return _mod
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WalletState {
  isAvailable: boolean
  isConnected: boolean
  publicKey: string | null
  error: string | null
  loading: boolean
}

export interface WalletActions {
  connect: () => Promise<void>
  disconnect: () => void
  signXdr: (xdrEnvelope: string, network: StellarNetwork) => Promise<string>
}

export type WalletContextValue = WalletState & WalletActions

// ── Context ───────────────────────────────────────────────────────────────────

const WalletCtx = createContext<WalletContextValue | null>(null)

// ── Provider ──────────────────────────────────────────────────────────────────

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<WalletState>({
    isAvailable: false,
    isConnected: false,
    publicKey: null,
    error: null,
    loading: false,
  })

  // On mount: check whether Freighter is installed and restore a prior session.
  useEffect(() => {
    let cancelled = false

    ;(async () => {
      try {
        const f = await freighter()

        // isConnected() returns { isConnected: boolean } in all versions.
        const { isConnected } = await f.isConnected()
        if (cancelled) return

        if (!isConnected) {
          setState((s) => ({ ...s, isAvailable: true }))
          return
        }

        // Silently restore the public key — user already approved this site.
        const address = await getAddress(f)
        if (!cancelled && address) {
          setState((s) => ({
            ...s,
            isAvailable: true,
            isConnected: true,
            publicKey: address,
          }))
        } else if (!cancelled) {
          setState((s) => ({ ...s, isAvailable: true }))
        }
      } catch {
        // Extension not installed or blocked by CSP.
        if (!cancelled) setState((s) => ({ ...s, isAvailable: false }))
      }
    })()

    return () => { cancelled = true }
  }, [])

  const connect = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }))
    try {
      const f = await freighter()
      const address = await getAddress(f)
      if (!address) throw new Error('Freighter did not return a public key.')
      setState((s) => ({
        ...s,
        isAvailable: true,
        isConnected: true,
        publicKey: address,
        loading: false,
      }))
    } catch (err) {
      setState((s) => ({
        ...s,
        loading: false,
        error: err instanceof Error ? err.message : 'Wallet connection failed.',
      }))
    }
  }, [])

  const disconnect = useCallback(() => {
    setState((s) => ({ ...s, isConnected: false, publicKey: null, error: null }))
  }, [])

  const signXdr = useCallback(
    async (xdrEnvelope: string, network: StellarNetwork): Promise<string> => {
      setState((s) => ({ ...s, loading: true, error: null }))
      try {
        const f = await freighter()
        const passphrase = NETWORKS[network].passphrase

        // signTransaction signature is stable across v3–v6:
        //   signTransaction(xdr, { networkPassphrase }) → { signedTxXdr, error }
        const result = await f.signTransaction(xdrEnvelope, {
          networkPassphrase: passphrase,
        })

        if (result.error) throw new Error(result.error)
        if (!result.signedTxXdr) throw new Error('Freighter returned no signed XDR.')

        setState((s) => ({ ...s, loading: false }))
        return result.signedTxXdr
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Transaction signing failed.'
        setState((s) => ({ ...s, loading: false, error: message }))
        throw err
      }
    },
    [],
  )

  return (
    <WalletCtx.Provider value={{ ...state, connect, disconnect, signXdr }}>
      {children}
    </WalletCtx.Provider>
  )
}

// ── Hook ──────────────────────────────────────────────────────────────────────

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletCtx)
  if (!ctx) throw new Error('useWallet must be used inside <WalletProvider>')
  return ctx
}

// ── Internal: normalise address retrieval across API versions ─────────────────

/**
 * v6 exports getAddress() which triggers the connection popup and returns
 * { address, error }.  Earlier versions export requestAccess() → { address }
 * and getPublicKey() → { address }.
 *
 * Try each method in order, newest first.
 */
async function getAddress(f: FreighterModule): Promise<string | null> {
  // v6 getAddress — triggers connection popup if not yet approved
  if ('getAddress' in f && typeof (f as Record<string, unknown>).getAddress === 'function') {
    const fn = (f as Record<string, unknown>).getAddress as () => Promise<{ address?: string; error?: string }>
    const result = await fn()
    if (result.error) throw new Error(result.error)
    return result.address ?? null
  }

  // v3–v5 requestAccess — triggers popup
  if ('requestAccess' in f && typeof (f as Record<string, unknown>).requestAccess === 'function') {
    const fn = (f as Record<string, unknown>).requestAccess as () => Promise<{ address?: string; error?: string }>
    const result = await fn()
    if (result.error) throw new Error(result.error)
    return result.address ?? null
  }

  // Fallback: read already-approved key without a popup
  if ('getPublicKey' in f && typeof (f as Record<string, unknown>).getPublicKey === 'function') {
    const fn = (f as Record<string, unknown>).getPublicKey as () => Promise<{ address?: string; error?: string }>
    const result = await fn()
    if (result.error) throw new Error(result.error)
    return result.address ?? null
  }

  return null
}
