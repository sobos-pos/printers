// Device-location hook backing the clock-in geofence.
//
// The geofence is checked against the user's ASSIGNED location (context.user.location)
// because that's exactly what the server uses to gate clock-in — keeping the client
// pre-check and the server enforcement in lock-step. The server always re-validates,
// so this hook is purely about UX (button enable/disable + a distance readout).

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { useAuth } from '../auth/store'
import { evaluateGeofence, hasGeofence, type GeofenceCheck } from '../lib/geo'
import { loadExpoLocation } from '../lib/nativeModules'
import type { Coords, LocationCtx } from '../lib/types'

export type GeoPermission = 'undetermined' | 'granted' | 'denied'

export interface GeofenceState {
  /** The location we geofence against (the user's assigned location), or null. */
  targetLocation: LocationCtx | null
  /** Whether that location actually has a geofence configured. */
  geofenceEnabled: boolean
  /** False when expo-location isn't in the installed dev build. */
  locationNativeAvailable: boolean
  permission: GeoPermission
  loading: boolean
  coords: Coords | null
  check: GeofenceCheck
  error: string | null
  /** Re-request permission (when prompt) and refresh the current position. */
  refresh: (prompt?: boolean) => Promise<void>
}

export function useGeofence(): GeofenceState {
  const user = useAuth((s) => s.context?.user ?? null)
  const targetLocation = user?.location ?? null
  const locationConfigured = hasGeofence(targetLocation)
  const Location = useMemo(() => loadExpoLocation(), [])
  const locationNativeAvailable = Location != null
  // Client-side gate only when both the server geofence and native module exist.
  const geofenceEnabled = locationConfigured && locationNativeAvailable

  const [permission, setPermission] = useState<GeoPermission>('undetermined')
  const [coords, setCoords] = useState<Coords | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inFlight = useRef(false)

  const refresh = useCallback(
    async (prompt = false) => {
      if (inFlight.current) return
      if (!Location) {
        setError(null)
        return
      }
      inFlight.current = true
      setLoading(true)
      setError(null)
      try {
        let perm = await Location.getForegroundPermissionsAsync()
        // Only actively prompt when asked (e.g. user tapped "Enable location"), and
        // only if the OS still allows asking — avoids nagging on every render.
        if (prompt && perm.status !== 'granted' && perm.canAskAgain) {
          perm = await Location.requestForegroundPermissionsAsync()
        }

        if (perm.status === 'granted') {
          setPermission('granted')
          const pos = await Location.getCurrentPositionAsync({
            accuracy: Location.Accuracy.Balanced,
          })
          setCoords({ latitude: pos.coords.latitude, longitude: pos.coords.longitude })
        } else {
          setPermission(perm.status === 'denied' ? 'denied' : 'undetermined')
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Could not read your location.')
      } finally {
        setLoading(false)
        inFlight.current = false
      }
    },
    [Location],
  )

  // Initial read: prompt when the location is geofenced (we genuinely need it),
  // otherwise best-effort silent (capture coords for the audit trail if already granted).
  useEffect(() => {
    refresh(locationConfigured && locationNativeAvailable)
  }, [locationConfigured, locationNativeAvailable, targetLocation?.id, refresh])

  // Re-check when the app returns to foreground — the user may have just toggled
  // location services or walked into range.
  useEffect(() => {
    if (!Location) return
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') refresh(false)
    })
    return () => sub.remove()
  }, [Location, refresh])

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
    geofenceEnabled,
    locationNativeAvailable,
    permission,
    loading,
    coords,
    check,
    error: buildError,
    refresh,
  }
}
