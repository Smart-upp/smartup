/**
 * lib/worker/deliver.ts
 *
 * Webhook delivery worker with exponential-backoff retries and HMAC-SHA256
 * request signing.
 *
 * Delivery flow:
 *   1. Fetch a batch of pending/retrying deliveries from the DB.
 *   2. For each delivery, load the channel endpoint and subscription payload.
 *   3. POST the event payload to the endpoint with an X-SmartUp-Signature header.
 *   4. On success → mark delivered.
 *   5. On failure → increment attempt counter, compute nextRetryAt using
 *      exponential backoff (capped at MAX_ATTEMPTS), or mark permanently failed.
 *
 * HMAC signing:
 *   The request body is signed with WEBHOOK_SECRET (env var).  Receivers can
 *   verify the signature with:
 *     HMAC-SHA256(secret, rawBody) === X-SmartUp-Signature
 */

import { createHmac } from 'crypto'
import {
  createDelivery,
  getPendingDeliveries,
  incrementChannelFailure,
  resetChannelFailure,
  updateDelivery,
  type DeliveryStatus,
} from '@/lib/db/repository'
import { db } from '@/lib/db/index'
import { deliveryChannels, events, subscriptions } from '@/lib/db/schema'
import { eq } from 'drizzle-orm'

// ── Config ────────────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 5
const BATCH_SIZE = 25
const REQUEST_TIMEOUT_MS = 10_000

/**
 * Exponential backoff delays (seconds) per attempt index (0-based):
 * attempt 1 → 30s, attempt 2 → 5min, attempt 3 → 30min, attempt 4 → 2h
 */
const BACKOFF_SECONDS = [30, 300, 1800, 7200]

function nextRetryAt(attempt: number): Date | null {
  const delaySeconds = BACKOFF_SECONDS[attempt - 1]
  if (delaySeconds === undefined) return null // no more retries
  return new Date(Date.now() + delaySeconds * 1000)
}

// ── HMAC signing ──────────────────────────────────────────────────────────────

function signPayload(body: string): string {
  const secret = process.env.WEBHOOK_SECRET ?? 'dev-webhook-secret'
  return createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

// ── Delivery payload ──────────────────────────────────────────────────────────

interface DeliveryPayload {
  deliveryId: string
  subscriptionId: string
  event: {
    eventId: string
    eventType: string
    contractAddress: string
    network: string
    ledgerNumber: number
    transactionHash: string | null
    topics: unknown
    data: unknown
    createdAt: Date
  }
  timestamp: string
}

// ── Core delivery function ────────────────────────────────────────────────────

/**
 * Attempt to deliver a single webhook.
 * Returns true on success, false on failure.
 */
async function attemptDelivery(
  delivery: Awaited<ReturnType<typeof getPendingDeliveries>>[number],
): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false

  // Load the channel endpoint
  const [channel] = await db
    .select()
    .from(deliveryChannels)
    .where(eq(deliveryChannels.channelId, delivery.channelId))
    .limit(1)

  if (!channel || !channel.active) {
    await updateDelivery(delivery.deliveryId, {
      status: 'failed',
      errorMessage: channel ? 'Channel is inactive.' : 'Channel not found.',
    })
    return false
  }

  // Load the event
  const [event] = await db
    .select()
    .from(events)
    .where(eq(events.eventId, delivery.eventId))
    .limit(1)

  if (!event) {
    await updateDelivery(delivery.deliveryId, {
      status: 'failed',
      errorMessage: 'Event record not found.',
    })
    return false
  }

  // Build payload
  const payload: DeliveryPayload = {
    deliveryId: delivery.deliveryId,
    subscriptionId: delivery.subscriptionId,
    event: {
      eventId: event.eventId,
      eventType: event.eventType,
      contractAddress: event.contractAddress,
      network: event.network,
      ledgerNumber: event.ledgerNumber,
      transactionHash: event.transactionHash ?? null,
      topics: event.topics,
      data: event.data,
      createdAt: event.createdAt!,
    },
    timestamp: new Date().toISOString(),
  }

  const body = JSON.stringify(payload)
  const signature = signPayload(body)

  // POST to endpoint with timeout
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(channel.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-SmartUp-Signature': `sha256=${signature}`,
        'X-SmartUp-Delivery': delivery.deliveryId,
        'X-SmartUp-Event': event.eventType,
        'User-Agent': 'SmartUp-Webhook/1.0',
      },
      body,
      signal: controller.signal,
    })
    clearTimeout(timer)

    if (response.ok) {
      await updateDelivery(delivery.deliveryId, {
        status: 'delivered',
        httpStatus: response.status,
        deliveredAt: new Date(),
        nextRetryAt: null,
      })
      await resetChannelFailure(channel.channelId)
      return true
    }

    // HTTP error (4xx/5xx)
    const attempt = (delivery.attempt ?? 1) + 1
    const retryAt = attempt <= MAX_ATTEMPTS ? nextRetryAt(attempt - 1) : null
    const status: DeliveryStatus =
      attempt > MAX_ATTEMPTS ? 'failed' : 'retrying'

    await updateDelivery(delivery.deliveryId, {
      status,
      attempt,
      httpStatus: response.status,
      errorMessage: `HTTP ${response.status}`,
      nextRetryAt: retryAt,
    })
    await incrementChannelFailure(channel.channelId)
    return false
  } catch (err) {
    clearTimeout(timer)

    const attempt = (delivery.attempt ?? 1) + 1
    const retryAt = attempt <= MAX_ATTEMPTS ? nextRetryAt(attempt - 1) : null
    const status: DeliveryStatus =
      attempt > MAX_ATTEMPTS ? 'failed' : 'retrying'
    const errorMessage =
      err instanceof Error
        ? err.name === 'AbortError'
          ? `Request timed out after ${REQUEST_TIMEOUT_MS}ms`
          : err.message
        : 'Unknown error'

    await updateDelivery(delivery.deliveryId, {
      status,
      attempt,
      errorMessage,
      nextRetryAt: retryAt,
    })
    await incrementChannelFailure(channel.channelId)
    return false
  }
}

