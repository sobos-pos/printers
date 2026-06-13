import { config } from '../config'
import { menuCacheRepository } from '../repositories/menuCacheRepository'
import type { MenuCachePayload } from '../types'

export const menuService = {
  getMenuForTable(tableUuid: string): Record<string, unknown> | null {
    const cached = menuCacheRepository.get(config.locationId)
    if (!cached) return null

    const payload = cached.payload
    // Full menu blob may be stored as sync response { version, categories }
    const categories = payload.categories ?? []
    let table = payload.table

    if (!table) {
      // Find table from any category context — menu from sync may not include table
      // Use placeholder; table label resolved from first table in location if needed
      table = { id: tableUuid, label: tableUuid.slice(0, 8).toUpperCase() }
    }

    return {
      table: table.id === tableUuid ? table : { id: tableUuid, label: table.label ?? 'Table' },
      menu_version: cached.menu_version,
      categories,
    }
  },

  findMenuItem(menuItemId: string): {
    item: MenuCachePayload['categories'][0]['items'][0]
    categoryId: string
  } | null {
    const cached = menuCacheRepository.get(config.locationId)
    if (!cached) return null
    for (const cat of cached.payload.categories ?? []) {
      const item = cat.items?.find((i) => i.id === menuItemId)
      if (item) return { item, categoryId: cat.id }
    }
    return null
  },

  resolveTableLabel(tableUuid: string): string {
    const cached = menuCacheRepository.get(config.locationId)
    if (cached?.payload.table?.id === tableUuid) return cached.payload.table.label
    return tableUuid.slice(0, 8).toUpperCase()
  },
}
