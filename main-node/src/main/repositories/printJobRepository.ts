import { v4 as uuidv4 } from 'uuid'
import { getDb, nowIso } from '../db/connection'
import type { PrintJobRow } from '../types'

export const printJobRepository = {
  enqueue(job: {
    id?: string
    order_id: string
    station: string
    job_type: string
    printer_id: string | null
    payload: string
  }): string {
    const id = job.id ?? uuidv4()
    const now = nowIso()
    const existing = getDb()
      .prepare('SELECT id, status FROM print_jobs WHERE id = ?')
      .get(id) as { id: string; status: string } | undefined
    if (existing) {
      if (existing.status === 'PRINTED' || existing.status === 'FAILED') return id
      return id
    }

    getDb()
      .prepare(
        `INSERT INTO print_jobs (id, order_id, station, job_type, printer_id, payload, status, attempt_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'PENDING', 0, ?, ?)`,
      )
      .run(id, job.order_id, job.station, job.job_type, job.printer_id, job.payload, now, now)
    return id
  },

  getDueJobs(): PrintJobRow[] {
    const now = nowIso()
    return getDb()
      .prepare(
        `SELECT * FROM print_jobs
         WHERE status IN ('PENDING', 'RETRYING')
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY created_at ASC`,
      )
      .all(now) as PrintJobRow[]
  },

  markPrinted(id: string): void {
    getDb()
      .prepare(`UPDATE print_jobs SET status = 'PRINTED', updated_at = ?, last_error = NULL WHERE id = ?`)
      .run(nowIso(), id)
  },

  // Terminal status for a job handed off to a follower node. Distinct from
  // PRINTED so "KOTs printed today" counts only what THIS node printed locally
  // (the follower that prints it records its own PRINTED entry). Like PRINTED,
  // it's excluded from getDueJobs so it is never re-processed.
  markForwarded(id: string): void {
    getDb()
      .prepare(`UPDATE print_jobs SET status = 'FORWARDED', updated_at = ?, last_error = NULL WHERE id = ?`)
      .run(nowIso(), id)
  },

  markRetrying(id: string, attemptCount: number, nextRetryAt: string, error: string): void {
    getDb()
      .prepare(
        `UPDATE print_jobs SET status = 'RETRYING', attempt_count = ?, next_retry_at = ?, last_error = ?, updated_at = ? WHERE id = ?`,
      )
      .run(attemptCount, nextRetryAt, error, nowIso(), id)
  },

  markFailed(id: string, error: string): void {
    getDb()
      .prepare(`UPDATE print_jobs SET status = 'FAILED', last_error = ?, updated_at = ? WHERE id = ?`)
      .run(error, nowIso(), id)
  },

  countByStatus(status: string): number {
    const row = getDb()
      .prepare('SELECT COUNT(*) as c FROM print_jobs WHERE status = ?')
      .get(status) as { c: number }
    return row.c
  },

  // KOTs this node actually printed today (markPrinted stamps updated_at). Works
  // for both roles — the leader's local prints and a follower's forwarded prints.
  countPrintedToday(): number {
    const today = new Date().toISOString().slice(0, 10)
    const row = getDb()
      .prepare(`SELECT COUNT(*) as c FROM print_jobs WHERE status = 'PRINTED' AND updated_at LIKE ?`)
      .get(`${today}%`) as { c: number }
    return row.c
  },
}
