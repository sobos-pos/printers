import { config } from '../config'
import { clusterNodeRepository } from '../repositories/clusterNodeRepository'
import { nodeConfigRepository } from '../repositories/nodeConfigRepository'
import { workerManager } from '../workers/workerManager'

let healthCheckInterval: NodeJS.Timeout | null = null

// LAN probes must finish well within the check interval so runs don't overlap;
// on a healthy LAN a node that can't answer in 3s is effectively unreachable.
const LAN_PROBE_TIMEOUT_MS = 3000

export const clusterService = {
  start(): void {
    this.stop()
    if (config.clusterRole === 'leader') {
      console.log('[Cluster] Starting health check loop for followers...')
      healthCheckInterval = setInterval(() => {
        this.runFollowerHealthChecks().catch(console.error)
      }, config.clusterHealthCheckMs)
    }
  },

  stop(): void {
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval)
      healthCheckInterval = null
    }
  },

  /**
   * Cross-check follower liveness. This is a positive-evidence probe: a
   * successful, IDENTITY-VERIFIED /health/ refreshes the node's contact time
   * (→ ONLINE via the freshness model). A failure does nothing — the node simply
   * ages out to OFFLINE once no signal (this probe OR the follower's inbound
   * heartbeat) has arrived within the TTL. No sticky flag, no 3-strike counter.
   *
   * Identity matters: /health/ returns the responder's node_id. A stale or
   * DHCP-reused LAN IP — or this machine's own IP, which several test nodes may
   * share — can answer 200 as a DIFFERENT node. Marking the expected node online
   * off that is exactly the "node I never started shows online" bug. So we only
   * accept the probe when the responder's node_id matches the node we probed.
   */
  async runFollowerHealthChecks(): Promise<void> {
    const followers = clusterNodeRepository.listAll().filter((n) => n.node_id !== config.nodeId)
    await Promise.all(
      followers.map(async (node) => {
        if (!node.host) return
        const url = `http://${node.host}:${node.port}/health/`
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), LAN_PROBE_TIMEOUT_MS)
        try {
          const res = await fetch(url, { signal: controller.signal })
          if (!res.ok) throw new Error(`health check returned ${res.status}`)
          const body = (await res.json().catch(() => null)) as { node_id?: string } | null
          if (!body || body.node_id !== node.node_id) {
            // Someone else (or ourselves) answers at that address — not proof the
            // expected node is up. Ignore so we don't falsely mark it online.
            if (clusterNodeRepository.isOnline(node)) {
              console.warn(
                `[Cluster] ${node.node_id} probe at ${node.host}:${node.port} answered as ` +
                  `${body?.node_id ?? 'unknown'} — stale/shared address, not marking online`,
              )
            }
            return
          }
          const wasOnline = clusterNodeRepository.isOnline(node)
          clusterNodeRepository.updateStatus(node.node_id, 'ONLINE') // refreshes contact time
          if (!wasOnline) console.log(`[Cluster] Follower ${node.node_id} is ONLINE`)
        } catch {
          // No-op: let the contact time age out. We don't log every miss to
          // avoid noise; the node flips OFFLINE automatically past the TTL.
        } finally {
          clearTimeout(timer)
        }
      }),
    )
  },

  async forwardPrintJob(nodeId: string, payload: any): Promise<boolean> {
    if (nodeId === config.nodeId) {
      console.warn(`[Cluster] Refusing to forward print job to self (${nodeId})`)
      return false
    }

    const node = clusterNodeRepository.get(nodeId)
    if (!node || !clusterNodeRepository.isOnline(node)) {
      console.warn(`[Cluster] Cannot forward print job to ${nodeId} — node is not registered or offline`)
      return false
    }

    const url = `http://${node.host}:${node.port}/api/v1/cluster/print-job`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000) // 8s timeout

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (res.ok) {
        const data = await res.json() as { status: string }
        return data.status === 'QUEUED'
      }
      return false
    } catch (err: any) {
      clearTimeout(timer)
      console.error(`[Cluster] Failed to forward print job to ${nodeId} at ${node.host}: ${err.message}`)
      return false
    }
  },

  switchToLeader(): void {
    console.warn('[Cluster] Switching role to LEADER...')
    nodeConfigRepository.set('cluster_role', 'leader')
    nodeConfigRepository.set('is_active', '1')
    nodeConfigRepository.delete('leader_node_id')
    nodeConfigRepository.delete('leader_host')
    nodeConfigRepository.delete('leader_port')

    this.stop()
    workerManager.startWorkers('leader')
    this.start()
  },

  switchToFollower(leaderHost: string, leaderPort: number, leaderNodeId: string): void {
    console.warn(`[Cluster] Switching role to FOLLOWER (Leader: ${leaderNodeId} @ ${leaderHost}:${leaderPort})...`)
    nodeConfigRepository.set('cluster_role', 'follower')
    nodeConfigRepository.set('is_active', '0')
    nodeConfigRepository.set('leader_node_id', leaderNodeId)
    nodeConfigRepository.set('leader_host', leaderHost)
    nodeConfigRepository.set('leader_port', String(leaderPort))
    // Reset to OFFLINE — the leaderHeartbeatWorker will flip it to ONLINE after
    // the first successful LAN beat. This avoids showing stale ONLINE if we just
    // demoted from leader where we knew ourselves to be online.
    nodeConfigRepository.set('leader_status', 'OFFLINE')

    this.stop()
    workerManager.startWorkers('follower')
  }
}
