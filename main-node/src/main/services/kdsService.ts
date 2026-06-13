import type { KotSegment } from '../types'

const clients = new Set<{ send: (data: string) => void; readyState: number }>()

export const kdsService = {
  registerClient(client: { send: (data: string) => void; readyState: number }): void {
    clients.add(client)
  },

  unregisterClient(client: { send: (data: string) => void; readyState: number }): void {
    clients.delete(client)
  },

  broadcast(payload: object): void {
    const msg = JSON.stringify(payload)
    for (const client of clients) {
      if (client.readyState === 1) client.send(msg)
    }
  },

  broadcastNewOrder(order: unknown): void {
    console.log('[KDS] Broadcast ORDER_NEW')
    this.broadcast({ type: 'ORDER_NEW', order })
  },

  broadcastStatusChange(orderId: string, status: string): void {
    console.log(`[KDS] Broadcast ORDER_STATUS ${orderId} → ${status}`)
    this.broadcast({ type: 'ORDER_STATUS', order_id: orderId, status })
  },

  emitKotToRenderer(segment: KotSegment): void {
    void import('electron')
      .then(({ BrowserWindow }) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send('new-kot', segment)
        }
      })
      .catch(() => {
        /* headless / non-Electron context */
      })
  },
}
