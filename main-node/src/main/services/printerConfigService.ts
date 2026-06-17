import { createHash } from 'crypto'
import { config } from '../config'
import { nodeConfigRepository } from '../repositories/nodeConfigRepository'
import { printerRepository } from '../repositories/printerRepository'
import { cloudClient } from './cloudClient'
import { listOsPrintersAsync } from './printerDiscovery'
import { nodeConfigService } from './nodeConfigService'

export interface NodePrinterAssignment {
  station_code: string
  station_name: string
  print_type: string
  scope: 'assigned' | 'leader_fallback'
  printer_id: string | null
  printer_name: string | null
}

function printerIdForName(name: string): string {
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 12)
  return `prn-${hash}`
}

function isRouteForThisNode(
  assignedNodeId: string | null,
  nodeId: string,
  clusterRole: string,
): boolean {
  // A node maps printers for stations routed to it. The leader is additionally
  // the universal fallback — it may have to print ANY station when the assigned
  // follower is offline (or a station is unassigned) — so it gets a mapping slot
  // for every route, letting a multi-printer leader pick the right printer per
  // station/type instead of dumping every fallback onto one printer.
  if (assignedNodeId === nodeId) return true
  return clusterRole === 'leader'
}

export const printerConfigService = {
  async getAssignments(): Promise<{
    assignments: NodePrinterAssignment[]
    os_printers: Array<{ name: string; isDefault: boolean }>
  }> {
    const [{ routes }, localRoutes, osPrinters] = await Promise.all([
      cloudClient.fetchPrintRoutes(),
      Promise.resolve(printerRepository.getAllRoutes()),
      listOsPrintersAsync(),
    ])

    const localPrinters = printerRepository.getAllPrinters()
    const printerById = new Map(localPrinters.map((p) => [p.id, p]))

    const assignments = routes
      .filter((r) => isRouteForThisNode(r.assigned_node_id, config.nodeId, config.clusterRole))
      .map((r) => {
        const local = localRoutes.find(
          (lr) => lr.station === r.station_code && lr.job_type === r.print_type,
        )
        const printer = local?.printer_id ? printerById.get(local.printer_id) : null
        return {
          station_code: r.station_code,
          station_name: r.station_name,
          print_type: r.print_type,
          // 'assigned' = this node is the routed target; 'leader_fallback' = this
          // leader prints it only when the assigned follower is offline/unassigned.
          scope: r.assigned_node_id === config.nodeId ? ('assigned' as const) : ('leader_fallback' as const),
          printer_id: local?.printer_id ?? null,
          printer_name: printer?.name ?? null,
        }
      })
      .sort((a, b) =>
        a.station_name.localeCompare(b.station_name) || a.print_type.localeCompare(b.print_type),
      )

    return { assignments, os_printers: osPrinters }
  },

  async saveAssignments(
    entries: Array<{ station_code: string; print_type: string; printer_name: string }>,
  ): Promise<number> {
    let saved = 0
    let firstPrinterName = ''

    for (const entry of entries) {
      const printerName = entry.printer_name.trim()
      if (!printerName) continue

      if (!firstPrinterName) firstPrinterName = printerName

      const id = printerIdForName(printerName)
      printerRepository.upsertPrinter({
        id,
        name: printerName,
        connection: printerName,
        driver: 'escpos',
        enabled: 1,
      })
      printerRepository.upsertRoute({
        station: entry.station_code,
        job_type: entry.print_type,
        printer_id: id,
        fallback_printer_id: null,
      })
      saved++
    }

    if (saved > 0) {
      nodeConfigRepository.set('printer_driver', 'escpos')
      nodeConfigRepository.set('printer_name', firstPrinterName)
    }

    await nodeConfigService.backupConfig()
    return saved
  },
}
