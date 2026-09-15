/**
 * lib/schemas.ts
 *
 * Zod schemas shared across API routes for request validation.
 * All schemas are exported individually and composed where needed.
 */

import { z } from 'zod'

// ── Reusable primitives ───────────────────────────────────────────────────────

/** Stellar G-address: 56-character base32 string starting with G */
const StellarAddress = z
  .string()
  .regex(/^G[A-Z2-7]{55}$/, 'Must be a valid Stellar G-address (56 chars, base32)')

/** Soroban contract C-address */
const ContractAddress = z
  .string()
  .min(56)
  .max(72)
  .regex(/^C/, 'Must be a valid Soroban contract address (starts with C)')

const Network = z.enum(['testnet', 'mainnet'], {
  errorMap: () => ({ message: "network must be 'testnet' or 'mainnet'" }),
})

const DeliveryChannel = z.enum(['webhook', 'email', 'slack', 'discord']).optional()

/** Webhook / notification endpoint — URL, email, or channel identifier */
const DeliveryEndpoint = z.string().max(512).optional()

// ── Subscription ──────────────────────────────────────────────────────────────

export const SubscriptionCreateSchema = z.object({
  subscriptionId: z
    .string()
    .min(1, 'subscriptionId is required')
    .max(96, 'subscriptionId must be at most 96 characters')
    .regex(/^[\w\-]+$/, 'subscriptionId may only contain letters, numbers, hyphens, and underscores'),
  /** Overridden server-side with the JWT ownerId — kept here for type completeness */
  ownerId: StellarAddress.optional(),
  network: Network,
  contractAddress: ContractAddress,
  eventFilter: z
    .object({
      eventTypes: z.array(z.string().min(1).max(128)).min(1).optional(),
      topics: z.array(z.string()).optional(),
    })
    .optional()
    .default({}),
  deliveryChannel: DeliveryChannel,
  deliveryEndpoint: DeliveryEndpoint,
  metadata: z.record(z.unknown()).optional(),
})

export type SubscriptionCreateInput = z.infer<typeof SubscriptionCreateSchema>

export const SubscriptionToggleSchema = z.object({
  active: z.boolean({ required_error: 'active must be a boolean' }),
})

export const SubscriptionUpdateSchema = z.object({
  eventFilter: z
    .object({
      eventTypes: z.array(z.string().min(1).max(128)).min(1).optional(),
      topics: z.array(z.string()).optional(),
    })
    .optional(),
  deliveryChannel: DeliveryChannel,
  deliveryEndpoint: DeliveryEndpoint,
})

// ── Events ────────────────────────────────────────────────────────────────────

export const EventQuerySchema = z.object({
  network: Network.optional(),
  contractAddress: z.string().max(72).optional(),
  limit: z
    .string()
    .regex(/^\d+$/, 'limit must be a positive integer')
    .transform(Number)
    .pipe(z.number().int().min(1).max(200))
    .optional()
    .default('50'),
})

// ── Auth ──────────────────────────────────────────────────────────────────────

export const AuthVerifySchema = z.object({
  address: StellarAddress,
  challenge: z.string().min(10, 'challenge is required'),
  signature: z
    .string()
    .min(1, 'signature is required')
    .regex(/^[0-9a-fA-F]+$/, 'signature must be a hex string'),
})

// ── Delivery channel ──────────────────────────────────────────────────────────

export const DeliveryChannelCreateSchema = z.object({
  channelId: z
    .string()
    .min(1)
    .max(96)
    .regex(/^[\w\-]+$/),
  type: z.enum(['webhook', 'email', 'slack', 'discord']),
  endpoint: z.string().min(1).max(512),
})

// ── Webhook worker ────────────────────────────────────────────────────────────

export const WorkerTriggerSchema = z.object({
  /** Optional secret to prevent public invocation of the worker endpoint */
  secret: z.string().optional(),
})
