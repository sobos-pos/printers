function showPanel(name: string): void {
  document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'))
  document.querySelectorAll('nav button').forEach((b) => b.classList.remove('active'))
  document.getElementById(`panel-${name}`)?.classList.add('active')
  document.querySelector(`nav button[data-panel="${name}"]`)?.classList.add('active')
}

function setBadge(text: string, styleClass: 'active' | 'standby' | 'unconfigured'): void {
  const badge = document.getElementById('role-badge')!
  badge.textContent = text
  badge.className = `badge badge-${styleClass}`
}

function showToast(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info'): void {
  const container = document.getElementById('toast-container')!
  const toast = document.createElement('div')
  toast.className = `toast toast-${type}`

  let icon = 'ℹ️'
  if (type === 'success') icon = '✅'
  if (type === 'error') icon = '❌'
  if (type === 'warning') icon = '⚠️'

  toast.innerHTML = `<span>${icon}</span><span style="flex:1">${message}</span>`
  container.appendChild(toast)

  setTimeout(() => { toast.remove() }, 5000)
}

function showError(message: string): void {
  setBadge('Error', 'standby')
  const grid = document.getElementById('status-grid')!
  grid.innerHTML = `<div class="card" style="grid-column:1/-1"><h3>Error</h3><p style="font-size:14px">${message}</p></div>`
}

function api() {
  if (!window.soboss) throw new Error('Preload bridge not loaded — restart the app')
  return window.soboss
}

document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const panel = (btn as HTMLButtonElement).dataset.panel!
    showPanel(panel)
    if (panel === 'nodes') refreshNodeManagement()
    if (panel === 'cluster') refreshClusterStatus()
  })
})

// ─── Setup Wizard state ───────────────────────────────────────────────
let sessionToken = ''
let selectedLocationId = ''

function wizardGoTo(step: string): void {
  document.querySelectorAll('.step').forEach((s) => s.classList.remove('active'))
  document.getElementById(`setup-step-${step}`)?.classList.add('active')
}

// Step 1 — Login
const btnLogin = document.getElementById('btn-login')!
const loginEmail = document.getElementById('login-email') as HTMLInputElement
const loginPassword = document.getElementById('login-password') as HTMLInputElement
const loginError = document.getElementById('login-error')!

btnLogin.addEventListener('click', async () => {
  loginError.style.display = 'none'
  const email = loginEmail.value.trim()
  const password = loginPassword.value.trim()

  if (!email || !password) {
    loginError.textContent = 'Please enter email and password.'
    loginError.style.display = 'block'
    return
  }

  btnLogin.textContent = 'Logging in…'
  ;(btnLogin as HTMLButtonElement).disabled = true

  try {
    const data = await api().login({ email, password })
    sessionToken = data.session_token

    const selectLocation = document.getElementById('select-location') as HTMLSelectElement
    selectLocation.innerHTML = ''
    if (data.restaurants && data.restaurants.length > 0) {
      data.restaurants.forEach((r: any) => {
        r.locations.forEach((loc: any) => {
          const opt = document.createElement('option')
          opt.value = loc.id
          opt.textContent = `${r.name} — ${loc.name}`
          selectLocation.appendChild(opt)
        })
      })
    }

    if (selectLocation.children.length === 0) throw new Error('No locations found for this account.')

    showToast('Authenticated successfully.', 'success')
    wizardGoTo('location')
  } catch (err: any) {
    loginError.textContent = err.message || 'Login failed.'
    loginError.style.display = 'block'
    showToast(err.message || 'Login failed.', 'error')
  } finally {
    btnLogin.textContent = 'Next Step'
    ;(btnLogin as HTMLButtonElement).disabled = false
  }
})

// Step 2 — Select Location
document.getElementById('btn-location-back')!.addEventListener('click', () => wizardGoTo('login'))

