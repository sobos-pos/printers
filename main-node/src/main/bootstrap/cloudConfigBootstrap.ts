import { nodeConfigRepository } from '../repositories/nodeConfigRepository'

function stripApiKeyPrefix(key: string): string {
  return key.replace(/^sk_live_/, '')
}

export function persistCloudCredentials(opts: {
  locationId: string
  cloudApiKey: string
  nodeId: string
  clusterRole: string
  nodeLabel?: string
  stationCodes?: string[]
  electionPriority?: number
  managerEmail?: string
  managerSessionToken?: string
  cloudBaseUrl?: string
}): void {
  nodeConfigRepository.set('location_id', opts.locationId)
  nodeConfigRepository.set('cloud_api_key', stripApiKeyPrefix(opts.cloudApiKey))
  nodeConfigRepository.set('node_id', opts.nodeId)
  nodeConfigRepository.set('cluster_role', opts.clusterRole)
  if (opts.nodeLabel) nodeConfigRepository.set('node_label', opts.nodeLabel)
  if (opts.stationCodes) {
    nodeConfigRepository.set('assigned_stations', JSON.stringify(opts.stationCodes))
  }
  if (opts.electionPriority != null) {
    nodeConfigRepository.set('election_priority', String(opts.electionPriority))
  }
  if (opts.managerEmail) nodeConfigRepository.set('manager_email', opts.managerEmail)
  if (opts.managerSessionToken) {
    nodeConfigRepository.set('manager_session_token', opts.managerSessionToken)
  }
  if (opts.cloudBaseUrl) nodeConfigRepository.set('cloud_base_url', opts.cloudBaseUrl.replace(/\/$/, ''))
  markNodeProvisioned()
}

export function saveManagerSession(sessionToken: string): void {
  nodeConfigRepository.set('manager_session_token', sessionToken)
}

/** Marks node as actively provisioned (clears decommission lock). */
export function markNodeProvisioned(): void {
  nodeConfigRepository.delete('decommissioned')
  nodeConfigRepository.set('provisioned_at', new Date().toISOString())
}

/**
 * Dev-only: import .env credentials into SQLite on first boot.
 * Skipped after logout/decommission or when ALLOW_ENV_BOOTSTRAP is not true.
 */
export function importEnvConfigIfNeeded(): void {
  if (isNodeDecommissioned()) return
  if (nodeConfigRepository.get('location_id') && nodeConfigRepository.get('cloud_api_key')) return
  if (process.env.ALLOW_ENV_BOOTSTRAP !== 'true') return

  const locationId = process.env.LOCATION_ID?.trim()
  const apiKey = process.env.CLOUD_API_KEY?.trim()
  if (!locationId || !apiKey) return

  persistCloudCredentials({
    locationId,
    cloudApiKey: apiKey,
    nodeId: process.env.NODE_ID?.trim() || `node-${Math.random().toString(36).substring(2, 10)}`,
    clusterRole: process.env.CLUSTER_ROLE?.trim() || 'leader',
    cloudBaseUrl: process.env.CLOUD_BASE_URL?.trim(),
  })
  console.log('[Boot] Dev bootstrap: imported cloud credentials from .env')
}

export function isNodeDecommissioned(): boolean {
  return nodeConfigRepository.get('decommissioned') === '1'
}

export function clearCloudCredentials(): void {
  for (const key of [
    'location_id',
    'cloud_api_key',
    'node_id',
    'cluster_role',
    'node_label',
    'assigned_stations',
    'election_priority',
    'manager_email',
    'manager_session_token',
    'leader_node_id',
    'leader_host',
    'leader_port',
    'leader_status',
    'is_active',
    'cloud_base_url',
    'provisioned_at',
  ]) {
    nodeConfigRepository.delete(key)
  }
}

/** Logout / reset: wipe credentials and block .env re-import until wizard completes again. */
export function decommissionNode(): void {
  clearCloudCredentials()
  nodeConfigRepository.set('decommissioned', '1')
}
