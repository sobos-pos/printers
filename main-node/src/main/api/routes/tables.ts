import type { FastifyInstance } from 'fastify'
import { menuCacheRepository } from '../../repositories/menuCacheRepository'
import { config } from '../../config'
import { menuSyncService } from '../../services/menuSyncService'
import { menuService } from '../../services/menuService'

export function registerTableRoutes(app: FastifyInstance): void {
  app.get<{ Params: { table_uuid: string } }>(
    '/api/v1/tables/:table_uuid/menu/',
    async (req, reply) => {
      // Self-heal: pull from cloud if the local menu cache is empty.
      if (menuCacheRepository.isEmpty(config.locationId)) {
        await menuSyncService.ensureMenuCached()
      }

      const data = menuService.getMenuForTable(req.params.table_uuid)
      if (!data) {
        return reply.status(503).send({
          error: {
            code: 'MENU_NOT_SYNCED',
            message: 'Menu not yet synced on this node — check cloud connectivity and try again.',
          },
        })
      }

      // Persist section mapping so local orders can route the BILL without a
      // cloud round-trip. The section comes from the cloud menu response; it is
      // null if the table has no section assigned yet (falls back to COUNTER).
      const tableData = data.table as
        | { id?: string; label?: string; section?: { code: string; name: string } }
        | undefined
      if (tableData?.id) {
        menuService.storeSectionForTable(
          tableData.id,
          tableData.section?.code ?? 'COUNTER',
          tableData.section?.name ?? '',
          tableData.label ?? '',
        )
      }

      return data
    },
  )
}
