import { describe, expect, it } from '@jest/globals'
import { centsToString, formatMoney, toCents } from '../money'

describe('toCents', () => {
  it('parses two-decimal strings', () => {
    expect(toCents('12.50')).toBe(1250)
    expect(toCents('0.99')).toBe(99)
  })
  it('pads single/zero fraction', () => {
    expect(toCents('12.5')).toBe(1250)
    expect(toCents('12')).toBe(1200)
  })
  it('handles negatives (price deltas)', () => {
    expect(toCents('-1.00')).toBe(-100)
    expect(toCents('-0.50')).toBe(-50)
  })
  it('rounds half-up on a third decimal', () => {
    expect(toCents('1.005')).toBe(101)
    expect(toCents('1.004')).toBe(100)
  })
  it('treats empty/nullish as zero', () => {
    expect(toCents('')).toBe(0)
    expect(toCents(null)).toBe(0)
    expect(toCents(undefined)).toBe(0)
  })
})

describe('centsToString', () => {
  it('formats with two decimals', () => {
    expect(centsToString(1250)).toBe('12.50')
    expect(centsToString(99)).toBe('0.99')
    expect(centsToString(0)).toBe('0.00')
  })
  it('formats negatives', () => {
    expect(centsToString(-100)).toBe('-1.00')
  })
})

describe('formatMoney', () => {
  it('prefixes the currency symbol', () => {
    expect(formatMoney(1250)).toBe('₹12.50')
    expect(formatMoney(1250, '$')).toBe('$12.50')
  })
})
