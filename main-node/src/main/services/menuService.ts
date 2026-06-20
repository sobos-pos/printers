import { config } from '../config'
import { menuCacheRepository } from '../repositories/menuCacheRepository'
import { tableSectionRepository } from '../repositories/tableSectionRepository'
import type { MenuCachePayload } from '../types'

type CachedCategory = MenuCachePayload['categories'][0]
type CachedSection = NonNullable<MenuCachePayload['sections']>[0]

export const menuService = {
  getMenuForTable(tableUuid: string): Record<string, unknown> | null {
    const cached = menuCacheRepository.get(config.locationId)
    if (!cached) return null

    const payload = cached.payload
    const allCategories = payload.categories ?? []

    // Resolve the table's section from the local mapping (warmup / menu-serve).
    const mapping = tableSectionRepository.get(tableUuid)
    const sectionCode = mapping?.section_code ?? null
    const sectionMeta = sectionCode
      ? this.findSection(payload, sectionCode)
      : null

    const tableObj: Record<string, unknown> = {
      id: tableUuid,
      label: mapping?.table_label || this.resolveTableLabel(tableUuid),
    }
    if (sectionMeta) {
      tableObj.section = { code: sectionMeta.code, name: sectionMeta.name }
    }

    // Apply the same section filtering the cloud's get_menu_for_table does:
    // when the section has explicit menus (filtered=true), only listed items
    // are visible and price overrides replace the displayed base price.
    const categories =
      sectionMeta && sectionMeta.filtered
        ? this.applySectionFilter(allCategories, sectionMeta)
        : allCategories

    return {
      table: tableObj,
      menu_version: cached.menu_version,
      categories,
    }
  },

  /** Filter categories to a section's visible items + apply price overrides,
   *  dropping categories left with no items. Mirrors the cloud's
   *  get_menu_for_table: per-variant override → flat item override →
   *  variant.price, with base_price = item override ?? cheapest effective variant. */
  applySectionFilter(categories: CachedCategory[], section: CachedSection): CachedCategory[] {
    const visible = new Set(section.visible_item_ids)
    const itemOverrides = section.price_overrides ?? {}
    const variantOverrides = section.variant_price_overrides ?? {}
    const result: CachedCategory[] = []
    for (const cat of categories) {
      const items = (cat.items ?? [])
        .filter((i) => visible.has(i.id))
        .map((i) => {
          // Apply per-variant section prices to each variant.
          const variants = (i.variants ?? []).map((v) =>
            variantOverrides[v.id] !== undefined ? { ...v, price: variantOverrides[v.id] } : v,
          )
          // base_price: flat item override wins; else cheapest effective variant.
          let base_price = i.base_price
          if (itemOverrides[i.id] !== undefined) {
            base_price = itemOverrides[i.id]
          } else if (variants.length > 0) {
            base_price = String(Math.min(...variants.map((v) => parseFloat(v.price))))
          }
          return { ...i, base_price, variants }
        })
      if (items.length > 0) result.push({ ...cat, items })
    }
    return result
  },

  findSection(payload: MenuCachePayload, sectionCode: string): CachedSection | null {
    return (payload.sections ?? []).find((s) => s.code === sectionCode) ?? null
  },

  /** Flat section override for an item (single-variant items), or null. Used by
   *  order pricing for a no-variant line so a local bill charges the section
   *  price (e.g. bar markup). */
  getPriceOverride(sectionCode: string | null, menuItemId: string): number | null {
    return this._lookupOverride(sectionCode, (s) => s.price_overrides?.[menuItemId])
  },

  /** Per-variant section price (multi-variant items), or null. Used by order
   *  pricing when a specific variant is selected. */
  getVariantPriceOverride(sectionCode: string | null, variantId: string): number | null {
    return this._lookupOverride(sectionCode, (s) => s.variant_price_overrides?.[variantId])
  },

  _lookupOverride(
    sectionCode: string | null,
    pick: (s: CachedSection) => string | undefined,
  ): number | null {
    if (!sectionCode) return null
    const cached = menuCacheRepository.get(config.locationId)
    if (!cached) return null
    const section = this.findSection(cached.payload, sectionCode)
    if (!section || !section.filtered) return null
    const raw = pick(section)
    if (raw === undefined) return null
    const value = parseFloat(raw)
    return Number.isFinite(value) ? value : null
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
    // Prefer the cached label (works for every table, not just the bootstrap one).
    const label = tableSectionRepository.getLabel(tableUuid)
    if (label) return label
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

  /** Persist the section mapping (and label when known) so future local orders
   *  route the BILL and print the table label without a cloud round-trip. */
  storeSectionForTable(
    tableUuid: string,
    sectionCode: string,
    sectionName: string,
    tableLabel = '',
  ): void {
    tableSectionRepository.upsert(tableUuid, sectionCode, sectionName, tableLabel)
  },
}