// ── Batch processor ───────────────────────────────────────────────────────────

export interface WorkerResult {
  processed: number
  succeeded: number
  failed: number
  durationMs: number
}

/**
 * Run one pass of the delivery worker.
 * Processes up to BATCH_SIZE pending/retrying deliveries concurrently.
 */
export async function runDeliveryWorker(): Promise<WorkerResult> {
  const start = Date.now()
  const pending = await getPendingDeliveries(BATCH_SIZE)

  if (pending.length === 0) {
    return { processed: 0, succeeded: 0, failed: 0, durationMs: Date.now() - start }
  }

  // Process all in parallel (bounded by BATCH_SIZE)
  const results = await Promise.allSettled(pending.map(attemptDelivery))

  let succeeded = 0
  let failed = 0
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) succeeded++
    else failed++
  }

  return {
    processed: pending.length,
    succeeded,
    failed,
    durationMs: Date.now() - start,
  }
}

// ── Queue helpers (used by the event indexer) ─────────────────────────────────

/**
 * Enqueue a delivery job for every active subscription whose event filter
 * matches the given event.  Call this when a new event is indexed.
 */
export async function enqueueMatchingDeliveries(eventId: string): Promise<number> {
  if (!process.env.DATABASE_URL) return 0

  // Load the event
  const [event] = await db
    .select()
    .from(events)
    .where(eq(events.eventId, eventId))
    .limit(1)
  if (!event) return 0

  // Find subscriptions that match this contract + network + event type
  const matchingSubs = await db
    .select()
    .from(subscriptions)
    .where(
      eq(subscriptions.contractAddress, event.contractAddress),
    )

  let enqueued = 0
  for (const sub of matchingSubs) {
    if (!sub.active) continue
    if (!sub.deliveryChannel || !sub.deliveryEndpoint) continue

    // Check event type filter
    const filter = sub.eventFilter as { eventTypes?: string[] } | null
    const allowed = filter?.eventTypes
    if (allowed && !allowed.includes(event.eventType)) continue

    // Find the channel that matches this subscription's endpoint exactly.
    // A subscription stores its target endpoint in deliveryEndpoint; look up
    // the deliveryChannels row by owner AND matching endpoint so we pick the
    // right channel when an owner has more than one.
    const [channel] = await db
      .select()
      .from(deliveryChannels)
      .where(
        eq(deliveryChannels.ownerId, sub.ownerId),
      )
      .then((rows) =>
        rows.filter(
          (r) =>
            r.endpoint === sub.deliveryEndpoint &&
            r.type === sub.deliveryChannel &&
            r.active,
        ),
      )
    if (!channel) continue

    // Use a deterministic deliveryId based on subscriptionId + eventId so that
    // ON CONFLICT DO NOTHING in createDelivery deduplicates if the indexer
    // re-processes the same ledger window.
    const deliveryId = `dlv_${sub.subscriptionId}_${eventId}`
    await createDelivery({
      deliveryId,
      subscriptionId: sub.subscriptionId,
      eventId: event.eventId,
      channelId: channel.channelId,
    })
    enqueued++
  }

  return enqueued
}
