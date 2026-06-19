// App-wide defaults and constants. Node/cloud URLs are user-editable (Settings screen) and
// persisted; these are only the initial defaults / dev conveniences.

export const DEFAULTS = {
  // Empty on native — localhost on a phone points at the device itself, not the venue PC.
  // The leader is found via mDNS or entered manually in Settings (port 3001).
  nodeBaseUrl: '',
  // Cloud fallback base URL. Empty string => relative (only meaningful on web); set a real URL
  // for native. Override in Settings.
  cloudBaseUrl: '',
}

export const NET = {
  healthTimeoutMs: 2000, // matches the web waiter page probe timeout
  reprobeIntervalMs: 20000, // re-probe every ~20s
  mdnsBrowseTimeoutMs: 8000, // give mDNS time to surface the leader on busy Wi-Fi
  mdnsServiceType: 'soboss', // node advertises type "soboss" (=> _soboss._tcp)
}

// v1 ships the Waiter role only; routing is role-aware so KIOSK / PRINTER_STATION can be added.
export const APP_ROLE = 'WAITER' as const

// Order source sent to the backend (enum value the backend accepts).
export const ORDER_SOURCE = 'Waiter_App' as const

// AsyncStorage / SecureStore keys.
export const STORAGE_KEYS = {
  sessionToken: 'soboss.session_token', // SecureStore
  authContext: 'soboss.auth_context', // AsyncStorage (JSON)
  nodeBaseUrl: 'soboss.node_base_url', // AsyncStorage — manually-entered URL
  cloudBaseUrl: 'soboss.cloud_base_url', // AsyncStorage
  // Last URL returned by mDNS discovery. Persisted so the app can use it immediately
  // on the next cold start while a fresh mDNS scan runs in the background.
  discoveredNodeUrl: 'soboss.discovered_node_url', // AsyncStorage
  tablesCachePrefix: 'soboss.tables.', // + locationId => AsyncStorage (JSON)
  menuCachePrefix: 'soboss.menu.', // + tableUuid => AsyncStorage (JSON)
}
