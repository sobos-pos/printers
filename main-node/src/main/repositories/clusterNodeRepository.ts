import { getDb } from '../db/connection'
import { config } from '../config'

// Sentinel for "the leader has never had contact with this node". Used instead
// of now() so a node we only learned about via the cloud peer list (metadata,
// no actual contact) does NOT look freshly online.
export const NEVER_CONTACTED = '1970-01-01T00:00:00.000Z'

/**
 * Pure freshness check: is a contact timestamp within `ttlMs` of `now`?
 * Returns false for the NEVER_CONTACTED sentinel and any unparseable value.
 * Extracted so the liveness rule can be unit-tested without a database.
 */
export function isContactFresh(lastHealthCheck: string, ttlMs: number, now: number = Date.now()): boolean {
  const ts = Date.parse(lastHealthCheck)
  if (!Number.isFinite(ts)) return false
  return now - ts <= ttlMs
}

export interface ClusterNode {
  node_id: string
  node_label: string
  station_codes: string // JSON string
  host: string
  port: number
  status: 'ONLINE' | 'OFFLINE'
  election_priority: number
  printer_info?: string // JSON string
  last_health_check: string
  registered_at: string
}

export const clusterNodeRepository = {
  get(nodeId: string): ClusterNode | null {
    const row = getDb().prepare('SELECT * FROM cluster_nodes WHERE node_id = ?').get(nodeId) as ClusterNode | undefined
    return row ?? null
  },

  upsert(node: Partial<ClusterNode> & { node_id: string; host: string }): void {
    const existing = this.get(node.node_id)
    const label = node.node_label ?? existing?.node_label ?? ''
    const stationCodes = node.station_codes ?? existing?.station_codes ?? '[]'
    const port = node.port ?? existing?.port ?? 3001
    // Default OFFLINE, never ONLINE: a node we merely learned about (e.g. from
    // the cloud peer list) is not known to be reachable. ONLINE is only ever set
    // by positive evidence — an inbound LAN heartbeat or a successful health check.
    const status = node.status ?? existing?.status ?? 'OFFLINE'
    const electionPriority = node.election_priority ?? existing?.election_priority ?? 10
    const printerInfo = node.printer_info ?? existing?.printer_info ?? null
    // Preserve a real prior contact time, but a brand-new metadata-only row gets
    // the NEVER_CONTACTED sentinel (not now()) so it reads as OFFLINE until contact.
    const lastHealthCheck = node.last_health_check ?? existing?.last_health_check ?? NEVER_CONTACTED
    const registeredAt = existing?.registered_at ?? new Date().toISOString()

    getDb()
      .prepare(
        `INSERT INTO cluster_nodes (
          node_id, node_label, station_codes, host, port, status,
          election_priority, printer_info, last_health_check, registered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(node_id) DO UPDATE SET
          node_label = excluded.node_label,
          station_codes = excluded.station_codes,
          host = excluded.host,
          port = excluded.port,
          status = excluded.status,
          election_priority = excluded.election_priority,
          printer_info = excluded.printer_info,
          last_health_check = excluded.last_health_check`
      )
      .run(
        node.node_id,
        label,
        stationCodes,
        node.host,
        port,
        status,
        electionPriority,
        printerInfo,
        lastHealthCheck,
        registeredAt
      )
  },

  listAll(): ClusterNode[] {
    return getDb().prepare('SELECT * FROM cluster_nodes').all() as ClusterNode[]
  },

  /**
   * Single source of truth for follower liveness: ONLINE iff the leader had a
   * successful contact (inbound heartbeat or outbound health check) within the
   * TTL. Freshness-based rather than a sticky flag, so a node that goes away is
   * shown OFFLINE automatically once contact ages out — no stale ONLINE.
   */
  isOnline(node: Pick<ClusterNode, 'last_health_check'>): boolean {
    return isContactFresh(node.last_health_check, config.clusterNodeOnlineTtlMs)
  },

  updateStatus(nodeId: string, status: 'ONLINE' | 'OFFLINE'): void {
    getDb()
      .prepare('UPDATE cluster_nodes SET status = ?, last_health_check = ? WHERE node_id = ?')
      .run(status, new Date().toISOString(), nodeId)
  },

  delete(nodeId: string): void {
    getDb().prepare('DELETE FROM cluster_nodes WHERE node_id = ?').run(nodeId)
  },

  clearAll(): void {
    getDb().prepare('DELETE FROM cluster_nodes').run()
  }
}
