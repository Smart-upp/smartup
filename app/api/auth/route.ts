/**
 * app/api/auth/route.ts
 *
 * Stellar-signature authentication endpoints.
 *
 * GET  /api/auth?address=G...
 *   Returns a one-time challenge string.  Sign it with Freighter's
 *   signMessage() and POST the signature back.
 *
 * POST /api/auth  { address, challenge, signature }
 *   Verifies the Ed25519 signature and issues a signed JWT on success.
 *
 * DELETE /api/auth
 *   Stateless logout — client must discard its token.
 */

import { issueChallenge, mintToken, verifyChallenge } from '@/lib/auth'
import { AuthVerifySchema } from '@/lib/schemas'

// ── GET — issue challenge ─────────────────────────────────────────────────────

export async function GET(request: Request) {
  const address = new URL(request.url).searchParams.get('address') ?? ''

  if (!/^G[A-Z2-7]{55}$/.test(address)) {
    return Response.json(
      { error: 'A valid Stellar G-address (56 chars, base32) is required.' },
      { status: 400 },
    )
  }

  // issueChallenge is async — it writes to the DB when DATABASE_URL is set
  const challenge = await issueChallenge(address)
  return Response.json({ challenge })
}

// ── POST — verify signature + issue JWT ───────────────────────────────────────

export async function POST(request: Request) {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  // Use the shared schema (validates hex format on signature)
  const parsed = AuthVerifySchema.safeParse(body)
  if (!parsed.success) {
    return Response.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid request.' },
      { status: 400 },
    )
  }

  const { address, challenge, signature } = parsed.data

  const valid = await verifyChallenge(address, challenge, signature)
  if (!valid) {
    return Response.json(
      { error: 'Signature verification failed or challenge has expired.' },
      { status: 401 },
    )
  }

  const token = await mintToken(address)
  return Response.json({ token, address, expiresIn: '8h' })
}

// ── DELETE — logout ───────────────────────────────────────────────────────────

export async function DELETE() {
  return Response.json({ message: 'Logged out. Discard your token on the client.' })
}
