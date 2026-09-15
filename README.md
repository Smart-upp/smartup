# SmartUp — Soroban Subscription Registry

A developer console for subscribing to Soroban smart contract events and delivering them to webhooks, Slack, email, or Discord.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│  Browser                                                        │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Next.js dashboard (app/page.tsx)                        │   │
│  │  • Freighter wallet (lib/stellar/wallet.ts)              │   │
│  │  • Soroban contract client (lib/stellar/contract-client) │   │
│  └──────────────────────────────────────────────────────────┘   │
└───────────────────────────┬─────────────────────────────────────┘
                            │ HTTPS
┌───────────────────────────▼─────────────────────────────────────┐
│  Next.js API routes                                             │
│  /api/auth              Challenge + JWT issuance                │
│  /api/subscriptions     CRUD (JWT-protected writes)             │
│  /api/events            Read (optional auth, owner-scoped)      │
│  /api/worker/deliver    Webhook delivery worker (cron trigger)  │
│  /api/health            System health check                     │
└───────┬──────────────────────────┬──────────────────────────────┘
        │ Drizzle ORM + pg         │ Soroban RPC
┌───────▼────────┐        ┌────────▼──────────────────────────────┐
│  PostgreSQL    │        │  Stellar network (testnet / mainnet)  │
│  (5 tables)    │        │  SubscriptionRegistry contract         │
└────────────────┘        └───────────────────────────────────────┘
```

---

## Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| Node.js | ≥ 20 | |
| pnpm | ≥ 9 | `npm install -g pnpm` |
| Rust + wasm32 target | stable | `rustup target add wasm32-unknown-unknown` |
| Stellar CLI | latest | [Install guide](https://developers.stellar.org/docs/tools/stellar-cli) |
| PostgreSQL | ≥ 15 | Or use Neon / Supabase |
| Freighter browser extension | latest | [freighter.app](https://freighter.app) |

---

## Quick start

```bash
# 1. Install dependencies
pnpm install

# 2. Copy env template and fill in your values
cp .env.example .env.local

# 3. Push the database schema
pnpm db:push

# 4. Start the development server
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

---

## Environment variables

Create `.env.local` (never committed) with the following:

```bash
# ── Database ──────────────────────────────────────────────────
# PostgreSQL connection string (Neon, Supabase, or local)
DATABASE_URL=postgresql://user:password@host:5432/smartup

# ── Authentication ────────────────────────────────────────────
# At least 32 random bytes; generate with: openssl rand -hex 32
AUTH_SECRET=change-me-to-a-long-random-secret

# ── Webhooks ──────────────────────────────────────────────────
# Secret used to sign outgoing webhook payloads (HMAC-SHA256)
WEBHOOK_SECRET=change-me-webhook-secret

# ── Worker ───────────────────────────────────────────────────
# Secret to protect the /api/worker/deliver endpoint
WORKER_SECRET=change-me-worker-secret

# ── Soroban contract addresses ────────────────────────────────
# Set after running `pnpm deploy:contract`
NEXT_PUBLIC_CONTRACT_ADDRESS_TESTNET=C...
NEXT_PUBLIC_CONTRACT_ADDRESS_MAINNET=C...
```

---

## Database migrations

