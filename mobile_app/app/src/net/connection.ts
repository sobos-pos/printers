// Connection store (zustand) — single source of truth for "where do we send requests?".
//
// Node URL resolution priority:
//   1. mDNS-discovered leader  (real-time, persisted across restarts)
//   2. Manual Settings URL     (user override / last resort)
//   3. Built-in default        (empty — forces cloud on native)
//
// Probe strategy (important for performance):
//   • init()         — loads persisted discovered URL instantly, then runs mDNS in background
//   • autoProbe      — health-check only every 20s (fast, no 8s mDNS wait)
//   • mDNS re-scan   — triggered only at: startup | user request | health check failure
//                      This prevents the 8s mDNS scan from blocking the app every 20s.
//   • On health fail — clears discoveredNodeUrl and re-runs mDNS once before falling to cloud.

import { create } from 'zustand'
import { DEFAULTS, NET } from '../lib/config'
import {
  clearDiscoveredNodeUrl,
  getCloudBaseUrl,
  getDiscoveredNodeUrl,
  getNodeBaseUrl,
  saveCloudBaseUrl,
  saveDiscoveredNodeUrl,
  saveNodeBaseUrl,
} from '../lib/storage'
import type { ConnMode, HealthResponse } from '../lib/types'
import { request } from './apiClient'
import { discoverLeader, isMdnsAvailable } from './discovery'
import { isLoopbackNodeUrl, resolveNodeUrl } from './nodeUrl'

interface ConnectionState {
  mode: ConnMode
  /** User-entered URL from Settings (persisted). */
  settingsNodeUrl: string
  cloudBaseUrl: string
  /**
   * URL returned by the last successful mDNS scan (persisted across restarts so the
   * app can use it immediately on cold start before mDNS completes).
   */
  discoveredNodeUrl: string | null
  mdnsAvailable: boolean
  /** True while a background mDNS scan is running (used by Settings to show a spinner). */
  mdnsScanning: boolean
  lastProbeAt: number | null
  initialized: boolean

  init: () => Promise<void>
  effectiveNodeUrl: () => string
  /** Base URL for requests: node in Local mode, cloud in Cloud mode. */
  activeBaseUrl: () => string
  setSettingsNodeUrl: (url: string) => Promise<void>
  setCloudBaseUrl: (url: string) => Promise<void>
  /**
   * Probe reachability.
   *   force=true  → re-run mDNS scan first (use for manual "test" and health-fail recovery)
   *   force=false → health-check only against the current effective URL (fast, used by auto-probe)
   */
  probe: (force?: boolean) => Promise<ConnMode>
  /** Kick off a standalone mDNS re-scan without blocking a health check. */
  rediscover: () => Promise<void>
  startAutoProbe: () => void
  stopAutoProbe: () => void
  /**
   * Subscribe to OS network-state changes so the app recovers to Local mode the
   * instant Wi-Fi comes back (the dedicated WiFi-ON handler). No-op if the
   * @react-native-community/netinfo native module isn't present.
   */
  startNetworkListener: () => void
  stopNetworkListener: () => void
}

let autoProbeTimer: ReturnType<typeof setInterval> | null = null
let netInfoUnsub: (() => void) | null = null
let wasConnected = true

