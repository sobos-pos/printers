import { config } from '../config'
import { startApiServer, stopApiServer } from '../api/server'
import { pollWorker } from './pollWorker'
import { printWorker } from './printWorker'
import { heartbeatWorker } from './heartbeatWorker'
import { leaderHeartbeatWorker } from './leaderHeartbeatWorker'
import { clusterReportWorker } from './clusterReportWorker'
import { mdnsService } from '../discovery/mdns'
import { clusterService } from '../services/clusterService'

export type WorkerRole = 'leader' | 'follower'

export const workerManager = {
  startWorkers(role: WorkerRole): void {
    this.stopAllWorkers()

    // Leader health-check loop is started for the leader inside clusterService.
    clusterService.start()

    if (role === 'leader') {
      // Leader keeps its OWN cloud heartbeat (lease renewal + liveness) and
      // pushes a consolidated cluster snapshot to the cloud.
      heartbeatWorker.start()
      clusterReportWorker.start()
      pollWorker.start()
      printWorker.start()
      startApiServer().catch(console.error)
      mdnsService.advertise()
    }

    if (role === 'follower') {
      // Followers no longer heartbeat the cloud — they heartbeat the leader
      // over the LAN instead.
      leaderHeartbeatWorker.start()
      printWorker.start()
      startApiServer().catch(console.error)
      mdnsService.stop()
    }
  },

  stopAllWorkers(): void {
    pollWorker.stop()
    printWorker.stop()
    heartbeatWorker.stop()
    leaderHeartbeatWorker.stop()
    clusterReportWorker.stop()
    clusterService.stop()
    stopApiServer().catch(() => {})
    mdnsService.stop()
  },

  bootFromState(): void {
    const role = config.clusterRole
    this.startWorkers(role)
  },
}
