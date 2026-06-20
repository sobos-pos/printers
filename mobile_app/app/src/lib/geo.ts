// Pure geo helpers. Kept free of any React Native / Expo imports so they're unit-testable.
// The server is the source of truth for the geofence gate; these power the client-side
// pre-check (button enable/disable + distance readout) only.

import type { Coords, LocationCtx } from './types'

const EARTH_RADIUS_M = 6371000

/** Great-circle distance between two WGS-84 points, in metres. */
export function haversineMeters(a: Coords, b: Coords): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.latitude - a.latitude)
  const dLng = toRad(b.longitude - a.longitude)
  const lat1 = toRad(a.latitude)
  const lat2 = toRad(b.latitude)
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** A location is geofenced only when it has both coordinates set. */
export function hasGeofence(loc: LocationCtx | null | undefined): boolean {
  return !!loc && loc.latitude != null && loc.longitude != null
}

export interface GeofenceCheck {
  /** true when the location has no geofence (clock-in allowed anywhere) or the point is inside. */
  within: boolean
  /** metres from the geofence centre, or null when the location isn't geofenced. */
  distanceM: number | null
  radiusM: number
}

/**
 * Evaluate a device position against a location's geofence.
 * When the location has no geofence configured, `within` is always true.
 */
export function evaluateGeofence(
  loc: LocationCtx | null | undefined,
  coords: Coords | null,
): GeofenceCheck {
  const radiusM = loc?.geofence_radius_m ?? 200
  if (!hasGeofence(loc)) return { within: true, distanceM: null, radiusM }
  if (!coords) return { within: false, distanceM: null, radiusM }
  const distanceM = haversineMeters(coords, {
    latitude: loc!.latitude as number,
    longitude: loc!.longitude as number,
  })
  return { within: distanceM <= radiusM, distanceM, radiusM }
}

/** Human-friendly distance, e.g. "85 m" or "1.2 km". */
export function formatDistance(meters: number): string {
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(1)} km`
}
