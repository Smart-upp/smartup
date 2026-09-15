import { and, desc, eq, inArray, lt, sql } from 'drizzle-orm'
import { db } from './index'
import { subscriptions, events, deliveryChannels, webhookDeliveries, authChallenges, indexerState } from './schema'
import type { SubscriptionCreateInput } from '@/lib/schemas'

// ── Demo seeds ────────────────────────────────────────────────────────────────
// Used when DATABASE_URL is not configured (local development without a DB).

export const demoSubscriptions = [
  { id: 1, subscriptionId: 'sub_payments_01', ownerId: 'GDEMO7KQ2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', network: 'testnet', contractAddress: 'C...9X2M', eventFilter: { eventTypes: ['payment_received'] }, deliveryChannel: 'webhook', deliveryEndpoint: 'https://api.acme.dev/hooks/stellar', active: true, createdAt: new Date('2026-09-12T10:20:00Z') },
  { id: 2, subscriptionId: 'sub_membership_02', ownerId: 'GDEMO7KQ2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', network: 'testnet', contractAddress: 'C...4P8R', eventFilter: { eventTypes: ['membership_renewed', 'membership_cancelled'] }, deliveryChannel: 'slack', deliveryEndpoint: '#billing-alerts', active: true, createdAt: new Date('2026-09-10T08:42:00Z') },
  { id: 3, subscriptionId: 'sub_treasury_03', ownerId: 'GDEMO7KQ2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', network: 'mainnet', contractAddress: 'C...1N6V', eventFilter: { eventTypes: ['transfer'] }, deliveryChannel: 'email', deliveryEndpoint: 'ops@acme.dev', active: false, createdAt: new Date('2026-09-03T14:12:00Z') },
]

export const demoEvents = [
  { eventId: 'evt_1008', eventType: 'payment_received', contractAddress: 'C...9X2M', network: 'testnet', ledgerNumber: 51298402, transactionHash: 'a8f2...91c', createdAt: new Date(Date.now() - 1000 * 60 * 4) },
  { eventId: 'evt_1007', eventType: 'membership_renewed', contractAddress: 'C...4P8R', network: 'testnet', ledgerNumber: 51298377, transactionHash: '7bd1...e02', createdAt: new Date(Date.now() - 1000 * 60 * 16) },
  { eventId: 'evt_1006', eventType: 'transfer', contractAddress: 'C...1N6V', network: 'mainnet', ledgerNumber: 29412011, transactionHash: 'c31a...0af', createdAt: new Date(Date.now() - 1000 * 60 * 29) },
]

// ── Subscriptions ─────────────────────────────────────────────────────────────

export async function listSubscriptions(network?: string, ownerId?: string) {
  if (!process.env.DATABASE_URL) {
    return demoSubscriptions.filter(
      (s) =>
        (!network || s.network === network) &&
        (!ownerId || s.ownerId === ownerId),
    )
  }

  const conditions = [
    network ? eq(subscriptions.network, network) : undefined,
    ownerId ? eq(subscriptions.ownerId, ownerId) : undefined,
  ].filter(Boolean)

  return db
    .select()
    .from(subscriptions)
    .where(conditions.length ? and(...(conditions as Parameters<typeof and>)) : undefined)
    .orderBy(desc(subscriptions.createdAt))
}

export async function getSubscription(id: number) {
  if (!process.env.DATABASE_URL) {
    return demoSubscriptions.find((s) => s.id === id) ?? null
  }
  const [row] = await db
    .select()
    .from(subscriptions)
    .where(eq(subscriptions.id, id))
    .limit(1)
  return row ?? null
}

export async function createSubscription(input: SubscriptionCreateInput & { ownerId: string }) {
  if (!process.env.DATABASE_URL) {
    return { ...input, id: Date.now(), active: true, createdAt: new Date().toISOString() }
  }
  const [created] = await db
    .insert(subscriptions)
    .values({
      subscriptionId: input.subscriptionId,
      ownerId: input.ownerId,
      network: input.network,
      contractAddress: input.contractAddress,
      eventFilter: input.eventFilter ?? {},
      deliveryChannel: input.deliveryChannel,
      deliveryEndpoint: input.deliveryEndpoint,
      metadata: input.metadata,
    })
    .returning()
  return created
}

export async function deleteSubscription(id: number) {
  if (!process.env.DATABASE_URL) return { id }
  await db.delete(subscriptions).where(eq(subscriptions.id, id))
  return { id }
}

export async function toggleSubscription(id: number, active: boolean) {
  if (!process.env.DATABASE_URL) return { id, active }
  const [updated] = await db
    .update(subscriptions)
    .set({ active, updatedAt: new Date() })
    .where(eq(subscriptions.id, id))
    .returning()
  if (!updated) throw new Error(`Subscription ${id} not found`)
  return updated
}

export async function updateSubscription(
  id: number,
  patch: {
    eventFilter?: object
    deliveryChannel?: string
    deliveryEndpoint?: string
  },
) {
  if (!process.env.DATABASE_URL) return { id, ...patch }
  const [updated] = await db
    .update(subscriptions)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(subscriptions.id, id))
    .returning()
  if (!updated) throw new Error(`Subscription ${id} not found`)
  return updated
}

