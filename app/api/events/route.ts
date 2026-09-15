import { optionalAuth } from '@/lib/auth'
import { listEvents } from '@/lib/db/repository'
import { EventQuerySchema } from '@/lib/schemas'

// ── GET /api/events ──────────────────────────────────────────────────────────
// Public read.  When authenticated, also accepts ?contractAddress= and
// ?limit= for finer-grained filtering.

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)

  const parsed = EventQuerySchema.safeParse(Object.fromEntries(searchParams))
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid query params.' },
      { status: 400 },
    )
  }

  const auth = await optionalAuth(request)
  const ownerId = auth?.ownerId

  return Response.json({
    data: await listEvents(parsed.data.network, parsed.data.contractAddress, parsed.data.limit, ownerId),
  })
}
