import { getDb } from '../db/connection'

export const nodeStateRepository = {
  get(key: string): string | null {
    const row = getDb().prepare('SELECT value FROM node_state WHERE key = ?').get(key) as
      | { value: string }
      | undefined
    return row?.value ?? null
  },

  set(key: string, value: string): void {
    getDb()
      .prepare(
        `INSERT INTO node_state (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, value)
  },

  seedDefaults(nodeId: string, haMode: 'standalone' | 'ha'): void {
    if (!this.get('node_id')) this.set('node_id', nodeId)
    if (!this.get('ha_mode')) this.set('ha_mode', haMode)
    if (!this.get('role')) this.set('role', haMode === 'standalone' ? 'active' : 'standby')
    if (!this.get('is_active')) this.set('is_active', haMode === 'standalone' ? '1' : '0')
  },

  isActive(): boolean {
    return this.get('is_active') === '1'
  },

  getRole(): 'standalone' | 'active' | 'standby' {
    const haMode = this.get('ha_mode')
    if (haMode === 'standalone') return 'standalone'
    return (this.get('role') as 'active' | 'standby') ?? 'standby'
  },
}
