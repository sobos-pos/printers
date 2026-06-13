import { getDb } from '../db/connection'
import type { PrintRouteRow, PrinterRow } from '../types'

export const printerRepository = {
  getPrinter(id: string): PrinterRow | null {
    return (
      (getDb().prepare('SELECT * FROM printers WHERE id = ?').get(id) as PrinterRow | undefined) ??
      null
    )
  },

  getRoute(station: string, jobType: string): PrintRouteRow | null {
    return (
      (getDb()
        .prepare('SELECT * FROM print_routes WHERE station = ? AND job_type = ?')
        .get(station, jobType) as PrintRouteRow | undefined) ?? null
    )
  },

  getAllPrinters(): PrinterRow[] {
    return getDb().prepare('SELECT * FROM printers ORDER BY name').all() as PrinterRow[]
  },

  getAllRoutes(): PrintRouteRow[] {
    return getDb().prepare('SELECT * FROM print_routes ORDER BY station, job_type').all() as PrintRouteRow[]
  },

  upsertPrinter(printer: PrinterRow): void {
    getDb()
      .prepare(
        `INSERT INTO printers (id, name, connection, driver, enabled) VALUES (@id, @name, @connection, @driver, @enabled)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, connection=excluded.connection, driver=excluded.driver, enabled=excluded.enabled`,
      )
      .run(printer)
  },

  upsertRoute(route: PrintRouteRow): void {
    getDb()
      .prepare(
        `INSERT INTO print_routes (station, job_type, printer_id, fallback_printer_id) VALUES (@station, @job_type, @printer_id, @fallback_printer_id)
         ON CONFLICT(station, job_type) DO UPDATE SET printer_id=excluded.printer_id, fallback_printer_id=excluded.fallback_printer_id`,
      )
      .run(route)
  },

  clearAll(): void {
    const db = getDb()
    db.exec('DELETE FROM print_routes')
    db.exec('DELETE FROM printers')
  },
}
