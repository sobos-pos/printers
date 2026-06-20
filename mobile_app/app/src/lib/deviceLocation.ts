// Device GPS reads via expo-location. Kept separate from React hooks so the same
// logic is used for background refresh, fresh reads at clock-in/out, and tests.

import { loadExpoLocation } from './nativeModules'
import type { Coords } from './types'

export type GeoPermission = 'undetermined' | 'granted' | 'denied'

export interface DeviceLocationResult {
  permission: GeoPermission
  coords: Coords | null
  error: string | null
}

export interface ReadDeviceCoordsOptions {
  /** Request OS permission when not yet granted (only if canAskAgain). */
  prompt?: boolean
}

/**
 * Read the device's current position. Returns null coords when permission is denied,
 * the native module is missing, or the OS location call fails.
 */
export async function readDeviceCoords(
  options: ReadDeviceCoordsOptions = {},
): Promise<DeviceLocationResult> {
  const Location = loadExpoLocation()
  if (!Location) {
    return {
      permission: 'undetermined',
      coords: null,
      error: null,
    }
  }

  try {
    let perm = await Location.getForegroundPermissionsAsync()
    if (options.prompt && perm.status !== 'granted' && perm.canAskAgain) {
      perm = await Location.requestForegroundPermissionsAsync()
    }

    if (perm.status !== 'granted') {
      return {
        permission: perm.status === 'denied' ? 'denied' : 'undetermined',
        coords: null,
        error: null,
      }
    }

    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    })

    return {
      permission: 'granted',
      coords: { latitude: pos.coords.latitude, longitude: pos.coords.longitude },
      error: null,
    }
  } catch (e) {
    return {
      permission: 'undetermined',
      coords: null,
      error: e instanceof Error ? e.message : 'Could not read your location.',
    }
  }
}
