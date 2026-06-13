import { listWindowsPrinters, sendRawToWindowsPrinter, isWindowsPrinterAvailable } from './windowsRawPrinter'

export function listOsPrinters(): Array<{ name: string; isDefault: boolean }> {
  if (process.platform !== 'win32') {
    console.warn('[Printer] OS printer listing is only supported on Windows')
    return []
  }
  // Sync wrapper not possible — callers should use listOsPrintersAsync
  return []
}

export async function listOsPrintersAsync(): Promise<Array<{ name: string; isDefault: boolean }>> {
  if (process.platform !== 'win32') return []
  try {
    return await listWindowsPrinters()
  } catch (err) {
    console.warn('[Printer] Could not list OS printers:', err)
    return []
  }
}

export async function sendRawToUsbPrinter(printerName: string, data: Buffer): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('USB RAW printing is only supported on Windows in this build')
  }
  await sendRawToWindowsPrinter(printerName, data)
}

export async function isUsbPrinterAvailable(printerName: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  return isWindowsPrinterAvailable(printerName)
}
