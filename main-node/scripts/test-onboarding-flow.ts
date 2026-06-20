#!/usr/bin/env node
/**
 * Integration test: cloud leader provision + follower provision + pairing payload.
 * Usage: node --import tsx scripts/test-onboarding-flow.ts
 * Requires: cloud-server running on CLOUD_BASE_URL (default http://localhost:8000)
 */

const BASE = process.env.CLOUD_BASE_URL || 'http://localhost:8000'
const EMAIL = 'manager.indira@copperpot.demo'
const PASSWORD = 'SobossDemo26!'

async function jsonFetch(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${JSON.stringify(body)}`)
  return body
}

async function main(): Promise<void> {
  console.log('=== Soboss onboarding flow test ===\n')

  const login = await jsonFetch('/api/v1/auth/login/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  const token = login.session_token as string
  const locationId = login.restaurants[0].locations[0].id as string
  console.log('✓ Login OK, location:', locationId)

  const leader = await jsonFetch('/api/v1/auth/provision-node/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      location_id: locationId,
      node_label: 'Test Kitchen Leader',
      station_codes: ['KITCHEN'],
      election_priority: 10,
    }),
  })
  if (leader.cluster_role !== 'leader') {
    throw new Error(`Expected leader role, got ${leader.cluster_role}`)
  }
  console.log('✓ Leader provisioned:', leader.node_id, leader.cluster_role)

  // Reconnect to existing cloud node (re-issues API key)
  const reconnect = await jsonFetch('/api/v1/auth/reconnect-node/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ node_id: leader.node_id }),
  })
  if (reconnect.node_id !== leader.node_id || !reconnect.reconnected) {
    throw new Error('Reconnect failed')
  }
  console.log('✓ Reconnect OK:', reconnect.node_id)
  const leaderKey = reconnect.api_key as string

  // Second provision still creates a new node (explicit registration)
  const follower = await jsonFetch('/api/v1/auth/provision-node/', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      location_id: locationId,
      node_label: 'Test Bar Follower',
      station_codes: ['BAR'],
      election_priority: 10,
    }),
  })
  if (follower.cluster_role !== 'follower') {
    throw new Error(`Expected follower role, got ${follower.cluster_role}`)
  }
  console.log('✓ Follower provisioned:', follower.node_id, follower.cluster_role)

  // Pairing code round-trip (LAN join payload — decoded by follower locally)
  const payload = {
    location_id: locationId,
    cloud_api_key: leaderKey.replace(/^sk_live_/, ''),
    cloud_base_url: BASE,
    leader_host: '127.0.0.1',
    leader_port: 3001,
    expires_at: new Date(Date.now() + 600_000).toISOString(),
  }
  const code = Buffer.from(JSON.stringify(payload)).toString('base64')
  const decoded = JSON.parse(Buffer.from(code, 'base64').toString('utf-8'))
  if (decoded.location_id !== locationId) {
    throw new Error('Pairing code location mismatch')
  }
  console.log('✓ Pairing code encode/decode OK')

  const nodes = await jsonFetch('/api/v1/sync/nodes/', {
    headers: { Authorization: `Api-Key ${leaderKey.replace(/^sk_live_/, '')}` },
  })
  console.log(`✓ Cluster has ${nodes.nodes.length} node(s), lease holder: ${nodes.lease.holder}`)

  console.log('\n=== All onboarding checks passed ===')
}

main().catch((err) => {
  console.error('\n✗ Test failed:', err.message)
  process.exit(1)
})
