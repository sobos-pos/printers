import { v4 as uuidv4 } from 'uuid'
import {
  CloudBlockedError,
  NotActiveHolderError,
  config,
  isCloudConfigured,
  isDemoCloudBlocked,
} from '../config'
import { getLanIp } from '../net'

const TIMEOUT_MS = 5000
// Menu writes can carry base64 image payloads; the upload + server-side image
// validation and file write easily exceed the 5 s default, so they opt into a
// longer timeout to avoid spuriously aborting a request that actually succeeds.
const UPLOAD_TIMEOUT_MS = 60000

async function cloudFetch(
  path: string,
  options: RequestInit & { mutating?: boolean; timeoutMs?: number } = {},
): Promise<Response> {
  if (isDemoCloudBlocked()) throw new CloudBlockedError()
  if (!isCloudConfigured()) throw new Error('Cloud not configured')

  const headers: Record<string, string> = {
    Authorization: `Api-Key ${config.cloudApiKey}`,
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  }

  if (options.mutating) {
    headers['X-Node-Id'] = config.nodeId
    headers['Idempotency-Key'] = uuidv4()
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS)

  try {
    const res = await fetch(`${config.cloudBaseUrl}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
    })

    if (res.status === 409 && options.mutating) {
      // A 409 NOT_ACTIVE_HOLDER means the cloud may have reassigned the lease
      // (e.g. another node was force-promoted). Trigger an immediate heartbeat
      // so the authoritative role is re-resolved right away instead of waiting
      // up to one heartbeat interval — this closes the dual-leader window. We
      // poke the heartbeat (rather than demote outright) so a cold-booting
      // leader whose lease merely lapsed re-claims instead of being demoted.
      if (config.clusterRole === 'leader') {
        import('../workers/heartbeatWorker')
          .then(({ heartbeatWorker }) => heartbeatWorker.runNow())
          .catch(() => {})
      }
      throw new NotActiveHolderError()
    }

    return res
  } finally {
    clearTimeout(timer)
  }
}

export const cloudClient = {
  async pullEvents(cursor: number, limit = 50) {
    const params = new URLSearchParams({
      location: config.locationId,
      cursor: String(cursor),
      limit: String(limit),
    })
    const res = await cloudFetch(`/api/v1/sync/orders/?${params}`)
    if (!res.ok) throw new Error(`pullEvents failed: ${res.status}`)
    return res.json() as Promise<{
      events: Array<{
        event_id: string
        sequence: number
        event_type: string
        order_ref: string | null
        payload: Record<string, unknown>
      }>
      next_cursor: number
      has_more: boolean
    }>
  },

  async ackEvents(eventIds: string[]) {
    const res = await cloudFetch('/api/v1/sync/orders/ack/', {
      method: 'POST',
      mutating: true,
      body: JSON.stringify({ event_ids: eventIds }),
    })
    if (!res.ok) throw new Error(`ackEvents failed: ${res.status}`)
    return res.json() as Promise<{ acked: number }>
  },

  async pushStatus(orderId: string, status: string) {
    const res = await cloudFetch(`/api/v1/sync/orders/${orderId}/status/`, {
      method: 'PATCH',
      mutating: true,
      body: JSON.stringify({ status, occurred_at: new Date().toISOString() }),
    })
    if (!res.ok) throw new Error(`pushStatus failed: ${res.status}`)
    return res.json()
  },

  async bulkPushOrders(orders: Array<Record<string, unknown>>) {
    const res = await cloudFetch('/api/v1/sync/orders/bulk/', {
      method: 'POST',
      mutating: true,
      body: JSON.stringify({ orders }),
    })
    if (!res.ok) throw new Error(`bulkPushOrders failed: ${res.status}`)
    return res.json() as Promise<{ created: number; skipped: number }>
  },

  async fetchMenu(sinceVersion: number) {
    const params = new URLSearchParams({ since_version: String(sinceVersion) })
    const res = await cloudFetch(`/api/v1/sync/menu/?${params}`)
    if (res.status === 204) return null
    if (!res.ok) throw new Error(`fetchMenu failed: ${res.status}`)
    const data = await res.json()
    if (data.changed === false) return null
    return data as { version: number; categories: unknown[] }
  },

  async sendHeartbeat(isActive: boolean) {
    const { nodeConfigRepository } = await import('../repositories/nodeConfigRepository')
    const nodeLabel = nodeConfigRepository.get('node_label') || ''

    const res = await cloudFetch('/api/v1/sync/heartbeat/', {
      method: 'POST',
      body: JSON.stringify({
        location: config.locationId,
        node_id: config.nodeId,
        node_time: new Date().toISOString(),
        is_active: isActive,
        cluster_role: config.clusterRole,
        node_label: nodeLabel,
        lan_host: getLanIp(),
        lan_port: config.localApiPort,
      }),
    })
    if (!res.ok) throw new Error(`heartbeat failed: ${res.status}`)
    return res.json()
  },

  // Leader → cloud consolidated cluster snapshot. The cloud becomes a
  // read-only mirror of the leader-owned membership/status.
  async reportClusterState(snapshot: {
    leader_id: string
    nodes: Array<{
      node_id: string
      node_label: string
      cluster_role: string
      lan_host: string
      lan_port: number
      status: string
      last_seen: string
    }>
  }) {
    const res = await cloudFetch('/api/v1/sync/cluster-state/', {
      method: 'POST',
      body: JSON.stringify(snapshot),
    })
    if (!res.ok) throw new Error(`reportClusterState failed: ${res.status}`)
    return res.json() as Promise<{ updated: number }>
  },

  async markOffline() {
    const res = await cloudFetch('/api/v1/sync/node-offline/', {
      method: 'POST',
      body: JSON.stringify({}),
    })
    if (!res.ok) throw new Error(`markOffline failed: ${res.status}`)
    return res.json()
  },

  async getActiveStatus() {
    const params = new URLSearchParams({ location: config.locationId })
    const res = await cloudFetch(`/api/v1/sync/active-status/?${params}`)
    if (!res.ok) throw new Error(`active-status failed: ${res.status}`)
    return res.json() as Promise<{
      holder: string
      lease_expires_at: string | null
      last_seen_seconds: number | null
      is_fresh: boolean
    }>
  },

  async claimActive(force = false) {
    const res = await cloudFetch('/api/v1/sync/claim-active/', {
      method: 'POST',
      body: JSON.stringify({
        location: config.locationId,
        node_id: config.nodeId,
        force,
      }),
    })
    if (res.status === 409) {
      const detail = await res.json()
      return { granted: false as const, detail: detail.error ?? detail }
    }
    if (!res.ok) throw new Error(`claimActive failed: ${res.status}`)
    return { granted: true as const, detail: await res.json() }
  },

  async getNodeConfig() {
    const params = new URLSearchParams({ node_id: config.nodeId })
    const res = await cloudFetch(`/api/v1/sync/node-config/?${params}`)
    if (res.status === 204) return null
    if (!res.ok) throw new Error(`getNodeConfig failed: ${res.status}`)
    const data = await res.json()
    return data.config as Record<string, unknown> | null
  },

  async saveNodeConfig(configBlob: Record<string, unknown>) {
    const res = await cloudFetch('/api/v1/sync/node-config/', {
      method: 'POST',
      body: JSON.stringify({ node_id: config.nodeId, config: configBlob }),
    })
    if (!res.ok) throw new Error(`saveNodeConfig failed: ${res.status}`)
    return res.json()
  },

  // Authenticated with the leader's own Api-Key (no manager session needed).
  async createNode(nodeName: string) {
    const res = await cloudFetch('/api/v1/sync/nodes/create/', {
      method: 'POST',
      body: JSON.stringify({ node_name: nodeName, location_id: config.locationId }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as any
      throw new Error(data.error || `createNode failed: ${res.status}`)
    }
    return res.json() as Promise<{
      node_id: string
      node_name: string
      cluster_role: string
      is_online: boolean
    }>
  },

  async fetchNodes(sessionToken: string, locationId?: string) {
    if (isDemoCloudBlocked()) throw new CloudBlockedError()
    // During onboarding the local config has no location yet, so the caller
    // (Setup Wizard) passes the manager-selected location explicitly.
    const loc = locationId || config.locationId
    const res = await fetch(
      `${config.cloudBaseUrl}/api/v1/sync/nodes/?location_id=${loc}`,
      {
        headers: {
          Authorization: `Bearer ${sessionToken}`,
        },
      },
    )
    if (!res.ok) throw new Error(`fetchNodes failed: ${res.status}`)
    return res.json() as Promise<{
      nodes: Array<{
        node_id: string
        node_name: string
        cluster_role: string
        is_online: boolean
        lan_host?: string
        lan_port?: number
      }>
    }>
  },

  async reconnectNode(sessionToken: string, nodeId: string) {
    if (isDemoCloudBlocked()) throw new CloudBlockedError()
    const res = await fetch(`${config.cloudBaseUrl}/api/v1/auth/reconnect-node/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
      body: JSON.stringify({ node_id: nodeId }),
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as any
      throw new Error(data.error || `reconnectNode failed: ${res.status}`)
    }
    return res.json() as Promise<{
      node_id: string
      api_key: string
      node_name: string
      cluster_role: string
      location: { id: string; name: string }
      restaurant_id?: string
      jwt_secret?: string
    }>
  },

  // Fetch the restaurant's staff-token verification material with the node's
  // own Api-Key. Used on boot to back-fill the secret for devices provisioned
  // before this feature, and to pick up a rotated secret.
  async fetchAuthMaterial() {
    const res = await cloudFetch('/api/v1/sync/auth-material/')
    if (!res.ok) throw new Error(`fetchAuthMaterial failed: ${res.status}`)
    return res.json() as Promise<{ restaurant_id: string; jwt_secret: string }>
  },

  // Fetch the full node inventory from Cloud using the node's own Api-Key
  // (no manager session needed) — used by Node Management + leader bootstrap.
  async fetchNodesByApiKey() {
    const res = await cloudFetch(`/api/v1/sync/nodes/?location=${config.locationId}`)
    if (!res.ok) throw new Error(`fetchNodesByApiKey failed: ${res.status}`)
    return res.json() as Promise<{
      nodes: Array<{
        node_id: string
        node_name: string
        cluster_role: string
        is_online: boolean
        lan_host?: string
        lan_port?: number
      }>
    }>
  },

  async fetchPrintRoutes() {
    const res = await cloudFetch(
      `/api/v1/sync/print-routes/?location=${config.locationId}`,
    )
    if (!res.ok) throw new Error(`fetchPrintRoutes failed: ${res.status}`)
    return res.json() as Promise<{
      stations: Array<{ code: string; name: string }>
      print_types: string[]
      routes: Array<{
        station_code: string
        station_name: string
        print_type: string
        assigned_node_id: string | null
        assigned_node_name: string | null
        node_is_online: boolean | null
      }>
    }>
  },

  // Authenticated with the leader's own Api-Key (no manager session needed).
  async savePrintRoutes(
    routes: Array<{ station_code: string; print_type: string; assigned_node_id: string | null }>,
  ) {
    const res = await cloudFetch('/api/v1/sync/print-routes/', {
      method: 'POST',
      body: JSON.stringify({ location_id: config.locationId, routes }),
    })
    if (!res.ok) throw new Error(`savePrintRoutes failed: ${res.status}`)
    return res.json() as Promise<{ saved: number }>
  },

  // ── Menu management (Api-Key authed, scoped to this node's location) ────

  async fetchMenuGlossary() {
    const res = await cloudFetch('/api/v1/menu/glossary/')
    if (!res.ok) throw new Error(`fetchMenuGlossary failed: ${res.status}`)
    return res.json() as Promise<Record<string, unknown>>
  },

  async fetchMenuTree() {
    const res = await cloudFetch('/api/v1/menu/tree/')
    if (!res.ok) throw new Error(`fetchMenuTree failed: ${res.status}`)
    return res.json() as Promise<{ categories: unknown[] }>
  },

  async createMenuCategory(payload: Record<string, unknown>) {
    const res = await cloudFetch('/api/v1/menu/categories/', {
      method: 'POST',
      mutating: true,
      timeoutMs: UPLOAD_TIMEOUT_MS,
      body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error((data as any).error || `createMenuCategory failed: ${res.status}`)
    return data as { id: string; name: string }
  },

  async createMenuItem(payload: Record<string, unknown>) {
    const res = await cloudFetch('/api/v1/menu/items/', {
      method: 'POST',
      mutating: true,
      timeoutMs: UPLOAD_TIMEOUT_MS,
      body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error((data as any).error || `createMenuItem failed: ${res.status}`)
    return data as { id: string; name: string }
  },

  async updateMenuItem(itemId: string, payload: Record<string, unknown>) {
    const res = await cloudFetch(`/api/v1/menu/items/${itemId}/`, {
      method: 'PATCH',
      mutating: true,
      timeoutMs: UPLOAD_TIMEOUT_MS,
      body: JSON.stringify(payload),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error((data as any).error || `updateMenuItem failed: ${res.status}`)
    return data as { id: string; name: string; is_available: boolean }
  },

  async deleteMenuItem(itemId: string) {
    const res = await cloudFetch(`/api/v1/menu/items/${itemId}/`, {
      method: 'DELETE',
      mutating: true,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error((data as any).error || `deleteMenuItem failed: ${res.status}`)
    return data as { deleted: boolean }
  },

  async addMenuItemMedia(itemId: string, image: string) {
    const res = await cloudFetch(`/api/v1/menu/items/${itemId}/media/`, {
      method: 'POST',
      mutating: true,
      timeoutMs: UPLOAD_TIMEOUT_MS,
      body: JSON.stringify({ image }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error((data as any).error || `addMenuItemMedia failed: ${res.status}`)
    return data as { id: string; url: string; is_primary: boolean }
  },

  async deleteMenuMedia(mediaId: string) {
    const res = await cloudFetch(`/api/v1/menu/media/${mediaId}/`, {
      method: 'DELETE',
      mutating: true,
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error((data as any).error || `deleteMenuMedia failed: ${res.status}`)
    return data as { deleted: boolean }
  },

  async fetchTables() {
    const params = new URLSearchParams({ location: config.locationId })
    const res = await cloudFetch(`/api/v1/tables/?${params}`)
    if (!res.ok) throw new Error(`fetchTables failed: ${res.status}`)
    return res.json() as Promise<{
      tables: Array<{
        id: string
        label: string
        location: string
        section?: { code: string; name: string }
      }>
    }>
  },
}
