import { config, isCloudConfigured } from '../config'
import { cloudClient } from '../services/cloudClient'
import { clusterNodeRepository } from '../repositories/clusterNodeRepository'
import { nodeConfigRepository } from '../repositories/nodeConfigRepository'
import { getLanIp } from '../net'

const REPORT_INTERVAL_MS = 15000

let timer: ReturnType<typeof setInterval> | null = null

export const clusterReportWorker = {
  start(): void {
    this.stop()
    if (!isCloudConfigured()) return

    const tick = async () => {
      try {
        if (config.clusterRole !== 'leader') return

        const now = new Date().toISOString()

        // The leader's own row (followers + self) — followers come from
        // cluster_nodes (kept fresh by /cluster/heartbeat + health checks).
        const nodes = clusterNodeRepository
          .listAll()
          .filter((n) => n.node_id !== config.nodeId)
          .map((n) => ({
            node_id: n.node_id,
            node_label: n.node_label,
            cluster_role: 'follower',
            lan_host: n.host,
            lan_port: n.port,
            status: n.status,
            last_seen: n.last_health_check,
          }))

        nodes.push({
          node_id: config.nodeId,
          node_label: nodeConfigRepository.get('node_label') || '',
          cluster_role: 'leader',
          lan_host: getLanIp(),
          lan_port: config.localApiPort,
          status: 'ONLINE',
          last_seen: now,
        })

        const result = await cloudClient.reportClusterState({
          leader_id: config.nodeId,
          nodes,
        })
        void result
      } catch (err) {
        console.warn('[ClusterReport]', err instanceof Error ? err.message : err)
      }
    }

    tick()
    timer = setInterval(tick, REPORT_INTERVAL_MS)
    console.log(`[ClusterReportWorker] Started (${REPORT_INTERVAL_MS}ms)`)
  },

  stop(): void {
    if (timer) clearInterval(timer)
    timer = null
  },
}
