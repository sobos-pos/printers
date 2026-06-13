import { describe, it, expect } from 'vitest'
import { backoffDelayMs } from '../src/main/services/printService'

describe('printService backoff', () => {
  it('follows defined schedule', () => {
    expect(backoffDelayMs(0)).toBe(5000)
    expect(backoffDelayMs(1)).toBe(15000)
    expect(backoffDelayMs(3)).toBe(60000)
    expect(backoffDelayMs(10)).toBe(300000)
  })
})
