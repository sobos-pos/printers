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
  clearConfig: () => ipcRenderer.invoke('clear-config'),
  // v2 node management
  reconnectNode: (data: any) => ipcRenderer.invoke('reconnect-node', data),
  getNodes: (data: any) => ipcRenderer.invoke('get-nodes', data),
  createNode: (data: any) => ipcRenderer.invoke('create-node', data),
  getPrintRoutes: () => ipcRenderer.invoke('get-print-routes'),
  savePrintRoutes: (data: any) => ipcRenderer.invoke('save-print-routes', data),
  getCloudNodes: () => ipcRenderer.invoke('get-cloud-nodes'),
  getClusterNodes: () => ipcRenderer.invoke('get-cluster-nodes'),
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
      clearConfig: () => Promise<any>
      reconnectNode: (data: any) => Promise<any>
      getNodes: (data: any) => Promise<any>
      createNode: (data: any) => Promise<any>
      getPrintRoutes: () => Promise<any>
      savePrintRoutes: (data: any) => Promise<any>
      getCloudNodes: () => Promise<any>
      getClusterNodes: () => Promise<any>
    }
  }
}
