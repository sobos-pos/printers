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

let activePanel = 'status'

document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => {
    const panel = (btn as HTMLButtonElement).dataset.panel!
    activePanel = panel
    showPanel(panel)
    if (panel === 'nodes') {
      // Opening the panel is a fresh start — drop any stale unsaved-edit guard
      // so the routing table renders the latest server state.
      routingDirty = false
      refreshNodeManagement()
    }
    if (panel === 'cluster') refreshClusterStatus()
    if (panel === 'printers') refreshPrinterPanel()
  })
})

// ─── Setup Wizard state ───────────────────────────────────────────────
let sessionToken = ''
let selectedLocationId = ''

let nodeListRefreshTimer: ReturnType<typeof setInterval> | null = null

function wizardGoTo(step: string): void {
  document.querySelectorAll('.step').forEach((s) => s.classList.remove('active'))
  document.getElementById(`setup-step-${step}`)?.classList.add('active')

  // Auto-refresh the node list so offline nodes appear without Back→Next.
  if (nodeListRefreshTimer) {
    clearInterval(nodeListRefreshTimer)
    nodeListRefreshTimer = null
  }
  if (step === 'nodes') {
    nodeListRefreshTimer = setInterval(fetchAndRenderSetupNodes, 10000)
  }
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

// A node is claimable when cloud reports it offline OR its heartbeat is stale.
// Stale threshold aligns with the cloud's own 90 s freshness window.
const CLAIM_STALE_SECONDS = 90
const isClaimable = (n: any) =>
  !n.is_online || n.last_seen_seconds == null || n.last_seen_seconds > CLAIM_STALE_SECONDS

// Guard so auto-refresh doesn't re-render the list while a connect is in flight.
let isConnectingNode = false

function renderSetupNodeList(nodes: any[]): void {
  const nodeList = document.getElementById('node-list')!
  if (nodes.length === 0) {
    nodeList.innerHTML = `
      <p style="color:var(--text-muted);font-size:13px">
        No nodes found for this location.<br>
        Add nodes from the Leader's Node Management tab first.
      </p>`
    return
  }

  // Show ALL nodes — online ones are shown with a disabled button so the user
  // can see the full picture instead of a confusing empty list.
  nodeList.innerHTML = nodes.map((n: any) => {
    const claimable = isClaimable(n)
    const statusLabel = claimable
      ? '<span style="color:var(--error)">🔴 Available</span>'
      : '<span style="color:var(--success)">🟢 Running</span>'
    const btnDisabled = claimable ? '' : 'disabled title="Already running on another machine"'
    const btnStyle = claimable ? '' : 'style="opacity:0.45;cursor:not-allowed"'
    return `
      <div class="node-item">
        <div class="node-item-info">
          <span class="node-item-name">${n.node_name}</span>
          <span class="node-item-meta">${n.node_id} &nbsp;·&nbsp; ${n.cluster_role}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          ${statusLabel}
          <button class="btn btn-sm" data-node-id="${n.node_id}" data-node-name="${n.node_name}" ${btnDisabled} ${btnStyle}>
            ${claimable ? 'Connect' : 'In Use'}
          </button>
        </div>
      </div>`
  }).join('')

  nodeList.querySelectorAll<HTMLButtonElement>('button[data-node-id]:not([disabled])').forEach((btn) => {
    btn.addEventListener('click', () => connectToNode(
      btn.dataset.nodeId!,
      btn.dataset.nodeName!,
      btn,
    ))
  })
}

async function fetchAndRenderSetupNodes(): Promise<void> {
  if (isConnectingNode || !sessionToken || !selectedLocationId) return
  try {
    const result = await api().getNodes({ sessionToken, locationId: selectedLocationId })
    renderSetupNodeList(result.nodes || [])
  } catch {
    // Silently ignore background-refresh errors — initial load already surfaced them.
  }
}

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
    renderSetupNodeList(result.nodes || [])
    wizardGoTo('nodes') // starts the 10 s auto-refresh timer via wizardGoTo
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
  isConnectingNode = true

  try {
    await api().reconnectNode({
      sessionToken,
      nodeId,
      managerEmail: loginEmail.value.trim()
    })

    loginEmail.value = ''
    loginPassword.value = ''
    sessionToken = ''
    // Stop polling once connected — we're leaving the setup wizard.
    if (nodeListRefreshTimer) { clearInterval(nodeListRefreshTimer); nodeListRefreshTimer = null }

    showToast(`Connected as "${nodeName}" successfully.`, 'success')
    await refreshStatus()
  } catch (err: any) {
    nodesError.textContent = err.message || 'Failed to connect.'
    nodesError.style.display = 'block'
    showToast(err.message || 'Connection failed.', 'error')
    btn.disabled = false
    btn.textContent = 'Connect'
  } finally {
    isConnectingNode = false
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

    // Role-aware cards. A follower neither owns orders nor polls the cloud, so
    // "Orders Processed Today" and "Sync Cursor" are meaningless there — it shows
    // what it actually does instead: KOTs it printed and its local print queue.
    const cards: Array<[string, unknown]> = [
      ['Node ID', s.node_id],
      ['Cluster Role', s.role],
      ['Cloud Connection', s.cloud_configured ? s.cloud_base_url : 'Not configured'],
    ]
    if (role === 'leader') {
      cards.push(['Orders Processed Today', s.orders_today])
      cards.push(['KOTs Printed Today', s.kots_printed_today])
      cards.push(['Pending Local Prints', s.pending_print_jobs])
      cards.push(['Sync Cursor', s.last_cursor])
    } else {
      cards.push(['KOTs Printed Today', s.kots_printed_today])
      cards.push(['Pending Local Prints', s.pending_print_jobs])
    }
    cards.push(['Cloud Blocked (Demo)', s.demo_cloud_blocked])
    cards.push(['Printer Offline (Demo)', s.demo_printer_offline])

    const cardsHtml = cards
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
let cachedOsPrinters: Array<{ name: string; isDefault: boolean }> = []

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)
  )
}

