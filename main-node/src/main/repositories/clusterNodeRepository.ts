import { getDb } from '../db/connection'

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
    const status = node.status ?? existing?.status ?? 'ONLINE'
    const electionPriority = node.election_priority ?? existing?.election_priority ?? 10
    const printerInfo = node.printer_info ?? existing?.printer_info ?? null
    const lastHealthCheck = node.last_health_check ?? existing?.last_health_check ?? new Date().toISOString()
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
