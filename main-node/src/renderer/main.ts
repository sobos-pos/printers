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
    if (panel === 'menu') refreshMenuPanel()
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
    // Menu management is cloud-backed, so it's available on any configured node.
    document.getElementById('nav-menu-btn')!.style.display = 'inline-flex'

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

interface OsPrinterInfo {
  name: string
  portName: string
  portType: 'usb' | 'tcp' | 'com' | 'unknown'
  isDefault: boolean
  hardwareStatus: 'active' | 'inactive' | 'unknown'
}

let cachedOsPrinters: OsPrinterInfo[] = []

function escapeHtml(s: string): string {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string)
  )
}

/** Dropdown only offers printers confirmed active by hardware check. */
function buildPrinterOptions(selectedName: string | null, osPrinters: OsPrinterInfo[]): string {
  // Include 'active' (confirmed connected) and 'unknown' (virtual/software printers
  // like OneNote or PDF writers that have no physical port to probe).
  // Exclude only 'inactive' — physically disconnected hardware printers.
  const activePrinters = osPrinters.filter((p) => p.hardwareStatus !== 'inactive')

  const names = new Set<string>()
  for (const p of activePrinters) names.add(p.name)
  // Do NOT inject selectedName when not in active printers — if the previously
  // saved printer is disconnected the dropdown resets to "— Select printer —"
  // so the user is prompted to reassign rather than silently keeping a dead printer.

  const sorted = [...names].sort((a, b) => a.localeCompare(b))
  const options = ['<option value="">— Select printer —</option>']
  for (const name of sorted) {
    const sel = name === selectedName ? ' selected' : ''
    const safeValue = name.replace(/"/g, '&quot;')
    options.push(`<option value="${safeValue}"${sel}>${escapeHtml(name)}</option>`)
  }
  return options.join('')
}

function statusDot(hw: OsPrinterInfo['hardwareStatus']): string {
  if (hw === 'active') return '🟢'
  if (hw === 'inactive') return '🔴'
  return '⚫'
}

async function refreshOsPrinters(): Promise<void> {
  try {
    const list = (await api().listOsPrinters()) as OsPrinterInfo[]
    cachedOsPrinters = list
    const el = document.getElementById('os-printers-list')!
    if (!list.length) {
      el.textContent = 'No OS printers found.'
      return
    }
    el.textContent = list
      .map((p) => {
        const star = p.isDefault ? '★ ' : '  '
        const dot = statusDot(p.hardwareStatus)
        const label = p.hardwareStatus === 'active' ? 'Active'
          : p.hardwareStatus === 'inactive' ? 'Inactive'
          : 'Unknown'
        const port = p.portType !== 'unknown' ? ` [${p.portName}]` : ''
        return `${star}${dot} ${p.name}${port}  — ${label}`
      })
      .join('\n')
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
      os_printers?: OsPrinterInfo[]
    }
    const assignments = data.assignments ?? []
    const osPrinters: OsPrinterInfo[] = data.os_printers?.length
      ? data.os_printers
      : (await api().listOsPrinters()) as OsPrinterInfo[]
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

// ─── Menu Management ──────────────────────────────────────────────────
let menuGlossary: any = null
let menuCategories: any[] = []
// Base64 data URLs staged for the item currently being created.
let pendingItemImages: string[] = []

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(new Error('Could not read file'))
    reader.readAsDataURL(file)
  })
}

function renderImagePreviews(): void {
  const wrap = document.getElementById('mi-image-previews')!
  wrap.innerHTML = pendingItemImages.map((src, i) => `
    <div style="position:relative;width:72px;height:72px;border-radius:8px;overflow:hidden;border:1px solid var(--border-color)">
      <img src="${src}" style="width:100%;height:100%;object-fit:cover" />
      <button type="button" class="mi-img-remove" data-idx="${i}"
        style="position:absolute;top:2px;right:2px;width:18px;height:18px;line-height:16px;padding:0;border:none;border-radius:50%;background:rgba(153,27,27,0.9);color:#fff;cursor:pointer;font-size:11px">✕</button>
    </div>`).join('')
  wrap.querySelectorAll<HTMLButtonElement>('.mi-img-remove').forEach((b) => {
    b.addEventListener('click', () => {
      pendingItemImages.splice(Number(b.dataset.idx), 1)
      renderImagePreviews()
    })
  })
}

function optionHtml(value: string, label: string, selected = false): string {
  return `<option value="${escapeHtml(value)}"${selected ? ' selected' : ''}>${escapeHtml(label)}</option>`
}

