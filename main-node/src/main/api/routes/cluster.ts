import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { config } from '../../config'
import { nodeConfigRepository } from '../../repositories/nodeConfigRepository'
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
      assigned_stations: config.assignedStations,
      leader: config.clusterRole === 'follower' ? {
        node_id: leaderId,
        host: leaderHost,
        port: leaderPort,
        status: leaderStatus
      } : null
    }
  })

  app.post('/api/v1/cluster/print-job', async (request: FastifyRequest, reply: FastifyReply) => {
    const { job_id, order_id, station, job_type, payload } = request.body as any

    if (!job_id || !order_id || !station || !payload) {
      reply.status(400).send({ error: 'Missing required print job parameters' })
      return
    }

    const { printService } = await import('../../services/printService')
    const { printerRepository } = await import('../../repositories/printerRepository')
    const { getPrinterDriver } = await import('../../services/printerDriver')

    const printerId = printService.resolvePrinterId(station, job_type)
    const printer = printerId ? printerRepository.getPrinter(printerId) : null
    const driver = getPrinterDriver(printer?.driver ?? config.printerDriver)

    // Check if local printer is online before queueing
    const isAvailable = await driver.isAvailable({ printer, paperWidth: config.paperWidth })
    if (!isAvailable) {
      reply.status(503).send({ error: 'Printer offline' })
      return
    }

    // Save to remote_print_jobs
    getDb().prepare(
      `INSERT INTO remote_print_jobs (job_id, order_id, station, job_type, payload, status, received_at)
       VALUES (?, ?, ?, ?, ?, 'RECEIVED', ?)`
    ).run(job_id, order_id, station, job_type, JSON.stringify(payload), new Date().toISOString())

    // Enqueue in local print_jobs queue
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

  app.post('/api/v1/cluster/pairing-code', async (request: FastifyRequest, reply: FastifyReply) => {
    if (config.clusterRole !== 'leader') {
      reply.status(403).send({ error: 'Only leader can generate pairing codes' })
      return
    }

    const os = await import('os')
    const nets = os.networkInterfaces()
    let leaderIp = '127.0.0.1'
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family === 'IPv4' && !net.internal) {
          leaderIp = net.address
          break
        }
      }
    }

    const { pairingService } = await import('../../services/pairingService')
    const code = pairingService.generateCode(leaderIp)
    return { pairing_code: code }
  })

  app.post('/api/v1/cluster/register', async (request: FastifyRequest, reply: FastifyReply) => {
    if (config.clusterRole !== 'leader') {
      reply.status(403).send({ error: 'Only leader can register followers' })
      return
    }

    const { node_id, node_label, station_codes, election_priority, host, port, printer_info } = request.body as any

    if (!node_id || !host) {
      reply.status(400).send({ error: 'Missing node_id or host in registration request' })
      return
    }

    const { clusterService } = await import('../../services/clusterService')
    await clusterService.registerFollower({
      node_id,
      node_label: node_label || '',
      station_codes: station_codes || [],
      host,
      port: port || 3001,
      printer_info,
    })

    return {
      status: 'registered',
      location_id: config.locationId,
      leader_node_id: config.nodeId,
    }
  })
}
