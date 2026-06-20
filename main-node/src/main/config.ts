import dotenv from 'dotenv'
import { resolve } from 'path'
import { nodeConfigRepository } from './repositories/nodeConfigRepository'

dotenv.config({ quiet: true })

const dbPathVal = resolve(process.cwd(), process.env.DB_PATH || './data/node.sqlite')

export const config = {
  get nodeId() { return nodeConfigRepository.get('node_id') || 'node-A' },
  get locationId() { return nodeConfigRepository.get('location_id') || '' },
  get cloudApiKey() { return nodeConfigRepository.get('cloud_api_key') || '' },
  // Device auth material (Layer 1) — used to verify staff JWTs offline (Layer 2).
  get restaurantId() { return nodeConfigRepository.get('restaurant_id') || '' },
  get jwtSecret() { return nodeConfigRepository.get('jwt_secret') || '' },
  get cloudBaseUrl() { return (process.env.CLOUD_BASE_URL || nodeConfigRepository.get('cloud_base_url') || 'http://localhost:8000').replace(/\/$/, '') },

  get localApiHost() { return nodeConfigRepository.get('local_api_host') || '0.0.0.0' },
  get localApiPort() { return parseInt(nodeConfigRepository.get('local_api_port') || '3001', 10) },
  get haPort() { return parseInt(nodeConfigRepository.get('ha_port') || '3002', 10) },

  get pollIntervalMs() { return parseInt(nodeConfigRepository.get('poll_interval_ms') || '7000', 10) },
  get heartbeatMs() { return parseInt(nodeConfigRepository.get('heartbeat_interval_ms') || '30000', 10) },

  // ─── LAN cluster liveness ────────────────────────────────────────────────
  // A follower is ONLINE iff the leader had a successful contact within
  // clusterNodeOnlineTtlMs. Two independent signals refresh that contact at
  // leaderBeatMs / clusterHealthCheckMs, so the TTL tolerates ~2 missed beats
  // before a node is shown OFFLINE. Keep TTL > 2× the faster of the two beats
  // to avoid flapping on a single dropped LAN packet.
  get leaderBeatMs() { return parseInt(nodeConfigRepository.get('leader_beat_ms') || '5000', 10) },
  get clusterHealthCheckMs() { return parseInt(nodeConfigRepository.get('cluster_health_check_ms') || '5000', 10) },
  get clusterNodeOnlineTtlMs() { return parseInt(nodeConfigRepository.get('cluster_node_online_ttl_ms') || '15000', 10) },
  get clusterReportMs() { return parseInt(nodeConfigRepository.get('cluster_report_ms') || '5000', 10) },
  get printRetryBaseMs() { return parseInt(nodeConfigRepository.get('print_retry_base_ms') || '5000', 10) },
  get printRetryMaxAttempts() { return parseInt(nodeConfigRepository.get('print_retry_max_attempts') || '20', 10) },

  get haMode() { return (nodeConfigRepository.get('ha_mode') || 'standalone') as 'standalone' | 'ha' },
  get printerDriver() { return (nodeConfigRepository.get('printer_driver') || 'simulated') as 'simulated' | 'escpos' },
  get printerName() { return nodeConfigRepository.get('printer_name') || '' },
  get paperWidth() { return (nodeConfigRepository.get('paper_width') || '58mm') as '58mm' | '80mm' },

  dbPath: dbPathVal,
  kotLogPath: resolve(process.cwd(), 'data/kot-log.txt'),
  dataDir: resolve(dbPathVal, '..'),
  get bootstrapTableUuid() { return process.env.BOOTSTRAP_TABLE_UUID || nodeConfigRepository.get('bootstrap_table_uuid') || '' },

  get clusterRole() { return (nodeConfigRepository.get('cluster_role') || 'follower') as 'leader' | 'follower' },
  get assignedStations() {
    try {
      return JSON.parse(nodeConfigRepository.get('assigned_stations') || '["KITCHEN"]') as string[]
    } catch {
      return ['KITCHEN']
    }
  }
}

export function reloadEnv(): void {
  dotenv.config({ override: true, quiet: true })
}

/** Read at call time — use reloadEnv() after editing .env from Settings UI. */
export function isDemoPrinterOffline(): boolean {
  return process.env.DEMO_PRINTER_OFFLINE === 'true'
}

export function isDemoCloudBlocked(): boolean {
  return process.env.DEMO_CLOUD_BLOCKED === 'true'
}

export function isCloudConfigured(): boolean {
  return Boolean(config.locationId && config.cloudApiKey)
}

export function assertCloudConfigured(): void {
  if (!isCloudConfigured()) {
    throw new Error('LOCATION_ID and CLOUD_API_KEY must be configured (Provision Node)')
  }
}

export class CloudBlockedError extends Error {
  constructor() {
    super('Cloud link blocked (DEMO_CLOUD_BLOCKED=true)')
    this.name = 'CloudBlockedError'
  }
}

export class NotActiveHolderError extends Error {
  constructor() {
    super('Not the active lease holder (409)')
    this.name = 'NotActiveHolderError'
  }
}