function fillSelect(id: string, rows: Array<{ value: string; label: string }>, placeholder?: string): void {
  const sel = document.getElementById(id) as HTMLSelectElement
  if (!sel) return
  const opts = placeholder ? [optionHtml('', placeholder)] : []
  for (const r of rows) opts.push(optionHtml(r.value, r.label))
  sel.innerHTML = opts.join('')
}

function taxGroupOptions(selected = ''): string {
  const rows = (menuGlossary?.tax_groups ?? []) as any[]
  return [
    optionHtml('', '— No tax —', selected === ''),
    ...rows.map((g) => optionHtml(g.slug, `${g.slug} (${g.rate}%)`, g.slug === selected)),
  ].join('')
}

function addVariantRow(name = '', price = '', taxGroup = ''): void {
  const tbody = document.getElementById('mi-variants-body')!
  const tr = document.createElement('tr')
  tr.className = 'mi-variant-row'
  tr.innerHTML = `
    <td><input class="mi-v-name" type="text" placeholder="e.g. Full" value="${escapeHtml(name)}"
      style="width:100%;padding:8px 10px;background:#0b0f19;border:1px solid var(--border-color);border-radius:6px;color:#fff" /></td>
    <td><input class="mi-v-price" type="number" min="0" step="0.01" placeholder="0.00" value="${escapeHtml(price)}"
      style="width:110px;padding:8px 10px;background:#0b0f19;border:1px solid var(--border-color);border-radius:6px;color:#fff" /></td>
    <td><select class="mi-v-tax">${taxGroupOptions(taxGroup)}</select></td>
    <td><button class="btn btn-danger btn-sm mi-v-remove" type="button">✕</button></td>`
  tbody.appendChild(tr)
  tr.querySelector('.mi-v-remove')!.addEventListener('click', () => tr.remove())
}

let groupSeq = 0
function addGroupRow(): void {
  const wrap = document.getElementById('mi-groups')!
  const id = `grp-${groupSeq++}`
  const div = document.createElement('div')
  div.className = 'mi-group'
  div.dataset.id = id
  div.style.cssText = 'border:1px solid var(--border-color);border-radius:8px;padding:12px;background:#0b0f19'
  div.innerHTML = `
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <input class="mi-g-name" type="text" placeholder="Group name (e.g. Add-ons)"
        style="flex:1;min-width:160px;padding:8px 10px;background:#151d30;border:1px solid var(--border-color);border-radius:6px;color:#fff" />
      <label style="font-size:12px;color:var(--text-muted)">min <input class="mi-g-min" type="number" min="0" value="0" style="width:56px;padding:6px;background:#151d30;border:1px solid var(--border-color);border-radius:6px;color:#fff" /></label>
      <label style="font-size:12px;color:var(--text-muted)">max <input class="mi-g-max" type="number" min="1" value="1" style="width:56px;padding:6px;background:#151d30;border:1px solid var(--border-color);border-radius:6px;color:#fff" /></label>
      <button class="btn btn-danger btn-sm mi-g-remove" type="button">Remove Group</button>
    </div>
    <div class="mi-g-options" style="margin-top:10px;display:flex;flex-direction:column;gap:6px"></div>
    <button class="btn btn-secondary btn-sm mi-g-add-opt" type="button" style="margin-top:8px">+ Add Option</button>`
  wrap.appendChild(div)
  div.querySelector('.mi-g-remove')!.addEventListener('click', () => div.remove())
  const addOpt = () => {
    const optWrap = div.querySelector('.mi-g-options')!
    const row = document.createElement('div')
    row.className = 'mi-opt-row'
    row.style.cssText = 'display:flex;gap:8px;align-items:center'
    row.innerHTML = `
      <input class="mi-o-name" type="text" placeholder="Option (e.g. Extra Cheese)"
        style="flex:1;padding:7px 10px;background:#151d30;border:1px solid var(--border-color);border-radius:6px;color:#fff" />
      <input class="mi-o-price" type="number" min="0" step="0.01" placeholder="+₹0"
        style="width:90px;padding:7px 10px;background:#151d30;border:1px solid var(--border-color);border-radius:6px;color:#fff" />
      <button class="btn btn-danger btn-sm mi-o-remove" type="button">✕</button>`
    optWrap.appendChild(row)
    row.querySelector('.mi-o-remove')!.addEventListener('click', () => row.remove())
  }
  div.querySelector('.mi-g-add-opt')!.addEventListener('click', addOpt)
  addOpt()
}

