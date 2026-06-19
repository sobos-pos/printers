// Helpers for node base URLs. localhost/127.0.0.1 are valid on web/dev simulators but useless on
// a physical phone — the device would probe itself instead of the venue PC.

import { Platform } from 'react-native'

export function isLoopbackNodeUrl(url: string | null | undefined): boolean {
  if (!url?.trim()) return false
  try {
    const host = new URL(url.trim()).hostname.toLowerCase()
    return host === 'localhost' || host === '127.0.0.1' || host === '::1'
  } catch {
    return false
  }
}

/** Pick the first node URL that is usable on this platform. */
export function resolveNodeUrl(
  discovered: string | null | undefined,
  settings: string | null | undefined,
  fallback = '',
): string {
  for (const candidate of [discovered, settings, fallback]) {
    const url = candidate?.trim()
    if (!url) continue
    if (Platform.OS !== 'web' && isLoopbackNodeUrl(url)) continue
    return url
  }
  return ''
}

/** URL to show in Settings — prefer mDNS result over stale loopback defaults. */
export function displayNodeUrl(
  discovered: string | null | undefined,
  settings: string | null | undefined,
): string {
  if (discovered?.trim()) return discovered.trim()
  if (settings?.trim() && !isLoopbackNodeUrl(settings)) return settings.trim()
  return ''
}
