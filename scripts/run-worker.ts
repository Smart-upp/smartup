/**
 * scripts/run-worker.ts
 *
 * CLI entry point for the webhook delivery worker.
 * Runs continuously with a configurable polling interval.
 *
 * Usage:
 *   pnpm worker:deliver
 *   WORKER_INTERVAL_MS=15000 pnpm worker:deliver
 *
 * Environment:
 *   DATABASE_URL        — Postgres connection string (required)
 *   WEBHOOK_SECRET      — Used to sign outgoing webhook requests
 *   WORKER_INTERVAL_MS  — Polling interval in ms (default: 30000)
 *
 * Graceful shutdown:
 *   Catches SIGTERM and SIGINT.  Waits for the current delivery batch to
 *   finish before exiting so no delivery rows are left in a half-processed
 *   state.
 */

import { pool } from '../lib/db/index'
import { runDeliveryWorker } from '../lib/worker/deliver'

const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 30_000)

// ── Shutdown state ────────────────────────────────────────────────────────────

let shuttingDown = false
let currentBatch: Promise<void> | null = null

async function shutdown(signal: string) {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`\n[worker] Received ${signal}. Waiting for current batch to finish…`)

  if (currentBatch) {
    await currentBatch.catch(() => {/* already logged inside the batch */})
  }

  // Close the DB pool cleanly so pg doesn't log spurious disconnect errors
  await pool.end().catch(() => {/* ignore */})
  console.log('[worker] Shutdown complete.')
  process.exit(0)
}

process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT',  () => shutdown('SIGINT'))

// ── Main loop ─────────────────────────────────────────────────────────────────

async function loop() {
  console.log(`[worker] Starting delivery worker (interval: ${INTERVAL_MS}ms)`)

  while (!shuttingDown) {
    // Wrap the batch in a named promise so shutdown() can await it
    let resolveBatch!: () => void
    currentBatch = new Promise<void>((resolve) => { resolveBatch = resolve })

    try {
      const result = await runDeliveryWorker()
      if (result.processed > 0) {
        console.log(
          `[worker] processed=${result.processed} succeeded=${result.succeeded} failed=${result.failed} ${result.durationMs}ms`,
        )
      }
    } catch (err) {
      console.error('[worker] Unhandled error:', err)
    } finally {
      resolveBatch()
      currentBatch = null
    }

    if (shuttingDown) break

    // Sleep until next poll, but wake immediately if shutdown is signalled
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, INTERVAL_MS)
      // Allow the timer to be garbage-collected without blocking Node exit
      if (typeof timer.unref === 'function') timer.unref()
    })
  }
}

loop().catch((err) => {
  console.error('[worker] Fatal:', err)
  process.exit(1)
})
