/**
 * app/api/channels/[channelId]/route.ts
 *
 * DELETE /api/channels/:channelId — remove a delivery channel (owner only)
 */

import { requireAuth } from '@/lib/auth'
import { deleteChannel, jsonError, listChannels } from '@/lib/db/repository'

export async function DELETE(
  request: Request,
  context: { params: Promise<{ channelId: string }> },
) {
  const auth = await requireAuth(request)
  if (auth instanceof Response) return auth

  const { channelId } = await context.params

  // Verify the channel belongs to this user
  const channels = await listChannels(auth.ownerId)
  const existing = channels.find((c) => c.channelId === channelId)
  if (!existing) return jsonError('Channel not found.', 404)

  await deleteChannel(channelId, auth.ownerId)
  return Response.json({ data: { channelId } })
}
