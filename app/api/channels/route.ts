/**
 * app/api/channels/route.ts
 *
 * GET  /api/channels        — list delivery channels for the authenticated user
 * POST /api/channels        — create a new delivery channel
 */

import { requireAuth } from '@/lib/auth'
import { createChannel, jsonError, listChannels } from '@/lib/db/repository'
import { DeliveryChannelCreateSchema } from '@/lib/schemas'

// ── GET ───────────────────────────────────────────────────────────────────────

export async function GET(request: Request) {
  const auth = await requireAuth(request)
  if (auth instanceof Response) return auth

  const channels = await listChannels(auth.ownerId)
  return Response.json({ data: channels })
}

// ── POST ──────────────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  const auth = await requireAuth(request)
  if (auth instanceof Response) return auth

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError('Invalid JSON body.')
  }

  const parsed = DeliveryChannelCreateSchema.safeParse(body)
  if (!parsed.success) {
    return jsonError(parsed.error.issues[0]?.message ?? 'Invalid request body.')
  }

  try {
    const channel = await createChannel({
      channelId: parsed.data.channelId,
      ownerId: auth.ownerId,
      type: parsed.data.type,
      endpoint: parsed.data.endpoint,
    })
    return Response.json({ data: channel }, { status: 201 })
  } catch (err) {
    // Unique constraint on channelId
    const message = err instanceof Error ? err.message : 'Failed to create channel.'
    if (message.includes('unique') || message.includes('duplicate')) {
      return jsonError(`A channel with id '${parsed.data.channelId}' already exists.`, 409)
    }
    return jsonError(message, 500)
  }
}