document.getElementById('btn-location-next')!.addEventListener('click', async () => {
  const locationError = document.getElementById('location-error')!
  locationError.style.display = 'none'
  const selectLocation = document.getElementById('select-location') as HTMLSelectElement
  selectedLocationId = selectLocation.value

  const btn = document.getElementById('btn-location-next') as HTMLButtonElement
  btn.disabled = true
  btn.textContent = 'Loading nodes…'

  try {
    const result = await api().getNodes({ sessionToken, locationId: selectedLocationId })
    // A node is connectable if it is offline, OR its heartbeat is stale (no beat in
    // > 2 min) — the latter covers crashes / unclean exits where the backend never
    // got told the node went away and `is_online` is stuck true.
    const STALE_SECONDS = 120
    const isConnectable = (n: any) =>
      !n.is_online || n.last_seen_seconds == null || n.last_seen_seconds > STALE_SECONDS
    const nodes: any[] = (result.nodes || []).filter(isConnectable)
    const nodeList = document.getElementById('node-list')!

    if (nodes.length === 0) {
      nodeList.innerHTML = `<p style="color:var(--text-muted);font-size:13px">No available nodes found for this location. Add nodes from the Leader's Node Management tab first.</p>`
    } else {
      nodeList.innerHTML = nodes.map((n: any) => {
        const stale = n.is_online && n.last_seen_seconds != null && n.last_seen_seconds > STALE_SECONDS
        const statusLabel = stale ? '🟠 Stale (reclaimable)' : '🔴 Offline'
        return `
        <div class="node-item">
          <div class="node-item-info">
            <span class="node-item-name">${n.node_name}</span>
            <span class="node-item-meta">${n.node_id} &nbsp;·&nbsp; ${n.cluster_role}</span>
          </div>
          <div style="display:flex;align-items:center;gap:10px">
            <span class="node-item-status">${statusLabel}</span>
            <button class="btn btn-sm" data-node-id="${n.node_id}" data-node-name="${n.node_name}">Connect</button>
          </div>
        </div>
      `}).join('')

      nodeList.querySelectorAll('button[data-node-id]').forEach((btn) => {
        btn.addEventListener('click', () => connectToNode(
          (btn as HTMLElement).dataset.nodeId!,
          (btn as HTMLElement).dataset.nodeName!,
          btn as HTMLButtonElement
        ))
      })
    }

    wizardGoTo('nodes')
  } catch (err: any) {
    locationError.textContent = err.message || 'Failed to fetch nodes.'
    locationError.style.display = 'block'
    showToast(err.message || 'Failed to fetch nodes.', 'error')
  } finally {
    btn.disabled = false
    btn.textContent = 'Next Step'
  }
})

document.getElementById('btn-nodes-back')!.addEventListener('click', () => wizardGoTo('location'))

async function connectToNode(nodeId: string, nodeName: string, btn: HTMLButtonElement): Promise<void> {
  const nodesError = document.getElementById('nodes-error')!
  nodesError.style.display = 'none'
  btn.disabled = true
  btn.textContent = 'Connecting…'

  try {
    await api().reconnectNode({
      sessionToken,
      nodeId,
      managerEmail: loginEmail.value.trim()
    })

    loginEmail.value = ''
    loginPassword.value = ''
    sessionToken = ''

    showToast(`Connected as "${nodeName}" successfully.`, 'success')
    await refreshStatus()
  } catch (err: any) {
    nodesError.textContent = err.message || 'Failed to connect.'
    nodesError.style.display = 'block'
    showToast(err.message || 'Connection failed.', 'error')
    btn.disabled = false
    btn.textContent = 'Connect'
  }
}

// ─── Clear config / Logout ────────────────────────────────────────────
document.getElementById('clear-config-btn')!.addEventListener('click', async () => {
  if (confirm('Are you sure you want to reset this node? All configurations will be lost.')) {
    try {
      await api().clearConfig()
      showToast('Node configuration cleared.', 'success')
      await refreshStatus()
    } catch (err: any) {
      showToast(`Reset failed: ${err.message}`, 'error')
    }
  }
})

document.getElementById('logout-btn')!.addEventListener('click', async () => {
  if (confirm('Are you sure you want to log out and decommission this POS station?')) {
    try {
      await api().clearConfig()
      showToast('Logged out successfully.', 'success')
      await refreshStatus()
    } catch (err: any) {
      showToast(`Logout failed: ${err.message}`, 'error')
    }
  }
})

