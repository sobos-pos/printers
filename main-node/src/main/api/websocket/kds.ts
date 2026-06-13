import type { FastifyInstance } from 'fastify'
import { kdsService } from '../../services/kdsService'

export function registerKdsWebSocket(app: FastifyInstance): void {
  app.get('/ws/kds/', { websocket: true }, (socket) => {
    kdsService.registerClient(socket)
    socket.on('close', () => kdsService.unregisterClient(socket))
    socket.send(JSON.stringify({ type: 'CONNECTED' }))
  })
}
