// React Query hooks for ordering. Network-first with an AsyncStorage cache fallback so the menu and
// table list remain usable on the LAN / briefly offline. Placing an order re-probes connectivity
// first (acceptance criterion: probe before placing) and reuses one Idempotency-Key across retries.

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '../auth/store'
import {
  getMenuCache,
  getTablesCache,
  saveMenuCache,
  saveTablesCache,
} from '../lib/storage'
import type {
  AttendanceHistory,
  AttendanceStatus,
  Coords,
  MenuResponse,
  Order,
  TableSummary,
} from '../lib/types'
import { useConnection } from '../net/connection'
import {
  clockIn,
  clockOut,
  createOrder,
  getAttendanceHistory,
  getAttendanceStatus,
  getMenu,
  getTables,
} from './api'
import { useCart } from './cart'

export function useTables(locationId: string | null) {
  return useQuery<TableSummary[]>({
    queryKey: ['tables', locationId],
    enabled: !!locationId,
    queryFn: async () => {
      const { cloudBaseUrl } = useConnection.getState()
      const token = useAuth.getState().token
      try {
        const tables = await getTables(cloudBaseUrl, locationId!, token)
        await saveTablesCache(locationId!, tables)
        return tables
      } catch (err) {
        const cached = await getTablesCache(locationId!)
        if (cached) return cached
        throw err
      }
    },
  })
}

export function useMenu(tableUuid: string | null) {
  return useQuery<MenuResponse>({
    queryKey: ['menu', tableUuid],
    enabled: !!tableUuid,
    queryFn: async () => {
      const base = useConnection.getState().activeBaseUrl()
      try {
        const menu = await getMenu(base, tableUuid!)
        await saveMenuCache(tableUuid!, menu)
        return menu
      } catch (err) {
        const cached = await getMenuCache(tableUuid!)
        if (cached) return cached
        throw err
      }
    },
  })
}

export function usePlaceOrder() {
  const queryClient = useQueryClient()
  return useMutation<Order, Error, { tableUuid: string }>({
    mutationFn: async ({ tableUuid }) => {
      const conn = useConnection.getState()
      // Re-probe so we place against the right base, then resolve it.
      await conn.probe(false)
      const base = conn.activeBaseUrl()
      // Node (local mode) verifies a staff JWT offline; cloud uses the session tok_.
      const auth = useAuth.getState()
      const token = conn.mode === 'local' ? (auth.staffToken ?? auth.token) : auth.token
      const cart = useCart.getState()
      const idempotencyKey = cart.ensureIdempotencyKey()
      const input = cart.toOrderInput(tableUuid)
      return createOrder(base, input, idempotencyKey, token)
    },
    onSuccess: (order) => {
      queryClient.setQueryData(['order', order.id], order)
    },
  })
}

// ---- Attendance hooks ----

export function useAttendanceStatus() {
  return useQuery<AttendanceStatus>({
    queryKey: ['attendance', 'status'],
    queryFn: async () => {
      const { cloudBaseUrl } = useConnection.getState()
      const token = useAuth.getState().token
      return getAttendanceStatus(cloudBaseUrl, token)
    },
    staleTime: 60_000,
  })
}

export function useClockIn() {
  const queryClient = useQueryClient()
  return useMutation<AttendanceStatus, Error, Coords | null | undefined>({
    mutationFn: async (coords) => {
      const { cloudBaseUrl } = useConnection.getState()
      const token = useAuth.getState().token
      return clockIn(cloudBaseUrl, token, coords ?? null)
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['attendance', 'status'], data)
    },
  })
}

export function useClockOut() {
  const queryClient = useQueryClient()
  return useMutation<AttendanceStatus, Error, Coords | null | undefined>({
    mutationFn: async (coords) => {
      const { cloudBaseUrl } = useConnection.getState()
      const token = useAuth.getState().token
      return clockOut(cloudBaseUrl, token, coords ?? null)
    },
    onSuccess: (data) => {
      queryClient.setQueryData(['attendance', 'status'], data)
    },
  })
}

export function useAttendanceHistory(from: string, to: string) {
  return useQuery<AttendanceHistory>({
    queryKey: ['attendance', 'history', from, to],
    queryFn: async () => {
      const { cloudBaseUrl } = useConnection.getState()
      const token = useAuth.getState().token
      return getAttendanceHistory(cloudBaseUrl, token, from, to)
    },
    staleTime: 60_000,
  })
}

export function useOrderStatus(orderId: string | null, poll = false) {
  return useQuery<Order>({
    queryKey: ['order', orderId],
    enabled: !!orderId,
    refetchInterval: poll ? 5000 : false,
    queryFn: async () => {
      const base = useConnection.getState().activeBaseUrl()
      const { getOrder } = await import('./api')
      return getOrder(base, orderId!)
    },
  })
}
