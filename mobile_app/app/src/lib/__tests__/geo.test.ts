import { describe, expect, it } from '@jest/globals'
import { evaluateGeofence, formatDistance, hasGeofence, haversineMeters } from '../geo'
import type { LocationCtx } from '../types'

describe('haversineMeters', () => {
  it('is ~0 for identical points', () => {
    expect(haversineMeters({ latitude: 28.6, longitude: 77.2 }, { latitude: 28.6, longitude: 77.2 })).toBeCloseTo(0, 5)
  })

  it('matches a known distance (~111 km per degree of latitude)', () => {
    const d = haversineMeters({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 })
    expect(d).toBeGreaterThan(110000)
    expect(d).toBeLessThan(112000)
  })
})

describe('hasGeofence', () => {
  it('false when coords missing', () => {
    expect(hasGeofence({ id: '1', name: 'A' })).toBe(false)
    expect(hasGeofence({ id: '1', name: 'A', latitude: null, longitude: null })).toBe(false)
    expect(hasGeofence(null)).toBe(false)
  })
  it('true when both coords present', () => {
    expect(hasGeofence({ id: '1', name: 'A', latitude: 28.6, longitude: 77.2 })).toBe(true)
  })
})

describe('evaluateGeofence', () => {
  const loc: LocationCtx = { id: '1', name: 'A', latitude: 28.6139, longitude: 77.209, geofence_radius_m: 200 }

  it('allows when no geofence configured', () => {
    const r = evaluateGeofence({ id: '1', name: 'A' }, null)
    expect(r.within).toBe(true)
    expect(r.distanceM).toBeNull()
  })

  it('blocks when geofenced but no coords yet', () => {
    expect(evaluateGeofence(loc, null).within).toBe(false)
  })

  it('within when at the centre', () => {
    const r = evaluateGeofence(loc, { latitude: 28.6139, longitude: 77.209 })
    expect(r.within).toBe(true)
    expect(r.distanceM).toBeLessThan(1)
  })

  it('outside when far away', () => {
    const r = evaluateGeofence(loc, { latitude: 28.70, longitude: 77.30 })
    expect(r.within).toBe(false)
    expect(r.distanceM).toBeGreaterThan(200)
  })
})

describe('formatDistance', () => {
  it('metres under 1km', () => {
    expect(formatDistance(85.4)).toBe('85 m')
  })
  it('km at/over 1km', () => {
    expect(formatDistance(1234)).toBe('1.2 km')
  })
})
