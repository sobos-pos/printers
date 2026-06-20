// Shared clock-in/out helpers: always fetch a fresh GPS fix before hitting the API.

import { evaluateGeofence } from '../lib/geo'
import type { Coords } from '../lib/types'
import type { GeofenceState } from './useGeofence'

export class LocationUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocationUnavailableError'
  }
}

export class OutsideGeofenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutsideGeofenceError'
  }
}

/**
 * Read a fresh device position and validate against the geofence when configured.
 * Throws LocationUnavailableError or OutsideGeofenceError when clock-in must abort.
 */
export async function resolveClockInCoords(geo: GeofenceState): Promise<Coords | null> {
  if (geo.locationConfigured && !geo.locationNativeAvailable) {
    throw new LocationUnavailableError(
      geo.error ?? 'Location module missing — rebuild the dev app for on-device geofence.',
    )
  }

  const coords = await geo.getFreshCoords(false)

  if (geo.locationConfigured) {
    if (!coords) {
      const msg =
        geo.error ??
        (geo.permission === 'denied'
          ? 'Location permission needed to clock in.'
          : 'Could not read your location. Try again.')
      throw new LocationUnavailableError(msg)
    }
    const check = evaluateGeofence(geo.targetLocation, coords)
    if (!check.within) {
      const dist =
        check.distanceM != null
          ? `You're ${Math.round(check.distanceM)} m away`
          : 'You are outside the restaurant'
      throw new OutsideGeofenceError(
        `${dist} — must be within ${check.radiusM} m to clock in.`,
      )
    }
  }

  return coords
}

/** Best-effort fresh coords for clock-out audit trail (never geofenced). */
export async function resolveClockOutCoords(geo: GeofenceState): Promise<Coords | null> {
  return geo.getFreshCoords(false)
}
