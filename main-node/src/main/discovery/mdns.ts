import Bonjour from 'bonjour-service'
import { config } from '../config'

let bonjour: Bonjour | null = null
let service: ReturnType<Bonjour['publish']> | null = null

export const mdnsService = {
  advertise(): void {
    this.stop()
    bonjour = new Bonjour()
    service = bonjour.publish({
      name: `Soboss POS - ${config.nodeId}`,
      type: 'soboss',
      port: config.localApiPort,
      txt: {
        node_id: config.nodeId,
        location_id: config.locationId,
        cluster_role: config.clusterRole,
        station_codes: JSON.stringify(config.assignedStations),
      },
    })
    service.on('error', (err) => {
      console.warn('[mDNS] Advertisement error or name conflict:', err.message)
    })
    console.log(`[mDNS] Advertised _soboss._tcp on port ${config.localApiPort}`)
  },

  stop(): void {
    service?.stop()
    service = null
    bonjour?.destroy()
    bonjour = null
  },
}
