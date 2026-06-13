import type { OrderStatus } from '../types'

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  Pending: ['Confirmed', 'Cancelled'],
  Confirmed: ['Preparing', 'Cancelled'],
  Preparing: ['Ready', 'Cancelled'],
  Ready: ['Served', 'Cancelled'],
  Served: [],
  Cancelled: [],
}

const STATUS_ORDER: OrderStatus[] = [
  'Pending',
  'Confirmed',
  'Preparing',
  'Ready',
  'Served',
  'Cancelled',
]

export const orderStateMachine = {
  canTransition(current: OrderStatus, target: OrderStatus): boolean {
    return TRANSITIONS[current]?.includes(target) ?? false
  },

  isAheadOrEqual(current: OrderStatus, incoming: OrderStatus): boolean {
    if (current === incoming) return true
    const ci = STATUS_ORDER.indexOf(current)
    const ii = STATUS_ORDER.indexOf(incoming)
    if (current === 'Cancelled' || incoming === 'Cancelled') return current === incoming
    return ci >= ii
  },

  apply(current: OrderStatus, target: OrderStatus): OrderStatus | null {
    if (current === target) return null
    if (!this.canTransition(current, target)) return null
    return target
  },
}
