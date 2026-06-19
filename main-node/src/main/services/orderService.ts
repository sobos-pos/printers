import { v4 as uuidv4 } from 'uuid'
import { config } from '../config'
import { orderRepository } from '../repositories/orderRepository'
import { menuService } from './menuService'
import { orderStateMachine } from './orderStateMachine'
import { kotService } from './kotService'
import { printService } from './printService'
import { kdsService } from './kdsService'
import { cloudClient } from './cloudClient'
import type {
  BulkOrderItem,
  CreateOrderInput,
  LocalOrder,
  MenuModifierGroup,
  MenuModifierOption,
  OrderStatus,
  SerializedOrder,
} from '../types'

/** Depth-first search for a modifier option by id, descending into nested
 * option groups so deeply-nested selections (e.g. sugar level on an add-on
 * beverage) are still resolved and priced. */
function findOption(
  groups: MenuModifierGroup[] | undefined,
  optionId: string,
): MenuModifierOption | null {
  for (const group of groups ?? []) {
    for (const opt of group.options ?? []) {
      if (opt.id === optionId) return opt
      const nested = findOption(opt.nested_option_groups, optionId)
      if (nested) return nested
    }
  }
  return null
}

function serializeOrder(order: LocalOrder): SerializedOrder {
  return {
    id: order.id,
    location: order.location_id,
    table: order.table_uuid,
    table_label: order.table_uuid ? menuService.resolveTableLabel(order.table_uuid) : null,
    source: order.source,
    status: order.status,
    total: String(order.total),
    customer_note: '',
    created_at: order.created_at,
    updated_at: order.updated_at,
    items: order.items.map((item) => ({
      id: item.id,
      menu_item: item.menu_item_id,
      menu_item_name: item.name_snapshot,
      variant: item.variant_id,
      quantity: item.quantity,
      unit_price: String(item.unit_price),
      notes: item.notes,
      modifiers: item.modifiers.map((m) => ({
        id: m.modifier_id,
        name: m.name_snapshot,
        price: String(m.price),
      })),
    })),
  }
}

function buildLineItems(items: BulkOrderItem[]) {
  return items.map((itemData) => {
    const found = menuService.findMenuItem(itemData.menu_item)
    if (!found) throw new Error(`Menu item not found: ${itemData.menu_item}`)

    // Variants carry the absolute price. A chosen variant sets the unit price
    // outright; otherwise fall back to base_price (cheapest available variant).
    let unitPrice = parseFloat(found.item.base_price)
    let variantName: string | null = null
    if (itemData.variant) {
      const variant = found.item.variants?.find((v) => v.id === itemData.variant)
      if (variant) {
        unitPrice = parseFloat(variant.price)
        variantName = variant.name
      }
    }

    const modifiers = (itemData.modifiers ?? []).map((modId) => {
      const opt = findOption(found.item.modifier_groups, modId)
      if (!opt) throw new Error(`Modifier not found: ${modId}`)
      const price = parseFloat(opt.price)
      unitPrice += price
      return {
        id: uuidv4(),
        modifier_id: modId,
        name_snapshot: opt.name,
        price,
      }
    })

    const name = variantName ? `${found.item.name} (${variantName})` : found.item.name

    return {
      id: uuidv4(),
      menu_item_id: itemData.menu_item,
      variant_id: itemData.variant ?? null,
      name_snapshot: name,
      quantity: itemData.quantity ?? 1,
      unit_price: unitPrice,
      notes: itemData.notes ?? '',
      modifiers,
    }
  })
}

