import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('soboss', {
  getStatus: () => ipcRenderer.invoke('get-status'),
  becomeActive: () => ipcRenderer.invoke('become-active'),
  getPrinters: () => ipcRenderer.invoke('get-printers'),
  getPrinterAssignments: () => ipcRenderer.invoke('get-printer-assignments'),
  savePrinterAssignments: (data: any) => ipcRenderer.invoke('save-printer-assignments', data),
  clearStuckJobs: () => ipcRenderer.invoke('clear-stuck-jobs'),
  wipeLocalData: () => ipcRenderer.invoke('wipe-local-data'),
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
  refreshClusterNodes: () => ipcRenderer.invoke('refresh-cluster-nodes'),
  // menu management
  getMenuGlossary: () => ipcRenderer.invoke('get-menu-glossary'),
  getMenuTree: () => ipcRenderer.invoke('get-menu-tree'),
  createMenuCategory: (data: any) => ipcRenderer.invoke('create-menu-category', data),
  createMenuItem: (data: any) => ipcRenderer.invoke('create-menu-item', data),
  updateMenuItem: (data: any) => ipcRenderer.invoke('update-menu-item', data),
  deleteMenuItem: (data: any) => ipcRenderer.invoke('delete-menu-item', data),
  addMenuItemMedia: (data: any) => ipcRenderer.invoke('add-menu-item-media', data),
  deleteMenuMedia: (data: any) => ipcRenderer.invoke('delete-menu-media', data),
})

declare global {
  interface Window {
    soboss: {
      getStatus: () => Promise<Record<string, unknown>>
      becomeActive: () => Promise<{ granted: boolean; reason?: string }>
      getPrinters: () => Promise<{ printers: unknown[]; routes: unknown[] }>
      getPrinterAssignments: () => Promise<{
        assignments: Array<{
          station_code: string
          station_name: string
          print_type: string
          scope: 'assigned' | 'leader_fallback'
          printer_id: string | null
          printer_name: string | null
        }>
        os_printers: Array<{ name: string; isDefault: boolean }>
      }>
      savePrinterAssignments: (data: {
        assignments: Array<{ station_code: string; print_type: string; printer_name: string }>
      }) => Promise<{ saved: number }>
      clearStuckJobs: () => Promise<{ cleared: number }>
      wipeLocalData: () => Promise<{ deleted: number }>
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
      refreshClusterNodes: () => Promise<any>
      getMenuGlossary: () => Promise<any>
      getMenuTree: () => Promise<any>
      createMenuCategory: (data: any) => Promise<any>
      createMenuItem: (data: any) => Promise<any>
      updateMenuItem: (data: any) => Promise<any>
      deleteMenuItem: (data: any) => Promise<any>
      addMenuItemMedia: (data: any) => Promise<any>
      deleteMenuMedia: (data: any) => Promise<any>
    }
  }
}