// ─── Status panel ────────────────────────────────────────────────────
async function refreshStatus(): Promise<void> {
  try {
    const s = await api().getStatus()
    if (s.role === 'error') {
      showError(String(s.error ?? 'Unknown error'))
      return
    }

    const configured = Boolean(s.cloud_configured)
    const profileSection = document.getElementById('profile-section')!
    if (!configured) {
      document.querySelector('nav')?.setAttribute('style', 'display: none')
      profileSection.style.display = 'none'
      // Only jump to the login step when first entering setup. The status poll
      // runs every 5s while unconfigured (the whole onboarding period); resetting
      // the step here would kick the user back to login mid-wizard.
      const setupAlreadyActive = document.getElementById('panel-setup')?.classList.contains('active')
      showPanel('setup')
      if (!setupAlreadyActive) wizardGoTo('login')
      setBadge('Unconfigured', 'unconfigured')
      return
    }

    document.querySelector('nav')?.removeAttribute('style')
    profileSection.style.display = 'flex'

    const activePanel = document.querySelector('.panel.active')
    if (!activePanel || activePanel.id === 'panel-setup') {
      showPanel('status')
    }

    const role = String(s.role ?? 'unknown')
    setBadge(
      role === 'leader' ? '🟢 Leader' : '🟡 Follower',
      role === 'leader' ? 'active' : 'standby'
    )

    const profileUser = document.getElementById('profile-user')!
    profileUser.textContent = s.manager_email ? `👤 ${s.manager_email}` : (role === 'leader' ? '👤 Leader' : '👤 Follower')

    // Show/hide role-specific nav tabs
    const navNodes = document.getElementById('nav-nodes-btn')!
    const navCluster = document.getElementById('nav-cluster-btn')!
    navNodes.style.display = role === 'leader' ? 'inline-flex' : 'none'
    navCluster.style.display = role === 'follower' ? 'inline-flex' : 'none'

    // Show/hide HA cards
    const cardEmergency = document.getElementById('card-offline-emergency')!
    cardEmergency.style.display = role === 'follower' ? 'block' : 'none'

    const grid = document.getElementById('status-grid')!

    let leaderSectionHtml = ''
    if (role === 'follower' && s.leader) {
      const l = s.leader as any
      leaderSectionHtml = `
        <div class="card" style="grid-column: 1/-1; border-color: var(--primary)">
          <h3>Active Leader Details</h3>
          <p style="font-size: 16px; font-weight: normal; margin-top: 4px">
            Node: <strong>${l.node_id}</strong> &nbsp;|&nbsp;
            Address: <strong>${l.host}:${l.port}</strong> &nbsp;|&nbsp;
            Status: <span style="color: ${l.status === 'ONLINE' ? 'var(--success)' : 'var(--error)'}; font-weight: bold">${l.status}</span>
          </p>
        </div>
      `
    }

    const cardsHtml = [
      ['Node ID', s.node_id],
      ['Cluster Role', s.role],
      ['Cloud Connection', s.cloud_configured ? s.cloud_base_url : 'Not configured'],
      ['Orders Processed Today', s.orders_today],
      ['Pending Local Prints', s.pending_print_jobs],
      ['Sync Cursor', s.last_cursor],
      ['Cloud Blocked (Demo)', s.demo_cloud_blocked],
      ['Printer Offline (Demo)', s.demo_printer_offline],
    ]
      .map(([label, val]) =>
        `<div class="card"><h3>${label}</h3><p style="font-size:${String(val).length > 25 ? '13' : '20'}px">${val}</p></div>`
      )
      .join('')

    grid.innerHTML = leaderSectionHtml + cardsHtml
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err))
  }
}

// ─── KOT Log ─────────────────────────────────────────────────────────
async function refreshKotLog(): Promise<void> {
  try {
    const log = await api().readKotLog()
    const el = document.getElementById('kot-log')!
    el.textContent = log || 'No KOT output yet.'
    el.scrollTop = el.scrollHeight
  } catch { /* status panel shows the error */ }
}

// ─── Printers ────────────────────────────────────────────────────────
async function refreshOsPrinters(): Promise<void> {
  try {
    const list = await api().listOsPrinters()
    const el = document.getElementById('os-printers-list')!
    if (!list.length) {
      el.textContent = 'No OS printers found.'
      return
    }
    el.textContent = list.map((p) => `${p.isDefault ? '★ ' : '  '}${p.name}`).join('\n')
  } catch (err) {
    document.getElementById('os-printers-list')!.textContent = String(err)
  }
}

document.getElementById('refresh-os-printers-btn')!.addEventListener('click', () => {
  refreshOsPrinters()
  refreshPrinters()
  showToast('Printers list refreshed.', 'success')
})

