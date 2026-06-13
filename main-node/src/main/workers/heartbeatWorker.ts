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
          const { promotion_granted, leader, peers } = response
          
          if (promotion_granted && config.clusterRole === 'follower') {
            console.log('[Heartbeat] Promotion granted by manager! Switching to leader...')
            const { clusterService } = await import('../services/clusterService')
            clusterService.switchToLeader()
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
              clusterNodeRepository.upsert({
                node_id: peer.node_id,
                node_label: peer.node_label,
                station_codes: JSON.stringify(peer.station_codes),
                host: peer.lan_host,
                port: peer.lan_port,
                status: peer.is_online ? 'ONLINE' : 'OFFLINE',
                last_health_check: new Date().toISOString(),
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
