import type { FastifyInstance } from 'fastify'
import { menuService } from '../../services/menuService'

export function registerTableRoutes(app: FastifyInstance): void {
  app.get<{ Params: { table_uuid: string } }>(
    '/api/v1/tables/:table_uuid/menu/',
    async (req, reply) => {
      const data = menuService.getMenuForTable(req.params.table_uuid)
      if (!data) {
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'Menu not cached yet' },
        })
      }
      return data
    },
  )
}
