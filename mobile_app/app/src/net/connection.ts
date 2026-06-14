// Connection store (zustand) — the single source of truth for "where do we send requests?".
//
// Resolution order for the node address (mDNS is primary, per product decision):
//   1. mDNS-discovered leader  ->  2. manual Settings node URL  ->  3. built-in default
// Then it probes GET {node}/health/. Reachable => Local mode (base = node).
// Unreachable => Cloud mode (base = cloud URL). Re-probes every ~20s and on demand before ordering.

import { create } from 'zustand'
import { DEFAULTS, NET } from '../lib/config'
import { getCloudBaseUrl, getNodeBaseUrl, saveCloudBaseUrl, saveNodeBaseUrl } from '../lib/storage'
import type { ConnMode, HealthResponse } from '../lib/types'
import { request } from './apiClient'
import { discoverLeader, isMdnsAvailable } from './discovery'

interface ConnectionState {
  mode: ConnMode
  // User-configured (Settings) URLs — persisted.
  settingsNodeUrl: string
  cloudBaseUrl: string
  // mDNS-discovered node URL (takes precedence over settingsNodeUrl when present).
  discoveredNodeUrl: string | null
  mdnsAvailable: boolean
  lastProbeAt: number | null
  initialized: boolean

  init: () => Promise<void>
  effectiveNodeUrl: () => string
  /** The base URL requests should currently use (node in Local mode, cloud in Cloud mode). */
  activeBaseUrl: () => string
  setSettingsNodeUrl: (url: string) => Promise<void>
  setCloudBaseUrl: (url: string) => Promise<void>
  /** Probe reachability; pass force=true to re-run mDNS discovery first. */
  probe: (force?: boolean) => Promise<ConnMode>
  startAutoProbe: () => void
  stopAutoProbe: () => void
}

let timer: ReturnType<typeof setInterval> | null = null

export const useConnection = create<ConnectionState>((set, get) => ({
  mode: 'probing',
  settingsNodeUrl: DEFAULTS.nodeBaseUrl,
  cloudBaseUrl: DEFAULTS.cloudBaseUrl,
  discoveredNodeUrl: null,
  mdnsAvailable: false,
  lastProbeAt: null,
  initialized: false,

  init: async () => {
    const [node, cloud] = await Promise.all([getNodeBaseUrl(), getCloudBaseUrl()])
    set({
      settingsNodeUrl: node || DEFAULTS.nodeBaseUrl,
      cloudBaseUrl: cloud || DEFAULTS.cloudBaseUrl,
      mdnsAvailable: isMdnsAvailable(),
      initialized: true,
    })
    await get().probe(true)
  },

  effectiveNodeUrl: () => get().discoveredNodeUrl || get().settingsNodeUrl || DEFAULTS.nodeBaseUrl,

  activeBaseUrl: () =>
    get().mode === 'local' ? get().effectiveNodeUrl() : get().cloudBaseUrl,

  setSettingsNodeUrl: async (url) => {
    set({ settingsNodeUrl: url })
    await saveNodeBaseUrl(url)
  },
  setCloudBaseUrl: async (url) => {
    set({ cloudBaseUrl: url })
    await saveCloudBaseUrl(url)
  },

  probe: async (force = false) => {
    set({ mode: 'probing' })

    // (Re)discover the leader via mDNS when forced or we don't yet have one.
    if (force || !get().discoveredNodeUrl) {
      try {
        const found = await discoverLeader()
        set({ discoveredNodeUrl: found?.url ?? get().discoveredNodeUrl ?? null })
      } catch {
        /* discovery failed -> fall through to settings/default */
      }
    }

    const nodeUrl = get().effectiveNodeUrl()
    try {
      const health = await request<HealthResponse>(nodeUrl, '/health/', {
        timeoutMs: NET.healthTimeoutMs,
      })
      if (health?.ok) {
        set({ mode: 'local', lastProbeAt: Date.now() })
        return 'local'
      }
    } catch {
      /* node unreachable -> cloud */
    }
    set({ mode: 'cloud', lastProbeAt: Date.now() })
    return 'cloud'
  },

  startAutoProbe: () => {
    if (timer) return
    timer = setInterval(() => {
      // Light re-probe (no mDNS re-scan) to flip Local/Cloud as reachability changes.
      void get().probe(false)
    }, NET.reprobeIntervalMs)
  },
  stopAutoProbe: () => {
    if (timer) {
      clearInterval(timer)
      timer = null
    }
  },
}))
