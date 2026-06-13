#!/usr/bin/env node
import { listOsPrintersAsync } from '../src/main/services/printerDiscovery.js'

const printers = await listOsPrintersAsync()
if (!printers.length) {
  console.log('No printers found in Windows.')
  console.log('Add your USB 58mm printer in Settings → Bluetooth & devices → Printers & scanners')
  process.exit(1)
}

console.log('Windows printers (copy exact name into main-node/.env PRINTER_NAME):\n')
for (const p of printers) {
  console.log(`${p.isDefault ? '* ' : '  '}${p.name}`)
}
