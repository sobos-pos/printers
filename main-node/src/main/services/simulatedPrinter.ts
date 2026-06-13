import { appendFileSync, mkdirSync } from 'fs'
import { config, isDemoPrinterOffline } from '../config'
import type { KotPrintPayload } from '../types'
import type { PrintContext, PrinterDriver } from './printerDriver'
import { kdsService } from './kdsService'

export const simulatedPrinter: PrinterDriver = {
  async isAvailable(_ctx: PrintContext): Promise<boolean> {
    return !isDemoPrinterOffline()
  },

  async print(payload: KotPrintPayload, _ctx: PrintContext): Promise<void> {
    const line = `[${new Date().toISOString()}] [KOT] ${payload.station}: ${JSON.stringify(payload.lines)}`
    console.log(line)
    mkdirSync(config.dataDir, { recursive: true })
    appendFileSync(config.kotLogPath, line + '\n')
    kdsService.emitKotToRenderer(payload)
  },
}
