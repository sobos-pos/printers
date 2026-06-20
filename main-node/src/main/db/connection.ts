import Database from 'better-sqlite3'
import { mkdirSync } from 'fs'
import { resolve } from 'path'
import dotenv from 'dotenv'

dotenv.config({ quiet: true })

const dbPath = resolve(process.cwd(), process.env.DB_PATH || './data/node.sqlite')
const dataDir = resolve(dbPath, '..')

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) {
    mkdirSync(dataDir, { recursive: true })
    db = new Database(dbPath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
  }
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}

export function nowIso(): string {
  return new Date().toISOString()
}

// Returns the UTC ISO boundaries that cover the current calendar day in IST
// (UTC+05:30). All stored timestamps are UTC, so "today" queries must use
// these boundaries instead of a plain UTC date prefix.
export function istTodayRange(): { start: string; end: string } {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000
  const istNow = Date.now() + IST_OFFSET_MS
  const istDate = new Date(istNow).toISOString().slice(0, 10) // YYYY-MM-DD in IST
  return {
    start: new Date(`${istDate}T00:00:00.000+05:30`).toISOString(),
    end: new Date(`${istDate}T23:59:59.999+05:30`).toISOString(),
  }
}
