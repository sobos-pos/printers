import { config, isCloudConfigured } from '../config'
import { menuCacheRepository } from '../repositories/menuCacheRepository'
import { syncRepository } from '../repositories/syncRepository'
import type { MenuCachePayload } from '../types'
import { cloudClient } from './cloudClient'

export const menuSyncService = {
  /**
   * Best-effort guarantee that a menu is cached for this location.
   *
   * Local order creation validates each line against the cached menu
   * (menuService.findMenuItem). If the cache is empty — e.g. the startup
   * bootstrap pull failed or the menu was never synced — every local order
   * would fail with a misleading "Menu item not found". Calling this before
   * accepting a local order lets the node self-heal by pulling the menu on
   * demand. Forces a full bootstrap pull (sinceVersion=0) so it works even
   * when the location is still at menu version 0.
   *
   * Returns true if a non-empty menu cache exists afterwards.
   */
  async ensureMenuCached(): Promise<boolean> {
    if (!menuCacheRepository.isEmpty(config.locationId)) return true
    if (!isCloudConfigured()) return false
    try {
      await this.fetchAndCacheMenu(0)
    } catch (err) {
      console.warn('[Menu] ensureMenuCached pull failed:', err)
    }
    return !menuCacheRepository.isEmpty(config.locationId)
  },

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

    // Always cache the full location snapshot — it carries the catalogue AND the
    // per-section visibility/price-override block the node needs to filter every
    // table correctly. (The per-table endpoint only returns one section's
    // filtered view with no `sections` block, so it must NOT seed the cache.)
    await this.fetchAndCacheMenu(0)
  },
}
