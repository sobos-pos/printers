import net from 'net'
import {
  listWindowsPrinters,
  sendRawToWindowsPrinter,
  isWindowsPrinterAvailable,
} from './windowsRawPrinter'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface OsPrinterInfo {
  name: string
  portName: string
  portType: 'usb' | 'tcp' | 'com' | 'unknown'
  isDefault: boolean
  /** 'unknown' when hardware check is skipped (e.g. during fast boot enumeration) */
  hardwareStatus: 'active' | 'inactive' | 'unknown'
}

// ─── Port type detection ──────────────────────────────────────────────────────

function detectPortType(portName: string): OsPrinterInfo['portType'] {
  if (!portName) return 'unknown'
  if (/^COM\d+$/i.test(portName)) return 'com'
  if (/^USB\d+$/i.test(portName)) return 'usb'
  // Printer port names that are bare IP addresses (e.g. from Standard TCP/IP port monitor)
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(portName)) return 'tcp'
  return 'unknown'
}

// ─── Hardware verification ────────────────────────────────────────────────────

/**
 * TCP/IP printers: attempt a direct socket connection to port 9100.
 * If the printer is powered off or unreachable the connection will be refused
 * or time out — the spooler status is intentionally ignored.
 */
function pingTcp(host: string, port = 9100, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port }, () => {
      socket.end()
      resolve(true)
    })
    socket.setTimeout(timeoutMs, () => {
      socket.destroy()
      resolve(false)
    })
    socket.on('error', () => resolve(false))
  })
}

async function checkHardwareStatus(
  name: string,
  portName: string,
  portType: OsPrinterInfo['portType'],
): Promise<OsPrinterInfo['hardwareStatus']> {
  try {
    if (portType === 'tcp') {
      return (await pingTcp(portName)) ? 'active' : 'inactive'
    }
    // USB and COM are handled by a single PowerShell call in isWindowsPrinterAvailable
    if (portType === 'usb' || portType === 'com') {
      return (await isWindowsPrinterAvailable(name)) ? 'active' : 'inactive'
    }
    return 'unknown'
  } catch {
    return 'unknown'
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Enumerate all Windows printers with optional hardware-level status probes.
 *
 * Without `includeHardwareStatus`, returns quickly with `hardwareStatus: 'unknown'`
 * for every printer — suitable for boot-time enumeration.
 *
 * With `includeHardwareStatus: true`, probes each printer in parallel:
 *   - USB/COM printers → PowerShell PnP / SerialPort check → 'active' | 'inactive'
 *   - TCP printers      → direct socket ping to port 9100  → 'active' | 'inactive'
 *   - Virtual printers  → no physical port to check        → 'unknown'
 *
 * All printers are always returned regardless of status so the UI can show a
 * complete list with indicators. Callers decide what to do with inactive ones.
 */
export async function listOsPrintersAsync(opts?: {
  includeHardwareStatus?: boolean
}): Promise<OsPrinterInfo[]> {
  if (process.platform !== 'win32') return []

  try {
    const raw = await listWindowsPrinters()

    if (!opts?.includeHardwareStatus) {
      return raw.map((p) => ({
        name: p.name,
        portName: p.portName,
        portType: detectPortType(p.portName),
        isDefault: p.isDefault,
        hardwareStatus: 'unknown' as const,
      }))
    }

    // Probe all printers in parallel. Returns every printer — active, inactive,
    // and unknown — so the UI list is complete. The dropdown narrows to active only.
    return Promise.all(
      raw.map(async (p) => {
        const portType = detectPortType(p.portName)
        const hardwareStatus = await checkHardwareStatus(p.name, p.portName, portType)
        return { name: p.name, portName: p.portName, portType, isDefault: p.isDefault, hardwareStatus }
      }),
    )
  } catch (err) {
    console.warn('[Printer] Could not list OS printers:', err)
    return []
  }
}

// ─── Compat wrappers (used by printerDiscovery callers) ──────────────────────

export async function sendRawToUsbPrinter(printerName: string, data: Buffer): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error('USB RAW printing is only supported on Windows in this build')
  }
  await sendRawToWindowsPrinter(printerName, data)
}

/** Hardware-level USB/COM availability check. TCP printers bypass this — see escposPrinter. */
export async function isUsbPrinterAvailable(printerName: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  return isWindowsPrinterAvailable(printerName)
}
