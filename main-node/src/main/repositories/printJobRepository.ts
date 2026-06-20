import { v4 as uuidv4 } from 'uuid'
import { getDb, istTodayRange, nowIso } from '../db/connection'
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

  /** True when a BILL job is already queued or printed for this order. */
  hasBillForOrder(orderId: string): boolean {
    const row = getDb()
      .prepare(
        `SELECT 1 FROM print_jobs
         WHERE order_id = ? AND job_type = 'BILL'
           AND status IN ('PENDING', 'RETRYING', 'PRINTED', 'FORWARDED')
         LIMIT 1`,
      )
      .get(orderId)
    return Boolean(row)
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

  /**
   * Atomically pick the oldest due job and mark it PRINTING.
   * Unlike getDueJobs()+claimJob(), this cannot hand two workers the same job
   * from a stale in-memory snapshot (e.g. duplicate dev timers / HMR reload).
   */
  claimNextDueJob(): PrintJobRow | null {
    const db = getDb()
    return db.transaction(() => {
      const now = nowIso()
      const row = db
        .prepare(
          `SELECT * FROM print_jobs
           WHERE status IN ('PENDING', 'RETRYING')
             AND (next_retry_at IS NULL OR next_retry_at <= ?)
           ORDER BY created_at ASC
           LIMIT 1`,
        )
        .get(now) as PrintJobRow | undefined
      if (!row) return null

      const claimed = db
        .prepare(
          `UPDATE print_jobs SET status = 'PRINTING', updated_at = ?
           WHERE id = ? AND status IN ('PENDING', 'RETRYING')`,
        )
        .run(now, row.id) as { changes: number }
      if (claimed.changes !== 1) return null
      return row
    })()
  },

  /** Atomically mark a job in-flight so overlapping worker ticks cannot print it twice. */
  claimJob(id: string): boolean {
    const result = getDb()
      .prepare(
        `UPDATE print_jobs SET status = 'PRINTING', updated_at = ?
         WHERE id = ? AND status IN ('PENDING', 'RETRYING')`,
      )
      .run(nowIso(), id) as { changes: number }
    return result.changes === 1
  },

  /** Recover jobs left PRINTING after a crash or forced restart. */
  resetStalePrinting(): number {
    const result = getDb()
      .prepare(
        `UPDATE print_jobs SET status = 'PENDING', updated_at = ? WHERE status = 'PRINTING'`,
      )
      .run(nowIso()) as { changes: number }
    return result.changes
  },

  markPrinted(id: string): boolean {
    const result = getDb()
      .prepare(
        `UPDATE print_jobs SET status = 'PRINTED', updated_at = ?, last_error = NULL
         WHERE id = ? AND status = 'PRINTING'`,
      )
      .run(nowIso(), id) as { changes: number }
    return result.changes === 1
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

  // True if this job arrived as a forward FROM the leader (recorded in
  // remote_print_jobs by the cluster receive handler). Such a job must always be
  // printed locally by this node and never re-forwarded — that would bounce it
  // back out and it would never print (nor log) here.
  isForwarded(id: string): boolean {
    const row = getDb()
      .prepare('SELECT 1 FROM remote_print_jobs WHERE job_id = ? LIMIT 1')
      .get(id)
    return Boolean(row)
  },

  // Mark old PENDING/RETRYING jobs as FAILED so they stop counting as "pending"
  // after the printer has been unreachable for too long. Called on worker startup
  // and hourly thereafter.
  expireStaleJobs(olderThanHours = 4): number {
    const cutoff = new Date(Date.now() - olderThanHours * 3_600_000).toISOString()
    const result = getDb()
      .prepare(
        `UPDATE print_jobs
         SET status = 'FAILED', last_error = 'Auto-expired: printer unreachable for too long', updated_at = ?
         WHERE status IN ('PENDING', 'RETRYING') AND created_at < ?`,
      )
      .run(nowIso(), cutoff) as { changes: number }
    return result.changes
  },

  // KOTs this node actually printed today (markPrinted stamps updated_at). Works
  // for both roles — the leader's local prints and a follower's forwarded prints.
  countPrintedToday(): number {
    const { start, end } = istTodayRange()
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) as c FROM print_jobs WHERE status = 'PRINTED' AND updated_at >= ? AND updated_at <= ?`,
      )
      .get(start, end) as { c: number }
    return row.c
  },
}