document.getElementById('test-print-btn')!.addEventListener('click', async () => {
  const btn = document.getElementById('test-print-btn') as HTMLButtonElement
  btn.disabled = true
  btn.textContent = 'Printing…'
  try {
    const result = await api().testPrint()
    showToast(`Test print sent to: ${result.printer}`, 'success')
  } catch (err) {
    showToast(String(err), 'error')
  } finally {
    btn.disabled = false
    btn.textContent = 'Test Print Page'
  }
})

async function refreshPrinters(): Promise<void> {
  try {
    const { printers } = await api().getPrinters()
    const tbody = document.querySelector('#printers-table tbody')!
    tbody.innerHTML = (printers as Array<Record<string, unknown>>)
      .map((p) => `<tr><td>${p.id}</td><td>${p.name}</td><td>${p.driver}</td><td>${p.connection}</td></tr>`)
      .join('')
  } catch { /* status panel shows the error */ }
}

// ─── Force promote ────────────────────────────────────────────────────
document.getElementById('become-active-btn')!.addEventListener('click', async () => {
  const ok = confirm('Force promote this node to Leader? Only do this if the primary Leader is offline.')
  if (!ok) return
  const btn = document.getElementById('become-active-btn') as HTMLButtonElement
  btn.disabled = true
  try {
    await api().becomeActive()
    showToast('Force promotion successful — role switched to leader.', 'success')
    refreshStatus()
  } catch (err) {
    showToast(`Force promotion failed: ${String(err)}`, 'error')
  } finally {
    btn.disabled = false
  }
})

// ─── Node Management (Leader) ─────────────────────────────────────────
// cachedNodes holds the full Cloud node inventory (online + offline), so offline
// nodes are visible and selectable for routing before they have ever connected.
let cachedNodes: any[] = []
let cachedRoutes: any[] = []

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)
  )
}

async function refreshNodeManagement(): Promise<void> {
  try {
    const [routesResult, nodesResult] = await Promise.all([
      api().getPrintRoutes(),
      api().getCloudNodes(),
    ])

    cachedRoutes = routesResult.routes || []
    cachedNodes = nodesResult.nodes || []

    renderNodesTable()
    renderRoutingTable()
  } catch (err: any) {
    showToast(`Failed to load node management: ${err.message}`, 'error')
  }
}

function onlineIcon(isOnline: boolean | null): string {
  if (isOnline === null || isOnline === undefined) return '⚫ —'
  return isOnline ? '🟢 Online' : '🔴 Offline'
}

function renderRoutingTable(): void {
  const tbody = document.getElementById('routing-table-body')!
  if (cachedRoutes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--text-muted)">No stations configured on Cloud.</td></tr>'
    return
  }

  // All Cloud nodes are selectable regardless of online status; printService
  // falls back to local printing if an assigned node is offline at print time.
  const buildOptions = (selectedId: string) =>
    [
      `<option value=""${selectedId === '' ? ' selected' : ''}>— Unassigned — (Leader prints locally)</option>`,
      ...cachedNodes.map((n: any) => {
        const name = escapeHtml(n.node_name || n.node_id)
        const sel = n.node_id === selectedId ? ' selected' : ''
        return `<option value="${n.node_id}"${sel}>${name} (${n.cluster_role}) ${n.is_online ? '🟢' : '🔴'}</option>`
      }),
    ].join('')

  tbody.innerHTML = cachedRoutes.map((r: any) => {
    const selected = r.assigned_node_id || ''
    return `
      <tr data-station="${r.station_code}" data-type="${r.print_type}">
        <td>${escapeHtml(r.station_name || r.station_code)}</td>
        <td>${r.print_type}</td>
        <td>
          <select class="route-node-select" data-station="${r.station_code}" data-type="${r.print_type}">
            ${buildOptions(selected)}
          </select>
        </td>
        <td>${onlineIcon(r.node_is_online)}</td>
      </tr>
    `
  }).join('')
}

function renderNodesTable(): void {
  const tbody = document.getElementById('nodes-table-body')!
  if (cachedNodes.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="color:var(--text-muted)">No nodes found. Add one below.</td></tr>'
    return
  }
  tbody.innerHTML = cachedNodes.map((n: any) => {
    const name = escapeHtml(n.node_name || n.node_id)
    const role = n.cluster_role === 'leader' ? 'Leader' : 'Follower'
    const status = n.is_online
      ? '<span style="color:var(--success)">🟢 Online</span>'
      : '<span style="color:var(--error)">🔴 Offline</span>'
    return `<tr><td>${name}</td><td style="font-family:monospace;font-size:12px">${n.node_id}</td><td>${role}</td><td>${status}</td></tr>`
  }).join('')
}

