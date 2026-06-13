import { describe, it, expect } from 'vitest'
import { orderStateMachine } from '../src/main/services/orderStateMachine'

describe('orderStateMachine', () => {
  it('allows Pending → Confirmed', () => {
    expect(orderStateMachine.canTransition('Pending', 'Confirmed')).toBe(true)
  })

  it('rejects backward Ready → Pending', () => {
    expect(orderStateMachine.canTransition('Ready', 'Pending')).toBe(false)
  })

  it('apply returns null for invalid transition', () => {
    expect(orderStateMachine.apply('Served', 'Pending')).toBeNull()
  })

  it('isAheadOrEqual detects echo skip', () => {
    expect(orderStateMachine.isAheadOrEqual('Confirmed', 'Confirmed')).toBe(true)
    expect(orderStateMachine.isAheadOrEqual('Preparing', 'Confirmed')).toBe(true)
  })
})
