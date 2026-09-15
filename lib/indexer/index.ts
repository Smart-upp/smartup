/**
 * lib/indexer/index.ts
 *
 * Stellar event indexer.
 *
 * For every active subscription in the DB, polls the Soroban RPC
 * `getEvents` JSON-RPC method for new contract events since the last
 * processed ledger, writes them to the `events` table, enqueues webhook
 * deliveries, and advances the per-contract cursor in `indexerState`.
 *
 * Design notes:
 *  - One RPC request per unique (network, contractAddress) pair — all
 *    subscriptions watching the same contract are batched.
 *  - The `indexerState` cursor means each cron run only fetches new events.
 *  - Safe under concurrent execution: `insertEvent` uses ON CONFLICT DO
 *    NOTHING, so duplicate runs at most re-process one ledger boundary.
 */

import { Server } from '@stellar/stellar-sdk/rpc'
import { db } from '@/lib/db/index'
import { subscriptions } from '@/lib/db/schema'
import {
  getIndexerState,
  setIndexerState,
  insertEvent,
  pruneExpiredChallenges,
} from '@/lib/db/repository'
import { enqueueMatchingDeliveries } from '@/lib/worker/deliver'
import { NETWORKS, type StellarNetwork } from '@/lib/stellar/networks'
import { eq } from 'drizzle-orm'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface IndexerResult {
  processed: number        // unique (network, contract) pairs scanned
  eventsFound: number
  eventsInserted: number
  deliveriesEnqueued: number
  durationMs: number
  errors: string[]
}

/**
 * Soroban RPC `getEvents` response shape (fields we use).
 * Reference: https://developers.stellar.org/docs/data/apis/rpc/api-reference/methods/getEvents
 *
 * Note: the RPC spec uses `topic` (array of base64 ScVals) and `value`
 * (base64 ScVal string) at the top level of each event object.
 * `txHash` is the transaction hash string.
 */
interface RpcEvent {
  id: string
  type: string
  ledger: number
  contractId: string
  txHash: string
  /** Array of base64-encoded XDR ScVal strings */
  topic: string[]
  /** Base64-encoded XDR ScVal string */
  value: string
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function runIndexer(): Promise<IndexerResult> {
  const start = Date.now()
  const result: IndexerResult = {
    processed: 0,
    eventsFound: 0,
    eventsInserted: 0,
    deliveriesEnqueued: 0,
    durationMs: 0,
    errors: [],
  }

  if (!process.env.DATABASE_URL) {
    result.errors.push('DATABASE_URL not set — indexer requires a real database.')
    result.durationMs = Date.now() - start
    return result
  }

  // Housekeeping: prune stale auth challenges
  await pruneExpiredChallenges().catch(() => { /* non-fatal */ })

  // Collect unique (network, contractAddress) pairs from active subscriptions
  const activeSubs = await db
    .select({
      network: subscriptions.network,
      contractAddress: subscriptions.contractAddress,
    })
    .from(subscriptions)
    .where(eq(subscriptions.active, true))

  if (activeSubs.length === 0) {
    result.durationMs = Date.now() - start
    return result
  }

  const pairs = deduplicatePairs(
    activeSubs as { network: string; contractAddress: string }[],
  )

  await Promise.all(
    pairs.map((pair) =>
      indexContract(pair.network as StellarNetwork, pair.contractAddress, result)
        .catch((err) => {
          result.errors.push(
            `[${pair.network}/${pair.contractAddress}] ${err instanceof Error ? err.message : String(err)}`,
          )
        }),
    ),
  )

  result.processed = pairs.length
  result.durationMs = Date.now() - start
  return result
}

// ── Per-contract indexing ─────────────────────────────────────────────────────

async function indexContract(
  network: StellarNetwork,
  contractAddress: string,
  result: IndexerResult,
): Promise<void> {
  const networkConfig = NETWORKS[network]
  const server = new Server(networkConfig.rpcUrl, { allowHttp: false })

  // getLatestLedger() returns { id, protocolVersion, sequence }
  // sequence is the latest closed ledger number
  const latestLedgerInfo = await server.getLatestLedger()
  const latestLedger = latestLedgerInfo.sequence

  const lastLedger = await getIndexerState(network, contractAddress)

  // Fresh start: index the last ~1 hour of history (≈720 ledgers at 5s each)
  const startLedger =
    lastLedger > 0 ? lastLedger + 1 : Math.max(1, latestLedger - 720)

  if (startLedger > latestLedger) return // cursor is already current

  const rpcEvents = await fetchEvents(
    networkConfig.rpcUrl,
    contractAddress,
    startLedger,
    latestLedger,
  )

  result.eventsFound += rpcEvents.length

  for (const evt of rpcEvents) {
    const eventType = decodeFirstTopic(evt.topic) ?? evt.type ?? 'unknown'

    const inserted = await insertEvent({
      eventId: evt.id,
      network,
      contractAddress,
      eventType,
      ledgerNumber: evt.ledger,
      transactionHash: evt.txHash ?? null,
      topics: evt.topic,   // stored as jsonb array of base64 strings
      data: evt.value,     // stored as jsonb base64 ScVal string
    })

    if (inserted) {
      result.eventsInserted++
      const enqueued = await enqueueMatchingDeliveries(evt.id).catch(() => 0)
      result.deliveriesEnqueued += enqueued
    }
  }

  // Advance the cursor regardless of how many events were found
  await setIndexerState(network, contractAddress, latestLedger)
}

// ── Soroban RPC getEvents (raw JSON-RPC) ──────────────────────────────────────

async function fetchEvents(
  rpcUrl: string,
  contractAddress: string,
  startLedger: number,
  endLedger: number,
): Promise<RpcEvent[]> {
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'getEvents',
    params: {
      startLedger,
      endLedger,
      filters: [{ type: 'contract', contractIds: [contractAddress] }],
      pagination: { limit: 10000 },
    },
  }

  const response = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })

  if (!response.ok) {
    throw new Error(`RPC HTTP ${response.status}: ${response.statusText}`)
  }

  const json = (await response.json()) as {
    result?: { events: RpcEvent[] }
    error?: { message: string; code?: number }
  }

  if (json.error) throw new Error(`RPC error (${json.error.code}): ${json.error.message}`)

  return json.result?.events ?? []
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function deduplicatePairs(
  rows: { network: string; contractAddress: string }[],
): { network: string; contractAddress: string }[] {
  const seen = new Set<string>()
  return rows.filter(({ network, contractAddress }) => {
    const key = `${network}:${contractAddress}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Try to decode the first topic ScVal as a Symbol or String for use as
 * the human-readable eventType.
 *
 * XDR layout for ScSymbol (type 14) and ScString (type 13):
 *   bytes 0–3  : u32 type discriminant (big-endian)
 *   bytes 4–7  : u32 byte length of the string (big-endian)
 *   bytes 8…   : UTF-8 payload, padded to a 4-byte boundary
 *
 * Returns null on any decode error so callers can fall back.
 */
function decodeFirstTopic(topics: string[]): string | null {
  if (!topics.length) return null
  try {
    const buf = Buffer.from(topics[0], 'base64')
    if (buf.length < 8) return null
    const typeCode = buf.readUInt32BE(0)
    // 13 = ScString, 14 = ScSymbol
    if (typeCode === 13 || typeCode === 14) {
      const len = buf.readUInt32BE(4)
      if (buf.length < 8 + len) return null
      return buf.subarray(8, 8 + len).toString('utf8')
    }
  } catch {
    // fall through
  }
  return null
}
