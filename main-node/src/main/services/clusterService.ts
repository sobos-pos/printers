import { config } from '../config'
import { clusterNodeRepository } from '../repositories/clusterNodeRepository'
import { nodeConfigRepository } from '../repositories/nodeConfigRepository'
import { workerManager } from '../workers/workerManager'

let healthCheckInterval: NodeJS.Timeout | null = null
const consecutiveFailures = new Map<string, number>()

export const clusterService = {
  start(): void {
    this.stop()
    if (config.clusterRole === 'leader') {
      console.log('[Cluster] Starting health check loop for followers...')
      healthCheckInterval = setInterval(() => {
        this.runFollowerHealthChecks().catch(console.error)
      }, 15000) // every 15 seconds
    }
  },

  stop(): void {
    if (healthCheckInterval) {
      clearInterval(healthCheckInterval)
      healthCheckInterval = null
    }
  },

  async runFollowerHealthChecks(): Promise<void> {
    const followers = clusterNodeRepository.listAll()
    for (const node of followers) {
      const url = `http://${node.host}:${node.port}/health/`
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000) // 5s timeout

      try {
        const res = await fetch(url, { signal: controller.signal })
        clearTimeout(timer)
        if (res.ok) {
          consecutiveFailures.set(node.node_id, 0)
          if (node.status !== 'ONLINE') {
            console.log(`[Cluster] Follower ${node.node_id} is back ONLINE`)
            clusterNodeRepository.updateStatus(node.node_id, 'ONLINE')
          }
        } else {
          throw new Error(`Health check returned status ${res.status}`)
        }
      } catch (err: any) {
        clearTimeout(timer)
        const fails = (consecutiveFailures.get(node.node_id) || 0) + 1
        consecutiveFailures.set(node.node_id, fails)
        console.warn(`[Cluster] Follower ${node.node_id} health check failed (${fails}/3): ${err.message}`)
        if (fails >= 3 && node.status !== 'OFFLINE') {
          console.error(`[Cluster] Follower ${node.node_id} marked OFFLINE`)
          clusterNodeRepository.updateStatus(node.node_id, 'OFFLINE')
        }
      }
    }
  },

  async forwardPrintJob(nodeId: string, payload: any): Promise<boolean> {
    const node = clusterNodeRepository.get(nodeId)
    if (!node || node.status !== 'ONLINE') {
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

    this.stop()
    workerManager.startWorkers('follower')
  }
}
