import type { FastifyInstance } from 'fastify'
import { menuCacheRepository } from '../../repositories/menuCacheRepository'
import { config } from '../../config'
import { menuSyncService } from '../../services/menuSyncService'
import { orderService } from '../../services/orderService'
import type { CreateOrderInput } from '../../types'

export function registerOrderRoutes(app: FastifyInstance): void {
  app.post<{ Body: CreateOrderInput }>('/api/v1/orders/', async (req, reply) => {
    try {
      // Local orders are validated against the cached menu. If the cache is empty
      // (bootstrap pull failed / menu never synced), try a one-off self-healing
      // pull before rejecting — otherwise every line fails with a misleading
      // "Menu item not found". If it is still empty, surface the *real* cause.
      if (menuCacheRepository.isEmpty(config.locationId)) {
        await menuSyncService.ensureMenuCached()
        if (menuCacheRepository.isEmpty(config.locationId)) {
          return reply.status(503).send({
            error: {
              code: 'MENU_NOT_SYNCED',
              message:
                'Menu not yet synced on this node. The node will retry automatically — please wait a moment and try again.',
            },
          })
        }
      }

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
