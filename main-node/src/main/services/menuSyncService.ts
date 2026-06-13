import { config, isCloudConfigured } from '../config'
import { menuCacheRepository } from '../repositories/menuCacheRepository'
import { syncRepository } from '../repositories/syncRepository'
import type { MenuCachePayload } from '../types'
import { cloudClient } from './cloudClient'

export const menuSyncService = {
  async fetchAndCacheMenu(sinceVersion?: number): Promise<boolean> {
    if (!isCloudConfigured()) return false
    const version = sinceVersion ?? menuCacheRepository.getVersion(config.locationId)

    try {
      const data = await cloudClient.fetchMenu(version)
      if (!data) return false

      menuCacheRepository.upsert(config.locationId, data.version, {
        version: data.version,
        categories: data.categories as MenuCachePayload['categories'],
      })

      syncRepository.insertSyncLog({
        direction: 'PULL',
        sync_type: 'MENU_SYNC',
        status: 'SUCCESS',
      })
      console.log(`[Menu] Cached version ${data.version}`)
      return true
    } catch (err) {
      syncRepository.insertSyncLog({
        direction: 'PULL',
        sync_type: 'MENU_SYNC',
        status: 'FAILED',
        error_message: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  },

  async bootstrapMenuFromCloud(): Promise<void> {
    if (!isCloudConfigured()) {
      console.warn('[Menu] Cloud not configured — skipping menu pull')
      return
    }
    if (!menuCacheRepository.isEmpty(config.locationId)) return

    // Prefer full table menu (includes table label) when BOOTSTRAP_TABLE_UUID is set
    if (config.bootstrapTableUuid) {
      try {
        const res = await fetch(
          `${config.cloudBaseUrl}/api/v1/tables/${config.bootstrapTableUuid}/menu/`,
        )
        if (res.ok) {
          const data = await res.json()
          menuCacheRepository.upsert(
            config.locationId,
            data.menu_version ?? 0,
            data,
          )
          console.log('[Menu] Bootstrapped from table menu endpoint')
          return
        }
      } catch (err) {
        console.warn('[Menu] Table menu bootstrap failed:', err)
      }
    }

    await this.fetchAndCacheMenu(0)
  },
}
