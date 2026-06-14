// App-wide defaults and constants. Node/cloud URLs are user-editable (Settings screen) and
// persisted; these are only the initial defaults / dev conveniences.

export const DEFAULTS = {
  // Dev default for the local leader node. On a real venue this is discovered via mDNS or set
  // in Settings. Matches the main-node default local API port (3001).
  nodeBaseUrl: 'http://localhost:3001',
  // Cloud fallback base URL. Empty string => relative (only meaningful on web); set a real URL
  // for native. Override in Settings.
  cloudBaseUrl: '',
}

export const NET = {
  healthTimeoutMs: 2000, // matches the web waiter page probe timeout
  reprobeIntervalMs: 20000, // re-probe every ~20s
  mdnsBrowseTimeoutMs: 4000, // give mDNS up to 4s to surface the leader
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
  nodeBaseUrl: 'soboss.node_base_url', // AsyncStorage
  cloudBaseUrl: 'soboss.cloud_base_url', // AsyncStorage
  tablesCachePrefix: 'soboss.tables.', // + locationId => AsyncStorage (JSON)
  menuCachePrefix: 'soboss.menu.', // + tableUuid => AsyncStorage (JSON)
}
