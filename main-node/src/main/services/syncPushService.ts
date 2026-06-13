import { config } from '../config'
import { orderRepository } from '../repositories/orderRepository'
import { syncRepository } from '../repositories/syncRepository'
import { cloudClient } from './cloudClient'

export const syncPushService = {
  async bulkPushPendingOrders(): Promise<void> {
    const pending = orderRepository.getPendingPushOrders()
    if (!pending.length) return

    const orders = pending.map((order) => ({
      id: order.id,
      table_uuid: order.table_uuid,
      items: orderRepository.getItemsForBulkPush(order.id),
      created_at: order.created_at,
    }))

    try {
      await cloudClient.bulkPushOrders(orders)
      orderRepository.markAsSynced(pending.map((o) => o.id))
      syncRepository.insertSyncLog({
        direction: 'PUSH',
        sync_type: 'OFFLINE_ORDER_PUSH',
        status: 'SUCCESS',
      })
      console.log(`[Push] Bulk synced ${pending.length} local orders`)
    } catch (err) {
      syncRepository.insertSyncLog({
        direction: 'PUSH',
        sync_type: 'OFFLINE_ORDER_PUSH',
        status: 'FAILED',
        error_message: err instanceof Error ? err.message : String(err),
      })
      throw err
    }
  },
}
