import { config } from '../config'
import { printJobRepository } from '../repositories/printJobRepository'
import { printerRepository } from '../repositories/printerRepository'
import { printRouteRepository } from '../repositories/printRouteRepository'
import type { KotPrintPayload, KotSegment, LocalOrder, PaperWidth } from '../types'
import { resolvePrinterDriver } from './printerDriver'
import { recordPrintedKot } from './kotLogService'

export function backoffDelayMs(attemptCount: number): number {
  const schedule = [5000, 15000, 30000, 60000]
  if (attemptCount < schedule.length) return schedule[attemptCount]
  return 300000
}

function buildPrintPayload(
  segment: KotSegment,
  jobType: string,
  meta?: { orderId?: string; table?: string | null; placedAt?: string },
): KotPrintPayload {
  return {
    ...segment,
    order_id: meta?.orderId,
    table: meta?.table,
    placed_at: meta?.placedAt,
    job_type: jobType,
  }
}

export const printService = {
  resolvePrinterId(station: string, jobType = 'KOT'): string | null {
    // 1. Exact mapping for this station + type on THIS node.
    const route = printerRepository.getRoute(station, jobType)
    if (route) {
      const printer = printerRepository.getPrinter(route.printer_id)
      if (printer && printer.enabled) return printer.id
      if (route.fallback_printer_id) return route.fallback_printer_id
      return route.printer_id
    }

    if (jobType === 'BILL') {
      // BILL routes are per-section (DEFAULT, COUNTER, …), never per-kitchen.
      for (const fallbackStation of ['DEFAULT', 'COUNTER']) {
        if (fallbackStation === station) continue
        const billRoute = printerRepository.getRoute(fallbackStation, 'BILL')
        if (billRoute?.printer_id) {
          const printer = printerRepository.getPrinter(billRoute.printer_id)
          if (printer && printer.enabled) return printer.id
          if (billRoute.fallback_printer_id) return billRoute.fallback_printer_id
          return billRoute.printer_id
        }
      }
      // Single-printer setup: no section BILL mapped yet — reuse the kitchen KOT printer.
      const kitchenKot = printerRepository.getRoute('KITCHEN', 'KOT')
      if (kitchenKot?.printer_id) {
        const printer = printerRepository.getPrinter(kitchenKot.printer_id)
        if (printer && printer.enabled) return printer.id
        if (kitchenKot.fallback_printer_id) return kitchenKot.fallback_printer_id
        return kitchenKot.printer_id
      }
    } else {
      // 2. Same node's KITCHEN mapping for KOT — common single-printer setup.
      const kitchen = printerRepository.getRoute('KITCHEN', jobType)
      if (kitchen?.printer_id) return kitchen.printer_id
    }

    // 3. Last resort: first enabled printer on this node.
    const fallback = printerRepository.getAllPrinters().find((p) => p.enabled)
    return fallback?.id ?? null
  },

  enqueueSegments(
    orderId: string,
    segments: KotSegment[],
    jobType = 'KOT',
    meta?: { table?: string | null; placedAt?: string },
  ): void {
    for (const segment of segments) {
      const printerId = this.resolvePrinterId(segment.station, jobType)
      const payload = buildPrintPayload(segment, jobType, {
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

  /** Enqueue ONE consolidated BILL for the entire order, routed by section code.
   *
   *  All order lines appear on a single receipt so the customer (and accounts)
   *  see one bill regardless of how many kitchens were involved.
   */
  enqueueBill(
    orderId: string,
    order: LocalOrder,
    sectionCode: string,
    meta?: { table?: string | null; placedAt?: string; total?: number },
  ): void {
    if (printJobRepository.hasBillForOrder(orderId)) {
      console.log(`[Print] BILL already queued/printed for order ${orderId} — skipping duplicate`)
      return
    }

    const billLines = order.items.map((item) => ({
      qty: item.quantity,
      name: item.name_snapshot,
      mods: item.modifiers.map((m) => m.name_snapshot),
      notes: item.notes,
      unit_price: Number(item.unit_price) || 0,
    }))

    const payload: KotPrintPayload = {
      station: sectionCode,
      lines: billLines,
      order_id: orderId,
      table: meta?.table ?? null,
      placed_at: meta?.placedAt,
      job_type: 'BILL',
      total: meta?.total ?? order.total,
    }

    const printerId = this.resolvePrinterId(sectionCode, 'BILL')
    printJobRepository.enqueue({
      order_id: orderId,
      station: sectionCode,
      job_type: 'BILL',
      printer_id: printerId,
      payload: JSON.stringify(payload),
    })
    console.log(`[Print] Enqueued BILL for section ${sectionCode} → ${printerId ?? 'unrouted'}`)
  },

  async processDueJobs(): Promise<void> {
    const g = globalThis as typeof globalThis & { __sobossPrintDraining?: boolean }
    if (g.__sobossPrintDraining) return
    g.__sobossPrintDraining = true

    try {
      await this.drainDueJobs()
    } finally {
      g.__sobossPrintDraining = false
    }
  },

  async drainDueJobs(): Promise<void> {
    const paperWidth: PaperWidth = config.paperWidth

    while (true) {
      const job = printJobRepository.claimNextDueJob()
      if (!job) break

      if (job.attempt_count >= config.printRetryMaxAttempts) {
        printJobRepository.markFailed(job.id, 'Max retry attempts exceeded')
        continue
      }

      // On the leader, check print routing to decide if this station should
      // be forwarded to a remote follower node. Never re-forward a job that was
      // itself forwarded to us (a follower that booted as 'leader' must still
      // print such jobs locally — otherwise it bounces back and never prints/logs).
      if (config.clusterRole === 'leader' && job.attempt_count < 3 && !printJobRepository.isForwarded(job.id)) {
        const route = printRouteRepository.getByStationAndType(
          config.locationId,
          job.station,
          job.job_type,
        )

        if (route?.assigned_node_id && route.assigned_node_id !== config.nodeId) {
          const { clusterNodeRepository } = await import('../repositories/clusterNodeRepository')
          const node = clusterNodeRepository.get(route.assigned_node_id)

          if (node && clusterNodeRepository.isOnline(node)) {
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
              printJobRepository.markForwarded(job.id)
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
      const driver = resolvePrinterDriver(printer, config.printerDriver)
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
        if (printJobRepository.markPrinted(job.id)) {
          recordPrintedKot(payload)
          console.log(`[Print] Job ${job.id} → PRINTED locally`)
        } else {
          console.warn(`[Print] Job ${job.id} already marked done — skipped duplicate log/output`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const next = new Date(Date.now() + backoffDelayMs(job.attempt_count)).toISOString()
        printJobRepository.markRetrying(job.id, job.attempt_count + 1, next, msg)
      }
    }
  },
}
