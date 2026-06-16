import os from 'os'

// Adapter name fragments that indicate a virtual / VPN / container interface.
// Addresses on these are usually NOT reachable by other machines on the
// physical LAN (other POS nodes, the leader, tablets), so we deprioritise them.
const VIRTUAL_ADAPTER_PATTERNS = [
  'vethernet', 'virtualbox', 'vmware', 'hyper-v', 'wsl', 'docker',
  'loopback', 'zerotier', 'tailscale', 'vpn', 'tap', 'tun', 'utun',
  'bluetooth', 'npcap', 'pseudo', 'default switch',
]

// Adapter name fragments that indicate the primary physical LAN/Wi-Fi NIC.
const PHYSICAL_ADAPTER_PATTERNS = ['wi-fi', 'wifi', 'wlan', 'ethernet', 'eth', 'en0', 'en1', 'lan']

function isVirtualAdapter(name: string): boolean {
  const n = name.toLowerCase()
  return VIRTUAL_ADAPTER_PATTERNS.some((p) => n.includes(p))
}

function isPreferredAdapter(name: string): boolean {
  const n = name.toLowerCase()
  return PHYSICAL_ADAPTER_PATTERNS.some((p) => n.includes(p))
}

// Prefer the private ranges most likely to be the real shared LAN subnet,
// in descending order of likelihood for a home/office network.
function privateRangeScore(addr: string): number {
  if (addr.startsWith('192.168.')) return 3
  if (addr.startsWith('10.')) return 2
  const m = addr.match(/^172\.(\d+)\./)
  if (m) {
    const second = Number(m[1])
    if (second >= 16 && second <= 31) return 1
  }
  return 0 // public / link-local (169.254) / other — least preferred
}

/**
 * Pick this machine's best LAN-reachable IPv4 address.
 *
 * `os.networkInterfaces()` can list several non-internal IPv4 addresses
 * (real Wi-Fi/Ethernet plus VirtualBox/WSL/VPN/Hyper-V adapters). The naive
 * "first one" approach frequently returns a virtual adapter that peers on the
 * physical LAN cannot reach, which silently breaks follower↔leader heartbeats
 * and mobile discovery. We score candidates so the real LAN NIC wins:
 *   1. physical adapters before virtual ones,
 *   2. adapters named like Wi-Fi/Ethernet before unknown ones,
 *   3. common private LAN ranges (192.168 > 10 > 172) before public/link-local.
 */
export function getLanIp(): string {
  const nets = os.networkInterfaces()
  const candidates: Array<{
    address: string
    virtual: boolean
    preferred: boolean
    score: number
  }> = []

  for (const [name, addrs] of Object.entries(nets)) {
    for (const net of addrs || []) {
      // Node may report family as the string 'IPv4' or the number 4.
      const isIpv4 = net.family === 'IPv4' || (net.family as unknown as number) === 4
      if (!isIpv4 || net.internal) continue
      candidates.push({
        address: net.address,
        virtual: isVirtualAdapter(name),
        preferred: isPreferredAdapter(name),
        score: privateRangeScore(net.address),
      })
    }
  }

  if (candidates.length === 0) return '127.0.0.1'

  candidates.sort((a, b) => {
    if (a.virtual !== b.virtual) return a.virtual ? 1 : -1
    if (a.preferred !== b.preferred) return a.preferred ? -1 : 1
    return b.score - a.score
  })

  return candidates[0].address
}
