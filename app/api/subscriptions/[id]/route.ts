import { requireAuth } from '@/lib/auth'
import {
  deleteSubscription,
  getSubscription,
  jsonError,
  toggleSubscription,
} from '@/lib/db/repository'
import { SubscriptionToggleSchema } from '@/lib/schemas'

// ── PATCH /api/subscriptions/:id ─────────────────────────────────────────────
// Toggles active state.  Requires JWT; owner must match the subscription.

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request)
  if (auth instanceof Response) return auth

  const id = Number((await context.params).id)
  if (!Number.isInteger(id) || id <= 0) return jsonError('Invalid subscription id.')

  // Ownership check
  const existing = await getSubscription(id)
  if (!existing) return jsonError('Subscription not found.', 404)
  if (existing.ownerId !== auth.ownerId) {
    return jsonError('You do not have permission to modify this subscription.', 403)
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError('Invalid JSON body.')
  }

  const parsed = SubscriptionToggleSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? 'Invalid request body.')
  }

  return Response.json({ data: await toggleSubscription(id, parsed.data.active) })
}

// ── DELETE /api/subscriptions/:id ────────────────────────────────────────────
// Permanently removes a subscription.  Requires JWT; owner must match.

export async function DELETE(
  _: Request,
  context: { params: Promise<{ id: string }> },
) {
  // Note: auth is read from the original request via the first arg.
  // Re-reading headers from `_` works fine; it's the same Request object.
  const auth = await requireAuth(_)
  if (auth instanceof Response) return auth

  const id = Number((await context.params).id)
  if (!Number.isInteger(id) || id <= 0) return jsonError('Invalid subscription id.')

  const existing = await getSubscription(id)
  if (!existing) return jsonError('Subscription not found.', 404)
  if (existing.ownerId !== auth.ownerId) {
    return jsonError('You do not have permission to delete this subscription.', 403)
  }

  return Response.json({ data: await deleteSubscription(id) })
}
