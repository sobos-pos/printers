import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ThermalPrinter, PrinterTypes } from 'node-thermal-printer'
import type { KotPrintPayload, PaperWidth } from '../types'

function charWidth(paperWidth: PaperWidth): number {
  return paperWidth === '58mm' ? 32 : 48
}

function formatTime(iso?: string): string {
  const d = iso ? new Date(iso) : new Date()
  return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function createBufferPrinter(paperWidth: PaperWidth): ThermalPrinter {
  const dir = mkdtempSync(join(tmpdir(), 'soboss-kot-'))
  const dummyFile = join(dir, 'kot.raw')
  const printer = new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: dummyFile,
    width: charWidth(paperWidth),
    lineCharacter: '=',
    removeSpecialCharacters: false,
  })
  ;(printer as ThermalPrinter & { _sobossTmpDir?: string })._sobossTmpDir = dir
  return printer
}

function readRawBuffer(printer: ThermalPrinter): Buffer {
  const tagged = printer as ThermalPrinter & { _sobossTmpDir?: string }
  const buffer = printer.getBuffer()
  if (buffer?.length) return Buffer.from(buffer)

  const iface = String((printer as { interface?: string }).interface ?? '')
  if (iface) {
    try {
      return readFileSync(iface)
    } catch {
      /* fall through */
    }
  }

  if (tagged._sobossTmpDir) {
    rmSync(tagged._sobossTmpDir, { recursive: true, force: true })
  }
  throw new Error('Failed to build ESC/POS buffer')
}

function cleanupTmp(printer: ThermalPrinter): void {
  const tagged = printer as ThermalPrinter & { _sobossTmpDir?: string }
  if (tagged._sobossTmpDir) {
    rmSync(tagged._sobossTmpDir, { recursive: true, force: true })
    tagged._sobossTmpDir = undefined
  }
}

function money(n: number): string {
  return n.toFixed(2)
}

function formatKotTicket(printer: ThermalPrinter, payload: KotPrintPayload): void {
  printer.alignCenter()
  printer.bold(true)
  printer.println('KITCHEN ORDER')
  printer.bold(false)
  printer.drawLine()

  printer.alignLeft()
  printer.leftRight(`Kitchen: ${payload.station}`, `Time: ${formatTime(payload.placed_at)}`)
  if (payload.table) printer.println(`Table: ${payload.table}`)
  if (payload.order_id) printer.println(`Order: ${payload.order_id.slice(0, 8)}`)
  printer.drawLine('-')

  for (const line of payload.lines) {
    printer.bold(true)
    printer.println(`${line.qty}x ${line.name}`)
    printer.bold(false)
    if (line.mods.length) printer.println(`   + ${line.mods.join(', ')}`)
    if (line.notes) printer.println(`   * ${line.notes}`)
  }

  printer.drawLine()
  printer.cut()
}

function formatBillReceipt(printer: ThermalPrinter, payload: KotPrintPayload): void {
  printer.alignCenter()
  printer.bold(true)
  printer.println('BILL')
  printer.bold(false)
  if (payload.table) printer.println(`Table: ${payload.table}`)
  printer.drawLine()

  printer.alignLeft()
  printer.leftRight(`Time: ${formatTime(payload.placed_at)}`, '')
  if (payload.order_id) printer.println(`Order: ${payload.order_id.slice(0, 8)}`)
  printer.drawLine('-')

  for (const line of payload.lines) {
    const amount = line.qty * (line.unit_price ?? 0)
    printer.leftRight(`${line.qty}x ${line.name}`, money(amount))
    if (line.mods.length) printer.println(`   + ${line.mods.join(', ')}`)
    if (line.notes) printer.println(`   * ${line.notes}`)
  }

  printer.drawLine('-')
  printer.bold(true)
  // Use the pre-computed order total when available (accurate; includes modifiers
  // and any rounding). Fall back to summing lines for legacy payloads.
  const total =
    payload.total ??
    payload.lines.reduce((sum, l) => sum + l.qty * (l.unit_price ?? 0), 0)
  printer.leftRight('TOTAL', money(total))
  printer.bold(false)
  printer.drawLine()
  printer.cut()
}

export function formatKotEscPos(payload: KotPrintPayload, paperWidth: PaperWidth = '58mm'): Buffer {
  const printer = createBufferPrinter(paperWidth)

  if ((payload.job_type ?? 'KOT').toUpperCase() === 'BILL') {
    formatBillReceipt(printer, payload)
  } else {
    formatKotTicket(printer, payload)
  }

  try {
    return readRawBuffer(printer)
  } finally {
    cleanupTmp(printer)
  }
}

export function formatTestKotEscPos(station = 'KITCHEN', paperWidth: PaperWidth = '58mm'): Buffer {
  return formatKotEscPos(
    {
      station,
      order_id: 'TEST-001',
      table: 'T99',
      placed_at: new Date().toISOString(),
      lines: [
        { qty: 1, name: 'Margherita Pizza', mods: ['Extra Cheese'], notes: 'Well done', unit_price: 280 },
        { qty: 2, name: 'Lime Soda', mods: [], notes: '', unit_price: 60 },
      ],
      total: 400,
    },
    paperWidth,
  )
}
