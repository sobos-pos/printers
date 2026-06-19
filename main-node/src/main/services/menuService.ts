import { config } from '../config'
import { menuCacheRepository } from '../repositories/menuCacheRepository'
import { tableSectionRepository } from '../repositories/tableSectionRepository'
import type { MenuCachePayload } from '../types'

export const menuService = {
  getMenuForTable(tableUuid: string): Record<string, unknown> | null {
    const cached = menuCacheRepository.get(config.locationId)
    if (!cached) return null

    const payload = cached.payload
    const categories = payload.categories ?? []
    let table = payload.table

    if (!table) {
      table = { id: tableUuid, label: tableUuid.slice(0, 8).toUpperCase() }
    }

    const tableObj = table.id === tableUuid
      ? table
      : { id: tableUuid, label: table.label ?? 'Table', section: table.section }

    return {
      table: tableObj,
      menu_version: cached.menu_version,
      categories,
    }
  },

  findMenuItem(menuItemId: string): {
    item: MenuCachePayload['categories'][0]['items'][0]
    categoryId: string
    categoryKitchenCode: string | null | undefined
  } | null {
    const cached = menuCacheRepository.get(config.locationId)
    if (!cached) return null
    for (const cat of cached.payload.categories ?? []) {
      const item = cat.items?.find((i) => i.id === menuItemId)
      if (item) return { item, categoryId: cat.id, categoryKitchenCode: cat.kitchen_code }
    }
    return null
  },

  resolveTableLabel(tableUuid: string): string {
    const cached = menuCacheRepository.get(config.locationId)
    if (cached?.payload.table?.id === tableUuid) return cached.payload.table.label
    return tableUuid.slice(0, 8).toUpperCase()
  },

  /** Resolve the section code for a table from the local table_sections cache.
   *  Returns 'COUNTER' if the table has not been seen yet (safe fallback). */
  resolveSectionCode(tableUuid: string | null): string {
    if (!tableUuid) return 'COUNTER'
    return tableSectionRepository.getSectionCode(tableUuid)
  },

  /** Persist the section mapping from the menu response so future local orders
   *  can route the BILL without a cloud round-trip. */
  storeSectionForTable(tableUuid: string, sectionCode: string, sectionName: string): void {
    tableSectionRepository.upsert(tableUuid, sectionCode, sectionName)
  },
}
