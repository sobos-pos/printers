import { getDb } from '../db/connection'

export interface PrintRoute {
  location_id: string
  station_code: string
  print_type: string
  assigned_node_id: string | null
}

export const printRouteRepository = {
  getAll(locationId: string): PrintRoute[] {
    return getDb()
      .prepare('SELECT * FROM print_route_nodes WHERE location_id = ?')
      .all(locationId) as PrintRoute[]
  },

  getByStationAndType(locationId: string, stationCode: string, printType: string): PrintRoute | null {
    const row = getDb()
      .prepare('SELECT * FROM print_route_nodes WHERE location_id = ? AND station_code = ? AND print_type = ?')
      .get(locationId, stationCode, printType) as PrintRoute | undefined
    return row ?? null
  },

  upsertAll(locationId: string, routes: Array<{ station_code: string; print_type: string; assigned_node_id: string | null }>): void {
    this.replaceAll(locationId, routes)
  },

  /** Replace the full route set for a location (drops stale rows removed on cloud). */
  replaceAll(locationId: string, routes: Array<{ station_code: string; print_type: string; assigned_node_id: string | null }>): void {
    const insert = getDb().prepare(
      `INSERT INTO print_route_nodes (location_id, station_code, print_type, assigned_node_id)
       VALUES (?, ?, ?, ?)`,
    )
    const run = getDb().transaction(() => {
      getDb().prepare('DELETE FROM print_route_nodes WHERE location_id = ?').run(locationId)
      for (const r of routes) {
        insert.run(locationId, r.station_code, r.print_type, r.assigned_node_id ?? null)
      }
    })
    run()
  },
}
