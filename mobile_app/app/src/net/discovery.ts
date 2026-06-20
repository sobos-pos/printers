// mDNS leader discovery — the PRIMARY way the app finds the leader node on the venue Wi-Fi.
// The node advertises Bonjour service type "soboss" over tcp (=> _soboss._tcp) with a TXT record
// carrying { node_id, location_id, cluster_role, station_codes } (see main-node/.../discovery/mdns.ts).
//
// We browse for that service, prefer the one whose TXT cluster_role === "leader", and build an
// http URL from its first IPv4 address + advertised port. Everything is wrapped defensively: if the
// native zeroconf module isn't present (e.g. running in Expo Go instead of a dev client) or mDNS is
// blocked, we resolve to null and the caller falls back to the Settings/cloud URL.

import { NET } from '../lib/config'

export interface DiscoveredNode {
  url: string // e.g. http://192.168.1.50:3001
  nodeId?: string
  locationId?: string
  clusterRole?: string
}

interface ZeroconfService {
  name: string
  host?: string
  port?: number
  addresses?: string[]
  txt?: Record<string, unknown>
}

// Cache only the CLASS reference — never create an instance here.
// isMdnsAvailable() must NOT instantiate Zeroconf because the constructor on some
// Android builds acquires a multicast lock; leaving that instance alive would block
// the real scan. Instance creation is deferred to discoverLeader().
let ZeroconfClass: (new () => any) | null | undefined // undefined = not yet attempted

function loadZeroconfClass(): (new () => any) | null {
  if (ZeroconfClass === undefined) {
    try {
      // Lazy require so this module never crashes when the native module is absent
      // (e.g. Expo Go, web, CI). Only custom dev-client and production builds carry
      // the react-native-zeroconf native module.
      const mod = require('react-native-zeroconf')
      ZeroconfClass = mod.default ?? mod
    } catch {
      ZeroconfClass = null
    }
  }
  return ZeroconfClass ?? null
}

function pickIpv4(addresses?: string[]): string | undefined {
  if (!addresses?.length) return undefined
  return addresses.find((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a)) ?? addresses[0]
}

function normalizeTxtValue(value: unknown): string | undefined {
  if (value == null) return undefined
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return String.fromCharCode(...value.filter((n) => typeof n === 'number'))
  return String(value)
}

function normalizeTxt(txt?: Record<string, unknown>): Record<string, string> {
  if (!txt) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(txt)) {
    const normalized = normalizeTxtValue(value)
    if (normalized != null) out[key] = normalized
  }
  return out
}

function toDiscovered(svc: ZeroconfService): DiscoveredNode | null {
  const ip =
    pickIpv4(svc.addresses) ??
    (svc.host && /^\d{1,3}(\.\d{1,3}){3}$/.test(svc.host) ? svc.host : undefined)
  if (!ip || !svc.port) return null
  const txt = normalizeTxt(svc.txt)
  return {
    url: `http://${ip}:${svc.port}`,
    nodeId: txt.node_id,
    locationId: txt.location_id,
    clusterRole: txt.cluster_role,
  }
}

/**
 * Returns whether native mDNS is available on this build.
 * False in Expo Go — only custom dev-client / production builds have the native module.
 * Does NOT instantiate Zeroconf (avoids spurious multicast-lock acquisition).
 */
export function isMdnsAvailable(): boolean {
  return loadZeroconfClass() != null
}

/**
 * Browse for the leader node. Resolves as soon as a service with cluster_role==="leader"
 * is found, otherwise returns the best non-leader candidate seen before the timeout, or
 * null if none found.
 *
 * A fresh Zeroconf instance is created per call and always stopped in the finish path,
 * so concurrent scans are safe and there are no leaked multicast locks.
 */
export function discoverLeader(timeoutMs = NET.mdnsBrowseTimeoutMs): Promise<DiscoveredNode | null> {
  const Cls = loadZeroconfClass()
  if (!Cls) return Promise.resolve(null)

  let zc: any
  try {
    zc = new Cls()
  } catch {
    return Promise.resolve(null)
  }

  return new Promise((resolve) => {
    let settled = false
    let fallback: DiscoveredNode | null = null

    const finish = (result: DiscoveredNode | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        zc.stop()
      } catch { /* noop */ }
      try {
        // removeDeviceListeners exists in react-native-zeroconf >=0.13
        zc.removeDeviceListeners()
      } catch { /* older builds expose removeEventListeners or nothing */ }
      resolve(result)
    }

    const timer = setTimeout(() => finish(fallback), timeoutMs)

    zc.on('resolved', (svc: ZeroconfService) => {
      const node = toDiscovered(svc)
      if (!node) return
      // Prefer explicit leader; accept missing role (Android TXT quirks) for single-node venues.
      if (node.clusterRole === 'leader' || !node.clusterRole) finish(node)
      else if (!fallback) fallback = node
    })

    zc.on('error', () => {
      /* swallow individual errors; timer will resolve with whatever we have */
    })

    try {
      zc.scan(NET.mdnsServiceType, 'tcp', 'local.')
    } catch {
      finish(null)
    }
  })
}