function collectItemPayload(): any {
  const name = (document.getElementById('mi-name') as HTMLInputElement).value.trim()
  const category_id = (document.getElementById('mi-category') as HTMLSelectElement).value
  const dietary = (document.getElementById('mi-dietary') as HTMLSelectElement).value
  const gst = (document.getElementById('mi-gst') as HTMLSelectElement).value
  const station_code = (document.getElementById('mi-station') as HTMLSelectElement).value
  const preparation_time = (document.getElementById('mi-prep') as HTMLSelectElement).value

  const tags = [dietary, gst].filter(Boolean)

  const variants: any[] = []
  document.querySelectorAll('#mi-variants-body .mi-variant-row').forEach((tr) => {
    const vname = (tr.querySelector('.mi-v-name') as HTMLInputElement).value.trim()
    const price = (tr.querySelector('.mi-v-price') as HTMLInputElement).value.trim()
    const tax_group = (tr.querySelector('.mi-v-tax') as HTMLSelectElement).value
    if (vname) variants.push({ name: vname, price: price || '0', tax_group: tax_group || null })
  })

  const modifier_groups: any[] = []
  document.querySelectorAll('#mi-groups .mi-group').forEach((g) => {
    const gname = (g.querySelector('.mi-g-name') as HTMLInputElement).value.trim()
    if (!gname) return
    const min_selection = Number((g.querySelector('.mi-g-min') as HTMLInputElement).value || 0)
    const max_selection = Number((g.querySelector('.mi-g-max') as HTMLInputElement).value || 1)
    const options: any[] = []
    g.querySelectorAll('.mi-opt-row').forEach((o) => {
      const oname = (o.querySelector('.mi-o-name') as HTMLInputElement).value.trim()
      const oprice = (o.querySelector('.mi-o-price') as HTMLInputElement).value.trim()
      if (oname) options.push({ name: oname, price: oprice || '0' })
    })
    if (options.length) modifier_groups.push({ name: gname, min_selection, max_selection, options })
  })

  return {
    name,
    category_id,
    description: (document.getElementById('mi-description') as HTMLInputElement).value.trim(),
    tags,
    station_code: station_code || null,
    preparation_time: preparation_time || null,
    variants,
    modifier_groups,
    images: pendingItemImages.slice(),
  }
}

function resetItemForm(): void {
  ;(document.getElementById('mi-name') as HTMLInputElement).value = ''
  ;(document.getElementById('mi-description') as HTMLInputElement).value = ''
  document.getElementById('mi-variants-body')!.innerHTML = ''
  document.getElementById('mi-groups')!.innerHTML = ''
  pendingItemImages = []
  ;(document.getElementById('mi-images') as HTMLInputElement).value = ''
  renderImagePreviews()
  addVariantRow()
}

function populateGlossarySelects(): void {
  if (!menuGlossary) return
  const dietary = (menuGlossary.tags?.dietary ?? []).map((t: any) => ({ value: t.slug, label: t.name }))
  fillSelect('mi-dietary', dietary)
  const gst = (menuGlossary.tags?.gst ?? []).map((t: any) => ({ value: t.slug, label: t.name }))
  fillSelect('mi-gst', gst, '— None —')
  const stations = (menuGlossary.stations ?? []).map((s: any) => ({ value: s.code, label: s.name }))
  fillSelect('mi-station', stations, '— None —')
  const prep = (menuGlossary.preparation_times ?? []).map((p: any) => ({ value: p.slug, label: p.label }))
  fillSelect('mi-prep', prep, '— None —')
}

function renderCategorySelect(): void {
  const sel = document.getElementById('mi-category') as HTMLSelectElement
  if (!sel) return
  sel.innerHTML = menuCategories.length
    ? menuCategories.map((c) => optionHtml(c.id, c.name)).join('')
    : optionHtml('', 'No categories yet — add one first')
}

