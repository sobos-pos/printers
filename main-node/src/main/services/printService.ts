import { config } from '../config'
import { printJobRepository } from '../repositories/printJobRepository'
import { printerRepository } from '../repositories/printerRepository'
import { printRouteRepository } from '../repositories/printRouteRepository'
import type { KotPrintPayload, KotSegment, PaperWidth } from '../types'
import { getPrinterDriver } from './printerDriver'

export function backoffDelayMs(attemptCount: number): number {
  const schedule = [5000, 15000, 30000, 60000]
  if (attemptCount < schedule.length) return schedule[attemptCount]
  return 300000
}

function buildPrintPayload(
  segment: KotSegment,
  meta?: { orderId?: string; table?: string | null; placedAt?: string },
): KotPrintPayload {
  return {
    ...segment,
    order_id: meta?.orderId,
    table: meta?.table,
    placed_at: meta?.placedAt,
  }
}

export const printService = {
  resolvePrinterId(station: string, jobType = 'KOT'): string | null {
    const route = printerRepository.getRoute(station, jobType)
    if (!route) {
      const fallback = printerRepository.getRoute('KITCHEN', jobType)
      return fallback?.printer_id ?? null
    }
    const printer = printerRepository.getPrinter(route.printer_id)
    if (printer && printer.enabled) return printer.id
    if (route.fallback_printer_id) return route.fallback_printer_id
    return route.printer_id
  },

  enqueueSegments(
    orderId: string,
    segments: KotSegment[],
    jobType = 'KOT',
    meta?: { table?: string | null; placedAt?: string },
  ): void {
    for (const segment of segments) {
      const printerId = this.resolvePrinterId(segment.station, jobType)
      const payload = buildPrintPayload(segment, {
        orderId,
        table: meta?.table,
        placedAt: meta?.placedAt,
      })
      printJobRepository.enqueue({
        order_id: orderId,
        station: segment.station,
        job_type: jobType,
        printer_id: printerId,
        payload: JSON.stringify(payload),
      })
      console.log(`[Print] Enqueued ${jobType} for ${segment.station} → ${printerId ?? 'unrouted'}`)
    }
  },

  async processDueJobs(): Promise<void> {
    const jobs = printJobRepository.getDueJobs()
    const paperWidth: PaperWidth = config.paperWidth

    for (const job of jobs) {
      if (job.attempt_count >= config.printRetryMaxAttempts) {
        printJobRepository.markFailed(job.id, 'Max retry attempts exceeded')
        continue
      }

      // On the leader, check print routing to decide if this station should
      // be forwarded to a remote follower node.
      if (config.clusterRole === 'leader' && job.attempt_count < 3) {
        const route = printRouteRepository.getByStationAndType(
          config.locationId,
          job.station,
          job.job_type,
        )

        if (route && route.assigned_node_id) {
          const { clusterNodeRepository } = await import('../repositories/clusterNodeRepository')
          const node = clusterNodeRepository.get(route.assigned_node_id)

          if (node && node.status === 'ONLINE') {
            console.log(`[Print] Forwarding job ${job.id} for ${job.station}/${job.job_type} to ${node.node_id} (Attempt ${job.attempt_count + 1})`)
            const { clusterService } = await import('./clusterService')
            const ok = await clusterService.forwardPrintJob(node.node_id, {
              job_id: job.id,
              order_id: job.order_id,
              station: job.station,
              job_type: job.job_type,
              payload: JSON.parse(job.payload),
            })

            if (ok) {
              printJobRepository.markPrinted(job.id)
              console.log(`[Print] Job ${job.id} forwarded to ${node.node_id}`)
              continue
            } else {
              const next = new Date(Date.now() + 15000).toISOString()
              printJobRepository.markRetrying(
                job.id,
                job.attempt_count + 1,
                next,
                `Forwarding to ${node.node_id} failed`,
              )
              continue
            }
          }
          // Node offline or not found — fall through to local printing as fallback
          console.warn(`[Print] Assigned node ${route.assigned_node_id} offline — falling back to local print`)
        }
        // route null or assigned_node_id null → print locally (Unassigned)
      }

      // Local printing fallback or direct local printing
      const printerId = this.resolvePrinterId(job.station, job.job_type)
      const printer = printerId ? printerRepository.getPrinter(printerId) : null
      const driver = getPrinterDriver(printer?.driver ?? config.printerDriver)
      const payload = JSON.parse(job.payload) as KotPrintPayload
      const ctx = { printer, paperWidth }

      if (!(await driver.isAvailable(ctx))) {
        const next = new Date(Date.now() + backoffDelayMs(job.attempt_count)).toISOString()
        printJobRepository.markRetrying(
          job.id,
          job.attempt_count + 1,
          next,
          'Printer unavailable',
        )
        continue
      }

      try {
        await driver.print(payload, ctx)
        printJobRepository.markPrinted(job.id)
        console.log(`[Print] Job ${job.id} → PRINTED locally`)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const next = new Date(Date.now() + backoffDelayMs(job.attempt_count)).toISOString()
        printJobRepository.markRetrying(job.id, job.attempt_count + 1, next, msg)
      }
    }
  },
}
