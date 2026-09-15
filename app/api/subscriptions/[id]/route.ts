/**
 * app/api/subscriptions/[id]/route.ts
 *
 * PATCH  /api/subscriptions/:id — toggle active state OR update filter/endpoint
 * DELETE /api/subscriptions/:id — permanently remove a subscription
 *
 * Both operations require JWT auth and enforce ownership.
 *
 * PATCH body variants:
 *   { active: boolean }                        — toggle active state
 *   { eventFilter?, deliveryChannel?, deliveryEndpoint? }  — update details
 *   (both can be combined in a single request)
 */

import { requireAuth } from '@/lib/auth'
import {
  deleteSubscription,
  getSubscription,
  jsonError,
  toggleSubscription,
  updateSubscription,
} from '@/lib/db/repository'
import { SubscriptionToggleSchema, SubscriptionUpdateSchema } from '@/lib/schemas'
import { z } from 'zod'

// Combined patch schema — accepts toggle fields, update fields, or both
const PatchSchema = z
  .object({
    active: z.boolean().optional(),
    eventFilter: z
      .object({
        eventTypes: z.array(z.string().min(1).max(128)).optional(),
        topics: z.array(z.string()).optional(),
      })
      .optional(),
    deliveryChannel: z.enum(['webhook', 'email', 'slack', 'discord']).optional(),
    deliveryEndpoint: z.string().max(512).optional(),
  })
  .refine(
    (val) =>
      val.active !== undefined ||
      val.eventFilter !== undefined ||
      val.deliveryChannel !== undefined ||
      val.deliveryEndpoint !== undefined,
    { message: 'At least one field must be provided.' },
  )

// ── PATCH /api/subscriptions/:id ─────────────────────────────────────────────

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request)
  if (auth instanceof Response) return auth

  const id = Number((await context.params).id)
  if (!Number.isInteger(id) || id <= 0) return jsonError('Invalid subscription id.')

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

  const parsed = PatchSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? 'Invalid request body.')
  }

  const { active, eventFilter, deliveryChannel, deliveryEndpoint } = parsed.data

  try {
    // Apply toggle if active field is present
    if (active !== undefined) {
      await toggleSubscription(id, active)
    }

    // Apply field updates if any detail fields are present
    const hasUpdates = eventFilter !== undefined || deliveryChannel !== undefined || deliveryEndpoint !== undefined
    if (hasUpdates) {
      await updateSubscription(id, {
        ...(eventFilter !== undefined && { eventFilter }),
        ...(deliveryChannel !== undefined && { deliveryChannel }),
        ...(deliveryEndpoint !== undefined && { deliveryEndpoint }),
      })
    }

    // Fetch and return the final state
    const updated = await getSubscription(id)
    return Response.json({ data: updated })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Update failed.'
    if (message.includes('not found')) return jsonError(message, 404)
    return jsonError(message, 500)
  }
}

// ── DELETE /api/subscriptions/:id ────────────────────────────────────────────

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request)
  if (auth instanceof Response) return auth

  const id = Number((await context.params).id)
  if (!Number.isInteger(id) || id <= 0) return jsonError('Invalid subscription id.')

  const existing = await getSubscription(id)
  if (!existing) return jsonError('Subscription not found.', 404)
  if (existing.ownerId !== auth.ownerId) {
    return jsonError('You do not have permission to delete this subscription.', 403)
  }

  await deleteSubscription(id)
  return Response.json({ data: { id, deleted: true } })
}
