import { createHmac, timingSafeEqual } from 'node:crypto'
import { config } from '../config'

/**
 * Offline verification of staff "shift" JWTs (Layer 2 of the two-layer auth
 * model). The cloud signs HS256 tokens with the restaurant's shared secret;
 * every device stores a copy of that secret and verifies tokens locally — no
 * network, no user table, no session lookup.
 *
 * Implemented directly on Node's crypto (no jsonwebtoken dependency) so we can
 * keep the trusted surface small and explicit:
 *   - only HS256 is accepted (alg-confusion / "alg: none" are rejected),
 *   - the signature is compared in constant time,
 *   - expiry and the device's own restaurant/location are enforced.
 */

export type StaffRole = 'owner' | 'manager' | 'staff' | 'waiter' | 'chef' | 'kiosk'

export interface AuthSuccess {
  valid: true
  userId: string
  username: string
  name: string
  role: string
  restaurantId: string
  locationId: string | null
}

export interface AuthFailure {
  valid: false
  reason: string
}

export type AuthResult = AuthSuccess | AuthFailure

function b64urlToBuffer(input: string): Buffer {
  // Restore base64 padding/alphabet then decode.
  const pad = input.length % 4 === 0 ? '' : '='.repeat(4 - (input.length % 4))
  return Buffer.from(input.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

function fail(reason: string): AuthFailure {
  return { valid: false, reason }
}

export interface VerifyContext {
  secret?: string
  restaurantId?: string
  locationId?: string
  now?: number
}

/** Verify a raw JWT string against this device's stored material.
 *
 * The verification context defaults to this device's config; tests (and any
 * other caller) may override it explicitly. */
export function verifyStaffToken(token: string, ctx: VerifyContext = {}): AuthResult {
  const secret = ctx.secret ?? config.jwtSecret
  const deviceRestaurant = ctx.restaurantId ?? config.restaurantId
  const deviceLocation = ctx.locationId ?? config.locationId
  const now = ctx.now ?? Date.now()
  if (!secret || !deviceRestaurant) {
    return fail('Device not provisioned for staff auth')
  }

  if (typeof token !== 'string') return fail('Malformed token')
  const parts = token.split('.')
  if (parts.length !== 3) return fail('Malformed token')
  const [headerB64, payloadB64, signatureB64] = parts

  // Header: only HS256 is allowed (reject "none" and asymmetric alg-confusion).
  let header: { alg?: string; typ?: string }
  try {
    header = JSON.parse(b64urlToBuffer(headerB64).toString('utf8'))
  } catch {
    return fail('Malformed token header')
  }
  if (header.alg !== 'HS256') return fail('Unsupported token algorithm')

  // Signature: HMAC-SHA256 over "header.payload", constant-time compared.
  const expected = createHmac('sha256', secret)
    .update(`${headerB64}.${payloadB64}`)
    .digest()
  const provided = b64urlToBuffer(signatureB64)
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return fail('Invalid signature')
  }

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(b64urlToBuffer(payloadB64).toString('utf8'))
  } catch {
    return fail('Malformed token payload')
  }

  if (payload.type !== 'staff_access') return fail('Wrong token type')

  const exp = payload.exp
  if (typeof exp !== 'number' || now >= exp * 1000) {
    return fail('Token expired')
  }

  // This token must belong to THIS device's restaurant…
  if (payload.restaurant_id !== deviceRestaurant) {
    return fail('Wrong restaurant')
  }
  // …and, when the token is scoped to a location, to THIS device's outlet.
  const tokenLocation = (payload.location_id ?? null) as string | null
  if (tokenLocation && deviceLocation && tokenLocation !== deviceLocation) {
    return fail('Wrong location')
  }

  return {
    valid: true,
    userId: String(payload.user_id ?? ''),
    username: String(payload.username ?? ''),
    name: String(payload.name ?? ''),
    role: String(payload.role ?? ''),
    restaurantId: String(payload.restaurant_id),
    locationId: tokenLocation,
  }
}

/** Extract a bearer token from an Authorization header value. */
export function bearerFromHeader(header: string | undefined): string | null {
  if (!header) return null
  const m = /^Bearer\s+(.+)$/i.exec(header.trim())
  return m ? m[1].trim() : null
}

/** Whether the device has staff-auth material configured at all. */
export function isLocalAuthConfigured(): boolean {
  return Boolean(config.jwtSecret && config.restaurantId)
}

export function roleAllowed(role: string, allowed: readonly string[]): boolean {
  return allowed.includes(role)
}
