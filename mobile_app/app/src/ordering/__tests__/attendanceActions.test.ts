import { describe, expect, it, jest } from '@jest/globals'
import {
  LocationUnavailableError,
  OutsideGeofenceError,
  resolveClockInCoords,
  resolveClockOutCoords,
} from '../attendanceActions'
import type { GeofenceState } from '../useGeofence'

function mockGeo(overrides: Partial<GeofenceState> = {}): GeofenceState {
  return {
    targetLocation: {
      id: '1',
      name: 'Indiranagar',
      latitude: 12.9719,
      longitude: 77.6412,
      geofence_radius_m: 200,
    },
    locationConfigured: true,
    geofenceEnabled: true,
    locationNativeAvailable: true,
    permission: 'granted',
    canAskAgain: true,
    loading: false,
    coords: null,
    check: { within: true, distanceM: 0, radiusM: 200 },
    error: null,
    refresh: jest.fn(async () => {}),
    openSettings: jest.fn(async () => {}),
    getFreshCoords: jest.fn(async () => ({ latitude: 12.9719, longitude: 77.6412 })),
    ...overrides,
  }
}

describe('resolveClockInCoords', () => {
  it('throws when geofence configured but native module missing', async () => {
    const geo = mockGeo({ locationNativeAvailable: false, geofenceEnabled: false })
    await expect(resolveClockInCoords(geo)).rejects.toBeInstanceOf(LocationUnavailableError)
  })

  it('throws when permission denied and coords unavailable', async () => {
    const geo = mockGeo({
      permission: 'denied',
      getFreshCoords: jest.fn(async () => null),
    })
    await expect(resolveClockInCoords(geo)).rejects.toBeInstanceOf(LocationUnavailableError)
  })

  it('throws when outside geofence', async () => {
    const geo = mockGeo({
      getFreshCoords: jest.fn(async () => ({ latitude: 13.0, longitude: 78.0 })),
    })
    await expect(resolveClockInCoords(geo)).rejects.toBeInstanceOf(OutsideGeofenceError)
  })

  it('returns coords when inside geofence', async () => {
    const coords = { latitude: 12.9719, longitude: 77.6412 }
    const geo = mockGeo({ getFreshCoords: jest.fn(async () => coords) })
    await expect(resolveClockInCoords(geo)).resolves.toEqual(coords)
  })

  it('allows null coords when geofence not configured', async () => {
    const geo = mockGeo({
      locationConfigured: false,
      geofenceEnabled: false,
      targetLocation: { id: '1', name: 'Anywhere' },
      getFreshCoords: jest.fn(async () => null),
    })
    await expect(resolveClockInCoords(geo)).resolves.toBeNull()
  })
})

describe('resolveClockOutCoords', () => {
  it('returns fresh coords without geofence validation', async () => {
    const coords = { latitude: 13.0, longitude: 78.0 }
    const geo = mockGeo({ getFreshCoords: jest.fn(async () => coords) })
    await expect(resolveClockOutCoords(geo)).resolves.toEqual(coords)
  })
})
