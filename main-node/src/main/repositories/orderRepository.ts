import { v4 as uuidv4 } from 'uuid'
import { getDb, nowIso } from '../db/connection'
import type {
  BulkOrderItem,
  LocalOrder,
  OrderItemModifierRow,
  OrderItemRow,
  OrderRow,
  OrderStatus,
} from '../types'

function hydrateOrder(row: OrderRow): LocalOrder {
  const db = getDb()
  const items = db
    .prepare('SELECT * FROM order_items WHERE order_id = ?')
    .all(row.id) as OrderItemRow[]

  return {
    ...row,
    items: items.map((item) => ({
      ...item,
      modifiers: db
        .prepare('SELECT * FROM order_item_modifiers WHERE order_item_id = ?')
        .all(item.id) as OrderItemModifierRow[],
    })),
  }
}

export const orderRepository = {
  getById(id: string): LocalOrder | null {
    const row = getDb().prepare('SELECT * FROM orders WHERE id = ?').get(id) as OrderRow | undefined
    return row ? hydrateOrder(row) : null
  },

  exists(id: string): boolean {
    return Boolean(getDb().prepare('SELECT 1 FROM orders WHERE id = ?').get(id))
  },

  insertOrder(
    order: Omit<OrderRow, 'created_at' | 'updated_at'>,
    items: Array<{
      id: string
      menu_item_id: string
      variant_id: string | null
      name_snapshot: string
      quantity: number
      unit_price: number
      notes: string
      modifiers: Array<{ id: string; modifier_id: string; name_snapshot: string; price: number }>
    }>,
    orIgnore = false,
  ): boolean {
    const db = getDb()
    const now = nowIso()
    const verb = orIgnore ? 'INSERT OR IGNORE' : 'INSERT'

    const result = db
      .prepare(
        `${verb} INTO orders (id, location_id, table_uuid, section_code, source, status, total, origin, push_state, pushed_at, created_at, updated_at)
         VALUES (@id, @location_id, @table_uuid, @section_code, @source, @status, @total, @origin, @push_state, @pushed_at, @created_at, @updated_at)`,
      )
      .run({ ...order, created_at: now, updated_at: now })

    if (orIgnore && result.changes === 0) return false

    for (const item of items) {
      db.prepare(
        `${verb} INTO order_items (id, order_id, menu_item_id, variant_id, name_snapshot, quantity, unit_price, notes)
         VALUES (@id, @order_id, @menu_item_id, @variant_id, @name_snapshot, @quantity, @unit_price, @notes)`,
      ).run({ ...item, order_id: order.id })

      for (const mod of item.modifiers) {
        db.prepare(
          `${verb} INTO order_item_modifiers (id, order_item_id, modifier_id, name_snapshot, price)
           VALUES (@id, @order_item_id, @modifier_id, @name_snapshot, @price)`,
        ).run({ ...mod, order_item_id: item.id })
      }
    }
    return true
  },

  updateStatus(id: string, status: OrderStatus): void {
    getDb()
      .prepare('UPDATE orders SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, nowIso(), id)
  },

  getPendingPushOrders(): OrderRow[] {
    return getDb()
      .prepare(`SELECT * FROM orders WHERE origin = 'local' AND push_state = 'pending'`)
      .all() as OrderRow[]
  },

  markAsSynced(ids: string[]): void {
    if (!ids.length) return
    const now = nowIso()
    const stmt = getDb().prepare(
      `UPDATE orders SET push_state = 'synced', pushed_at = ?, updated_at = ? WHERE id = ?`,
    )
    for (const id of ids) stmt.run(now, now, id)
  },

  getItemsForBulkPush(orderId: string): BulkOrderItem[] {
    const db = getDb()
    const items = db
      .prepare('SELECT * FROM order_items WHERE order_id = ?')
      .all(orderId) as OrderItemRow[]

    return items.map((item) => ({
      menu_item: item.menu_item_id,
      variant: item.variant_id,
      quantity: item.quantity,
      notes: item.notes,
      modifiers: (
        db
          .prepare('SELECT modifier_id FROM order_item_modifiers WHERE order_item_id = ?')
          .all(item.id) as Array<{ modifier_id: string }>
      ).map((m) => m.modifier_id),
    }))
  },

  countToday(): number {
    const today = new Date().toISOString().slice(0, 10)
    const row = getDb()
      .prepare(`SELECT COUNT(*) as c FROM orders WHERE created_at LIKE ?`)
      .get(`${today}%`) as { c: number }
    return row.c
  },

  newId(): string {
    return uuidv4()
  },
}
