/**
 * lib/auth.ts
 *
 * Stellar-signature-based authentication — challenge / verify / JWT.
 *
 * Flow:
 *   1. GET  /api/auth?address=G...  → { challenge }
 *      Server generates a random challenge and persists it in the DB
 *      (or an in-memory map when DATABASE_URL is absent).
 *
 *   2. Client signs the challenge with Freighter signMessage() (SEP-53 / raw Ed25519).
 *
 *   3. POST /api/auth  { address, challenge, signature }
 *      Server verifies the Ed25519 signature and the stored challenge,
 *      then issues a short-lived HS256 JWT.
 *
 *   4. All protected routes call requireAuth(request) which verifies the JWT
 *      and returns { ownerId: string }.
 *
 * Challenge persistence:
 *   - When DATABASE_URL is set  → stored in the `authChallenges` DB table.
 *     Survives restarts and works across multiple serverless instances.
 *   - Otherwise                 → in-memory Map (single-process dev only).
 */

import { SignJWT, jwtVerify, type JWTPayload } from 'jose'
import { Keypair } from '@stellar/stellar-sdk'
import {
  saveChallenge as dbSaveChallenge,
  consumeChallenge as dbConsumeChallenge,
} from '@/lib/db/repository'

// ── Config ────────────────────────────────────────────────────────────────────

const AUTH_SECRET = process.env.AUTH_SECRET
const JWT_ISSUER = 'smartup'
const JWT_AUDIENCE = 'smartup-api'
const TOKEN_TTL = '8h'
const CHALLENGE_TTL_MS = 5 * 60 * 1000 // 5 minutes

// ── Secret key ────────────────────────────────────────────────────────────────

function getSecretKey(): Uint8Array {
  if (!AUTH_SECRET) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('AUTH_SECRET environment variable is required in production.')
    }
    // Dev fallback — deterministic, insecure, clearly labelled
    return new TextEncoder().encode('dev-insecure-secret-32-bytes-min!')
  }
  return new TextEncoder().encode(AUTH_SECRET)
}

// ── In-memory fallback (dev without DB) ──────────────────────────────────────

const memStore = new Map<string, { challenge: string; expiresAt: number }>()

// ── Challenge lifecycle ───────────────────────────────────────────────────────

/** Generate and persist a one-time challenge for the given Stellar address. */
export async function issueChallenge(address: string): Promise<string> {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  const challenge = `smartup-auth:${address}:${Buffer.from(bytes).toString('hex')}`

  if (process.env.DATABASE_URL) {
    await dbSaveChallenge(address, challenge)
  } else {
    // Dev: in-memory, keyed by address (one pending challenge per address)
    memStore.set(address, { challenge, expiresAt: Date.now() + CHALLENGE_TTL_MS })
  }

  return challenge
}

/**
 * Verify an Ed25519 signature over the challenge bytes and consume the
 * challenge (single-use).  Returns true on success.
 */
export async function verifyChallenge(
  address: string,
  challenge: string,
  signatureHex: string,
): Promise<boolean> {
  // 1. Verify the stored challenge exists and hasn't been used / expired
  const challengeValid = await checkAndConsumeChallenge(address, challenge)
  if (!challengeValid) return false

  // 2. Verify the Ed25519 signature
  try {
    const keypair = Keypair.fromPublicKey(address)
    const messageBytes = Buffer.from(challenge, 'utf-8')
    const signatureBytes = Buffer.from(signatureHex, 'hex')
    return keypair.verify(messageBytes, signatureBytes)
  } catch {
    return false
  }
}

async function checkAndConsumeChallenge(address: string, challenge: string): Promise<boolean> {
  if (process.env.DATABASE_URL) {
    // DB path — consumeChallenge() does the expiry check and marks as used atomically
    return dbConsumeChallenge(address, challenge)
  }

  // In-memory path
  const stored = memStore.get(address)
  if (!stored) return false
  if (stored.challenge !== challenge) return false
  if (Date.now() > stored.expiresAt) {
    memStore.delete(address)
    return false
  }
  memStore.delete(address) // single-use
  return true
}

// ── JWT ───────────────────────────────────────────────────────────────────────

/** Mint a signed HS256 JWT for the given Stellar address. */
export async function mintToken(ownerId: string): Promise<string> {
  return new SignJWT({ ownerId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(JWT_ISSUER)
    .setAudience(JWT_AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(getSecretKey())
}

export interface AuthPayload extends JWTPayload {
  ownerId: string
}

/** Verify a JWT and return its payload, or throw on failure. */
export async function verifyToken(token: string): Promise<AuthPayload> {
  const { payload } = await jwtVerify(token, getSecretKey(), {
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  })
  if (typeof (payload as AuthPayload).ownerId !== 'string') {
    throw new Error('Invalid token payload: missing ownerId.')
  }
  return payload as AuthPayload
}

// ── Route middleware ──────────────────────────────────────────────────────────

/**
 * Require a valid Bearer JWT on the request.
 * Returns the AuthPayload on success, or a 401 Response on failure.
 *
 * Usage:
 *   const auth = await requireAuth(request)
 *   if (auth instanceof Response) return auth
 *   // auth.ownerId is verified
 */
export async function requireAuth(request: Request): Promise<AuthPayload | Response> {
  const authHeader = request.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : null

  if (!token) {
    return Response.json(
      { error: 'Authorization header is missing or malformed. Expected: Bearer <token>' },
      { status: 401 },
    )
  }

  try {
    return await verifyToken(token)
  } catch {
    return Response.json({ error: 'Invalid or expired token.' }, { status: 401 })
  }
}

/**
 * Attempt auth without failing.  Returns the payload or null.
 * Useful for routes that are public reads but scoped writes.
 */
export async function optionalAuth(request: Request): Promise<AuthPayload | null> {
  const result = await requireAuth(request)
  return result instanceof Response ? null : result
}
