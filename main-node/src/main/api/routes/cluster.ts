import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../../config'
import { nodeConfigRepository } from '../../repositories/nodeConfigRepository'
import { clusterNodeRepository } from '../../repositories/clusterNodeRepository'
import { getDb } from '../../db/connection'

export function registerClusterRoutes(app: FastifyInstance): void {
  app.get('/api/v1/cluster/status', async () => {
    const leaderId = nodeConfigRepository.get('leader_node_id') || ''
    const leaderHost = nodeConfigRepository.get('leader_host') || ''
    const leaderPort = parseInt(nodeConfigRepository.get('leader_port') || '3001', 10)
    const leaderStatus = nodeConfigRepository.get('leader_status') || 'OFFLINE'

    return {
      node_id: config.nodeId,
      node_label: nodeConfigRepository.get('node_label') || '',
      cluster_role: config.clusterRole,
      leader: config.clusterRole === 'follower' ? {
        node_id: leaderId,
        host: leaderHost,
        port: leaderPort,
        status: leaderStatus
      } : null
    }
  })

  // Follower → leader liveness signal. The follower POSTs this every
  // heartbeatMs; the leader records it into cluster_nodes as ONLINE with a
  // fresh last_health_check. runFollowerHealthChecks stays as a cross-check.
  app.post('/api/v1/cluster/heartbeat', async (request: FastifyRequest, reply: FastifyReply) => {
    const { node_id, node_label, station_codes, lan_host, lan_port } = (request.body || {}) as any

    if (!node_id || !lan_host) {
      reply.status(400).send({ error: 'Missing node_id or lan_host' })
      return
    }

    clusterNodeRepository.upsert({
      node_id,
      node_label: node_label ?? '',
      station_codes: JSON.stringify(station_codes ?? []),
      host: lan_host,
      port: typeof lan_port === 'number' ? lan_port : parseInt(lan_port || '3001', 10),
      status: 'ONLINE',
      last_health_check: new Date().toISOString(),
    })

    return { status: 'ok' }
  })

  app.post('/api/v1/cluster/print-job', async (request: FastifyRequest, reply: FastifyReply) => {
    const { job_id, order_id, station, job_type, payload } = request.body as any

    if (!job_id || !order_id || !station || !payload) {
      reply.status(400).send({ error: 'Missing required print job parameters' })
      return
    }

    const { printService } = await import('../../services/printService')
    const { printerRepository } = await import('../../repositories/printerRepository')
    const { resolvePrinterDriver } = await import('../../services/printerDriver')

    const printerId = printService.resolvePrinterId(station, job_type)
    const printer = printerId ? printerRepository.getPrinter(printerId) : null
    const driver = resolvePrinterDriver(printer, config.printerDriver)

    // Check if local printer is online before queueing
    const isAvailable = await driver.isAvailable({ printer, paperWidth: config.paperWidth })
    if (!isAvailable) {
      reply.status(503).send({ error: 'Printer offline' })
      return
    }

    // Idempotent receive — leader may retry forward after a crash before markForwarded.
    const existingRemote = getDb()
      .prepare('SELECT job_id FROM remote_print_jobs WHERE job_id = ?')
      .get(job_id)
    if (existingRemote) {
      return { job_id, status: 'QUEUED' }
    }

    // Save to remote_print_jobs
    getDb().prepare(
      `INSERT INTO remote_print_jobs (job_id, order_id, station, job_type, payload, status, received_at)
       VALUES (?, ?, ?, ?, ?, 'RECEIVED', ?)`,
    ).run(job_id, order_id, station, job_type, JSON.stringify(payload), new Date().toISOString())

    // Enqueue in local print_jobs queue (enqueue is idempotent for same job id)
    const { printJobRepository } = await import('../../repositories/printJobRepository')
    printJobRepository.enqueue({
      id: job_id,
      order_id,
      station,
      job_type,
      printer_id: printerId,
      payload: JSON.stringify(payload),
    })

    return { job_id, status: 'QUEUED' }
  })
}
