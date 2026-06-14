// Cart store (zustand). All arithmetic is in integer cents (see lib/money) because backend prices
// are decimal strings. Lines are keyed by item+variant+modifier-set so re-adding the same
// configuration just increments quantity; per-line notes keep otherwise-identical lines distinct
// only when the user sets them (we merge on the config key and apply the latest note).

import * as Crypto from 'expo-crypto'
import { create } from 'zustand'
import { ORDER_SOURCE } from '../lib/config'
import { toCents } from '../lib/money'
import type {
  CreateOrderInput,
  MenuItem,
  ModifierOption,
  OrderItemInput,
  Variant,
} from '../lib/types'

export interface CartLine {
  key: string
  item: MenuItem
  variant: Variant | null
  modifiers: ModifierOption[]
  qty: number
  note: string
}

function lineKey(item: MenuItem, variant: Variant | null, modifiers: ModifierOption[]): string {
  const mods = modifiers
    .map((m) => m.id)
    .sort()
    .join(',')
  return `${item.id}|${variant?.id ?? ''}|${mods}`
}

/** Unit price of a configured line in cents: base + variant delta + sum of modifier deltas. */
export function lineUnitCents(line: CartLine): number {
  let cents = toCents(line.item.base_price)
  if (line.variant) cents += toCents(line.variant.price_delta)
  for (const m of line.modifiers) cents += toCents(m.price_delta)
  return cents
}

export const lineTotalCents = (line: CartLine): number => lineUnitCents(line) * line.qty

interface CartStore {
  lines: CartLine[]
  orderNote: string
  idempotencyKey: string | null

  addLine: (item: MenuItem, variant: Variant | null, modifiers: ModifierOption[]) => void
  setQty: (key: string, qty: number) => void
  removeLine: (key: string) => void
  setLineNote: (key: string, note: string) => void
  setOrderNote: (note: string) => void
  clear: () => void
  subtotalCents: () => number
  itemCount: () => number
  /** Generate (once) and return an Idempotency-Key, reused across retries until success/clear. */
  ensureIdempotencyKey: () => string
  toOrderInput: (tableUuid: string) => CreateOrderInput
}

export const useCart = create<CartStore>((set, get) => ({
  lines: [],
  orderNote: '',
  idempotencyKey: null,

  addLine: (item, variant, modifiers) => {
    const key = lineKey(item, variant, modifiers)
    set((s) => {
      const existing = s.lines.find((l) => l.key === key)
      if (existing) {
        return { lines: s.lines.map((l) => (l.key === key ? { ...l, qty: l.qty + 1 } : l)) }
      }
      return { lines: [...s.lines, { key, item, variant, modifiers, qty: 1, note: '' }] }
    })
  },

  setQty: (key, qty) =>
    set((s) => ({
      lines:
        qty <= 0
          ? s.lines.filter((l) => l.key !== key)
          : s.lines.map((l) => (l.key === key ? { ...l, qty } : l)),
    })),

  removeLine: (key) => set((s) => ({ lines: s.lines.filter((l) => l.key !== key) })),

  setLineNote: (key, note) =>
    set((s) => ({ lines: s.lines.map((l) => (l.key === key ? { ...l, note } : l)) })),

  setOrderNote: (note) => set({ orderNote: note }),

  clear: () => set({ lines: [], orderNote: '', idempotencyKey: null }),

  subtotalCents: () => get().lines.reduce((sum, l) => sum + lineTotalCents(l), 0),

  itemCount: () => get().lines.reduce((sum, l) => sum + l.qty, 0),

  ensureIdempotencyKey: () => {
    const existing = get().idempotencyKey
    if (existing) return existing
    const key = Crypto.randomUUID()
    set({ idempotencyKey: key })
    return key
  },

  toOrderInput: (tableUuid) => {
    const items: OrderItemInput[] = get().lines.map((l) => ({
      menu_item: l.item.id,
      variant: l.variant?.id ?? null,
      quantity: l.qty,
      notes: l.note,
      modifiers: l.modifiers.map((m) => m.id),
    }))
    return {
      table_uuid: tableUuid,
      source: ORDER_SOURCE,
      customer_note: get().orderNote,
      items,
    }
  },
}))
