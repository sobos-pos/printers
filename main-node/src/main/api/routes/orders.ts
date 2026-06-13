import type { FastifyInstance } from 'fastify'
import { orderService } from '../../services/orderService'
import type { CreateOrderInput } from '../../types'

export function registerOrderRoutes(app: FastifyInstance): void {
  app.post<{ Body: CreateOrderInput }>('/api/v1/orders/', async (req, reply) => {
    try {
      const order = orderService.createLocalOrder({
        ...req.body,
        source: req.body.source ?? 'Staff_POS',
      })
      return reply.status(201).send(order)
    } catch (err) {
      return reply.status(400).send({
        error: { code: 'BAD_REQUEST', message: err instanceof Error ? err.message : String(err) },
      })
    }
  })

  app.get<{ Params: { uuid: string } }>('/api/v1/orders/:uuid/', async (req, reply) => {
    const order = orderService.getOrder(req.params.uuid)
    if (!order) {
      return reply.status(404).send({
        error: { code: 'NOT_FOUND', message: 'Order not found' },
      })
    }
    return order
  })
}
