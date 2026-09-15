import { requireAuth } from '@/lib/auth'
import {
  createSubscription,
  jsonError,
  listSubscriptions,
} from '@/lib/db/repository'
import { SubscriptionCreateSchema } from '@/lib/schemas'

// ── GET /api/subscriptions?network=testnet|mainnet ───────────────────────────
// Public — returns subscriptions scoped to the authenticated user when a token
// is present, or all subscriptions for unauthenticated/demo usage.

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const network = searchParams.get('network') ?? undefined

  // Optional auth: scope to owner when token is present
  const authHeader = request.headers.get('authorization')
  if (authHeader?.startsWith('Bearer ')) {
    const auth = await requireAuth(request)
    if (auth instanceof Response) return auth
    return Response.json({ data: await listSubscriptions(network, auth.ownerId) })
  }

  return Response.json({ data: await listSubscriptions(network) })
}

// ── POST /api/subscriptions ──────────────────────────────────────────────────
// Protected — requires a valid JWT.  The ownerId is taken from the token, not
// from the request body, preventing users from creating records for others.

export async function POST(request: Request) {
  const auth = await requireAuth(request)
  if (auth instanceof Response) return auth

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError('Invalid JSON body.')
  }

  const parsed = SubscriptionCreateSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? 'Invalid request body.')
  }

  // Always use the authenticated address as the owner — overrides anything in the body
  const data: Parameters<typeof createSubscription>[0] = {
    ...parsed.data,
    ownerId: auth.ownerId,
  }

  return Response.json({ data: await createSubscription(data) }, { status: 201 })
}
