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
import { seedLocalPrintersIfEmpty, configurePrinterFromEnv } from './bootstrap/seedPrinters'
import { orderRepository } from './repositories/orderRepository'
import { printJobRepository } from './repositories/printJobRepository'
import { syncRepository } from './repositories/syncRepository'
import { printerRepository } from './repositories/printerRepository'
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
    await nodeConfigService.restoreConfig().catch(() => false)

    if (config.clusterRole === 'leader') {
      await menuSyncService.bootstrapMenuFromCloud().catch((err) => {
        console.warn('[Boot] Menu bootstrap failed:', err)
      })
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

  ipcMain.handle('provision', async (_e, { sessionToken, locationId, nodeLabel, stationCodes, electionPriority, managerEmail }) => {
    const res = await fetch(`${config.cloudBaseUrl}/api/v1/auth/provision-node/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`
      },
      body: JSON.stringify({
        location_id: locationId,
        node_label: nodeLabel,
        station_codes: stationCodes,
        election_priority: electionPriority
      })
    })
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as any
      throw new Error(data.error || 'Provisioning failed')
    }
    const data = await res.json() as any
    nodeConfigRepository.set('location_id', data.location.id)
    nodeConfigRepository.set('cloud_api_key', data.api_key.replace(/^sk_live_/, ''))
    nodeConfigRepository.set('node_id', data.node_id)
    nodeConfigRepository.set('cluster_role', data.cluster_role)
    nodeConfigRepository.set('node_label', nodeLabel)
    nodeConfigRepository.set('assigned_stations', JSON.stringify(stationCodes))
    nodeConfigRepository.set('election_priority', String(electionPriority))
    nodeConfigRepository.set('manager_email', managerEmail || '')

    workerManager.startWorkers(data.cluster_role)
    return data
  })

  ipcMain.handle('join-cluster', async (_e, { pairingCode, nodeLabel, stationCodes }) => {
    const { pairingService } = await import('./services/pairingService')
    const payload = pairingService.decodeCode(pairingCode)

    const leaderUrl = `http://${payload.leader_host}:${payload.leader_port}/api/v1/cluster/register`
    const nodeId = `node-${Math.random().toString(36).substring(2, 10)}`

    const os = await import('os')
    const nets = os.networkInterfaces()
    let followerIp = '127.0.0.1'
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          followerIp = net.address
          break
        }
      }
    }

    try {
      const res = await fetch(leaderUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          node_id: nodeId,
          node_label: nodeLabel,
          station_codes: stationCodes,
          election_priority: 10,
          host: followerIp,
          port: config.localApiPort
        })
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as any
        throw new Error(data.error || 'Registration with leader failed')
      }

      const data = await res.json() as any

      nodeConfigRepository.set('location_id', payload.location_id)
      nodeConfigRepository.set('cloud_api_key', payload.cloud_api_key.replace(/^sk_live_/, ''))
      nodeConfigRepository.set('node_id', nodeId)
      nodeConfigRepository.set('cluster_role', 'follower')
      nodeConfigRepository.set('node_label', nodeLabel)
      nodeConfigRepository.set('assigned_stations', JSON.stringify(stationCodes))
      nodeConfigRepository.set('leader_node_id', data.leader_node_id)
      nodeConfigRepository.set('leader_host', payload.leader_host)
      nodeConfigRepository.set('leader_port', String(payload.leader_port))
      nodeConfigRepository.set('leader_status', 'ONLINE')

      workerManager.startWorkers('follower')
      return data
    } catch (err: any) {
      if (err.message.includes('fetch failed') || err.code === 'ECONNREFUSED') {
        throw new Error(`Connection to leader failed (${leaderUrl}). Make sure the Leader node is running on the same network and its API server is active.`)
      }
      throw err
    }
  })

  ipcMain.handle('generate-pairing-code', async () => {
    if (config.clusterRole !== 'leader') {
      throw new Error('Only leader can generate pairing codes')
    }
    const os = await import('os')
    const nets = os.networkInterfaces()
    let leaderIp = '127.0.0.1'
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          leaderIp = net.address
          break
        }
      }
    }
    const { pairingService } = await import('./services/pairingService')
    const code = pairingService.generateCode(leaderIp)
    return { pairing_code: code }
  })

  ipcMain.handle('clear-config', () => {
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

  ipcMain.handle('get-printers', () => ({
    printers: printerRepository.getAllPrinters(),
    routes: printerRepository.getAllRoutes(),
  }))

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
