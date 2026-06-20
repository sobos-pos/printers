import { printJobRepository } from '../repositories/printJobRepository'
import { printService } from '../services/printService'

let timer: ReturnType<typeof setInterval> | null = null
let expireTimer: ReturnType<typeof setInterval> | null = null

export const printWorker = {
  start(): void {
    this.stop()
    // On startup, expire jobs stuck for longer than 4 hours so the dashboard
    // count doesn't show stale entries from previous sessions.
    const stale = printJobRepository.expireStaleJobs(4)
    if (stale > 0) console.log(`[PrintWorker] Expired ${stale} stale print jobs on startup`)

    timer = setInterval(() => {
      printService.processDueJobs().catch((err) => console.error('[PrintWorker]', err))
    }, 5000)
    // Hourly cleanup for jobs that get stuck during a long run.
    expireTimer = setInterval(() => {
      const expired = printJobRepository.expireStaleJobs(4)
      if (expired > 0) console.log(`[PrintWorker] Expired ${expired} stale print jobs`)
    }, 3_600_000)
    console.log('[PrintWorker] Started (5s)')
  },

  stop(): void {
    if (timer) clearInterval(timer)
    timer = null
    if (expireTimer) clearInterval(expireTimer)
    expireTimer = null
  },
}
