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
  
  setTimeout(() => {
    toast.remove()
  }, 5000)
}

function showError(message: string): void {
  setBadge('Error', 'standby')
  const grid = document.getElementById('status-grid')!
  grid.innerHTML = `<div class="card" style="grid-column:1/-1"><h3>Error</h3><p style="font-size:14px">${message}</p></div>`
}

function api() {
  if (!window.soboss) {
    throw new Error('Preload bridge not loaded — restart the app')
  }
  return window.soboss
}

document.querySelectorAll('nav button').forEach((btn) => {
  btn.addEventListener('click', () => showPanel((btn as HTMLButtonElement).dataset.panel!))
})

// Setup Wizard tab switching
const tabBtnProvision = document.getElementById('tab-btn-provision')!
const tabBtnJoin = document.getElementById('tab-btn-join')!
const formProvision = document.getElementById('setup-form-provision')!
const formJoin = document.getElementById('setup-form-join')!

tabBtnProvision.addEventListener('click', () => {
  tabBtnProvision.classList.add('active')
  tabBtnJoin.classList.remove('active')
  formProvision.classList.add('active')
  formJoin.classList.remove('active')
})

tabBtnJoin.addEventListener('click', () => {
  tabBtnJoin.classList.add('active')
  tabBtnProvision.classList.remove('active')
  formJoin.classList.add('active')
  formProvision.classList.remove('active')
})

// Wizard navigation and form state
let sessionToken = ''

// Login button click
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
    showToast('Please fill in login credentials.', 'warning')
    return
  }

  btnLogin.textContent = 'Logging in...'
  ;(btnLogin as HTMLButtonElement).disabled = true

  try {
    const data = await api().login({ email, password })
    sessionToken = data.session_token
    showToast('Authenticated successfully.', 'success')

    // Populate locations
    const selectLocation = document.getElementById('select-location') as HTMLSelectElement
    selectLocation.innerHTML = ''
    
    if (data.restaurants && data.restaurants.length > 0) {
      data.restaurants.forEach((r: any) => {
        r.locations.forEach((loc: any) => {
          const opt = document.createElement('option')
          opt.value = loc.id
          opt.textContent = `${r.name} - ${loc.name}`
          selectLocation.appendChild(opt)
        })
      })
    }

    if (selectLocation.children.length === 0) {
      throw new Error('No locations found for this manager.')
    }

    // Switch to step 2 details
    document.getElementById('setup-step-login')!.classList.remove('active')
    document.getElementById('setup-step-details')!.classList.add('active')
  } catch (err: any) {
    loginError.textContent = err.message || 'Login failed.'
    loginError.style.display = 'block'
    showToast(err.message || 'Login failed.', 'error')
  } finally {
    btnLogin.textContent = 'Next Step'
    ;(btnLogin as HTMLButtonElement).disabled = false
  }
})

// Provision back button
document.getElementById('btn-provision-back')!.addEventListener('click', () => {
  document.getElementById('setup-step-details')!.classList.remove('active')
  document.getElementById('setup-step-login')!.classList.add('active')
})

// Provision submit button
const btnProvisionSubmit = document.getElementById('btn-provision-submit')!
const provisionLabel = document.getElementById('provision-label') as HTMLInputElement
const provisionError = document.getElementById('provision-error')!

btnProvisionSubmit.addEventListener('click', async () => {
  provisionError.style.display = 'none'
  const selectLocation = document.getElementById('select-location') as HTMLSelectElement
  const locationId = selectLocation.value
  const nodeLabel = provisionLabel.value.trim() || 'Kitchen Station'

  const stationCodes: string[] = []
  document.querySelectorAll('input[name="provision-stations"]:checked').forEach((cb) => {
    stationCodes.push((cb as HTMLInputElement).value)
  })

  if (stationCodes.length === 0) {
    provisionError.textContent = 'Please check at least one station code.'
    provisionError.style.display = 'block'
    showToast('Select at least one station code.', 'warning')
    return
  }

  btnProvisionSubmit.textContent = 'Provisioning...'
  ;(btnProvisionSubmit as HTMLButtonElement).disabled = true

  try {
    await api().provision({
      sessionToken,
      locationId,
      nodeLabel,
      stationCodes,
      electionPriority: 10,
      managerEmail: loginEmail.value.trim()
    })

    // Reset setup wizard back to login step for future use if wiped
    document.getElementById('setup-step-details')!.classList.remove('active')
    document.getElementById('setup-step-login')!.classList.add('active')
    loginEmail.value = ''
    loginPassword.value = ''
    provisionLabel.value = ''

    showToast('Leader node provisioned successfully.', 'success')
    await refreshStatus()
  } catch (err: any) {
    provisionError.textContent = err.message || 'Provisioning failed.'
    provisionError.style.display = 'block'
    showToast(err.message || 'Provisioning failed.', 'error')
  } finally {
    btnProvisionSubmit.textContent = 'Provision Node'
    ;(btnProvisionSubmit as HTMLButtonElement).disabled = false
  }
})

// Join submit button
const btnJoinSubmit = document.getElementById('btn-join-submit')!
const joinPairingCode = document.getElementById('join-pairing-code') as HTMLInputElement
const joinLabel = document.getElementById('join-label') as HTMLInputElement
const joinError = document.getElementById('join-error')!

