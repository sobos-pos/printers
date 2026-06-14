import { config } from '../config'
import { getDb } from '../db/connection'
import { printerRepository } from '../repositories/printerRepository'

const USB_PRINTER_ID = 'prn-usb-1'

export function upgradeMisconfiguredPrinterDrivers(): void {
  for (const printer of printerRepository.getAllPrinters()) {
    if (printer.connection !== 'simulated' && printer.driver !== 'escpos') {
      printerRepository.upsertPrinter({ ...printer, driver: 'escpos' })
      console.log(`[Boot] Upgraded printer "${printer.name}" to escpos driver`)
    }
  }
}

export function seedLocalPrintersIfEmpty(): void {
  const existing = printerRepository.getAllPrinters()
  if (existing.length) {
    upgradeMisconfiguredPrinterDrivers()
    return
  }

  dbSeedSimulated()
  console.log('[Boot] Seeded simulated printer + KITCHEN/BAR routes')
}

/** Apply PRINTER_NAME + PRINTER_DRIVER=escpos from .env on every boot. */
export function configurePrinterFromEnv(): void {
  if (config.printerDriver !== 'escpos' || !config.printerName) return

  printerRepository.upsertPrinter({
    id: USB_PRINTER_ID,
    name: config.printerName,
    connection: config.printerName,
    driver: 'escpos',
    enabled: 1,
  })

  const db = getDb()
  for (const [station, jobType] of [
    ['KITCHEN', 'KOT'],
    ['BAR', 'KOT'],
    ['KITCHEN', 'BILL'],
  ] as const) {
    db.prepare(
      `INSERT INTO print_routes (station, job_type, printer_id, fallback_printer_id) VALUES (?, ?, ?, NULL)
       ON CONFLICT(station, job_type) DO UPDATE SET printer_id = excluded.printer_id`,
    ).run(station, jobType, USB_PRINTER_ID)
  }

  console.log(`[Boot] USB ESC/POS printer configured: "${config.printerName}" (${config.paperWidth})`)
}

function dbSeedSimulated(): void {
  const db = getDb()
  db.prepare(
    `INSERT OR IGNORE INTO printers (id, name, connection, driver, enabled) VALUES (?, ?, ?, ?, ?)`,
  ).run('prn-simulated-1', 'Simulated Printer', 'simulated', 'simulated', 1)

  for (const [station, jobType] of [
    ['KITCHEN', 'KOT'],
    ['BAR', 'KOT'],
    ['KITCHEN', 'BILL'],
  ] as const) {
    db.prepare(
      `INSERT OR IGNORE INTO print_routes (station, job_type, printer_id, fallback_printer_id) VALUES (?, ?, ?, NULL)`,
    ).run(station, jobType, 'prn-simulated-1')
  }
}
