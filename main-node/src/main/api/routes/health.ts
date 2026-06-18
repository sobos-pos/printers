import type { FastifyInstance } from 'fastify'
import { config } from '../../config'
import { printJobRepository } from '../../repositories/printJobRepository'
import { printerRepository } from '../../repositories/printerRepository'
import { resolvePrinterDriver } from '../../services/printerDriver'

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health/', async () => {
    const enabledPrinters = printerRepository.getAllPrinters().filter((p) => p.enabled)
    const realPrinter = enabledPrinters.find((p) => p.connection !== 'simulated')

    let printerOnline = false
    if (realPrinter) {
      const driver = resolvePrinterDriver(realPrinter)
      printerOnline = await driver.isAvailable({ printer: realPrinter, paperWidth: config.paperWidth })
    }

    return {
      ok: true,
      node_id: config.nodeId,
      cluster_role: config.clusterRole,
      uptime_seconds: Math.floor(process.uptime()),
      printer_online: printerOnline,
      pending_print_jobs: printJobRepository.getDueJobs().length,
    }
  })
}
