import type { KotPayload, LocalOrder } from '../types'
import { menuCacheRepository } from '../repositories/menuCacheRepository'
import { config } from '../config'

export const kotService = {
  buildKot(order: LocalOrder): KotPayload {
    const segmentsMap = new Map<string, KotPayload['segments'][0]['lines']>()
    const menu = menuCacheRepository.get(config.locationId)

    for (const item of order.items) {
      // Resolution rule: item.kitchen_code ?? category.kitchen_code ?? 'KITCHEN'
      let kitchenCode = 'KITCHEN'
      if (menu) {
        for (const cat of menu.payload.categories ?? []) {
          const mi = cat.items?.find((i) => i.id === item.menu_item_id)
          if (mi) {
            kitchenCode = mi.kitchen_code ?? cat.kitchen_code ?? 'KITCHEN'
            break
          }
        }
      }

      let name = item.name_snapshot
      if (item.variant_id && menu) {
        for (const cat of menu.payload.categories ?? []) {
          const mi = cat.items?.find((i) => i.id === item.menu_item_id)
          const variant = mi?.variants?.find((v) => v.id === item.variant_id)
          if (variant) {
            name = `${name} (${variant.name})`
            break
          }
        }
      }

      const lines = segmentsMap.get(kitchenCode) ?? []
      lines.push({
        qty: item.quantity,
        name,
        mods: item.modifiers.map((m) => m.name_snapshot),
        notes: item.notes,
        unit_price: Number(item.unit_price) || 0,
      })
      segmentsMap.set(kitchenCode, lines)
    }

    let tableLabel: string | null = null
    if (order.table_uuid && menu?.payload) {
      const root = menu.payload as { table?: { label: string } }
      tableLabel = root.table?.label ?? order.table_uuid.slice(0, 8)
    }

    return {
      order: order.id,
      table: tableLabel,
      placed_at: order.created_at,
      section_code: order.section_code ?? 'COUNTER',
      segments: [...segmentsMap.entries()].map(([station, lines]) => ({ station, lines })),
    }
  },
}
