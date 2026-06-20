import { execFile } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

export interface WindowsPrinterInfo {
  name: string
  portName: string
  printerStatus: string
  isDefault: boolean
}

interface WindowsPrinterRaw {
  Name: string
  PortName: string
  PrinterStatus: string | number
  Default: boolean
}

const RAW_PRINT_PS = String.raw`
param(
  [Parameter(Mandatory=$true)][string]$PrinterName,
  [Parameter(Mandatory=$true)][string]$FilePath
)

Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;

public class RawPrinterHelper {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Ansi)]
  public class DOCINFOA {
    [MarshalAs(UnmanagedType.LPStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPStr)] public string pDataType;
  }

  [DllImport("winspool.Drv", EntryPoint="OpenPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool OpenPrinter(string szPrinter, out IntPtr hPrinter, IntPtr pd);

  [DllImport("winspool.Drv", EntryPoint="ClosePrinter", SetLastError=true)]
  public static extern bool ClosePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint="StartDocPrinterA", SetLastError=true, CharSet=CharSet.Ansi)]
  public static extern bool StartDocPrinter(IntPtr hPrinter, int level, [In] DOCINFOA di);

  [DllImport("winspool.Drv", EntryPoint="EndDocPrinter", SetLastError=true)]
  public static extern bool EndDocPrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint="StartPagePrinter", SetLastError=true)]
  public static extern bool StartPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint="EndPagePrinter", SetLastError=true)]
  public static extern bool EndPagePrinter(IntPtr hPrinter);

  [DllImport("winspool.Drv", EntryPoint="WritePrinter", SetLastError=true)]
  public static extern bool WritePrinter(IntPtr hPrinter, IntPtr pBytes, int dwCount, out int dwWritten);

  public static bool SendBytes(string printerName, byte[] bytes) {
    IntPtr hPrinter;
    if (!OpenPrinter(printerName, out hPrinter, IntPtr.Zero)) return false;
    try {
      var di = new DOCINFOA { pDocName = "Soboss KOT", pDataType = "RAW" };
      if (!StartDocPrinter(hPrinter, 1, di)) return false;
      try {
        if (!StartPagePrinter(hPrinter)) return false;
        try {
          IntPtr unmanaged = Marshal.AllocCoTaskMem(bytes.Length);
          try {
            Marshal.Copy(bytes, 0, unmanaged, bytes.Length);
            int written;
            return WritePrinter(hPrinter, unmanaged, bytes.Length, out written);
          } finally {
            Marshal.FreeCoTaskMem(unmanaged);
          }
        } finally {
          EndPagePrinter(hPrinter);
        }
      } finally {
        EndDocPrinter(hPrinter);
      }
    } finally {
      ClosePrinter(hPrinter);
    }
  }
}
"@

$bytes = [System.IO.File]::ReadAllBytes($FilePath)
$ok = [RawPrinterHelper]::SendBytes($PrinterName, $bytes)
if (-not $ok) { throw "RAW print failed for printer: $PrinterName" }
`

export async function listWindowsPrinters(): Promise<WindowsPrinterInfo[]> {
  const script =
    'Get-Printer | Select-Object Name, PortName, PrinterStatus, Default | ConvertTo-Json -Compress'
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 15000 },
  )
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed) as WindowsPrinterRaw | WindowsPrinterRaw[]
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  return rows.map((r) => ({
    name: r.Name,
    portName: r.PortName ?? '',
    printerStatus: typeof r.PrinterStatus === 'number'
      ? PRINTER_STATUS_MAP[r.PrinterStatus] ?? 'Unknown'
      : (r.PrinterStatus ?? 'Unknown'),
    isDefault: Boolean(r.Default),
  }))
}

// https://docs.microsoft.com/en-us/windows/win32/cimwin32prov/win32-printer — PrinterStatus values
const PRINTER_STATUS_MAP: Record<number, string> = {
  1: 'Other', 2: 'Unknown', 3: 'Idle', 4: 'Printing', 5: 'Warmup',
  6: 'Stopped Printing', 7: 'Offline',
}

export async function sendRawToWindowsPrinter(
  printerName: string,
  data: Buffer,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'soboss-raw-'))
  const binPath = join(dir, 'kot.bin')
  const psPath = join(dir, 'print-raw.ps1')
  try {
    writeFileSync(binPath, data)
    writeFileSync(psPath, RAW_PRINT_PS, 'utf-8')
    await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        psPath,
        '-PrinterName',
        printerName,
        '-FilePath',
        binPath,
      ],
      { timeout: 30000 },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * Hardware-level printer availability check.
 *
 * The Windows Print Spooler caches printer objects even after the device is
 * physically disconnected, so a simple `Get-Printer` existence test always
 * returns true. This function goes further:
 *   - USB ports: verifies the PnP device is enumerated by Windows as Status=OK
 *   - COM ports: verifies the serial port is present in SerialPort.GetPortNames()
 *   - Unknown ports: falls back to spooler WorkOffline / PrinterStatus checks
 *
 * Note: TCP/IP printers are handled upstream via a direct socket ping and never
 * reach this function.
 */
export async function isWindowsPrinterAvailable(printerName: string): Promise<boolean> {
  const safeName = printerName.replace(/'/g, "''")

  // Single PowerShell process handles all port types to avoid multiple spawns.
  const script = [
    `$p = Get-Printer -Name '${safeName}' -ErrorAction SilentlyContinue`,
    `if ($null -eq $p) { Write-Output 'false'; exit }`,
    `if ($p.WorkOffline -eq $true) { Write-Output 'false'; exit }`,
    `if ($p.PrinterStatus -eq 7) { Write-Output 'false'; exit }`, // 7 = Offline
    // USB: confirm the physical device is still connected.
    //
    // Thermal/receipt printers do NOT register under PnP -Class Printer.
    // Instead, Windows creates a SoftwareDevice with InstanceId like:
    //   USBPRINT\HAOYIN_CX58D\6&20489CF1&0&USB004
    // This PnP device only exists when the USB cable is physically plugged in.
    // The InstanceId conveniently ends with the spooler port name (e.g. USB004),
    // so we match on that to tie the physical device to this specific printer.
    //
    // PrintQueue PnP devices (SWD\PRINTENUM\...) are software objects that
    // persist with Status OK even after unplugging — never use those.
    `if ($p.PortName -match '^USB\\d+$') {`,
    `  $usbDev = Get-PnpDevice -PresentOnly -Status OK -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -like "USBPRINT\\*$($p.PortName)" }`,
    `  if (-not ($usbDev)) { Write-Output 'false'; exit }`,
    `}`,
    // COM/Bluetooth: confirm the virtual serial port is still present
    `if ($p.PortName -match '^COM\\d+$') {`,
    `  $ports = [System.IO.Ports.SerialPort]::GetPortNames()`,
    `  if ($ports -notcontains $p.PortName) { Write-Output 'false'; exit }`,
    `}`,
    `Write-Output 'true'`,
  ].join('; ')

  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout: 10000 },
    )
    return stdout.trim().toLowerCase() === 'true'
  } catch {
    return false
  }
}
