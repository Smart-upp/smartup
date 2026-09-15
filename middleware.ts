/**
 * middleware.ts
 *
 * Next.js Edge Middleware — runs before every matched request.
 *
 * Responsibilities:
 *  1. CORS — add appropriate headers to all /api/* responses so the API can
 *     be called from browser-based clients on different origins.
 *  2. Preflight handling — respond immediately to OPTIONS requests with 204.
 *
 * CORS policy:
 *  - In development: allow all origins (*).
 *  - In production:  allow origins listed in ALLOWED_ORIGINS env var
 *    (comma-separated).  Falls back to * if the var is not set.
 *
 * Example ALLOWED_ORIGINS value:
 *   https://smartup.vercel.app,https://www.smart-upp.com
 */

import { NextRequest, NextResponse } from 'next/server'

const ALLOWED_ORIGINS =
  process.env.ALLOWED_ORIGINS?.split(',').map((o) => o.trim()).filter(Boolean) ?? []

function getAllowedOrigin(origin: string | null): string {
  if (!origin) return '*'
  if (process.env.NODE_ENV !== 'production') return origin
  if (ALLOWED_ORIGINS.length === 0) return origin // no restriction configured
  return ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
}

const CORS_HEADERS = {
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-SmartUp-Signature',
  'Access-Control-Max-Age': '86400',
}

export function middleware(request: NextRequest) {
  const origin = request.headers.get('origin')
  const allowedOrigin = getAllowedOrigin(origin)

  // Handle CORS preflight
  if (request.method === 'OPTIONS') {
    return new NextResponse(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': allowedOrigin,
        ...CORS_HEADERS,
      },
    })
  }

  // Clone the response and inject CORS headers
  const response = NextResponse.next()
  response.headers.set('Access-Control-Allow-Origin', allowedOrigin)
  Object.entries(CORS_HEADERS).forEach(([key, value]) => {
    response.headers.set(key, value)
  })

  return response
}

export const config = {
  matcher: '/api/:path*',
}
