import type { FastifyInstance } from 'fastify'
import { config } from '../../config'
import { printJobRepository } from '../../repositories/printJobRepository'

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/health/', async () => {
    return {
      ok: true,
      node_id: config.nodeId,
      cluster_role: config.clusterRole,
      uptime_seconds: Math.floor(process.uptime()),
      printer_online: true,
      pending_print_jobs: printJobRepository.getDueJobs().length,
    }
  })
}
