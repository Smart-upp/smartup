/**
 * app/api/channels/[channelId]/route.ts
 *
 * DELETE /api/channels/:channelId — remove a delivery channel (owner only)
 */

import { requireAuth } from '@/lib/auth'
import { deleteChannel, jsonError } from '@/lib/db/repository'
import { db } from '@/lib/db/index'
import { deliveryChannels } from '@/lib/db/schema'
import { and, eq } from 'drizzle-orm'

export async function DELETE(
  request: Request,
  context: { params: Promise<{ channelId: string }> },
) {
  const auth = await requireAuth(request)
  if (auth instanceof Response) return auth

  const { channelId } = await context.params

  // Single targeted query — avoids loading all owner channels into memory
  const [existing] = await db
    .select({ channelId: deliveryChannels.channelId })
    .from(deliveryChannels)
    .where(
      and(
        eq(deliveryChannels.channelId, channelId),
        eq(deliveryChannels.ownerId, auth.ownerId),
      ),
    )
    .limit(1)

  if (!existing) return jsonError('Channel not found.', 404)

  await deleteChannel(channelId, auth.ownerId)
  return Response.json({ data: { channelId } })
}
