import { printService } from '../services/printService'

let timer: ReturnType<typeof setInterval> | null = null

export const printWorker = {
  start(): void {
    this.stop()
    timer = setInterval(() => {
      printService.processDueJobs().catch((err) => console.error('[PrintWorker]', err))
    }, 5000)
    console.log('[PrintWorker] Started (5s)')
  },

  stop(): void {
    if (timer) clearInterval(timer)
    timer = null
  },
}