function renderMenuTree(): void {
  const root = document.getElementById('menu-tree')!
  if (!menuCategories.length) {
    root.innerHTML = '<p style="color:var(--text-muted);font-size:13px">No categories yet. Add a category, then add items.</p>'
    return
  }
  root.innerHTML = menuCategories.map((cat) => {
    const items = (cat.items ?? []).map((it: any) => {
      const prices = (it.variants ?? []).map((v: any) => `${v.name} ₹${v.price}`).join(', ') || 'No variants'
      const avail = it.is_available
        ? '<span style="color:var(--success)">Available</span>'
        : '<span style="color:var(--error)">Hidden</span>'
      const media = (it.media ?? []) as Array<{ id: string; url: string; is_primary: boolean }>
      const thumbs = media.map((m) => `
        <div style="position:relative;width:48px;height:48px;border-radius:6px;overflow:hidden;border:1px solid var(--border-color)">
          <img src="${escapeHtml(m.url)}" style="width:100%;height:100%;object-fit:cover" />
          <button class="btn mi-media-del" data-media="${m.id}" title="Remove image"
            style="position:absolute;top:1px;right:1px;width:16px;height:16px;line-height:14px;padding:0;border:none;border-radius:50%;background:rgba(153,27,27,0.9);color:#fff;cursor:pointer;font-size:10px">✕</button>
        </div>`).join('')
      const imageCell = `
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          ${thumbs || '<span style="color:var(--text-muted);font-size:12px">No image</span>'}
          <label class="btn btn-secondary btn-sm" style="cursor:pointer">
            + Add<input type="file" class="mi-media-add" data-item="${it.id}" accept="image/png,image/jpeg,image/gif,image/webp" style="display:none" />
          </label>
        </div>`
      return `
        <tr data-item="${it.id}">
          <td>${escapeHtml(it.name)}</td>
          <td>${imageCell}</td>
          <td style="color:var(--text-muted);font-size:13px">${escapeHtml(prices)}</td>
          <td>${avail}</td>
          <td style="text-align:right;white-space:nowrap">
            <button class="btn btn-secondary btn-sm mi-toggle" data-item="${it.id}" data-avail="${it.is_available}">${it.is_available ? 'Hide' : 'Show'}</button>
            <button class="btn btn-danger btn-sm mi-del" data-item="${it.id}" data-name="${escapeHtml(it.name)}">Delete</button>
          </td>
        </tr>`
    }).join('')
    return `
      <div style="margin-bottom:18px">
        <h3 style="font-size:14px;margin-bottom:6px;color:#fff">${escapeHtml(cat.name)}</h3>
        <table>
          <thead><tr><th>Item</th><th>Images</th><th>Variants</th><th>Status</th><th></th></tr></thead>
          <tbody>${items || '<tr><td colspan="5" style="color:var(--text-muted)">No items</td></tr>'}</tbody>
        </table>
      </div>`
  }).join('')

  root.querySelectorAll<HTMLButtonElement>('.mi-toggle').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const itemId = btn.dataset.item!
      const makeAvailable = btn.dataset.avail !== 'true'
      btn.disabled = true
      try {
        await api().updateMenuItem({ itemId, is_available: makeAvailable })
        showToast('Item updated.', 'success')
        await loadMenuTree()
      } catch (err: any) {
        showToast(err.message || 'Update failed.', 'error')
        btn.disabled = false
      }
    })
  })
  root.querySelectorAll<HTMLButtonElement>('.mi-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm(`Delete "${btn.dataset.name}"? This removes it from the menu everywhere.`)) return
      btn.disabled = true
      try {
        await api().deleteMenuItem({ itemId: btn.dataset.item! })
        showToast('Item deleted.', 'success')
        await loadMenuTree()
      } catch (err: any) {
        showToast(err.message || 'Delete failed.', 'error')
        btn.disabled = false
      }
    })
  })
  root.querySelectorAll<HTMLInputElement>('.mi-media-add').forEach((input) => {
    input.addEventListener('change', async () => {
      const file = input.files?.[0]
      if (!file) return
      if (file.size > 10 * 1024 * 1024) { showToast('Image larger than 10 MB.', 'warning'); return }
      try {
        const image = await readFileAsDataUrl(file)
        await api().addMenuItemMedia({ itemId: input.dataset.item!, image })
        showToast('Image added.', 'success')
        await loadMenuTree()
      } catch (err: any) {
        showToast(err.message || 'Image upload failed.', 'error')
      }
    })
  })
  root.querySelectorAll<HTMLButtonElement>('.mi-media-del').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true
      try {
        await api().deleteMenuMedia({ mediaId: btn.dataset.media! })
        showToast('Image removed.', 'success')
        await loadMenuTree()
      } catch (err: any) {
        showToast(err.message || 'Failed to remove image.', 'error')
        btn.disabled = false
      }
    })
  })
}

async function loadMenuTree(): Promise<void> {
  const result = await api().getMenuTree()
  menuCategories = result.categories || []
  renderCategorySelect()
  renderMenuTree()
}

