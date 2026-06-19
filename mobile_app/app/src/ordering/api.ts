// Ordering API calls.
// - Tables list is CLOUD-ONLY (the node has no list endpoint) -> always cloud base.
// - Menu / order create / order status are served by BOTH node and cloud -> caller passes the
//   currently-active base URL (node in Local mode, cloud in Cloud mode).
// - Attendance (clock in/out) is CLOUD-ONLY — session token required.

import { request } from '../net/apiClient'
import type {
  AttendanceHistory,
  AttendanceStatus,
  Coords,
  CreateOrderInput,
  MenuResponse,
  Order,
  TableSummary,
} from '../lib/types'

export async function getTables(
  cloudBaseUrl: string,
  locationId: string,
  token?: string | null,
): Promise<TableSummary[]> {
  const res = await request<{ tables: TableSummary[] }>(
    cloudBaseUrl,
    `/api/v1/tables/?location=${encodeURIComponent(locationId)}`,
    { token },
  )
  return res.tables
}

export function getMenu(baseUrl: string, tableUuid: string): Promise<MenuResponse> {
  return request<MenuResponse>(baseUrl, `/api/v1/tables/${tableUuid}/menu/`)
}

export function createOrder(
  baseUrl: string,
  input: CreateOrderInput,
  idempotencyKey: string,
  token?: string | null,
): Promise<Order> {
  return request<Order>(baseUrl, '/api/v1/orders/', {
    method: 'POST',
    body: input,
    idempotencyKey,
    token,
  })
}

export function getOrder(baseUrl: string, orderId: string): Promise<Order> {
  return request<Order>(baseUrl, `/api/v1/orders/${orderId}/`)
}

// ---- Attendance (cloud-only) ----

export function getAttendanceStatus(
  cloudBaseUrl: string,
  token: string | null,
): Promise<AttendanceStatus> {
  return request<AttendanceStatus>(cloudBaseUrl, '/api/v1/attendance/status/', { token })
}

export function clockIn(
  cloudBaseUrl: string,
  token: string | null,
  coords?: Coords | null,
): Promise<AttendanceStatus> {
  return request<AttendanceStatus>(cloudBaseUrl, '/api/v1/attendance/clock-in/', {
    method: 'POST',
    token,
    body: coords ?? {},
  })
}

export function clockOut(
  cloudBaseUrl: string,
  token: string | null,
  coords?: Coords | null,
): Promise<AttendanceStatus> {
  return request<AttendanceStatus>(cloudBaseUrl, '/api/v1/attendance/clock-out/', {
    method: 'POST',
    token,
    body: coords ?? {},
  })
}

export function getAttendanceHistory(
  cloudBaseUrl: string,
  token: string | null,
  from: string,
  to: string,
): Promise<AttendanceHistory> {
  const qs = `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`
  return request<AttendanceHistory>(cloudBaseUrl, `/api/v1/attendance/history/${qs}`, { token })
}
