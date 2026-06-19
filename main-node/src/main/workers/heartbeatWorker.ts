import { config, isCloudConfigured } from '../config'
import { cloudClient } from '../services/cloudClient'

let timer: ReturnType<typeof setInterval> | null = null
let inFlight = false

/**
 * One heartbeat round-trip: report liveness, then adopt the cloud-resolved role.
 * The cloud is the single source of truth for who is leader (lease ownership),
 * so this is where a node that won or lost the lease transitions roles.
 *
 * Guarded by `inFlight` so an out-of-band `runNow()` (e.g. triggered by a 409
 * fence) can't overlap the scheduled tick and double-apply a role switch.
 */
async function runTick(): Promise<void> {
  if (!isCloudConfigured() || inFlight) return
  inFlight = true
  try {
    const isActive = config.clusterRole === 'leader'
    const response = (await cloudClient.sendHeartbeat(isActive)) as any

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
          // Demoted to follower but the cloud doesn't know the leader yet.
          // Still do a full follower transition so we stop running leader-only
          // workers (pollWorker / clusterReportWorker) — otherwise a demoted
          // node keeps double-polling cloud orders. leaderHeartbeatWorker will
          // learn the leader's LAN address from the cloud on its next tick.
          console.log('[Heartbeat] Cloud assigned follower role (no leader known yet) — switching to follower')
          clusterService.switchToFollower('', 0, '')
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
  } finally {
    inFlight = false
  }
}

export const heartbeatWorker = {
  start(): void {
    this.stop()
    if (!isCloudConfigured()) return

    runTick()
    timer = setInterval(runTick, config.heartbeatMs)
    console.log(`[HeartbeatWorker] Started (${config.heartbeatMs}ms)`)
  },

  /**
   * Force an immediate heartbeat outside the normal interval. Used when a
   * mutating sync call is fenced with 409 (we may have lost the lease): rather
   * than guessing, we let the authoritative heartbeat re-resolve the role — it
   * re-claims if we're still the holder, or demotes us if we genuinely lost it.
   */
  async runNow(): Promise<void> {
    await runTick()
  },

  stop(): void {
    if (timer) clearInterval(timer)
    timer = null
  },
}