btnJoinSubmit.addEventListener('click', async () => {
  joinError.style.display = 'none'
  const pairingCode = joinPairingCode.value.trim()
  const nodeLabel = joinLabel.value.trim() || 'Bar Station'

  const stationCodes: string[] = []
  document.querySelectorAll('input[name="join-stations"]:checked').forEach((cb) => {
    stationCodes.push((cb as HTMLInputElement).value)
  })

  if (!pairingCode) {
    joinError.textContent = 'Please paste a pairing code.'
    joinError.style.display = 'block'
    showToast('Pairing code is required.', 'warning')
    return
  }

  if (stationCodes.length === 0) {
    joinError.textContent = 'Please check at least one station code.'
    joinError.style.display = 'block'
    showToast('Select at least one station code.', 'warning')
    return
  }

  btnJoinSubmit.textContent = 'Joining...'
  ;(btnJoinSubmit as HTMLButtonElement).disabled = true

  try {
    await api().joinCluster({
      pairingCode,
      nodeLabel,
      stationCodes
    })

    joinPairingCode.value = ''
    joinLabel.value = ''

    showToast('Successfully joined cluster as follower.', 'success')
    await refreshStatus()
  } catch (err: any) {
    joinError.textContent = err.message || 'Failed to join cluster.'
    joinError.style.display = 'block'
    showToast(err.message || 'Failed to join cluster.', 'error')
  } finally {
    btnJoinSubmit.textContent = 'Join Cluster'
    ;(btnJoinSubmit as HTMLButtonElement).disabled = false
  }
})

// Clear config button
const btnClearConfig = document.getElementById('clear-config-btn')!
btnClearConfig.addEventListener('click', async () => {
  if (confirm('Are you sure you want to reset this node? All configurations will be lost.')) {
    try {
      await api().clearConfig()
      showToast('Node configuration cleared successfully.', 'success')
      await refreshStatus()
    } catch (err: any) {
      showToast(`Reset failed: ${err.message}`, 'error')
    }
  }
})

// Profile Logout button in header
const logoutBtn = document.getElementById('logout-btn')!
logoutBtn.addEventListener('click', async () => {
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
      showPanel('setup')
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
    if (s.manager_email) {
      profileUser.textContent = `👤 ${s.manager_email}`
    } else {
      profileUser.textContent = role === 'leader' ? '👤 Leader' : '👤 Follower'
    }

    // Conditional visibility: hide Offline Emergency card on Leader node, show Follower Onboarding card
    const cardEmergency = document.getElementById('card-offline-emergency')!
    const cardPairing = document.getElementById('card-follower-onboarding')!
    if (role === 'leader') {
      cardEmergency.style.display = 'none'
      cardPairing.style.display = 'block'
    } else {
      cardEmergency.style.display = 'block'
      cardPairing.style.display = 'none'
    }

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
      .map(
        ([label, val]) =>
          `<div class="card"><h3>${label}</h3><p style="font-size:${String(val).length > 25 ? '13' : '20'}px">${val}</p></div>`,
      )
      .join('')

    grid.innerHTML = leaderSectionHtml + cardsHtml
  } catch (err) {
    showError(err instanceof Error ? err.message : String(err))
  }
}

async function refreshKotLog(): Promise<void> {
  try {
    const log = await api().readKotLog()
    const el = document.getElementById('kot-log')!
    el.textContent = log || 'No KOT output yet.'
    el.scrollTop = el.scrollHeight
  } catch {
    /* status panel shows the error */
  }
}

async function refreshOsPrinters(): Promise<void> {
  try {
    const list = await api().listOsPrinters()
    const el = document.getElementById('os-printers-list')!
    if (!list.length) {
      el.textContent = 'No OS printers found. Plug in USB printer and add it in Windows Settings → Printers.'
      return
    }
    el.textContent = list
      .map((p) => `${p.isDefault ? '★ ' : '  '}${p.name}`)
      .join('\n')
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
    showToast(`Test print sent to printer: ${result.printer}`, 'success')
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
      .map(
        (p) =>
          `<tr><td>${p.id}</td><td>${p.name}</td><td>${p.driver}</td><td>${p.connection}</td></tr>`,
      )
      .join('')
  } catch {
    /* status panel shows the error */
  }
}

// Generate pairing code button
const btnGeneratePairing = document.getElementById('generate-pairing-btn') as HTMLButtonElement
const inputGeneratedPairing = document.getElementById('generated-pairing-code') as HTMLInputElement

btnGeneratePairing.addEventListener('click', async () => {
  btnGeneratePairing.disabled = true
  btnGeneratePairing.textContent = 'Generating...'
  try {
    const res = await api().generatePairingCode()
    inputGeneratedPairing.value = res.pairing_code
    inputGeneratedPairing.style.display = 'block'
    showToast('Pairing code generated successfully.', 'success')
  } catch (err: any) {
    showToast(err.message || 'Failed to generate pairing code.', 'error')
  } finally {
    btnGeneratePairing.disabled = false
    btnGeneratePairing.textContent = 'Generate Pairing Code'
  }
})

document.getElementById('become-active-btn')!.addEventListener('click', async () => {
  const ok = confirm('Are you sure you want to force promote this node to Leader? This should ONLY be done if the primary Leader is offline and unreachable on the network.')
  if (!ok) return

  const btn = document.getElementById('become-active-btn') as HTMLButtonElement
  btn.disabled = true
  try {
    await api().becomeActive()
    showToast('Force promotion successful! Role switched to leader.', 'success')
    refreshStatus()
  } catch (err) {
    showToast(`Force promotion failed: ${String(err)}`, 'error')
  } finally {
    btn.disabled = false
  }
})

try {
  api().onNewKot((segment) => {
    const el = document.getElementById('kot-log')!
    el.textContent += `\n[live] ${JSON.stringify(segment)}`
  })
} catch {
  /* bridge unavailable */
}

refreshStatus()
refreshKotLog()
refreshPrinters()
refreshOsPrinters()
setInterval(refreshStatus, 5000)
setInterval(refreshKotLog, 3000)

window.addEventListener('unhandledrejection', (e) => {
  showError(e.reason instanceof Error ? e.reason.message : String(e.reason))
})
