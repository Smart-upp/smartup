import {
  pgTable,
  text,
  integer,
  boolean,
  timestamp,
  jsonb,
  serial,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core'

// Subscriptions: SmartUp subscription registry
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: serial('id').primaryKey(),
    subscriptionId: text('subscriptionId').notNull().unique(),
    ownerId: text('ownerId').notNull(), // Stellar account ID
    network: text('network').notNull(), // 'testnet' or 'mainnet'
    contractAddress: text('contractAddress').notNull(), // Soroban contract address
    eventFilter: jsonb('eventFilter').notNull(), // {"eventTypes": [...], "topics": [...]}
    deliveryChannel: text('deliveryChannel'), // e.g., 'webhook', 'email', 'slack'
    deliveryEndpoint: text('deliveryEndpoint'), // webhook URL, email, etc.
    active: boolean('active').default(true),
    createdAt: timestamp('createdAt').defaultNow(),
    updatedAt: timestamp('updatedAt').defaultNow(),
    metadata: jsonb('metadata'), // custom app data
  },
  (table) => [
    index('idx_subscriptions_owner_network').on(table.ownerId, table.network),
    index('idx_subscriptions_contract').on(table.contractAddress),
    index('idx_subscriptions_active').on(table.active),
  ]
)

// Delivery channels: available notification endpoints
export const deliveryChannels = pgTable(
  'deliveryChannels',
  {
    id: serial('id').primaryKey(),
    channelId: text('channelId').notNull().unique(),
    ownerId: text('ownerId').notNull(),
    type: text('type').notNull(), // 'webhook', 'email', 'discord', 'slack'
    endpoint: text('endpoint').notNull(), // URL or identifier
    active: boolean('active').default(true),
    failureCount: integer('failureCount').default(0),
    lastFailedAt: timestamp('lastFailedAt'),
    createdAt: timestamp('createdAt').defaultNow(),
  },
  (table) => [
    index('idx_channels_owner').on(table.ownerId),
    index('idx_channels_type').on(table.type),
  ]
)

// Events: indexed contract events
export const events = pgTable(
  'events',
  {
    id: serial('id').primaryKey(),
    eventId: text('eventId').notNull().unique(),
    network: text('network').notNull(),
    contractAddress: text('contractAddress').notNull(),
    eventType: text('eventType').notNull(),
    ledgerNumber: integer('ledgerNumber').notNull(),
    transactionHash: text('transactionHash'),
    topics: jsonb('topics'),
    data: jsonb('data'),
    createdAt: timestamp('createdAt').defaultNow(),
  },
  (table) => [
    index('idx_events_contract_network').on(table.contractAddress, table.network),
    index('idx_events_type').on(table.eventType),
    index('idx_events_created').on(table.createdAt),
  ]
)

// Webhook deliveries: delivery attempt log
export const webhookDeliveries = pgTable(
  'webhookDeliveries',
  {
    id: serial('id').primaryKey(),
    deliveryId: text('deliveryId').notNull().unique(),
    subscriptionId: text('subscriptionId').notNull(),
    eventId: text('eventId').notNull(),
    channelId: text('channelId').notNull(),
    status: text('status').notNull(), // 'pending', 'delivered', 'failed', 'retrying'
    attempt: integer('attempt').default(1),
    httpStatus: integer('httpStatus'),
    errorMessage: text('errorMessage'),
    nextRetryAt: timestamp('nextRetryAt'),
    createdAt: timestamp('createdAt').defaultNow(),
    deliveredAt: timestamp('deliveredAt'),
  },
  (table) => [
    index('idx_deliveries_subscription').on(table.subscriptionId),
    index('idx_deliveries_status').on(table.status),
    index('idx_deliveries_created').on(table.createdAt),
  ]
)

// Auth challenges: one-time challenge tokens for Stellar signature auth
export const authChallenges = pgTable(
  'authChallenges',
  {
    id: serial('id').primaryKey(),
    address: text('address').notNull().unique(), // one pending challenge per address
    challenge: text('challenge').notNull().unique(),
    expiresAt: timestamp('expiresAt').notNull(),
    usedAt: timestamp('usedAt'),           // set when consumed — single-use
    createdAt: timestamp('createdAt').defaultNow(),
  },
  (table) => [
    index('idx_challenges_expires').on(table.expiresAt),
  ]
)

// Indexer state: tracks the last ledger processed per network+contract
export const indexerState = pgTable(
  'indexerState',
  {
    id: serial('id').primaryKey(),
    network: text('network').notNull(),
    contractAddress: text('contractAddress').notNull(),
    lastLedger: integer('lastLedger').notNull().default(0),
    updatedAt: timestamp('updatedAt').defaultNow(),
  },
  (table) => [
    // uniqueIndex is required for the ON CONFLICT DO UPDATE upsert in setIndexerState
    uniqueIndex('idx_indexer_network_contract_unique').on(table.network, table.contractAddress),
  ]
)

// Health metrics: system status
export const healthMetrics = pgTable(
  'healthMetrics',
  {
    id: serial('id').primaryKey(),
    metric: text('metric').notNull(), // 'indexing_lag', 'delivery_success_rate', 'event_throughput'
    value: text('value').notNull(),
    unit: text('unit'),
    createdAt: timestamp('createdAt').defaultNow(),
  },
  (table) => [
    index('idx_metrics_created').on(table.createdAt),
  ]
)
