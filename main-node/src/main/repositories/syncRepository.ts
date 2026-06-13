import { v4 as uuidv4 } from 'uuid'
import { getDb, nowIso } from '../db/connection'

export const syncRepository = {
  getCursor(locationId: string): number {
    const row = getDb()
      .prepare('SELECT last_sequence FROM sync_cursor WHERE location_id = ?')
      .get(locationId) as { last_sequence: number } | undefined
    return row?.last_sequence ?? 0
  },

  updateCursor(locationId: string, sequence: number): void {
    const now = nowIso()
    getDb()
      .prepare(
        `INSERT INTO sync_cursor (location_id, last_sequence, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(location_id) DO UPDATE SET last_sequence = excluded.last_sequence, updated_at = excluded.updated_at`,
      )
      .run(locationId, sequence, now)
  },

  insertSyncLog(entry: {
    direction: string
    sync_type: string
    payload_ref?: string | null
    status: string
    attempt_count?: number
    error_message?: string
  }): void {
    getDb()
      .prepare(
        `INSERT INTO sync_log (id, direction, sync_type, payload_ref, status, attempt_count, error_message, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        uuidv4(),
        entry.direction,
        entry.sync_type,
        entry.payload_ref ?? null,
        entry.status,
        entry.attempt_count ?? 0,
        entry.error_message ?? '',
        nowIso(),
      )
  },
}
