import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('soboss', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  becomeActive: () => ipcRenderer.invoke('become-active'),
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  listOsPrinters: () => ipcRenderer.invoke('list-os-printers'),
  testPrint: (printerName?: string) => ipcRenderer.invoke('test-print', printerName),
  readKotLog: () => ipcRenderer.invoke('read-kot-log'),
  onNewKot: (cb: (segment: unknown) => void) => {
    ipcRenderer.on('new-kot', (_e, segment) => cb(segment))
  },
  login: (credentials: any) => ipcRenderer.invoke('login', credentials),
  provision: (data: any) => ipcRenderer.invoke('provision', data),
  joinCluster: (data: any) => ipcRenderer.invoke('join-cluster', data),
  clearConfig: () => ipcRenderer.invoke('clear-config'),
  generatePairingCode: () => ipcRenderer.invoke('generate-pairing-code'),
})

declare global {
  interface Window {
    soboss: {
      getStatus: () => Promise<Record<string, unknown>>
      becomeActive: () => Promise<{ granted: boolean; reason?: string }>
      getPrinters: () => Promise<{ printers: unknown[]; routes: unknown[] }>
      listOsPrinters: () => Promise<Array<{ name: string; isDefault: boolean }>>
      testPrint: (printerName?: string) => Promise<{ ok: boolean; printer: string }>
      readKotLog: () => Promise<string>
      onNewKot: (cb: (segment: unknown) => void) => void
      login: (credentials: any) => Promise<any>
      provision: (data: any) => Promise<any>
      joinCluster: (data: any) => Promise<any>
      clearConfig: () => Promise<any>
      generatePairingCode: () => Promise<{ pairing_code: string }>
    }
  }
}
