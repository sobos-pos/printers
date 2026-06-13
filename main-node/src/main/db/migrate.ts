import { migration001 } from './migrations/001_initial'
import { migration002 } from './migrations/002_cluster'
import { getDb } from './connection'

const MIGRATIONS: Array<{ name: string; sql: string }> = [
  { name: '001_initial.sql', sql: migration001 },
  { name: '002_cluster.sql', sql: migration002 },
]

export function runMigrations(): void {
  const db = getDb()
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `)

  for (const { name, sql } of MIGRATIONS) {
    const applied = db.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(name)
    if (applied) continue

    db.exec(sql)
    db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(
      name,
      new Date().toISOString(),
    )
    console.log(`[DB] Applied migration: ${name}`)
  }
}
