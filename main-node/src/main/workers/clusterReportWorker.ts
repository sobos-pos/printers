import { config, isCloudConfigured } from '../config'
import { cloudClient } from '../services/cloudClient'
import { clusterNodeRepository } from '../repositories/clusterNodeRepository'
import { nodeConfigRepository } from '../repositories/nodeConfigRepository'
import { getLanIp } from '../net'

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
            // Derive from contact freshness so the cloud mirror matches the
            // leader's live view — never the stale stored flag.
            status: clusterNodeRepository.isOnline(n) ? 'ONLINE' : 'OFFLINE',
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
        const msg = err instanceof Error ? err.message : String(err)
        // 409 = the cloud lease is held by another node, so we're not the
        // authoritative leader (yet). Expected briefly at boot before the cloud
        // heartbeat reconciles our role — not an error, so don't alarm.
        if (msg.includes('409')) {
          console.log('[ClusterReport] Skipped — not the active leader yet (lease held elsewhere)')
          return
        }
        console.warn('[ClusterReport]', msg)
      }
    }

    tick()
    timer = setInterval(tick, config.clusterReportMs)
    console.log(`[ClusterReportWorker] Started (${config.clusterReportMs}ms)`)
  },

  stop(): void {
    if (timer) clearInterval(timer)
    timer = null
  },
}
