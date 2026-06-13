import { getDb, nowIso } from '../db/connection'
import type { MenuCachePayload } from '../types'

export const menuCacheRepository = {
  get(locationId: string): { menu_version: number; payload: MenuCachePayload } | null {
    const row = getDb()
      .prepare('SELECT menu_version, payload FROM menu_cache WHERE location_id = ?')
      .get(locationId) as { menu_version: number; payload: string } | undefined
    if (!row) return null
    return { menu_version: row.menu_version, payload: JSON.parse(row.payload) as MenuCachePayload }
  },

  getVersion(locationId: string): number {
    const row = getDb()
      .prepare('SELECT menu_version FROM menu_cache WHERE location_id = ?')
      .get(locationId) as { menu_version: number } | undefined
    return row?.menu_version ?? 0
  },

  upsert(locationId: string, version: number, payload: MenuCachePayload): void {
    getDb()
      .prepare(
        `INSERT INTO menu_cache (location_id, menu_version, payload, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(location_id) DO UPDATE SET menu_version = excluded.menu_version, payload = excluded.payload, updated_at = excluded.updated_at`,
      )
      .run(locationId, version, JSON.stringify(payload), nowIso())
  },

  isEmpty(locationId: string): boolean {
    return !getDb().prepare('SELECT 1 FROM menu_cache WHERE location_id = ?').get(locationId)
  },
}
