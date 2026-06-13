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
