import { appendFileSync, mkdirSync } from 'fs'
import { config } from '../config'
import { sendToRenderer } from '../windowBridge'
import type { KotPrintPayload } from '../types'

/**
 * Record a KOT for a job THIS node actually printed, and push it to the
 * renderer's live KOT log.
 *
 * Called from the print path (after a successful local print), NOT from order
 * processing — so every node's KOT log reflects exactly what it printed:
 *   • leader: locally-created POS orders + cloud-pulled orders it prints itself
 *   • follower: jobs forwarded to it by the leader
 * A station the leader forwards away is therefore logged on the follower that
 * prints it, not on the leader.
 */
export function recordPrintedKot(payload: KotPrintPayload): void {
  try {
    mkdirSync(config.dataDir, { recursive: true })
    const ts = new Date().toISOString()
    const lines = [
      `[${ts}] Order: ${payload.order_id ?? '—'}  Table: ${payload.table ?? '—'}  Station: ${payload.station}`,
    ]
    for (const l of payload.lines ?? []) {
      const mods = l.mods?.length ? `  +${l.mods.join(', ')}` : ''
      const notes = l.notes ? `  (${l.notes})` : ''
      lines.push(`    ${l.qty}x ${l.name}${mods}${notes}`)
    }
    lines.push('')
    appendFileSync(config.kotLogPath, lines.join('\n'), 'utf-8')
    sendToRenderer('new-kot', payload)
  } catch (err) {
    console.warn('[KOT] Log write failed:', err)
  }
}
