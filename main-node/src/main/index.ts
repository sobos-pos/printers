import { app, BrowserWindow, ipcMain } from 'electron'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { runMigrations } from './db/migrate'
import {
  config,
  isCloudConfigured,
  isDemoCloudBlocked,
  isDemoPrinterOffline,
} from './config'
import { nodeConfigRepository } from './repositories/nodeConfigRepository'
import { nodeConfigService } from './services/nodeConfigService'
import { menuSyncService } from './services/menuSyncService'
import { workerManager } from './workers/workerManager'
import { seedLocalPrintersIfEmpty, configurePrinterFromEnv, upgradeMisconfiguredPrinterDrivers } from './bootstrap/seedPrinters'
import { orderRepository } from './repositories/orderRepository'
import { printJobRepository } from './repositories/printJobRepository'
import { syncRepository } from './repositories/syncRepository'
import { printerRepository } from './repositories/printerRepository'
import { printRouteRepository } from './repositories/printRouteRepository'
import { clusterNodeRepository } from './repositories/clusterNodeRepository'
import { resolvePreloadPath } from './paths'

const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow: BrowserWindow | null = null

function bootstrapSync(): void {
  runMigrations()
  seedLocalPrintersIfEmpty()
  configurePrinterFromEnv()
}

async function bootstrapAsync(): Promise<void> {
  if (isCloudConfigured()) {
    // Restore this node's own printer/route config blob from Cloud.
    await nodeConfigService.restoreConfig().catch(() => false)
    upgradeMisconfiguredPrinterDrivers()

    if (config.clusterRole === 'leader') {
      await menuSyncService.bootstrapMenuFromCloud().catch((err) => {
        console.warn('[Boot] Menu bootstrap failed:', err)
      })

      // Fresh-master restore: pull the full cluster state from Cloud so a brand-new
      // machine taking over as leader has the node inventory + print routing
      // immediately, without waiting for heartbeat peer discovery or a manager re-save.
      const { cloudClient } = await import('./services/cloudClient')

      await cloudClient
        .fetchNodesByApiKey()
        .then(({ nodes }) => {
          for (const n of nodes) {
            if (n.node_id === config.nodeId) continue
            clusterNodeRepository.upsert({
              node_id: n.node_id,
              node_label: n.node_name,
              station_codes: '[]',
              host: n.lan_host ?? '',
              port: n.lan_port ?? 3001,
              status: n.is_online ? 'ONLINE' : 'OFFLINE',
              last_health_check: new Date().toISOString(),
            })
          }
          console.log(`[Boot] Seeded ${nodes.length} nodes from Cloud`)
        })
        .catch((err) => console.warn('[Boot] Node inventory pull failed:', err))

      await cloudClient
        .fetchPrintRoutes()
        .then(({ routes }) => {
          printRouteRepository.upsertAll(
            config.locationId,
            routes.map((r) => ({
              station_code: r.station_code,
              print_type: r.print_type,
              assigned_node_id: r.assigned_node_id,
            })),
          )
          console.log(`[Boot] Seeded ${routes.length} print routes from Cloud`)
        })
        .catch((err) => console.warn('[Boot] Print routes pull failed:', err))

      // Back up the current local printer config so a future replacement master
      // can restore it via restoreConfig().
      await nodeConfigService
        .backupConfig()
        .catch((err) => console.warn('[Boot] Config backup failed:', err))
    }
    workerManager.bootFromState()
  } else {
    console.log('[Boot] Cloud not configured — waiting for Setup Wizard')
  }
}