document.getElementById('save-assignments-btn')!.addEventListener('click', async () => {
  const statusEl = document.getElementById('save-assignments-status')!
  const btn = document.getElementById('save-assignments-btn') as HTMLButtonElement
  btn.disabled = true
  btn.textContent = 'Saving…'
  statusEl.textContent = ''

  try {
    const routes: Array<{ station_code: string; print_type: string; assigned_node_id: string | null }> = []
    document.querySelectorAll<HTMLSelectElement>('.route-node-select').forEach((sel) => {
      routes.push({
        station_code: sel.dataset.station!,
        print_type: sel.dataset.type!,
        assigned_node_id: sel.value || null,
      })
    })

    const result = await api().savePrintRoutes({ routes })
    statusEl.textContent = `Saved ${result.saved} routes.`
    showToast(`Print routing saved (${result.saved} routes).`, 'success')
    refreshNodeManagement()
  } catch (err: any) {
    statusEl.textContent = 'Save failed.'
    showToast(`Save failed: ${err.message}`, 'error')
  } finally {
    btn.disabled = false
    btn.textContent = 'Save Routing'
  }
})

document.getElementById('add-node-btn')!.addEventListener('click', async () => {
  const nameInput = document.getElementById('add-node-name') as HTMLInputElement
  const errorEl = document.getElementById('add-node-error')!
  const btn = document.getElementById('add-node-btn') as HTMLButtonElement
  errorEl.style.display = 'none'
  const nodeName = nameInput.value.trim()

  if (!nodeName) {
    errorEl.textContent = 'Enter a node name.'
    errorEl.style.display = 'block'
    return
  }

  btn.disabled = true
  btn.textContent = 'Adding…'

  try {
    const node = await api().createNode({ nodeName })
    nameInput.value = ''
    showToast(`Node "${node.node_name}" created (${node.node_id}) — offline until connected.`, 'success')
    refreshNodeManagement()
  } catch (err: any) {
    errorEl.textContent = err.message || 'Failed to create node.'
    errorEl.style.display = 'block'
    showToast(err.message || 'Failed to create node.', 'error')
  } finally {
    btn.disabled = false
    btn.textContent = 'Add Node'
  }
})

// ─── Cluster Status (Follower) ────────────────────────────────────────
async function refreshClusterStatus(): Promise<void> {
  try {
    const s = await api().getStatus()
    document.getElementById('cn-name')!.textContent = String(s.node_label || s.node_id || '—')
    document.getElementById('cn-id')!.textContent = String(s.node_id || '—')
    document.getElementById('cn-role')!.textContent = 'Follower'
    document.getElementById('cn-status')!.textContent = '🟢 Online'

    if (s.leader) {
      const l = s.leader as any
      document.getElementById('cl-id')!.textContent = l.node_id || '—'
      document.getElementById('cl-address')!.textContent = `${l.host}:${l.port}`
      const clStatus = document.getElementById('cl-status')!
      if (l.status === 'ONLINE') {
        clStatus.textContent = '🟢 Online'
        clStatus.style.color = 'var(--success)'
      } else {
        clStatus.textContent = '🔴 Offline'
        clStatus.style.color = 'var(--error)'
      }
    } else {
      document.getElementById('cl-id')!.textContent = '—'
      document.getElementById('cl-address')!.textContent = '—'
      document.getElementById('cl-status')!.textContent = '—'
    }
  } catch (err: any) {
    showToast(`Failed to load cluster status: ${err.message}`, 'error')
  }
}

// ─── Live KOT listener ───────────────────────────────────────────────
try {
  api().onNewKot((segment) => {
    const el = document.getElementById('kot-log')!
    el.textContent += `\n[live] ${JSON.stringify(segment)}`
  })
} catch { /* bridge unavailable */ }

// ─── Bootstrap ───────────────────────────────────────────────────────
refreshStatus()
refreshKotLog()
refreshPrinters()
refreshOsPrinters()
setInterval(refreshStatus, 5000)
setInterval(refreshKotLog, 3000)

window.addEventListener('unhandledrejection', (e) => {
  showError(e.reason instanceof Error ? e.reason.message : String(e.reason))
})
