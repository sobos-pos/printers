import type { PrinterRow } from '../types'
import { escposPrinter } from './escposPrinter'
import { simulatedPrinter } from './simulatedPrinter'

export interface PrintContext {
  printer: PrinterRow | null
  paperWidth: '58mm' | '80mm'
}

export interface PrinterDriver {
  print(payload: import('../types').KotPrintPayload, ctx: PrintContext): Promise<void>
  isAvailable(ctx: PrintContext): Promise<boolean>
}

export function getPrinterDriver(driverName: string): PrinterDriver {
  return driverName === 'escpos' ? escposPrinter : simulatedPrinter
}