function createWindow(): void {
  const preloadPath = resolvePreloadPath(__dirname)
  console.log('[Window] Preload:', preloadPath)

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    show: false,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    if (process.env.NODE_ENV !== 'production') {
      mainWindow.webContents.openDevTools({ mode: 'detach' })
    }
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function registerIpc(): void {
  ipcMain.handle('get-status', () => {
    try {
      const leaderId = nodeConfigRepository.get('leader_node_id') || ''
      const leaderHost = nodeConfigRepository.get('leader_host') || ''
      const leaderPort = parseInt(nodeConfigRepository.get('leader_port') || '3001', 10)
      const leaderStatus = nodeConfigRepository.get('leader_status') || 'OFFLINE'

      return {
        node_id: config.nodeId,
        role: config.clusterRole,
        is_active: config.clusterRole === 'leader',
        cloud_base_url: config.cloudBaseUrl,
        cloud_configured: isCloudConfigured(),
        orders_today: orderRepository.countToday(),
        pending_print_jobs:
          printJobRepository.countByStatus('PENDING') +
          printJobRepository.countByStatus('RETRYING'),
        last_cursor: syncRepository.getCursor(config.locationId),
        demo_cloud_blocked: isDemoCloudBlocked(),
        demo_printer_offline: isDemoPrinterOffline(),
        manager_email: nodeConfigRepository.get('manager_email') || '',
        node_label: nodeConfigRepository.get('node_label') || '',
        leader: config.clusterRole === 'follower' ? {
          node_id: leaderId,
          host: leaderHost,
          port: leaderPort,
          status: leaderStatus
        } : null
      }
    } catch (err) {
      console.error('[IPC] get-status failed:', err)
      return {
        node_id: config.nodeId,
        role: 'error',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  })

  ipcMain.handle('become-active', async () => {
    const { clusterService } = await import('./services/clusterService')
    clusterService.switchToLeader()
    return { granted: true }
  })

  ipcMain.handle('login', async (_e, { email, password }) => {
    const res = await fetch(`${config.cloudBaseUrl}/api/v1/auth/login/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as any
      throw new Error(data.error || 'Login failed')
    }
    return res.json()
  })

  ipcMain.handle('reconnect-node', async (_e, { sessionToken, nodeId, managerEmail }) => {
    const { cloudClient } = await import('./services/cloudClient')
    const data = await cloudClient.reconnectNode(sessionToken, nodeId)

    const os = await import('os')
    const nets = os.networkInterfaces()
    let lanHost = '127.0.0.1'
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          lanHost = net.address
          break
        }
      }
    }

    nodeConfigRepository.set('location_id', data.location.id)
    nodeConfigRepository.set('cloud_api_key', data.api_key.replace(/^sk_live_/, ''))
    nodeConfigRepository.set('node_id', data.node_id)
    nodeConfigRepository.set('cluster_role', data.cluster_role)
    nodeConfigRepository.set('node_label', data.node_name)
    nodeConfigRepository.set('manager_email', managerEmail || '')
    nodeConfigRepository.set('lan_host', lanHost)

    workerManager.startWorkers(data.cluster_role as 'leader' | 'follower')
    return data
  })

  ipcMain.handle('get-nodes', async (_e, { sessionToken, locationId }) => {
    const { cloudClient } = await import('./services/cloudClient')
    return cloudClient.fetchNodes(sessionToken, locationId)
  })

  ipcMain.handle('create-node', async (_e, { nodeName }) => {
    const { cloudClient } = await import('./services/cloudClient')
    return cloudClient.createNode(nodeName)
  })

  ipcMain.handle('get-print-routes', async () => {
    const { cloudClient } = await import('./services/cloudClient')
    return cloudClient.fetchPrintRoutes()
  })

  ipcMain.handle('save-print-routes', async (_e, payload) => {
    const { routes, printer_assignments: printerAssignments } = payload ?? {}

    if (printerAssignments) {
      const { printerConfigService } = await import('./services/printerConfigService')
      const saved = await printerConfigService.saveAssignments(printerAssignments)
      return { saved }
    }

    const { cloudClient } = await import('./services/cloudClient')
    const result = await cloudClient.savePrintRoutes(routes)
    // Cache locally for print routing resolution
    printRouteRepository.upsertAll(config.locationId, routes)
    // Persist the local config blob to Cloud so a fresh master can restore it
    const { nodeConfigService } = await import('./services/nodeConfigService')
    await nodeConfigService.backupConfig().catch((err) =>
      console.warn('[Config] backup after save-print-routes failed:', err),
    )
    return result
  })

  // Cloud node inventory (Api-Key authed) — includes offline/never-connected nodes
  ipcMain.handle('get-cloud-nodes', async () => {
    const { cloudClient } = await import('./services/cloudClient')
    return cloudClient.fetchNodesByApiKey()
  })

  // Local cluster_nodes view (heartbeat-populated) — kept for diagnostics
  ipcMain.handle('get-cluster-nodes', () => {
    return { nodes: clusterNodeRepository.listAll() }
  })

  ipcMain.handle('clear-config', async () => {
    // Best-effort: tell Cloud this node is going offline BEFORE wiping the API key,
    // so it's immediately reclaimable in the Setup Wizard (no stale-online lockout).
    if (isCloudConfigured()) {
      const { cloudClient } = await import('./services/cloudClient')
      await cloudClient.markOffline().catch((err) =>
        console.warn('[Config] markOffline on reset failed:', err),
      )
    }

    nodeConfigRepository.delete('location_id')
    nodeConfigRepository.delete('cloud_api_key')
    nodeConfigRepository.delete('node_id')
    nodeConfigRepository.delete('cluster_role')
    nodeConfigRepository.delete('node_label')
    nodeConfigRepository.delete('assigned_stations')
    nodeConfigRepository.delete('leader_node_id')
    nodeConfigRepository.delete('leader_host')
    nodeConfigRepository.delete('leader_port')
    nodeConfigRepository.delete('leader_status')
    nodeConfigRepository.delete('manager_email')

    workerManager.stopAllWorkers()
    return { ok: true }
  })

  ipcMain.handle('get-printers', async () => {
    const base = {
      printers: printerRepository.getAllPrinters(),
      routes: printerRepository.getAllRoutes(),
    }
    try {
      const { printerConfigService } = await import('./services/printerConfigService')
      const { assignments, os_printers } = await printerConfigService.getAssignments()
      return { ...base, assignments, os_printers }
    } catch (err) {
      console.warn('[IPC] get-printers assignments failed:', err)
      return { ...base, assignments: [], os_printers: [] }
    }
  })

  ipcMain.handle('get-printer-assignments', async () => {
    const { printerConfigService } = await import('./services/printerConfigService')
    return printerConfigService.getAssignments()
  })

  ipcMain.handle('save-printer-assignments', async (_e, { assignments }) => {
    const { printerConfigService } = await import('./services/printerConfigService')
    const saved = await printerConfigService.saveAssignments(assignments ?? [])
    return { saved }
  })

  ipcMain.handle('list-os-printers', async () => {
    const { listOsPrintersAsync } = await import('./services/printerDiscovery')
    return listOsPrintersAsync()
  })

  ipcMain.handle('test-print', async (_e, printerName?: string) => {
    const name = printerName || config.printerName
    if (!name) throw new Error('Set PRINTER_NAME in .env or pass a printer name')

    const { dispatchEscPos } = await import('./services/escposPrinter')
    const payload = {
      station: 'KITCHEN',
      order_id: 'TEST-001',
      table: 'T99',
      placed_at: new Date().toISOString(),
      lines: [
        { qty: 1, name: 'Test Print OK', mods: ['58mm USB'], notes: 'Soboss Main Node' },
      ],
    }
    await dispatchEscPos(name, payload, config.paperWidth)
    return { ok: true, printer: name }
  })

  ipcMain.handle('read-kot-log', async () => {
    try {
      const { readFileSync } = await import('fs')
      return readFileSync(config.kotLogPath, 'utf-8')
    } catch {
      return ''
    }
  })
}

app.whenReady().then(async () => {
  registerIpc()
  bootstrapSync()
  createWindow()
  await bootstrapAsync()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  workerManager.stopAllWorkers()
  if (process.platform !== 'darwin') app.quit()
})
