// Device-location hook backing the clock-in geofence.
//
// The geofence is checked against the user's ASSIGNED location (context.user.location)
// because that's exactly what the server uses to gate clock-in — keeping the client
// pre-check and the server enforcement in lock-step. The server always re-validates;
// this hook drives UX (button enable/disable + distance readout) and supplies fresh
// coordinates at clock-in/out time.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState, Linking } from 'react-native'
import { useAuth } from '../auth/store'
import { readDeviceCoords, type GeoPermission } from '../lib/deviceLocation'
import { evaluateGeofence, hasGeofence, type GeofenceCheck } from '../lib/geo'
import { loadExpoLocation } from '../lib/nativeModules'
import type { Coords, LocationCtx } from '../lib/types'

export type { GeoPermission }

/** How often to re-check position while the geofence gate is active (not clocked in). */
const WATCH_INTERVAL_MS = 30_000

export interface UseGeofenceOptions {
  /** Poll for position updates while true (typically when not clocked in). */
  watchActive?: boolean
}

export interface GeofenceState {
  /** The location we geofence against (the user's assigned location), or null. */
  targetLocation: LocationCtx | null
  /** Server-side geofence is configured (lat/lng set on assigned location). */
  locationConfigured: boolean
  /** Client can read GPS and enforce the gate (native module present). */
  geofenceEnabled: boolean
  /** False when expo-location isn't in the installed dev build. */
  locationNativeAvailable: boolean
  permission: GeoPermission
  /** False when the user must open system Settings to grant location. */
  canAskAgain: boolean
  loading: boolean
  coords: Coords | null
  check: GeofenceCheck
  error: string | null
  /** Re-request permission (when prompt) and refresh the current position. */
  refresh: (prompt?: boolean) => Promise<void>
  /** Open the app's page in system Settings (after permanent denial). */
  openSettings: () => Promise<void>
  /**
   * Force a fresh GPS read. Updates hook state and returns coords.
   * Pass prompt=true to show the OS permission dialog when needed.
   */
  getFreshCoords: (prompt?: boolean) => Promise<Coords | null>
}

export function useGeofence(options: UseGeofenceOptions = {}): GeofenceState {
  const { watchActive = false } = options
  const user = useAuth((s) => s.context?.user ?? null)
  const targetLocation = user?.location ?? null
  const locationConfigured = hasGeofence(targetLocation)
  const Location = useMemo(() => loadExpoLocation(), [])
  const locationNativeAvailable = Location != null
  const geofenceEnabled = locationConfigured && locationNativeAvailable

  const [permission, setPermission] = useState<GeoPermission>('undetermined')
  const [canAskAgain, setCanAskAgain] = useState(true)
  const [coords, setCoords] = useState<Coords | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const bgInFlight = useRef(false)

  const applyRead = useCallback((result: Awaited<ReturnType<typeof readDeviceCoords>>) => {
    setPermission(result.permission)
    setCanAskAgain(result.canAskAgain)
    setCoords(result.coords)
    setError(result.error)
    return result.coords
  }, [])

  const runRead = useCallback(
    async (prompt: boolean, userInitiated: boolean) => {
      if (!Location) {
        setError(null)
        return null
      }
      // Background polls yield to user-initiated permission requests.
      if (bgInFlight.current && !userInitiated) return null

      if (userInitiated) bgInFlight.current = true
      else if (bgInFlight.current) return null
      else bgInFlight.current = true

      setLoading(true)
      if (userInitiated) setError(null)
      try {
        return applyRead(await readDeviceCoords({ prompt }))
      } finally {
        setLoading(false)
        bgInFlight.current = false
      }
    },
    [Location, applyRead],
  )

  const refresh = useCallback(
    async (prompt = false) => {
      await runRead(prompt, prompt)
    },
    [runRead],
  )

  const getFreshCoords = useCallback(
    async (prompt = false): Promise<Coords | null> => {
      return runRead(prompt, prompt)
    },
    [runRead],
  )

  const openSettings = useCallback(async () => {
    await Linking.openSettings()
  }, [])

  // Initial read: prompt when the location is geofenced (we genuinely need it),
  // otherwise best-effort silent (capture coords for the audit trail if already granted).
  useEffect(() => {
    refresh(locationConfigured && locationNativeAvailable)
  }, [locationConfigured, locationNativeAvailable, targetLocation?.id, refresh])

  // Re-check when the app returns to foreground — user may have just granted in Settings.
  useEffect(() => {
    if (!Location) return
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh(false)
    })
    return () => sub.remove()
  }, [Location, refresh])

  // Periodic refresh while waiting to clock in so the gate reacts as the user moves.
  useEffect(() => {
    if (!watchActive || !geofenceEnabled) return
    const id = setInterval(() => {
      if (!bgInFlight.current) refresh(false)
    }, WATCH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [watchActive, geofenceEnabled, refresh])

  const check =
    geofenceEnabled
      ? evaluateGeofence(targetLocation, coords)
      : {
          within: true,
          distanceM: null,
          radiusM: targetLocation?.geofence_radius_m ?? 200,
        }

  const buildError =
    error ??
    (locationConfigured && !locationNativeAvailable
      ? 'Location module missing — rebuild the dev app (expo run:android) for on-device geofence.'
      : null)

  return {
    targetLocation,
    locationConfigured,
    geofenceEnabled,
    locationNativeAvailable,
    permission,
    canAskAgain,
    loading,
    coords,
    check,
    error: buildError,
    refresh,
    openSettings,
    getFreshCoords,
  }
}
