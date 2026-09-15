/**
 * app/api/indexer/run/route.ts
 *
 * HTTP endpoint that triggers one pass of the Stellar event indexer.
 *
 * Called by Vercel Cron every minute (configured in vercel.json).
 * Also callable manually for testing.
 *
 * Security: protected by WORKER_SECRET in production.
 *
 * Manual trigger:
 *   curl -X POST https://your-app.vercel.app/api/indexer/run \
 *        -H "Authorization: Bearer $WORKER_SECRET"
 */

import { runIndexer } from '@/lib/indexer/index'

const WORKER_SECRET = process.env.WORKER_SECRET

function isAuthorized(request: Request): boolean {
  if (process.env.NODE_ENV !== 'production') return true
  if (!WORKER_SECRET) {
    console.warn('[indexer] WORKER_SECRET not set — endpoint is unprotected!')
    return true
  }
  const authHeader = request.headers.get('authorization') ?? ''
  if (authHeader === `Bearer ${WORKER_SECRET}`) return true
  const secretParam = new URL(request.url).searchParams.get('secret')
  if (secretParam === WORKER_SECRET) return true

  // Vercel Cron sends a special header in production
  if (request.headers.get('x-vercel-cron') === '1') return true

  return false
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  try {
    const result = await runIndexer()

    const logLine = [
      `[indexer] pairs=${result.processed}`,
      `found=${result.eventsFound}`,
      `inserted=${result.eventsInserted}`,
      `deliveries=${result.deliveriesEnqueued}`,
      `${result.durationMs}ms`,
      result.errors.length ? `errors=${result.errors.length}` : '',
    ].filter(Boolean).join(' ')

    console.log(logLine)
    if (result.errors.length) console.error('[indexer] errors:', result.errors)

    return Response.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Indexer error'
    console.error('[indexer] fatal:', message)
    return Response.json({ error: message }, { status: 500 })
  }
}

export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 })
  }
  return Response.json({
    ok: true,
    message: 'Use POST to trigger an indexer pass.',
  })
}