export const orderService = {
  serialize: serializeOrder,

  getOrder(id: string): SerializedOrder | null {
    const order = orderRepository.getById(id)
    return order ? serializeOrder(order) : null
  },

  createLocalOrder(input: CreateOrderInput): SerializedOrder {
    const lineItems = buildLineItems(input.items)
    const total = lineItems.reduce(
      (sum, li) =>
        sum + li.unit_price * li.quantity + li.modifiers.reduce((s, m) => s + m.price, 0) * li.quantity,
      0,
    )

    const orderId = orderRepository.newId()
    orderRepository.insertOrder(
      {
        id: orderId,
        location_id: config.locationId,
        table_uuid: input.table_uuid,
        source: input.source ?? 'Staff_POS',
        status: 'Pending',
        total,
        origin: 'local',
        push_state: 'pending',
        pushed_at: null,
      },
      lineItems,
    )

    const order = orderRepository.getById(orderId)!
    kdsService.broadcastNewOrder(serializeOrder(order))

    const kot = kotService.buildKot(order)
    // Each station segment produces a KOT (kitchen ticket) and a BILL (priced
    // receipt). Both are routed independently by (station, type) so an offline
    // follower's BILL and KOT both fall back to the leader.
    printService.enqueueSegments(orderId, kot.segments, 'KOT', {
      table: kot.table,
      placedAt: kot.placed_at,
    })
    printService.enqueueSegments(orderId, kot.segments, 'BILL', {
      table: kot.table,
      placedAt: kot.placed_at,
    })

    orderRepository.updateStatus(orderId, 'Confirmed')
    const confirmed = orderRepository.getById(orderId)!
    kdsService.broadcastStatusChange(orderId, 'Confirmed')

    // Best-effort cloud status push
    cloudClient.pushStatus(orderId, 'Confirmed').catch(() => {
      console.warn(`[Order] Cloud status push deferred for ${orderId}`)
    })

    return serializeOrder(confirmed)
  },

  applyStatusLocally(orderId: string, newStatus: OrderStatus): boolean {
    const order = orderRepository.getById(orderId)
    if (!order) return false
    const next = orderStateMachine.apply(order.status, newStatus)
    if (!next) return false
    orderRepository.updateStatus(orderId, next)
    kdsService.broadcastStatusChange(orderId, next)
    return true
  },

  ingestFromCloudPayload(payload: Record<string, unknown>, orIgnore = true): LocalOrder | null {
    const orderId = String(payload.id)
    if (orIgnore && orderRepository.exists(orderId)) {
      return orderRepository.getById(orderId)
    }

    const items = (payload.items as Array<Record<string, unknown>>) ?? []
    const lineItems = items.map((item) => ({
      id: String(item.id),
      menu_item_id: String(item.menu_item_id ?? item.menu_item),
      variant_id: item.variant_id ? String(item.variant_id) : null,
      name_snapshot: String(item.menu_item_name ?? 'Item'),
      quantity: Number(item.quantity ?? 1),
      unit_price: parseFloat(String(item.unit_price ?? 0)),
      notes: String(item.notes ?? ''),
      modifiers: ((item.modifiers as Array<Record<string, unknown>>) ?? []).map((m) => ({
        id: uuidv4(),
        modifier_id: String(m.id),
        name_snapshot: String(m.name),
        price: parseFloat(String(m.price ?? 0)),
      })),
    }))

    const inserted = orderRepository.insertOrder(
      {
        id: orderId,
        location_id: config.locationId,
        table_uuid: payload.table_uuid ? String(payload.table_uuid) : null,
        source: String(payload.source ?? 'User_App_QR'),
        status: String(payload.status ?? 'Pending') as OrderStatus,
        total: parseFloat(String(payload.total ?? 0)),
        origin: 'cloud',
        push_state: 'synced',
        pushed_at: null,
      },
      lineItems,
      orIgnore,
    )

    if (!inserted && orIgnore) return orderRepository.getById(orderId)
    return orderRepository.getById(orderId)
  },

  processCloudOrder(order: LocalOrder): void {
    kdsService.broadcastNewOrder(serializeOrder(order))
    const kot = kotService.buildKot(order)
    printService.enqueueSegments(order.id, kot.segments, 'KOT', {
      table: kot.table,
      placedAt: kot.placed_at,
    })
    printService.enqueueSegments(order.id, kot.segments, 'BILL', {
      table: kot.table,
      placedAt: kot.placed_at,
    })
    if (order.status === 'Pending') {
      orderRepository.updateStatus(order.id, 'Confirmed')
      kdsService.broadcastStatusChange(order.id, 'Confirmed')
    }
  },
}