export const useConnection = create<ConnectionState>((set, get) => ({
  mode: 'probing',
  settingsNodeUrl: DEFAULTS.nodeBaseUrl,
  cloudBaseUrl: DEFAULTS.cloudBaseUrl,
  discoveredNodeUrl: null,
  mdnsAvailable: false,
  mdnsScanning: false,
  lastProbeAt: null,
  initialized: false,

  init: async () => {
    // Load all persisted values in parallel.
    const [node, cloud, discovered] = await Promise.all([
      getNodeBaseUrl(),
      getCloudBaseUrl(),
      getDiscoveredNodeUrl(), // last mDNS result — use immediately, no 8s wait
    ])

    const savedNode = node?.trim() ?? ''
    const settingsNodeUrl = isLoopbackNodeUrl(savedNode) ? '' : savedNode
    if (savedNode && !settingsNodeUrl) await saveNodeBaseUrl('')

    set({
      settingsNodeUrl,
      cloudBaseUrl: cloud || DEFAULTS.cloudBaseUrl,
      discoveredNodeUrl: discovered || null,
      mdnsAvailable: isMdnsAvailable(),
      initialized: true,
    })

    // Health-check immediately against whatever URL we already have (fast path).
    // Then kick off mDNS in the background — on success it updates discoveredNodeUrl
    // and a follow-up health check switches to Local mode automatically.
    await get().probe(false)
    void get().rediscover()
  },

  effectiveNodeUrl: () =>
    resolveNodeUrl(get().discoveredNodeUrl, get().settingsNodeUrl, DEFAULTS.nodeBaseUrl),

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

  /**
   * Run a standalone mDNS scan. Updates discoveredNodeUrl + storage on success.
   * Does not change the connection mode — call probe(false) afterwards if needed.
   */
  rediscover: async () => {
    if (!isMdnsAvailable()) return
    set({ mdnsScanning: true })
    try {
      const found = await discoverLeader()
      if (found?.url) {
        set({ discoveredNodeUrl: found.url })
        await saveDiscoveredNodeUrl(found.url)
      }
    } catch {
      /* discovery failed — keep the previously persisted URL */
    } finally {
      set({ mdnsScanning: false })
    }
  },

  probe: async (force = false) => {
    set({ mode: 'probing' })

    // Re-run mDNS when explicitly requested (user taps "Save & test" or manual call).
    if (force) {
      await get().rediscover()
    }

    const nodeUrl = get().effectiveNodeUrl()
    if (!nodeUrl) {
      set({ mode: 'cloud', lastProbeAt: Date.now() })
      return 'cloud'
    }

    try {
      const health = await request<HealthResponse>(nodeUrl, '/health/', {
        timeoutMs: NET.healthTimeoutMs,
      })
      if (health?.ok) {
        set({ mode: 'local', lastProbeAt: Date.now() })
        return 'local'
      }
    } catch {
      // Health check failed. If we had a discovered URL, the node may have moved
      // (leader failover). Clear the stale URL and immediately re-scan mDNS once.
      if (get().discoveredNodeUrl) {
        set({ discoveredNodeUrl: null })
        await clearDiscoveredNodeUrl()
        await get().rediscover()

        // Re-check with the freshly discovered URL (if any).
        const newUrl = get().effectiveNodeUrl()
        if (newUrl && newUrl !== nodeUrl) {
          try {
            const health2 = await request<HealthResponse>(newUrl, '/health/', {
              timeoutMs: NET.healthTimeoutMs,
            })
            if (health2?.ok) {
              set({ mode: 'local', lastProbeAt: Date.now() })
              return 'local'
            }
          } catch { /* fall through to cloud */ }
        }
      }
    }

    set({ mode: 'cloud', lastProbeAt: Date.now() })
    return 'cloud'
  },

  startAutoProbe: () => {
    if (autoProbeTimer) return
    autoProbeTimer = setInterval(() => {
      // When we're already on the node (Local), a cheap health-check is enough —
      // no 8s mDNS stall in the steady state.
      //
      // When we're NOT local (Cloud/probing) the discovered URL is usually null,
      // so probe(false) resolves straight back to Cloud and the app would never
      // climb back onto the node by itself. In that degraded state we force an
      // mDNS re-scan each cycle so a node that (re)appears on the Wi-Fi — e.g.
      // after Wi-Fi comes back — is picked up automatically within one interval.
      const forceRescan = get().mode !== 'local'
      void get().probe(forceRescan)
    }, NET.reprobeIntervalMs)
  },

  stopAutoProbe: () => {
    if (autoProbeTimer) {
      clearInterval(autoProbeTimer)
      autoProbeTimer = null
    }
  },

  startNetworkListener: () => {
    if (netInfoUnsub) return
    // Lazy require: only custom dev-client / production builds carry the native
    // module. Absent in Expo Go / web / CI — degrade to a no-op (the auto-probe
    // self-heal above still recovers within one interval).
    let NetInfo: any
    try {
      const mod = require('@react-native-community/netinfo')
      NetInfo = mod.default ?? mod
    } catch {
      return
    }
    if (!NetInfo?.addEventListener) return

    try {
      netInfoUnsub = NetInfo.addEventListener((state: { isConnected?: boolean | null }) => {
        const connected = state?.isConnected !== false
        // Fire only on the offline→online transition (Wi-Fi just came back).
        if (connected && !wasConnected) {
          // Force an mDNS re-scan + health check so we jump back to Local fast.
          void get().probe(true)
        }
        wasConnected = connected
      })
    } catch {
      netInfoUnsub = null
    }
  },

  stopNetworkListener: () => {
    if (netInfoUnsub) {
      try {
        netInfoUnsub()
      } catch {
        /* noop */
      }
      netInfoUnsub = null
    }
  },
}))
