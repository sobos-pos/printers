import net from 'net'
import { isDemoPrinterOffline, config } from '../config'
import type { KotPrintPayload } from '../types'
import { formatKotEscPos } from './kotFormatter'
import type { PrintContext, PrinterDriver } from './printerDriver'
import { kdsService } from './kdsService'
import { isUsbPrinterAvailable, sendRawToUsbPrinter } from './printerDiscovery'

export type ConnectionTarget =
  | { kind: 'usb'; printerName: string }
  | { kind: 'tcp'; host: string; port: number }

export function parsePrinterConnection(connection: string): ConnectionTarget {
  if (connection.startsWith('tcp://')) {
    const url = new URL(connection)
    return {
      kind: 'tcp',
      host: url.hostname,
      port: parseInt(url.port || '9100', 10),
    }
  }
  return { kind: 'usb', printerName: connection }
}

function sendRawToTcp(host: string, port: number, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.write(data, (err) => {
        socket.end()
        if (err) reject(err)
        else resolve()
      })
    })
    socket.setTimeout(8000, () => {
      socket.destroy()
      reject(new Error(`TCP printer timeout (${host}:${port})`))
    })
    socket.on('error', reject)
  })
}

async function pingTcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.end()
      resolve(true)
    })
    socket.setTimeout(2000, () => {
      socket.destroy()
      resolve(false)
    })
    socket.on('error', () => resolve(false))
  })
}

export async function dispatchEscPos(
  connection: string,
  payload: KotPrintPayload,
  paperWidth: '58mm' | '80mm' = config.paperWidth,
): Promise<void> {
  const raw = formatKotEscPos(payload, paperWidth)
  const target = parsePrinterConnection(connection)

  if (target.kind === 'tcp') {
    await sendRawToTcp(target.host, target.port, raw)
    return
  }

  await sendRawToUsbPrinter(target.printerName, raw)
}

export const escposPrinter: PrinterDriver = {
  async isAvailable(ctx: PrintContext): Promise<boolean> {
    if (isDemoPrinterOffline()) return false
    const connection = ctx.printer?.connection
    if (!connection || connection === 'simulated') return false

    const target = parsePrinterConnection(connection)
    if (target.kind === 'tcp') return pingTcp(target.host, target.port)
    return isUsbPrinterAvailable(target.printerName)
  },

  async print(payload: KotPrintPayload, ctx: PrintContext): Promise<void> {
    const connection = ctx.printer?.connection
    if (!connection) throw new Error('No printer connection configured')

    await dispatchEscPos(connection, payload, ctx.paperWidth)
    console.log(`[KOT] ${payload.station}: printed to ${connection}`)
    kdsService.emitKotToRenderer(payload)
  },
}
