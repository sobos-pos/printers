import { config } from '../config'
import { printRouteRepository } from '../repositories/printRouteRepository'
import { cloudClient } from './cloudClient'

/** Pull cluster print-route assignments from cloud and replace local cache. */
export async function syncPrintRoutesFromCloud(): Promise<number> {
  const { routes } = await cloudClient.fetchPrintRoutes()
  printRouteRepository.replaceAll(
    config.locationId,
    routes.map((r) => ({
      station_code: r.station_code,
      print_type: r.print_type,
      assigned_node_id: r.assigned_node_id,
    })),
  )
  console.log(`[PrintRoutes] Synced ${routes.length} cluster route(s) from cloud`)
  return routes.length
}
