import { execFile } from 'child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)

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

export async function listWindowsPrinters(): Promise<Array<{ name: string; isDefault: boolean }>> {
  const script =
    'Get-Printer | Select-Object Name, PrinterStatus | ConvertTo-Json -Compress'
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 15000 },
  )
  const trimmed = stdout.trim()
  if (!trimmed) return []
  const parsed = JSON.parse(trimmed) as { Name: string } | Array<{ Name: string }>
  const rows = Array.isArray(parsed) ? parsed : [parsed]
  let defaultName = ''
  try {
    const { stdout: defOut } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-Command', '(Get-Printer | Where-Object Default).Name'],
      { timeout: 10000 },
    )
    defaultName = defOut.trim()
  } catch {
    /* optional */
  }
  return rows.map((r) => ({
    name: r.Name,
    isDefault: Boolean(defaultName && r.Name === defaultName),
  }))
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

export async function isWindowsPrinterAvailable(printerName: string): Promise<boolean> {
  const script = `($null -ne (Get-Printer -Name '${printerName.replace(/'/g, "''")}' -ErrorAction SilentlyContinue))`
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
