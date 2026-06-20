// Device GPS reads via expo-location. Kept separate from React hooks so the same
// logic is used for background refresh, fresh reads at clock-in/out, and tests.

import { PermissionStatus } from 'expo-modules-core'
import { loadExpoLocation } from './nativeModules'
import type { Coords } from './types'

export type GeoPermission = 'undetermined' | 'granted' | 'denied'

export interface DeviceLocationResult {
  permission: GeoPermission
  coords: Coords | null
  error: string | null
  /** False when the OS will not show the permission dialog again — user must open Settings. */
  canAskAgain: boolean
}

export interface ReadDeviceCoordsOptions {
  /** Request OS permission when not yet granted. */
  prompt?: boolean
}

function mapPermission(status: PermissionStatus, canAskAgain: boolean): GeoPermission {
  if (status === PermissionStatus.GRANTED) return 'granted'
  if (status === PermissionStatus.DENIED && !canAskAgain) return 'denied'
  return 'undetermined'
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
      canAskAgain: true,
    }
  }

  try {
    let perm = await Location.getForegroundPermissionsAsync()

    if (options.prompt && !perm.granted) {
      // Always call request when we intend to prompt and can still ask — this shows
      // the system dialog for undetermined, and re-prompts on Android when allowed.
      if (perm.canAskAgain) {
        perm = await Location.requestForegroundPermissionsAsync()
      }
    }

    if (!perm.granted) {
      return {
        permission: mapPermission(perm.status, perm.canAskAgain),
        coords: null,
        error: null,
        canAskAgain: perm.canAskAgain,
      }
    }

    const servicesOn = await Location.hasServicesEnabledAsync()
    if (!servicesOn) {
      return {
        permission: 'granted',
        coords: null,
        error: 'Location services are turned off on this device.',
        canAskAgain: perm.canAskAgain,
      }
    }

    const pos = await Location.getCurrentPositionAsync({
      accuracy: Location.Accuracy.High,
    })

    return {
      permission: 'granted',
      coords: { latitude: pos.coords.latitude, longitude: pos.coords.longitude },
      error: null,
      canAskAgain: perm.canAskAgain,
    }
  } catch (e) {
    return {
      permission: 'undetermined',
      coords: null,
      error: e instanceof Error ? e.message : 'Could not read your location.',
      canAskAgain: true,
    }
  }
}
