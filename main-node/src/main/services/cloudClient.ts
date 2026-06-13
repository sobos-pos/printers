import { v4 as uuidv4 } from 'uuid'
import {
  CloudBlockedError,
  NotActiveHolderError,
  config,
  isCloudConfigured,
  isDemoCloudBlocked,
} from '../config'
import { haService } from './nodeConfigService'

const TIMEOUT_MS = 5000

async function cloudFetch(
  path: string,
  options: RequestInit & { mutating?: boolean } = {},
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
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(`${config.cloudBaseUrl}${path}`, {
      ...options,
      headers,
      signal: controller.signal,
    })

    if (res.status === 409 && options.mutating) {
      haService.demoteToStandby()
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
    const os = await import('os')
    const getLocalIp = () => {
      const nets = os.networkInterfaces()
      for (const name of Object.keys(nets)) {
        for (const net of nets[name] || []) {
          if (net.family === 'IPv4' && !net.internal) {
            return net.address
          }
        }
      }
      return '127.0.0.1'
    }

    const { nodeConfigRepository } = await import('../repositories/nodeConfigRepository')
    const nodeLabel = nodeConfigRepository.get('node_label') || ''
    const priorityStr = nodeConfigRepository.get('election_priority') || '10'
    const stationCodesStr = nodeConfigRepository.get('assigned_stations') || '["KITCHEN"]'
    let stationCodes = ['KITCHEN']
    try {
      stationCodes = JSON.parse(stationCodesStr)
    } catch {}

    const res = await cloudFetch('/api/v1/sync/heartbeat/', {
      method: 'POST',
      body: JSON.stringify({
        location: config.locationId,
        node_id: config.nodeId,
        node_time: new Date().toISOString(),
        is_active: isActive,
        cluster_role: config.clusterRole,
        node_label: nodeLabel,
        station_codes: stationCodes,
        election_priority: parseInt(priorityStr, 10),
        lan_host: getLocalIp(),
        lan_port: config.localApiPort,
      }),
    })
    if (!res.ok) throw new Error(`heartbeat failed: ${res.status}`)
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
}
