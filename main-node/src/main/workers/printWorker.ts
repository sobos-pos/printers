import { printJobRepository } from '../repositories/printJobRepository'
import { printService } from '../services/printService'

/** Process-wide singleton — survives electron-vite HMR so we never stack timers. */
type PrintWorkerGlobals = {
  timer: ReturnType<typeof setInterval> | null
  expireTimer: ReturnType<typeof setInterval> | null
  processing: boolean
}

function workerGlobals(): PrintWorkerGlobals {
  const g = globalThis as typeof globalThis & { __sobossPrintWorker?: PrintWorkerGlobals }
  if (!g.__sobossPrintWorker) {
    g.__sobossPrintWorker = { timer: null, expireTimer: null, processing: false }
  }
  return g.__sobossPrintWorker
}

export const printWorker = {
  start(): void {
    this.stop()
    const reset = printJobRepository.resetStalePrinting()
    if (reset > 0) console.log(`[PrintWorker] Reset ${reset} in-flight print job(s) to PENDING`)

    const stale = printJobRepository.expireStaleJobs(4)
    if (stale > 0) console.log(`[PrintWorker] Expired ${stale} stale print jobs on startup`)

    const wg = workerGlobals()
    wg.timer = setInterval(() => {
      if (wg.processing) return
      wg.processing = true
      printService
        .processDueJobs()
        .catch((err) => console.error('[PrintWorker]', err))
        .finally(() => {
          wg.processing = false
        })
    }, 5000)

    wg.expireTimer = setInterval(() => {
      const expired = printJobRepository.expireStaleJobs(4)
      if (expired > 0) console.log(`[PrintWorker] Expired ${expired} stale print jobs`)
    }, 3_600_000)
    console.log('[PrintWorker] Started (5s)')
  },

  stop(): void {
    const wg = workerGlobals()
    if (wg.timer) clearInterval(wg.timer)
    wg.timer = null
    if (wg.expireTimer) clearInterval(wg.expireTimer)
    wg.expireTimer = null
    wg.processing = false
  },
}
