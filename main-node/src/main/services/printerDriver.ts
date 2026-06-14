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

/** Pick escpos when the printer row points at a real OS/TCP device, even if driver was saved wrong. */
export function resolvePrinterDriver(
  printer: PrinterRow | null,
  fallbackDriver = 'simulated',
): PrinterDriver {
  if (printer?.driver === 'escpos') return escposPrinter
  if (printer?.connection && printer.connection !== 'simulated') return escposPrinter
  return getPrinterDriver(printer?.driver ?? fallbackDriver)
}
