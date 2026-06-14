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

let Zeroconf: any | undefined
function getZeroconf(): any | null {
  if (Zeroconf === undefined) {
    try {
      // Lazy require so import never crashes when the native module is absent.
      Zeroconf = require('react-native-zeroconf').default
    } catch {
      Zeroconf = null
    }
  }
  if (!Zeroconf) return null
  try {
    return new Zeroconf()
  } catch {
    return null
  }
}

function pickIpv4(addresses?: string[]): string | undefined {
  if (!addresses?.length) return undefined
  return addresses.find((a) => /^\d{1,3}(\.\d{1,3}){3}$/.test(a)) ?? addresses[0]
}

function toDiscovered(svc: ZeroconfService): DiscoveredNode | null {
  const ip = pickIpv4(svc.addresses) ?? svc.host
  if (!ip || !svc.port) return null
  const txt = svc.txt ?? {}
  return {
    url: `http://${ip}:${svc.port}`,
    nodeId: txt.node_id as string | undefined,
    locationId: txt.location_id as string | undefined,
    clusterRole: txt.cluster_role as string | undefined,
  }
}

/** Returns whether native mDNS is available on this build (false in Expo Go). */
export function isMdnsAvailable(): boolean {
  return getZeroconf() != null
}

/**
 * Browse for the leader node. Resolves as soon as a service with cluster_role==="leader" is found,
 * otherwise returns the best non-leader candidate seen before the timeout, or null if none.
 */
export function discoverLeader(timeoutMs = NET.mdnsBrowseTimeoutMs): Promise<DiscoveredNode | null> {
  const zc = getZeroconf()
  if (!zc) return Promise.resolve(null)

  return new Promise((resolve) => {
    let settled = false
    let fallback: DiscoveredNode | null = null

    const finish = (result: DiscoveredNode | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        zc.stop()
        zc.removeDeviceListeners?.()
      } catch {
        /* noop */
      }
      resolve(result)
    }

    const timer = setTimeout(() => finish(fallback), timeoutMs)

    zc.on('resolved', (svc: ZeroconfService) => {
      const node = toDiscovered(svc)
      if (!node) return
      if (node.clusterRole === 'leader') finish(node)
      else if (!fallback) fallback = node // keep first follower as a fallback target
    })
    zc.on('error', () => {
      /* swallow; timer will resolve with whatever we have */
    })

    try {
      zc.scan(NET.mdnsServiceType, 'tcp', 'local.')
    } catch {
      finish(null)
    }
  })
}
