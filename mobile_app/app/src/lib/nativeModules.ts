// Safe loaders for optional native modules. The dev client must be rebuilt after adding
// a new native dependency (`npx expo run:android`). Until then these return null and
// callers degrade gracefully instead of crashing Metro / the JS runtime.

import { NativeModules } from 'react-native'

export function loadNetInfo(): {
  addEventListener: (listener: (state: { isConnected?: boolean | null }) => void) => () => void
} | null {
  try {
    if (!NativeModules.RNCNetInfo) return null
    const mod = require('@react-native-community/netinfo')
    const NetInfo = mod.default ?? mod
    return NetInfo?.addEventListener ? NetInfo : null
  } catch {
    return null
  }
}

export type ExpoLocationModule = typeof import('expo-location')

export function loadExpoLocation(): ExpoLocationModule | null {
  try {
    if (!NativeModules.ExpoLocation) return null
    return require('expo-location') as ExpoLocationModule
  } catch {
    return null
  }
}