// ── Events ────────────────────────────────────────────────────────────────────

/**
 * List events, optionally filtered by network, contract address, and owner.
 * When ownerId is provided we join against subscriptions so only events for
 * contracts the owner is subscribed to are returned.
 */
export async function listEvents(
  network?: string,
  contractAddress?: string,
  limit = 50,
  ownerId?: string,
) {
  if (!process.env.DATABASE_URL) {
    return demoEvents.filter(
      (e) =>
        (!network || e.network === network) &&
        (!contractAddress || e.contractAddress === contractAddress),
    )
  }

  const safeLimit = Math.min(Math.max(1, limit), 200)

  // When owner-scoped, restrict to contracts they are subscribed to
  if (ownerId) {
    const ownerContracts = await db
      .selectDistinct({ contractAddress: subscriptions.contractAddress })
      .from(subscriptions)
      .where(eq(subscriptions.ownerId, ownerId))

    const contractAddresses = ownerContracts.map((r) => r.contractAddress)
    if (contractAddresses.length === 0) return []

    const conditions = [
      network ? eq(events.network, network) : undefined,
      contractAddress ? eq(events.contractAddress, contractAddress) : undefined,
      inArray(events.contractAddress, contractAddresses),
    ].filter(Boolean)

    return db
      .select()
      .from(events)
      .where(and(...(conditions as Parameters<typeof and>)))
      .orderBy(desc(events.createdAt))
      .limit(safeLimit)
  }

  const conditions = [
    network ? eq(events.network, network) : undefined,
    contractAddress ? eq(events.contractAddress, contractAddress) : undefined,
  ].filter(Boolean)

  return db
    .select()
    .from(events)
    .where(conditions.length ? and(...(conditions as Parameters<typeof and>)) : undefined)
    .orderBy(desc(events.createdAt))
    .limit(safeLimit)
}

// ── Delivery channels ─────────────────────────────────────────────────────────

export async function listChannels(ownerId?: string) {
  if (!process.env.DATABASE_URL) {
    return [
      { channelId: 'channel_webhook', ownerId: 'GDEMO7KQ2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', type: 'webhook', endpoint: 'https://api.acme.dev/hooks/stellar', active: true, failureCount: 0 },
    ]
  }
  const conditions = [ownerId ? eq(deliveryChannels.ownerId, ownerId) : undefined].filter(Boolean)
  return db
    .select()
    .from(deliveryChannels)
    .where(conditions.length ? (conditions[0] as ReturnType<typeof eq>) : undefined)
    .orderBy(desc(deliveryChannels.createdAt))
}

export async function createChannel(input: {
  channelId: string
  ownerId: string
  type: string
  endpoint: string
}) {
  if (!process.env.DATABASE_URL) {
    return { ...input, id: Date.now(), active: true, failureCount: 0, createdAt: new Date() }
  }
  const [created] = await db
    .insert(deliveryChannels)
    .values(input)
    .returning()
  return created
}

export async function deleteChannel(channelId: string, ownerId: string) {
  if (!process.env.DATABASE_URL) return { channelId }
  await db
    .delete(deliveryChannels)
    .where(and(eq(deliveryChannels.channelId, channelId), eq(deliveryChannels.ownerId, ownerId)))
  return { channelId }
}

// ── Webhook deliveries ────────────────────────────────────────────────────────

export type DeliveryStatus = 'pending' | 'delivered' | 'failed' | 'retrying'

export async function getPendingDeliveries(limit = 50) {
  if (!process.env.DATABASE_URL) return []
  return db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        sql`${webhookDeliveries.status} IN ('pending', 'retrying')`,
        sql`(${webhookDeliveries.nextRetryAt} IS NULL OR ${webhookDeliveries.nextRetryAt} <= NOW())`,
      ),
    )
    .orderBy(webhookDeliveries.createdAt)
    .limit(limit)
}

export async function createDelivery(input: {
  deliveryId: string
  subscriptionId: string
  eventId: string
  channelId: string
}) {
  if (!process.env.DATABASE_URL) {
    return { ...input, id: Date.now(), status: 'pending', attempt: 1, createdAt: new Date() }
  }
  const [row] = await db
    .insert(webhookDeliveries)
    .values({ ...input, status: 'pending', attempt: 1 })
    .returning()
  return row
}

export async function updateDelivery(
  deliveryId: string,
  patch: {
    status: DeliveryStatus
    attempt?: number
    httpStatus?: number
    errorMessage?: string
    nextRetryAt?: Date | null
    deliveredAt?: Date | null
  },
) {
  if (!process.env.DATABASE_URL) return { deliveryId, ...patch }
  const [row] = await db
    .update(webhookDeliveries)
    .set(patch)
    .where(eq(webhookDeliveries.deliveryId, deliveryId))
    .returning()
  return row
}

export async function incrementChannelFailure(channelId: string) {
  if (!process.env.DATABASE_URL) return
  await db
    .update(deliveryChannels)
    .set({
      failureCount: sql`${deliveryChannels.failureCount} + 1`,
      lastFailedAt: new Date(),
    })
    .where(eq(deliveryChannels.channelId, channelId))
}

