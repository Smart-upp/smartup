/**
 * app/api/health/route.ts
 *
 * GET /api/health
 *
 * Returns system health including:
 *  - database connectivity (live ping)
 *  - active subscription count
 *  - total events indexed
 *  - delivery queue depth (pending + failed)
 *  - last indexer run info
 */

import { db } from '@/lib/db/index'
import { getHealthStats } from '@/lib/db/repository'
import { sql } from 'drizzle-orm'

export async function GET() {
  const hasDb = Boolean(process.env.DATABASE_URL)

  // Probe the DB with a cheap query
  let dbOk = false
  let dbError: string | null = null
  if (hasDb) {
    try {
      await db.execute(sql`SELECT 1`)
      dbOk = true
    } catch (err) {
      dbError = err instanceof Error ? err.message : 'Database unreachable'
    }
  }

  // Live stats — only when DB is reachable
  const stats = dbOk ? await getHealthStats().catch(() => null) : null

  const status = !hasDb ? 'degraded' : dbOk ? 'ok' : 'error'

  return Response.json(
    {
      status,
      timestamp: new Date().toISOString(),
      database: {
        configured: hasDb,
        connected: dbOk,
        error: dbError ?? undefined,
      },
      networks: ['testnet', 'mainnet'],
      stats: stats ?? undefined,
    },
    { status: status === 'error' ? 503 : 200 },
  )
}