The project uses [Drizzle ORM](https://orm.drizzle.team) with `drizzle-kit`.

```bash
# Generate SQL migration files from schema changes
pnpm db:generate

# Apply migrations to the database
pnpm db:migrate

# Push schema directly (dev shortcut — skips migration files)
pnpm db:push
```

Schema is defined in `lib/db/schema.ts`.  Five tables:

| Table | Purpose |
|-------|---------|
| `subscriptions` | Registered event listeners |
| `deliveryChannels` | Notification endpoints per owner |
| `events` | Indexed Soroban contract events |
| `webhookDeliveries` | Delivery attempt log with retry state |
| `healthMetrics` | System telemetry snapshots |

---

## Deploying the Soroban contract

### 1. Install Rust + wasm32 target

```bash
rustup update stable
rustup target add wasm32-unknown-unknown
```

### 2. Fund a testnet account

```bash
stellar keys generate --global deployer --network testnet
stellar keys fund deployer --network testnet
```

### 3. Deploy

```bash
export STELLAR_NETWORK=testnet
export STELLAR_SECRET_KEY=$(stellar keys show deployer --network testnet)
pnpm deploy:contract
```

The script builds the WASM, uploads it, instantiates the contract, and writes the address to `.env.local` automatically.

### 4. Run contract tests (requires Rust)

```bash
cd contracts/smartup_subscription_registry
cargo test
```

Tests cover:

- Full lifecycle (register → update → pause → resume → remove)
- `list_by_owner` across multiple owners
- Duplicate registration prevention
- `get` / `update` / `remove` on non-existent subscriptions
- Empty-id and empty-filter/destination validation
- Mainnet subscription creation
- `set_active` after removal

---

## Authentication flow

SmartUp uses Stellar signature-based auth (similar to SEP-0010):

```
1. GET  /api/auth?address=G...
   ← { challenge: "smartup-auth:G...:deadbeef..." }

2. Sign the challenge string with Freighter:
   freighter.signMessage(challenge)
   ← { signature: "aabbcc..." }  (hex-encoded Ed25519)

3. POST /api/auth
   → { address, challenge, signature }
   ← { token: "eyJ...", expiresIn: "8h" }

4. Include in all protected requests:
   Authorization: Bearer eyJ...
```

The JWT is HS256, signed with `AUTH_SECRET`, valid for 8 hours.  The challenge is single-use and expires in 5 minutes.

**Production note:** The in-memory challenge store does not survive restarts or work across multiple instances.  Replace it with Redis or a `challenges` DB table.

---

## Webhook delivery

Subscriptions route events to delivery channels via the worker.

### Payload format

```json
{
  "deliveryId": "dlv_sub_payments_01_evt_1008_1726123456789",
  "subscriptionId": "sub_payments_01",
  "event": {
    "eventId": "evt_1008",
    "eventType": "payment_received",
    "contractAddress": "C...",
    "network": "testnet",
    "ledgerNumber": 51298402,
    "transactionHash": "a8f2...91c",
    "topics": [...],
    "data": {...},
    "createdAt": "2026-09-15T10:00:00.000Z"
  },
  "timestamp": "2026-09-15T10:00:01.000Z"
}
```

### Signature verification

Every POST includes an `X-SmartUp-Signature: sha256=<hex>` header.

```typescript
import { createHmac } from 'crypto'

function verifyWebhook(rawBody: string, signature: string): boolean {
  const expected = createHmac('sha256', process.env.WEBHOOK_SECRET!)
    .update(rawBody, 'utf8')
    .digest('hex')
  return `sha256=${expected}` === signature
}
```

### Retry schedule

| Attempt | Delay before retry |
|---------|--------------------|
| 1 | 30 seconds |
| 2 | 5 minutes |
| 3 | 30 minutes |
| 4 | 2 hours |
| 5 | Marked permanently failed |

### Running the worker

**Cron (recommended for production):**  Add to `vercel.json`:

```json
{
  "crons": [
    { "path": "/api/worker/deliver", "schedule": "* * * * *" }
  ]
}
```

**Long-running process (self-hosted):**

```bash
WORKER_INTERVAL_MS=30000 pnpm worker:deliver
```

**Manual trigger:**

```bash
curl -X POST http://localhost:3000/api/worker/deliver \
     -H "Authorization: Bearer $WORKER_SECRET"
```

---

## API reference

### Auth

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/auth?address=G...` | — | Issue challenge |
| POST | `/api/auth` | — | Verify signature → JWT |
| DELETE | `/api/auth` | — | Logout (client-side) |

### Subscriptions

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/subscriptions` | optional | List subscriptions (owner-scoped when authenticated) |
| POST | `/api/subscriptions` | required | Create subscription |
| PATCH | `/api/subscriptions/:id` | required | Toggle active state |
| DELETE | `/api/subscriptions/:id` | required | Delete subscription |

### Events

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/api/events` | optional | List events (owner-scoped when authenticated) |

Query params: `network`, `contractAddress`, `limit` (1–200, default 50).

### Worker

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| POST | `/api/worker/deliver` | `WORKER_SECRET` | Run delivery worker pass |

---

## Production checklist

- [ ] Set `AUTH_SECRET` to ≥ 32 random bytes
- [ ] Set `WEBHOOK_SECRET` and `WORKER_SECRET`
- [ ] Replace in-memory challenge store with Redis or a DB table
- [ ] Set `NEXT_PUBLIC_CONTRACT_ADDRESS_TESTNET` / `_MAINNET` after deploying the contract
- [ ] Configure Vercel Cron (or equivalent) for `/api/worker/deliver`
- [ ] Enable HTTPS on all endpoints (Vercel handles this automatically)
- [ ] Review `CORS` headers if the API is consumed by third parties
- [ ] Add a rate limiter (e.g. Upstash Ratelimit) to `/api/auth` and `/api/subscriptions`
- [ ] Set up log aggregation (Axiom, Datadog, etc.) for worker output
- [ ] Monitor `webhookDeliveries` for permanently failed deliveries
