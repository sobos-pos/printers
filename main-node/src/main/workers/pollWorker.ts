import { config, isCloudConfigured } from '../config'
import { syncPullService } from '../services/syncPullService'
import { menuSyncService } from '../services/menuSyncService'

let timer: ReturnType<typeof setInterval> | null = null
let menuTimer: ReturnType<typeof setInterval> | null = null

export const pollWorker = {
  start(): void {
    this.stop()
    if (!isCloudConfigured()) {
      console.warn('[PollWorker] Cloud not configured — poll disabled')
      return
    }
    syncPullService.runOnce().catch(() => {})
    timer = setInterval(() => syncPullService.runOnce().catch(() => {}), config.pollIntervalMs)
    console.log(`[PollWorker] Started (${config.pollIntervalMs}ms)`)
  },

  stop(): void {
    if (timer) clearInterval(timer)
    timer = null
  },
}

export const readOnlyMenuRefresh = {
  start(): void {
    this.stop()
    if (!isCloudConfigured()) return
    menuTimer = setInterval(
      () => menuSyncService.fetchAndCacheMenu().catch(() => {}),
      config.pollIntervalMs * 2,
    )
  },

  stop(): void {
    if (menuTimer) clearInterval(menuTimer)
    menuTimer = null
  },
}
