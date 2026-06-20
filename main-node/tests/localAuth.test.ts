import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { verifyStaffToken, bearerFromHeader } from '../src/main/services/localAuthService'

const SECRET = 'shared-restaurant-secret'
const CTX = { secret: SECRET, restaurantId: 'R1', locationId: 'L1', now: 1_000_000_000_000 }

function b64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function sign(
  payload: Record<string, unknown>,
  opts: { secret?: string; alg?: string } = {},
): string {
  const alg = opts.alg ?? 'HS256'
  const header = b64url(JSON.stringify({ alg, typ: 'JWT' }))
  const body = b64url(JSON.stringify(payload))
  if (alg === 'none') return `${header}.${body}.`
  const sig = createHmac('sha256', opts.secret ?? SECRET)
    .update(`${header}.${body}`)
    .digest()
  return `${header}.${body}.${b64url(sig)}`
}

// exp = 1 hour after the fixed "now"
const validPayload = {
  type: 'staff_access',
  user_id: 'U1',
  username: 'waiter1',
  name: 'Waiter One',
  role: 'waiter',
  restaurant_id: 'R1',
  location_id: 'L1',
  iat: CTX.now / 1000,
  exp: CTX.now / 1000 + 3600,
}

describe('verifyStaffToken', () => {
  it('accepts a valid token and returns the staff claims', () => {
    const res = verifyStaffToken(sign(validPayload), CTX)
    expect(res.valid).toBe(true)
    if (res.valid) {
      expect(res.userId).toBe('U1')
      expect(res.role).toBe('waiter')
      expect(res.locationId).toBe('L1')
    }
  })

  it('rejects an expired token', () => {
    const expired = { ...validPayload, exp: CTX.now / 1000 - 1 }
    expect(verifyStaffToken(sign(expired), CTX)).toMatchObject({ valid: false, reason: 'Token expired' })
  })

  it('rejects a token for another restaurant', () => {
    const other = { ...validPayload, restaurant_id: 'R2' }
    expect(verifyStaffToken(sign(other), CTX)).toMatchObject({ valid: false, reason: 'Wrong restaurant' })
  })

  it('rejects a token scoped to a different location', () => {
    const other = { ...validPayload, location_id: 'L2' }
    expect(verifyStaffToken(sign(other), CTX)).toMatchObject({ valid: false, reason: 'Wrong location' })
  })

  it('allows a location-less (restaurant-wide) token on any device', () => {
    const wide = { ...validPayload, location_id: null }
    expect(verifyStaffToken(sign(wide), CTX).valid).toBe(true)
  })

  it('rejects a token signed with the wrong secret', () => {
    const forged = sign(validPayload, { secret: 'attacker-secret' })
    expect(verifyStaffToken(forged, CTX)).toMatchObject({ valid: false, reason: 'Invalid signature' })
  })

  it('rejects a tampered payload (signature no longer matches)', () => {
    const token = sign(validPayload)
    const [h, , s] = token.split('.')
    const tamperedBody = b64url(JSON.stringify({ ...validPayload, role: 'manager' }))
    expect(verifyStaffToken(`${h}.${tamperedBody}.${s}`, CTX)).toMatchObject({
      valid: false,
      reason: 'Invalid signature',
    })
  })

  it('rejects the alg:none downgrade attack', () => {
    expect(verifyStaffToken(sign(validPayload, { alg: 'none' }), CTX)).toMatchObject({
      valid: false,
      reason: 'Unsupported token algorithm',
    })
  })

  it('rejects a non-staff token type', () => {
    const wrongType = { ...validPayload, type: 'refresh' }
    expect(verifyStaffToken(sign(wrongType), CTX)).toMatchObject({ valid: false, reason: 'Wrong token type' })
  })

  it('rejects malformed tokens', () => {
    expect(verifyStaffToken('not-a-jwt', CTX).valid).toBe(false)
    expect(verifyStaffToken('a.b', CTX).valid).toBe(false)
  })

  it('fails closed when the device is not provisioned', () => {
    expect(verifyStaffToken(sign(validPayload), { secret: '', restaurantId: '' })).toMatchObject({
      valid: false,
    })
  })
})

describe('bearerFromHeader', () => {
  it('extracts a bearer token', () => {
    expect(bearerFromHeader('Bearer abc.def.ghi')).toBe('abc.def.ghi')
    expect(bearerFromHeader('bearer xyz')).toBe('xyz')
  })
  it('returns null when absent or malformed', () => {
    expect(bearerFromHeader(undefined)).toBeNull()
    expect(bearerFromHeader('Api-Key foo')).toBeNull()
  })
})