function buildPrinterOptions(selectedName: string | null, osPrinters: Array<{ name: string; isDefault: boolean }>): string {
  const names = new Set<string>()
  for (const p of osPrinters) names.add(p.name)
  if (selectedName) names.add(selectedName)

  const sorted = [...names].sort((a, b) => a.localeCompare(b))
  const options = ['<option value="">— Select printer —</option>']
  for (const name of sorted) {
    const sel = name === selectedName ? ' selected' : ''
    const safeValue = name.replace(/"/g, '&quot;')
    options.push(`<option value="${safeValue}"${sel}>${escapeHtml(name)}</option>`)
  }
  return options.join('')
}

async function refreshOsPrinters(): Promise<void> {
  try {
    const list = await api().listOsPrinters()
    cachedOsPrinters = list
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

async function refreshPrinterPanel(): Promise<void> {
  const tbody = document.getElementById('printer-assignments-body')!
  try {
    const data = await api().getPrinters() as {
      assignments?: Array<{
        station_code: string
        station_name: string
        print_type: string
        scope: 'assigned' | 'leader_fallback'
        printer_name: string | null
      }>
      os_printers?: Array<{ name: string; isDefault: boolean }>
    }
    const assignments = data.assignments ?? []
    const osPrinters = data.os_printers?.length ? data.os_printers : await api().listOsPrinters()
    cachedOsPrinters = osPrinters

    if (assignments.length === 0) {
      tbody.innerHTML =
        '<tr><td colspan="4" style="color:var(--text-muted)">No stations are routed to this node yet. Assign stations in Node Management (Leader) first.</td></tr>'
      return
    }

    tbody.innerHTML = assignments.map((a) => {
      const routing = a.scope === 'leader_fallback'
        ? '<span style="color:var(--warning)">Leader fallback</span>'
        : '<span style="color:var(--success)">Assigned to this node</span>'
      return `
        <tr data-station="${escapeHtml(a.station_code)}" data-type="${escapeHtml(a.print_type)}">
          <td>${escapeHtml(a.station_name || a.station_code)}</td>
          <td>${escapeHtml(a.print_type)}</td>
          <td>${routing}</td>
          <td>
            <select class="printer-route-select" data-station="${escapeHtml(a.station_code)}" data-type="${escapeHtml(a.print_type)}">
              ${buildPrinterOptions(a.printer_name, osPrinters)}
            </select>
          </td>
        </tr>
      `
    }).join('')
  } catch (err: any) {
    tbody.innerHTML = `<tr><td colspan="4" style="color:var(--error)">${escapeHtml(err.message || String(err))}</td></tr>`
  }
}

document.getElementById('refresh-os-printers-btn')!.addEventListener('click', async () => {
  await refreshOsPrinters()
  await refreshPrinterPanel()
  showToast('Printers list refreshed.', 'success')
})

document.getElementById('save-printer-assignments-btn')!.addEventListener('click', async () => {
  const statusEl = document.getElementById('save-printer-assignments-status')!
  const btn = document.getElementById('save-printer-assignments-btn') as HTMLButtonElement
  btn.disabled = true
  btn.textContent = 'Saving…'
  statusEl.textContent = ''

  try {
    const assignments: Array<{ station_code: string; print_type: string; printer_name: string }> = []
    document.querySelectorAll<HTMLSelectElement>('.printer-route-select').forEach((sel) => {
      assignments.push({
        station_code: sel.dataset.station!,
        print_type: sel.dataset.type!,
        printer_name: sel.value,
      })
    })

    const result = await api().savePrintRoutes({ printer_assignments: assignments }) as { saved: number }
    statusEl.textContent = `Saved ${result.saved} mapping(s).`
    showToast(`Printer mapping saved (${result.saved} routes).`, 'success')
    await refreshPrinterPanel()
  } catch (err: any) {
    statusEl.textContent = 'Save failed.'
    showToast(`Save failed: ${err.message}`, 'error')
  } finally {
    btn.disabled = false
    btn.textContent = 'Save Mapping'
  }
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
// True once the user touches a routing dropdown and hasn't saved yet. While set,
// background refreshes must NOT rebuild the routing table — doing so would
// discard the in-progress selection (and close an open dropdown). Cleared on
// save or when the panel is (re)opened.
let routingDirty = false

// The routing table must stay stable while the user is choosing a node: skip
// rebuilding it if there are unsaved edits OR a routing dropdown is focused/open.
function isEditingRouting(): boolean {
  if (routingDirty) return true
  const el = document.activeElement as HTMLElement | null
  return !!el && el.classList.contains('route-node-select')
}

async function refreshNodeManagement(): Promise<void> {
  try {
    const [statusResult, routesResult, nodesResult, localResult] = await Promise.all([
      api().getStatus(),
      api().getPrintRoutes(),
      api().getCloudNodes(),
      api().getClusterNodes(),
    ])

    const selfNodeId = String(statusResult.node_id || '')
    cachedRoutes = routesResult.routes || []
    const cloudNodes: any[] = nodesResult.nodes || []
    const localNodes: any[] = localResult.nodes || []

    // Build a map of local health-check status (derived from contact freshness:
    // ONLINE only with recent LAN contact, else OFFLINE). This is the ONLY source
    // of truth for follower status. Cloud's is_online can be stale and is ignored.
    const localStatus = new Map<string, string>(
      localNodes.map((n: any) => [n.node_id, n.status as string])
    )

    cachedNodes = cloudNodes.map((n: any) => {
      // Self (the leader running this UI) — we know we're online since we're rendering.
      if (n.node_id === selfNodeId) return { ...n, is_online: true }
      // All other nodes: trust local health-check status only.
      // Nodes not yet in the local DB (never connected) are treated as OFFLINE.
      return { ...n, is_online: localStatus.get(n.node_id) === 'ONLINE' }
    })

    renderNodesTable()
    // Don't clobber an in-progress edit. The dropdowns keep their current DOM
    // values; the table re-renders on the next idle refresh or after save.
    if (!isEditingRouting()) renderRoutingTable()
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
    // Look up status from cachedNodes (local health-check) so the Status column
    // matches the dropdown indicator. r.node_is_online comes from the cloud and
    // can be up to 90 s stale — cachedNodes is always current.
    const assignedNode = selected ? cachedNodes.find((n: any) => n.node_id === selected) : null
    const routeOnline: boolean | null = selected ? (assignedNode?.is_online ?? false) : null
    return `
      <tr data-station="${r.station_code}" data-type="${r.print_type}">
        <td>${escapeHtml(r.station_name || r.station_code)}</td>
        <td>${r.print_type}</td>
        <td>
          <select class="route-node-select" data-station="${r.station_code}" data-type="${r.print_type}">
            ${buildOptions(selected)}
          </select>
        </td>
        <td>${onlineIcon(routeOnline)}</td>
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

// Mark routing dirty as soon as the user changes any dropdown. Delegated on the
// stable tbody element so it survives table re-renders (which replace innerHTML).
document.getElementById('routing-table-body')!.addEventListener('change', (e) => {
  const target = e.target as HTMLElement
  if (target.classList.contains('route-node-select')) routingDirty = true
})

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
    // Edits are now persisted — allow the table to re-render from server state.
    routingDirty = false
    refreshNodeManagement()
  } catch (err: any) {
    statusEl.textContent = 'Save failed.'
    showToast(`Save failed: ${err.message}`, 'error')
  } finally {
    btn.disabled = false
    btn.textContent = 'Save Routing'
  }
})

document.getElementById('refresh-nodes-btn')!.addEventListener('click', async () => {
  const btn = document.getElementById('refresh-nodes-btn') as HTMLButtonElement
  const original = btn.textContent
  btn.disabled = true
  btn.textContent = '↻ Refreshing…'
  try {
    // Forces an immediate identity-verified health-check round on the leader,
    // then re-renders, so the displayed statuses are current right now.
    await api().refreshClusterNodes()
    await refreshNodeManagement()
    showToast('Node statuses refreshed.', 'success')
  } catch (err: any) {
    showToast(err.message || 'Failed to refresh nodes.', 'error')
  } finally {
    btn.disabled = false
    btn.textContent = original || '↻ Refresh'
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
refreshOsPrinters()
refreshPrinterPanel()
setInterval(refreshStatus, 5000)
setInterval(refreshKotLog, 3000)
// Auto-refresh the active panel so node/cluster status stays live without reload.
setInterval(() => {
  if (activePanel === 'nodes') refreshNodeManagement()
  else if (activePanel === 'cluster') refreshClusterStatus()
}, 3000)

window.addEventListener('unhandledrejection', (e) => {
  showError(e.reason instanceof Error ? e.reason.message : String(e.reason))
})
