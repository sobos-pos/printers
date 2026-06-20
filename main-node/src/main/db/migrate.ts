import { migration001 } from './migrations/001_initial'
import { migration002 } from './migrations/002_cluster'
import { migration003 } from './migrations/003_label_assignments'
import { migration004 } from './migrations/004_print_routes'
import { migration005 } from './migrations/005_kitchens_sections'
import { migration006 } from './migrations/006_table_label'
import { getDb } from './connection'

const MIGRATIONS: Array<{ name: string; sql: string }> = [
  { name: '001_initial.sql', sql: migration001 },
  { name: '002_cluster.sql', sql: migration002 },
  { name: '003_label_assignments.sql', sql: migration003 },
  { name: '004_print_routes.sql', sql: migration004 },
  { name: '005_kitchens_sections.sql', sql: migration005 },
  { name: '006_table_label.sql', sql: migration006 },
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
