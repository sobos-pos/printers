import type { FastifyInstance } from 'fastify'
import { menuCacheRepository } from '../../repositories/menuCacheRepository'
import { config } from '../../config'
import { menuSyncService } from '../../services/menuSyncService'
import { menuService } from '../../services/menuService'

export function registerTableRoutes(app: FastifyInstance): void {
  app.get<{ Params: { table_uuid: string } }>(
    '/api/v1/tables/:table_uuid/menu/',
    async (req, reply) => {
      // Self-heal: if the menu cache is empty (bootstrap failed or menu never synced),
      // attempt a one-off pull from cloud before returning 404 — same pattern as the
      // order route. This lets the mobile app get a valid menu on first open in Local
      // mode even if the node's startup bootstrap didn't complete.
      if (menuCacheRepository.isEmpty(config.locationId)) {
        await menuSyncService.ensureMenuCached()
      }
      const data = menuService.getMenuForTable(req.params.table_uuid)
      if (!data) {
        return reply.status(503).send({
          error: { code: 'MENU_NOT_SYNCED', message: 'Menu not yet synced on this node — check cloud connectivity and try again.' },
        })
      }
      return data
    },
  )
}
