import { printerRepository } from '../repositories/printerRepository'
import { cloudClient } from './cloudClient'

export const nodeConfigService = {
  serializeConfig(): Record<string, unknown> {
    return {
      printers: printerRepository.getAllPrinters(),
      print_routes: printerRepository.getAllRoutes(),
    }
  },

  async backupConfig(): Promise<void> {
    const blob = this.serializeConfig()
    await cloudClient.saveNodeConfig(blob)
    console.log('[Config] Backed up to Cloud')
  },

  restoreFromBlob(blob: Record<string, unknown>): void {
    printerRepository.clearAll()
    for (const p of (blob.printers as Array<Record<string, unknown>>) ?? []) {
      printerRepository.upsertPrinter({
        id: String(p.id),
        name: String(p.name),
        connection: String(p.connection),
        driver: String(p.driver),
        enabled: Number(p.enabled ?? 1),
      })
    }
    for (const r of (blob.print_routes as Array<Record<string, unknown>>) ?? []) {
      printerRepository.upsertRoute({
        station: String(r.station),
        job_type: String(r.job_type),
        printer_id: String(r.printer_id),
        fallback_printer_id: r.fallback_printer_id ? String(r.fallback_printer_id) : null,
      })
    }
  },

  async restoreConfig(): Promise<boolean> {
    try {
      const blob = await cloudClient.getNodeConfig()
      if (!blob) return false
      this.restoreFromBlob(blob)
      console.log('[Config] Restored from Cloud')
      return true
    } catch {
      return false
    }
  },
}
