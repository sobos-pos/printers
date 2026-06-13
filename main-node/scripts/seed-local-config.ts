#!/usr/bin/env node
import { mkdirSync } from 'fs'
import { resolve } from 'path'
import Database from 'better-sqlite3'
import { migration001 } from '../src/main/db/migrations/001_initial.js'

const dbPath = resolve(process.cwd(), process.env.DB_PATH ?? './data/node.sqlite')
mkdirSync(resolve(dbPath, '..'), { recursive: true })

const db = new Database(dbPath)
db.exec(migration001)

db.prepare(
  `INSERT OR IGNORE INTO printers (id, name, connection, driver, enabled) VALUES (?, ?, ?, ?, ?)`,
).run('prn-simulated-1', 'Simulated Printer', 'simulated', 'simulated', 1)

for (const [station, jobType] of [
  ['KITCHEN', 'KOT'],
  ['BAR', 'KOT'],
  ['KITCHEN', 'BILL'],
]) {
  db.prepare(
    `INSERT OR IGNORE INTO print_routes (station, job_type, printer_id, fallback_printer_id) VALUES (?, ?, ?, NULL)`,
  ).run(station, jobType, 'prn-simulated-1')
}

console.log('Local config seeded — SimulatedPrinter + KITCHEN/BAR routes ready')
db.close()
