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
 *   DATABASE_URL     — Postgres connection string (required)
 *   WEBHOOK_SECRET   — Used to sign outgoing webhook requests
 *   WORKER_INTERVAL_MS — Polling interval in ms (default: 30000)
 */

import { runDeliveryWorker } from '../lib/worker/deliver'

const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 30_000)

async function loop() {
  console.log(`[worker] Starting delivery worker (interval: ${INTERVAL_MS}ms)`)

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const result = await runDeliveryWorker()
      if (result.processed > 0) {
        console.log(
          `[worker] processed=${result.processed} succeeded=${result.succeeded} failed=${result.failed} ${result.durationMs}ms`,
        )
      }
    } catch (err) {
      console.error('[worker] Unhandled error:', err)
    }
    await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS))
  }
}

loop().catch((err) => {
  console.error('[worker] Fatal:', err)
  process.exit(1)
})
