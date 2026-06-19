import { describe, it, expect } from 'vitest'
import { isContactFresh, NEVER_CONTACTED } from '../src/main/repositories/clusterNodeRepository'

describe('cluster liveness freshness', () => {
  const now = Date.parse('2026-06-17T12:00:00.000Z')
  const ttl = 15000

  it('treats a node never contacted as offline', () => {
    expect(isContactFresh(NEVER_CONTACTED, ttl, now)).toBe(false)
  })

  it('is online within the TTL window', () => {
    const justNow = new Date(now - 4000).toISOString()
    expect(isContactFresh(justNow, ttl, now)).toBe(true)
  })

  it('is online exactly at the TTL boundary', () => {
    const atBoundary = new Date(now - ttl).toISOString()
    expect(isContactFresh(atBoundary, ttl, now)).toBe(true)
  })

  it('goes offline once contact ages past the TTL', () => {
    const stale = new Date(now - (ttl + 1)).toISOString()
    expect(isContactFresh(stale, ttl, now)).toBe(false)
  })

  it('treats an unparseable contact time as offline', () => {
    expect(isContactFresh('not-a-date', ttl, now)).toBe(false)
    expect(isContactFresh('', ttl, now)).toBe(false)
  })
})
