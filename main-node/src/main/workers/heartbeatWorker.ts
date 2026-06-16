import { config, isCloudConfigured } from '../config'
import { cloudClient } from '../services/cloudClient'

let timer: ReturnType<typeof setInterval> | null = null

export const heartbeatWorker = {
  start(): void {
    this.stop()
    if (!isCloudConfigured()) return

    const tick = async () => {
      try {
        const isActive = config.clusterRole === 'leader'
        const response = await cloudClient.sendHeartbeat(isActive) as any
        
        if (response && typeof response === 'object') {
          const { role: resolvedRole, leader, peers } = response

          // Cloud is the source of truth for role (single leader per location).
          // Adopt whatever it tells us; this is how a node that lost the lease
          // (or a stale ex-leader) is demoted to follower automatically.
          if (resolvedRole && resolvedRole !== config.clusterRole) {
            const { clusterService } = await import('../services/clusterService')
            if (resolvedRole === 'leader') {
              console.log('[Heartbeat] Cloud assigned leader role — switching to leader')
              clusterService.switchToLeader()
            } else if (leader) {
              console.log('[Heartbeat] Cloud assigned follower role — switching to follower')
              clusterService.switchToFollower(leader.lan_host, leader.lan_port, leader.node_id)
            } else {
              const { nodeConfigRepository } = await import('../repositories/nodeConfigRepository')
              nodeConfigRepository.set('cluster_role', 'follower')
            }
            return
          }

          if (config.clusterRole === 'follower') {
            const { nodeConfigRepository } = await import('../repositories/nodeConfigRepository')
            if (leader) {
              nodeConfigRepository.set('leader_node_id', leader.node_id)
              nodeConfigRepository.set('leader_host', leader.lan_host)
              nodeConfigRepository.set('leader_port', String(leader.lan_port))
              nodeConfigRepository.set('leader_status', leader.is_online ? 'ONLINE' : 'OFFLINE')
            } else {
              nodeConfigRepository.set('leader_status', 'OFFLINE')
            }
          }
          
          if (config.clusterRole === 'leader' && Array.isArray(peers)) {
            const { clusterNodeRepository } = await import('../repositories/clusterNodeRepository')
            for (const peer of peers) {
              // Do NOT set status here. Cloud is_online has a 90s freshness window
              // and will keep saying ONLINE long after the node actually goes down.
              // The local health check loop (15s, 3-strike) owns the status field.
              // We only update metadata so the health check can reach the right address.
              clusterNodeRepository.upsert({
                node_id: peer.node_id,
                node_label: peer.node_label,
                station_codes: JSON.stringify(peer.station_codes ?? []),
                host: peer.lan_host,
                port: peer.lan_port,
              })
            }
          }
        }
      } catch (err) {
        console.warn('[Heartbeat]', err instanceof Error ? err.message : err)
      }
    }

    tick()
    timer = setInterval(tick, config.heartbeatMs)
    console.log(`[HeartbeatWorker] Started (${config.heartbeatMs}ms)`)
  },

  stop(): void {
    if (timer) clearInterval(timer)
    timer = null
  },
}