let menuPanelLoading = false
async function refreshMenuPanel(): Promise<void> {
  if (menuPanelLoading) return
  menuPanelLoading = true
  try {
    if (!menuGlossary) {
      menuGlossary = await api().getMenuGlossary()
      populateGlossarySelects()
    }
    await loadMenuTree()
    if (!document.querySelector('#mi-variants-body .mi-variant-row')) addVariantRow()
  } catch (err: any) {
    document.getElementById('menu-tree')!.innerHTML =
      `<p style="color:var(--error);font-size:13px">${escapeHtml(err.message || String(err))}</p>`
  } finally {
    menuPanelLoading = false
  }
}

document.getElementById('menu-refresh-btn')!.addEventListener('click', async () => {
  menuGlossary = null
  await refreshMenuPanel()
  showToast('Menu refreshed.', 'success')
})

document.getElementById('mi-add-variant-btn')!.addEventListener('click', () => addVariantRow())
document.getElementById('mi-add-group-btn')!.addEventListener('click', () => addGroupRow())

document.getElementById('mi-images')!.addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  for (const file of files) {
    if (file.size > 10 * 1024 * 1024) {
      showToast(`"${file.name}" is larger than 10 MB and was skipped.`, 'warning')
      continue
    }
    try {
      pendingItemImages.push(await readFileAsDataUrl(file))
    } catch {
      showToast(`Could not read "${file.name}".`, 'error')
    }
  }
  input.value = '' // allow re-selecting the same file
  renderImagePreviews()
})

let pendingCategoryImage: string | null = null
document.getElementById('menu-cat-image')!.addEventListener('change', async (e) => {
  const input = e.target as HTMLInputElement
  const file = input.files?.[0]
  const label = document.getElementById('menu-cat-image-label')!
  if (!file) { pendingCategoryImage = null; label.textContent = 'Choose Image'; return }
  if (file.size > 10 * 1024 * 1024) { showToast('Image larger than 10 MB.', 'warning'); input.value = ''; return }
  try {
    pendingCategoryImage = await readFileAsDataUrl(file)
    label.textContent = `✓ ${file.name}`
  } catch {
    showToast('Could not read image.', 'error')
  }
})

document.getElementById('menu-add-cat-btn')!.addEventListener('click', async () => {
  const input = document.getElementById('menu-cat-name') as HTMLInputElement
  const name = input.value.trim()
  if (!name) { showToast('Enter a category name.', 'warning'); return }
  const btn = document.getElementById('menu-add-cat-btn') as HTMLButtonElement
  btn.disabled = true
  try {
    await api().createMenuCategory({ name, image: pendingCategoryImage || undefined })
    input.value = ''
    pendingCategoryImage = null
    ;(document.getElementById('menu-cat-image') as HTMLInputElement).value = ''
    document.getElementById('menu-cat-image-label')!.textContent = 'Choose Image'
    showToast(`Category "${name}" added.`, 'success')
    await loadMenuTree()
  } catch (err: any) {
    showToast(err.message || 'Failed to add category.', 'error')
  } finally {
    btn.disabled = false
  }
})

document.getElementById('mi-save-btn')!.addEventListener('click', async () => {
  const errEl = document.getElementById('mi-error')!
  const statusEl = document.getElementById('mi-status')!
  errEl.style.display = 'none'
  const payload = collectItemPayload()

  if (!payload.name) { errEl.textContent = 'Item name is required.'; errEl.style.display = 'block'; return }
  if (!payload.category_id) { errEl.textContent = 'Pick a category (add one first).'; errEl.style.display = 'block'; return }
  if (!payload.variants.length) { errEl.textContent = 'Add at least one variant with a price.'; errEl.style.display = 'block'; return }
  if (!payload.tags.length) { errEl.textContent = 'Select a dietary tag (veg/non-veg/egg).'; errEl.style.display = 'block'; return }

  const btn = document.getElementById('mi-save-btn') as HTMLButtonElement
  btn.disabled = true
  btn.textContent = 'Saving…'
  statusEl.textContent = ''
  try {
    const result = await api().createMenuItem(payload)
    showToast(`"${result.name}" added to the menu.`, 'success')
    resetItemForm()
    await loadMenuTree()
  } catch (err: any) {
    errEl.textContent = err.message || 'Failed to save item.'
    errEl.style.display = 'block'
    showToast(err.message || 'Failed to save item.', 'error')
  } finally {
    btn.disabled = false
    btn.textContent = 'Save Item'
  }
})

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
