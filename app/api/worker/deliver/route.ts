/**
 * app/api/worker/deliver/route.ts
 *
 * HTTP endpoint that triggers one pass of the webhook delivery worker.
 *
 * Designed to be called by a cron job (Vercel Cron, GitHub Actions, etc.)
 * every 30–60 seconds.
 *
 * Security: requests must include the WORKER_SECRET in the Authorization
 * header as `Bearer <secret>`, or as the `secret` query parameter.
 * Set WORKER_SECRET to a long random string in your environment.
 *
 * Example cron invocation:
 *   curl -X POST https://your-app.vercel.app/api/worker/deliver \
 *        -H "Authorization: Bearer $WORKER_SECRET"
 *
 * Vercel cron (vercel.json):
 *   { "crons": [{ "path": "/api/worker/deliver", "schedule": "* * * * *" }] }
 */

import { runDeliveryWorker } from '@/lib/worker/deliver'

const WORKER_SECRET = process.env.WORKER_SECRET

function isAuthorized(request: Request): boolean {
  // In development, allow without auth so you can test locally
  if (process.env.NODE_ENV !== 'production') return true
  if (!WORKER_SECRET) {
    console.warn('[worker] WORKER_SECRET is not set — worker endpoint is unprotected!')
    return true
  }

  const authHeader = request.headers.get('authorization') ?? ''
  if (authHeader === `Bearer ${WORKER_SECRET}`) return true

  const secretParam = new URL(request.url).searchParams.get('secret')
  if (secretParam === WORKER_SECRET) return true

  // Vercel Cron sends this header automatically in production
  if (request.headers.get('x-vercel-cron') === '1') return true

  return false
}

export async function POST(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 })
  }

  try {
    const result = await runDeliveryWorker()
    console.log(
      `[worker/deliver] processed=${result.processed} succeeded=${result.succeeded} failed=${result.failed} duration=${result.durationMs}ms`,
    )
    return Response.json({ ok: true, ...result })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Worker error'
    console.error('[worker/deliver] fatal error:', message)
    return Response.json({ error: message }, { status: 500 })
  }
}

// Allow GET for health checks / manual testing in dev
export async function GET(request: Request) {
  if (!isAuthorized(request)) {
    return Response.json({ error: 'Unauthorized.' }, { status: 401 })
  }
  return Response.json({
    ok: true,
    message: 'Use POST to trigger a delivery worker pass.',
  })
}
