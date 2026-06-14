// Ordering API calls.
// - Tables list is CLOUD-ONLY (the node has no list endpoint) -> always cloud base.
// - Menu / order create / order status are served by BOTH node and cloud -> caller passes the
//   currently-active base URL (node in Local mode, cloud in Cloud mode).

import { request } from '../net/apiClient'
import type { CreateOrderInput, MenuResponse, Order, TableSummary } from '../lib/types'

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
