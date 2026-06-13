import { describe, expect, it } from 'vitest'
import { formatKotEscPos } from '../src/main/services/kotFormatter'

describe('kotFormatter', () => {
  it('builds non-empty ESC/POS buffer for 58mm', () => {
    const buf = formatKotEscPos(
      {
        station: 'KITCHEN',
        order_id: 'abc-123',
        table: 'T1',
        placed_at: '2026-06-13T10:00:00.000Z',
        lines: [{ qty: 2, name: 'Margherita', mods: ['Extra Cheese'], notes: '' }],
      },
      '58mm',
    )
    expect(buf.length).toBeGreaterThan(20)
    expect(buf[0]).toBe(0x1b) // ESC init common in thermal output
  })
})
