import { beforeEach, describe, expect, it, jest } from '@jest/globals'

jest.mock('expo-crypto', () => ({ randomUUID: () => 'fixed-idempotency-key' }))

import type { MenuItem, ModifierOption, Variant } from '../../lib/types'
import { lineUnitCents, useCart } from '../cart'

function makeItem(overrides: Partial<MenuItem> = {}): MenuItem {
  return {
    id: 'item-1',
    name: 'Burger',
    description: '',
    base_price: '10.00',
    is_available: true,
    image: null,
    station: null,
    dietary_tags: [],
    variants: [],
    modifier_groups: [],
    ...overrides,
  }
}

const variant: Variant = { id: 'v-large', name: 'Large', price_delta: '2.50' }
const cheese: ModifierOption = {
  id: 'm-cheese',
  name: 'Cheese',
  price_delta: '1.00',
  is_available: true,
}

beforeEach(() => useCart.getState().clear())

describe('cart', () => {
  it('merges identical configurations by incrementing quantity', () => {
    const item = makeItem()
    useCart.getState().addLine(item, null, [])
    useCart.getState().addLine(item, null, [])
    expect(useCart.getState().lines).toHaveLength(1)
    expect(useCart.getState().lines[0].qty).toBe(2)
  })

  it('keeps different variants as separate lines', () => {
    const item = makeItem({ variants: [variant] })
    useCart.getState().addLine(item, null, [])
    useCart.getState().addLine(item, variant, [])
    expect(useCart.getState().lines).toHaveLength(2)
  })

  it('computes unit price as base + variant + modifiers (in cents)', () => {
    const item = makeItem()
    const line = { key: 'k', item, variant, modifiers: [cheese], qty: 1, note: '' }
    expect(lineUnitCents(line)).toBe(1000 + 250 + 100) // ₹13.50
  })

  it('sums subtotal across lines and quantities', () => {
    const item = makeItem()
    useCart.getState().addLine(item, variant, [cheese]) // 1350
    useCart.getState().addLine(item, variant, [cheese]) // qty 2 -> 2700
    useCart.getState().addLine(makeItem({ id: 'item-2', base_price: '5.00' }), null, []) // 500
    expect(useCart.getState().subtotalCents()).toBe(2700 + 500)
    expect(useCart.getState().itemCount()).toBe(3)
  })

  it('builds the order input with source Waiter_App', () => {
    const item = makeItem()
    useCart.getState().addLine(item, variant, [cheese])
    useCart.getState().setOrderNote('birthday')
    const input = useCart.getState().toOrderInput('table-uuid')
    expect(input).toMatchObject({
      table_uuid: 'table-uuid',
      source: 'Waiter_App',
      customer_note: 'birthday',
      items: [
        {
          menu_item: 'item-1',
          variant: 'v-large',
          quantity: 1,
          modifiers: ['m-cheese'],
        },
      ],
    })
  })

  it('reuses one idempotency key until cleared', () => {
    const k1 = useCart.getState().ensureIdempotencyKey()
    const k2 = useCart.getState().ensureIdempotencyKey()
    expect(k1).toBe(k2)
    useCart.getState().clear()
    expect(useCart.getState().idempotencyKey).toBeNull()
  })
})
