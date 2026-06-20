import { app, BrowserWindow, ipcMain } from 'electron'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { runMigrations } from './db/migrate'
import { getDb } from './db/connection'
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
import { setMainWindow } from './windowBridge'
import { getLanIp } from './net'

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

    // Back-fill staff-token verification material (Layer 1) for devices
    // provisioned before this feature, and pick up a rotated secret. Best-effort:
    // if cloud is unreachable we keep whatever secret we already stored.
    if (!config.jwtSecret || !config.restaurantId) {
      const { cloudClient: authClient } = await import('./services/cloudClient')
      await authClient
        .fetchAuthMaterial()
        .then((m) => {
          nodeConfigRepository.set('restaurant_id', m.restaurant_id)
          nodeConfigRepository.set('jwt_secret', m.jwt_secret)
          console.log('[Boot] Fetched staff-auth material')
        })
        .catch((err) => console.warn('[Boot] Auth material fetch failed:', err))
    }

    if (config.clusterRole === 'leader') {
      await menuSyncService.bootstrapMenuFromCloud().catch((err) => {
        console.warn('[Boot] Menu bootstrap failed:', err)
      })

      // Fresh-master restore: pull the full cluster state from Cloud so a brand-new
      // machine taking over as leader has the node inventory + print routing
      // immediately, without waiting for heartbeat peer discovery or a manager re-save.
      const { cloudClient } = await import('./services/cloudClient')

      // Warm up table→section mapping so BILL routing works from order #1,
      // without waiting for waiters to open each table's menu first.
      try {
        const { tables } = await cloudClient.fetchTables()
        const { menuService } = await import('./services/menuService')
        let warmed = 0
        for (const t of tables) {
          if (t.section) {
            menuService.storeSectionForTable(t.id, t.section.code, t.section.name)
            warmed++
          }
        }
        console.log(`[Boot] Warmed ${warmed}/${tables.length} table→section mappings`)
      } catch (err) {
        console.warn('[Boot] Table section warmup failed:', err)
      }

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
              // Seed metadata only. Status is derived from contact freshness, and
              // we deliberately do NOT stamp last_health_check here — a seeded node
              // we haven't actually reached must read OFFLINE until a real heartbeat
              // or health check arrives. (upsert preserves any genuine prior contact.)
              status: 'OFFLINE',
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

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    if (mainWindow) setMainWindow(mainWindow)
  })

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
        kots_printed_today: printJobRepository.countPrintedToday(),
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

    // Force-promotion MUST claim the cloud lease first. Otherwise we only flip
    // the local role to leader, and the very next cloud heartbeat (is_active=true)
    // fails to claim — the old leader still holds a fresh lease — so the cloud
    // resolves our role back to 'follower' and heartbeatWorker demotes us within
    // one heartbeat interval. force=true overrides a live lease and demotes the
    // previous holder in the same transaction, making the promotion durable.
    if (isCloudConfigured()) {
      try {
        const { cloudClient } = await import('./services/cloudClient')
        const result = await cloudClient.claimActive(true)
        if (!result.granted) {
          return { granted: false, reason: JSON.stringify(result.detail) }
        }
      } catch (err) {
        // Cloud unreachable — fall back to a local-only promotion so a LAN
        // island can still elect a leader. The cloud reconciles on reconnect
        // (if the real leader is alive it reclaims; if it's down our next
        // is_active heartbeat claims the now-expired lease).
        console.warn(
          '[Promote] Cloud lease claim failed, promoting locally only:',
          err instanceof Error ? err.message : err,
        )
      }
    }

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

    const lanHost = getLanIp()

    nodeConfigRepository.set('location_id', data.location.id)
    nodeConfigRepository.set('cloud_api_key', data.api_key.replace(/^sk_live_/, ''))
    nodeConfigRepository.set('node_id', data.node_id)
    nodeConfigRepository.set('cluster_role', data.cluster_role)
    nodeConfigRepository.set('node_label', data.node_name)
    nodeConfigRepository.set('manager_email', managerEmail || '')
    nodeConfigRepository.set('lan_host', lanHost)
    // Device auth material for verifying staff JWTs offline (Layer 1 → Layer 2).
    if (data.restaurant_id) nodeConfigRepository.set('restaurant_id', data.restaurant_id)
    if (data.jwt_secret) nodeConfigRepository.set('jwt_secret', data.jwt_secret)

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

  // ── Menu management (cloud is the source of truth) ──────────────────────
  // Reads proxy straight to cloud; writes go to cloud (which bumps the menu
  // version) and then force a local cache refresh so this node serves the
  // updated menu immediately instead of waiting for the next poll tick.
  const refreshMenuCache = async () => {
    try {
      await menuSyncService.fetchAndCacheMenu(0)
    } catch (err) {
      console.warn('[Menu] cache refresh after write failed:', err)
    }
  }

  ipcMain.handle('get-menu-glossary', async () => {
    const { cloudClient } = await import('./services/cloudClient')
    return cloudClient.fetchMenuGlossary()
  })

  ipcMain.handle('get-menu-tree', async () => {
    const { cloudClient } = await import('./services/cloudClient')
    return cloudClient.fetchMenuTree()
  })

  ipcMain.handle('create-menu-category', async (_e, payload) => {
    const { cloudClient } = await import('./services/cloudClient')
    const result = await cloudClient.createMenuCategory(payload)
    await refreshMenuCache()
    return result
  })

  ipcMain.handle('create-menu-item', async (_e, payload) => {
    const { cloudClient } = await import('./services/cloudClient')
    const result = await cloudClient.createMenuItem(payload)
    await refreshMenuCache()
    return result
  })

  ipcMain.handle('update-menu-item', async (_e, { itemId, ...payload }) => {
    const { cloudClient } = await import('./services/cloudClient')
    const result = await cloudClient.updateMenuItem(itemId, payload)
    await refreshMenuCache()
    return result
  })

  ipcMain.handle('delete-menu-item', async (_e, { itemId }) => {
    const { cloudClient } = await import('./services/cloudClient')
    const result = await cloudClient.deleteMenuItem(itemId)
    await refreshMenuCache()
    return result
  })

  ipcMain.handle('add-menu-item-media', async (_e, { itemId, image }) => {
    const { cloudClient } = await import('./services/cloudClient')
    const result = await cloudClient.addMenuItemMedia(itemId, image)
    await refreshMenuCache()
    return result
  })

  ipcMain.handle('delete-menu-media', async (_e, { mediaId }) => {
    const { cloudClient } = await import('./services/cloudClient')
    const result = await cloudClient.deleteMenuMedia(mediaId)
    await refreshMenuCache()
    return result
  })

  // Cloud node inventory (Api-Key authed) — includes offline/never-connected nodes
  ipcMain.handle('get-cloud-nodes', async () => {
    const { cloudClient } = await import('./services/cloudClient')
    return cloudClient.fetchNodesByApiKey()
  })

  // Local cluster_nodes view — the leader's authoritative follower status, shown
  // in Node Management. status is derived from contact freshness (not the stored
  // flag) so it's always live: ONLINE only with recent contact, else OFFLINE.
  ipcMain.handle('get-cluster-nodes', () => {
    const nodes = clusterNodeRepository.listAll().map((n) => ({
      ...n,
      status: clusterNodeRepository.isOnline(n) ? 'ONLINE' : 'OFFLINE',
    }))
    return { nodes }
  })

  // Manual refresh: run an immediate identity-verified health-check round so the
  // UI reflects real current state right away instead of waiting for the next
  // scheduled tick. Only the leader probes; followers just re-render.
  ipcMain.handle('refresh-cluster-nodes', async () => {
    if (config.clusterRole === 'leader') {
      const { clusterService } = await import('./services/clusterService')
      await clusterService.runFollowerHealthChecks().catch((err) =>
        console.warn('[Refresh] health check round failed:', err),
      )
    }
    const nodes = clusterNodeRepository.listAll().map((n) => ({
      ...n,
      status: clusterNodeRepository.isOnline(n) ? 'ONLINE' : 'OFFLINE',
    }))
    return { nodes }
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
    // Decommission must not leave the staff-token secret on the device.
    nodeConfigRepository.delete('restaurant_id')
    nodeConfigRepository.delete('jwt_secret')

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

  ipcMain.handle('clear-stuck-jobs', () => {
    // Expires ALL pending/retrying jobs regardless of age — used to manually
    // clear a backlog built up while a printer was offline.
    const cleared = printJobRepository.expireStaleJobs(0)
    return { cleared }
  })

  ipcMain.handle('wipe-local-data', () => {
    // Wipes all operational data from the local SQLite database while keeping
    // node_config intact (so the node stays connected to Cloud after the wipe).
    // Used after a full cloud wipe to start fresh without needing to re-run
    // the Setup Wizard.
    workerManager.stopAllWorkers()
    const db = getDb()
    const tables = [
      'remote_print_jobs',
      'cluster_nodes',
      'node_state',
      'print_routes',
      'printers',
      'menu_cache',
      'sync_cursor',
      'sync_log',
      'print_jobs',
      'orders', // cascades order_items and order_item_modifiers
    ]
    let totalDeleted = 0
    for (const t of tables) {
      const result = db.prepare(`DELETE FROM ${t}`).run() as { changes: number }
      totalDeleted += result.changes
    }
    // Restart workers so the node resumes printing / heartbeat immediately.
    if (isCloudConfigured()) {
      workerManager.bootFromState()
    }
    return { deleted: totalDeleted }
  })

  ipcMain.handle('list-os-printers', async () => {
    const { listOsPrintersAsync } = await import('./services/printerDiscovery')
    return listOsPrintersAsync({ includeHardwareStatus: true })
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