export async function resetChannelFailure(channelId: string) {
  if (!process.env.DATABASE_URL) return
  await db
    .update(deliveryChannels)
    .set({ failureCount: 0 })
    .where(eq(deliveryChannels.channelId, channelId))
}

// ── Shared helpers ────────────────────────────────────────────────────────────

/** @deprecated Use validateSubscription from lib/schemas.ts instead */
export function validateSubscription(input: Record<string, unknown>) {
  const required = ['subscriptionId', 'ownerId', 'network', 'contractAddress']
  for (const key of required)
    if (typeof input[key] !== 'string' || !input[key]) return `${key} is required`
  if (input.network !== 'testnet' && input.network !== 'mainnet')
    return 'network must be testnet or mainnet'
  return null
}

export function jsonError(message: string, status = 400) {
  return Response.json({ error: message }, { status })
}

// ── Health stats ──────────────────────────────────────────────────────────────

export async function getHealthStats() {
  if (!process.env.DATABASE_URL) return null
  const [subCount] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(subscriptions)
    .where(eq(subscriptions.active, true))

  const [pendingCount] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(webhookDeliveries)
    .where(sql`${webhookDeliveries.status} IN ('pending', 'retrying')`)

  const [failedCount] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.status, 'failed'))

  const [deliveredCount] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(webhookDeliveries)
    .where(eq(webhookDeliveries.status, 'delivered'))

  const [eventCount] = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(events)

  const [latestIndexer] = await db
    .select({ lastLedger: indexerState.lastLedger, updatedAt: indexerState.updatedAt, network: indexerState.network })
    .from(indexerState)
    .orderBy(desc(indexerState.updatedAt))
    .limit(1)

  return {
    activeSubscriptions: subCount?.count ?? 0,
    totalEventsIndexed: eventCount?.count ?? 0,
    deliveries: {
      pending: pendingCount?.count ?? 0,
      failed: failedCount?.count ?? 0,
      delivered: deliveredCount?.count ?? 0,
    },
    indexer: latestIndexer
      ? { lastLedger: latestIndexer.lastLedger, lastRunAt: latestIndexer.updatedAt, network: latestIndexer.network }
      : null,
  }
}

// ── Auth challenges (DB-backed, replaces in-memory store) ─────────────────────

const CHALLENGE_TTL_MS = 5 * 60 * 1000 // 5 minutes

export async function saveChallenge(address: string, challenge: string): Promise<void> {
  if (!process.env.DATABASE_URL) return // dev: no-op, in-memory fallback in auth.ts
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS)
  // One pending challenge per address — upsert on address so the old one is
  // replaced rather than leaving stale rows.  The unique constraint on
  // `challenge` stays as a secondary safety net.
  await db
    .insert(authChallenges)
    .values({ address, challenge, expiresAt })
    .onConflictDoUpdate({
      target: authChallenges.address,
      set: { challenge, expiresAt, usedAt: null, createdAt: new Date() },
    })
}

export async function consumeChallenge(
  address: string,
  challenge: string,
): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false // signal: use in-memory path
  const [row] = await db
    .select()
    .from(authChallenges)
    .where(
      and(
        eq(authChallenges.address, address),
        eq(authChallenges.challenge, challenge),
        sql`${authChallenges.usedAt} IS NULL`,
        sql`${authChallenges.expiresAt} > NOW()`,
      ),
    )
    .limit(1)

  if (!row) return false

  // Mark as used (single-use)
  await db
    .update(authChallenges)
    .set({ usedAt: new Date() })
    .where(eq(authChallenges.id, row.id))

  return true
}

/** Prune expired challenges — call periodically (the indexer cron does this). */
export async function pruneExpiredChallenges(): Promise<void> {
  if (!process.env.DATABASE_URL) return
  await db
    .delete(authChallenges)
    .where(lt(authChallenges.expiresAt, new Date()))
}

// ── Indexer state ─────────────────────────────────────────────────────────────

export async function getIndexerState(
  network: string,
  contractAddress: string,
): Promise<number> {
  if (!process.env.DATABASE_URL) return 0
  const [row] = await db
    .select()
    .from(indexerState)
    .where(
      and(
        eq(indexerState.network, network),
        eq(indexerState.contractAddress, contractAddress),
      ),
    )
    .limit(1)
  return row?.lastLedger ?? 0
}

export async function setIndexerState(
  network: string,
  contractAddress: string,
  lastLedger: number,
): Promise<void> {
  if (!process.env.DATABASE_URL) return
  await db
    .insert(indexerState)
    .values({ network, contractAddress, lastLedger, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [indexerState.network, indexerState.contractAddress],
      set: { lastLedger, updatedAt: new Date() },
    })
}

export async function insertEvent(input: {
  eventId: string
  network: string
  contractAddress: string
  eventType: string
  ledgerNumber: number
  transactionHash: string | null
  topics: unknown
  data: unknown
}): Promise<boolean> {
  if (!process.env.DATABASE_URL) return false
  try {
    await db.insert(events).values(input).onConflictDoNothing()
    return true
  } catch {
    return false
  }
}
