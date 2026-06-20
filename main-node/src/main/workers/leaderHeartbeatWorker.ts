import { config, isCloudConfigured } from '../config'
import { nodeConfigRepository } from '../repositories/nodeConfigRepository'
import { getLanIp } from '../net'

let timer: ReturnType<typeof setInterval> | null = null
let consecutiveFailures = 0

/**
 * Learn the current leader's LAN address from the cloud (single fetch). Used on
 * first boot (when leader_host is unknown) and after repeated LAN failures
 * (covers a manual failover where the leader changed). Reuses the existing
 * cloud heartbeat path, which returns the authoritative leader info, and caches
 * it into node_config so subsequent beats stay LAN-only.
 */
async function refreshLeaderFromCloud(): Promise<{ host: string; port: number } | null> {
  if (!isCloudConfigured()) return null
  try {
    const { cloudClient } = await import('../services/cloudClient')
    const response = (await cloudClient.sendHeartbeat(false)) as any
    if (response && typeof response === 'object') {
      const { role: resolvedRole, leader } = response
      // If the cloud says we are the leader now (e.g. a failover made us leader),
      // hand off to the cluster service so the correct workers start.
      if (resolvedRole === 'leader') {
        const { clusterService } = await import('../services/clusterService')
        clusterService.switchToLeader()
        return null
      }
      if (leader && leader.lan_host) {
        nodeConfigRepository.set('leader_node_id', leader.node_id)
        nodeConfigRepository.set('leader_host', leader.lan_host)
        nodeConfigRepository.set('leader_port', String(leader.lan_port))
        // Seed leader_status from cloud's freshness view so the UI has an
        // initial value before the first LAN heartbeat round-trip completes.
        nodeConfigRepository.set('leader_status', leader.is_online ? 'ONLINE' : 'OFFLINE')
        return { host: leader.lan_host, port: Number(leader.lan_port) || 3001 }
      }
    }
  } catch (err) {
    console.warn('[LeaderHeartbeat] cloud leader refresh failed:', err instanceof Error ? err.message : err)
  }
  return null
}

export const leaderHeartbeatWorker = {
  start(): void {
    this.stop()
    consecutiveFailures = 0

    const tick = async () => {
      try {
        // Only followers heartbeat the leader.
        if (config.clusterRole !== 'follower') return

        let host = nodeConfigRepository.get('leader_host') || ''
        let port = parseInt(nodeConfigRepository.get('leader_port') || '3001', 10)

        // First boot / unknown leader → learn it from the cloud once, then cache.
        if (!host) {
          const learned = await refreshLeaderFromCloud()
          if (!learned) return // either we became leader, or cloud unreachable
          host = learned.host
          port = learned.port
        }

        const body = {
          node_id: config.nodeId,
          node_label: nodeConfigRepository.get('node_label') || '',
          station_codes: config.assignedStations,
          lan_host: getLanIp(),
          lan_port: config.localApiPort,
        }

        const controller = new AbortController()
        // Keep the LAN beat timeout below leaderBeatMs so ticks don't pile up.
        const timeout = setTimeout(() => controller.abort(), 3000)
        try {
          const res = await fetch(`http://${host}:${port}/api/v1/cluster/heartbeat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          })
          clearTimeout(timeout)
          if (!res.ok) throw new Error(`leader heartbeat returned ${res.status}`)
          consecutiveFailures = 0
          // Leader is reachable over LAN — mark it online so the Electron UI
          // reflects the real state. This is the only place that sets this for
          // followers because heartbeatWorker (cloud path) only runs on the leader.
          nodeConfigRepository.set('leader_status', 'ONLINE')
        } catch (err) {
          clearTimeout(timeout)
          consecutiveFailures += 1
          console.warn(
            `[LeaderHeartbeat] beat to ${host}:${port} failed (${consecutiveFailures}): ${
              err instanceof Error ? err.message : err
            }`,
          )
          // After 3 misses, mark leader offline and re-learn its address from
          // the cloud (covers a manual failover where the leader changed).
          if (consecutiveFailures >= 3) {
            nodeConfigRepository.set('leader_status', 'OFFLINE')
            const learned = await refreshLeaderFromCloud()
            if (learned) consecutiveFailures = 0
          }
        }
      } catch (err) {
        console.warn('[LeaderHeartbeat]', err instanceof Error ? err.message : err)
      }
    }

    tick()
    timer = setInterval(tick, config.leaderBeatMs)
    console.log(`[LeaderHeartbeatWorker] Started (${config.leaderBeatMs}ms)`)
  },

  stop(): void {
    if (timer) clearInterval(timer)
    timer = null
  },
}
