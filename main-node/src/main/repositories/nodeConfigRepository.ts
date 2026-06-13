import { getDb } from '../db/connection'

export const nodeConfigRepository = {
  get(key: string): string | null {
    try {
      const row = getDb().prepare('SELECT value FROM node_config WHERE key = ?').get(key) as
        | { value: string }
        | undefined
      return row?.value ?? null
    } catch (err) {
      return null
    }
  },

  set(key: string, value: string): void {
    getDb()
      .prepare(
        `INSERT INTO node_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      )
      .run(key, value)
  },

  delete(key: string): void {
    getDb().prepare('DELETE FROM node_config WHERE key = ?').run(key)
  },

  getAll(): Record<string, string> {
    try {
      const rows = getDb().prepare('SELECT key, value FROM node_config').all() as Array<{ key: string; value: string }>
      const res: Record<string, string> = {}
      for (const r of rows) {
        res[r.key] = r.value
      }
      return res
    } catch {
      return {}
    }
  }
}
