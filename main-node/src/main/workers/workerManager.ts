import { config } from '../config'
import { startApiServer, stopApiServer } from '../api/server'
import { pollWorker } from './pollWorker'
import { printWorker } from './printWorker'
import { heartbeatWorker } from './heartbeatWorker'
import { mdnsService } from '../discovery/mdns'
import { clusterService } from '../services/clusterService'

export type WorkerRole = 'leader' | 'follower'

export const workerManager = {
  startWorkers(role: WorkerRole): void {
    this.stopAllWorkers()

    heartbeatWorker.start()
    clusterService.start()

    if (role === 'leader') {
      pollWorker.start()
      printWorker.start()
      startApiServer().catch(console.error)
      mdnsService.advertise()
    }

    if (role === 'follower') {
      printWorker.start()
      startApiServer().catch(console.error)
      mdnsService.stop()
    }
  },

  stopAllWorkers(): void {
    pollWorker.stop()
    printWorker.stop()
    heartbeatWorker.stop()
    clusterService.stop()
    stopApiServer().catch(() => {})
    mdnsService.stop()
  },

  bootFromState(): void {
    const role = config.clusterRole
    this.startWorkers(role)
  },
}
