import { CloudBlockedError, config, isDemoCloudBlocked } from '../config'
import { orderRepository } from '../repositories/orderRepository'
import { syncRepository } from '../repositories/syncRepository'
import { cloudClient } from './cloudClient'
import { orderService } from './orderService'
import { orderStateMachine } from './orderStateMachine'
import { menuSyncService } from './menuSyncService'
import type { OrderStatus, SyncEvent } from '../types'

let hadRecentFailure = false

export const syncPullService = {
  async runOnce(): Promise<void> {
    try {
      if (isDemoCloudBlocked()) {
        syncRepository.insertSyncLog({
          direction: 'PULL',
          sync_type: 'QR_ORDER_PULL',
          status: 'RETRYING',
          error_message: 'Cloud blocked demo toggle',
        })
        return
      }

      const cursor = syncRepository.getCursor(config.locationId)
      const response = await cloudClient.pullEvents(cursor)
      const eventIds: string[] = []

      for (const event of response.events as SyncEvent[]) {
        await this.processEvent(event)
        eventIds.push(event.event_id)
      }

      if (eventIds.length) {
        await cloudClient.ackEvents(eventIds)
        syncRepository.updateCursor(config.locationId, response.next_cursor)
        console.log(`[Poll] Acked ${eventIds.length} events, cursor=${response.next_cursor}`)
      }

      syncRepository.insertSyncLog({
        direction: 'PULL',
        sync_type: 'QR_ORDER_PULL',
        status: 'SUCCESS',
      })

      if (hadRecentFailure) {
        hadRecentFailure = false
        const { syncPushService } = await import('./syncPushService')
        await syncPushService.bulkPushPendingOrders()
      }
    } catch (err) {
      if (!(err instanceof CloudBlockedError)) hadRecentFailure = true
      syncRepository.insertSyncLog({
        direction: 'PULL',
        sync_type: 'QR_ORDER_PULL',
        status: err instanceof CloudBlockedError ? 'RETRYING' : 'FAILED',
        error_message: err instanceof Error ? err.message : String(err),
      })
      console.error('[Poll] Error:', err)
    }
  },

  async processEvent(event: SyncEvent): Promise<void> {
    console.log(`[Poll] Event ${event.event_type} seq=${event.sequence}`)

    if (event.event_type === 'ORDER_CREATED') {
      const { order, created } = orderService.ingestFromCloudPayload(event.payload, true)
      if (!order) return
      if (!created) {
        console.log(`[Poll] Order ${order.id} already ingested — skipping duplicate print`)
        return
      }
      orderService.processCloudOrder(order)
      try {
        await cloudClient.pushStatus(order.id, 'Confirmed')
      } catch {
        console.warn(`[Poll] Status push failed for ${order.id}`)
      }
      return
    }

    if (event.event_type === 'STATUS_CHANGED') {
      const orderId = event.order_ref ?? String(event.payload.order_ref ?? '')
      const order = orderRepository.getById(orderId)
      if (!order) return

      const incoming = String(event.payload.status) as OrderStatus
      if (order.origin === 'local' && orderStateMachine.isAheadOrEqual(order.status, incoming)) {
        return
      }
      orderService.applyStatusLocally(orderId, incoming)
      return
    }

    if (event.event_type === 'MENU_UPDATED') {
      await menuSyncService.fetchAndCacheMenu()
    }
  },
}
