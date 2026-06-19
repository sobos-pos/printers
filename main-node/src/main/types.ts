export type OrderOrigin = 'cloud' | 'local'
export type PushState = 'pending' | 'synced'
export type OrderStatus =
  | 'Pending'
  | 'Confirmed'
  | 'Preparing'
  | 'Ready'
  | 'Served'
  | 'Cancelled'

export interface OrderRow {
  id: string
  location_id: string
  table_uuid: string | null
  source: string
  status: OrderStatus
  total: number
  origin: OrderOrigin
  push_state: PushState
  pushed_at: string | null
  created_at: string
  updated_at: string
}

export interface OrderItemRow {
  id: string
  order_id: string
  menu_item_id: string
  variant_id: string | null
  name_snapshot: string
  quantity: number
  unit_price: number
  notes: string
}

export interface OrderItemModifierRow {
  id: string
  order_item_id: string
  modifier_id: string
  name_snapshot: string
  price: number
}

export interface LocalOrder extends OrderRow {
  items: Array<
    OrderItemRow & {
      modifiers: OrderItemModifierRow[]
    }
  >
}

export interface KotLine {
  qty: number
  name: string
  mods: string[]
  notes: string
  /** Per-unit price. Used only for BILL formatting; KOT ignores it. */
  unit_price?: number
}

export interface KotSegment {
  station: string
  lines: KotLine[]
}

/** Stored in print_jobs.payload — segment plus order context for the ticket header. */
export interface KotPrintPayload extends KotSegment {
  order_id?: string
  table?: string | null
  placed_at?: string
  /** 'KOT' (kitchen ticket) or 'BILL' (priced receipt). Drives formatting. */
  job_type?: string
}

export type PaperWidth = '58mm' | '80mm'

export interface KotPayload {
  order: string
  table: string | null
  placed_at: string
  segments: KotSegment[]
}

export interface SyncEvent {
  event_id: string
  sequence: number
  event_type: 'ORDER_CREATED' | 'STATUS_CHANGED' | 'MENU_UPDATED'
  order_ref: string | null
  payload: Record<string, unknown>
}

export interface MenuModifierOption {
  id: string
  name: string
  price: string
  is_default?: boolean
  in_stock?: boolean
  kind?: string | null
  nested_option_groups?: MenuModifierGroup[]
}

export interface MenuModifierGroup {
  id: string
  name: string
  slug?: string
  min_selection: number
  max_selection: number
  required?: boolean
  options: MenuModifierOption[]
}

export interface MenuVariant {
  id: string
  name: string
  price: string
  tax_group?: string | null
  taxes?: string[]
  portion_size?: { value: string; unit: string | null } | null
  charges?: Array<{ slug: string; value: string }>
}

export interface MenuItemPayload {
  id: string
  name: string
  description?: string
  kind?: string
  subcategory_id?: string | null
  is_available: boolean
  // Convenience "from" price = cheapest available variant.
  base_price: string
  station?: { code: string; name: string } | null
  preparation_time?: string | null
  serving_info?: string | null
  tags?: string[]
  meat_types?: string[]
  allergens?: string[]
  nutrition?: Record<string, number | string | null>
  box_metadata?: { rows: number | null; columns: number | null } | null
  media?: string[]
  variants?: MenuVariant[]
  modifier_groups?: MenuModifierGroup[]
}

export interface MenuCachePayload {
  table?: { id: string; label: string }
  menu_version?: number
  version?: number
  categories: Array<{
    id: string
    name: string
    description?: string
    display_order: number
    image?: string | null
    subcategories?: Array<{ id: string; name: string; display_order: number }>
    items: MenuItemPayload[]
  }>
}

export interface PrinterRow {
  id: string
  name: string
  connection: string
  driver: string
  enabled: number
}

export interface PrintRouteRow {
  station: string
  job_type: string
  printer_id: string
  fallback_printer_id: string | null
}

export interface PrintJobRow {
  id: string
  order_id: string
  station: string
  job_type: string
  printer_id: string | null
  payload: string
  status: string
  attempt_count: number
  next_retry_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface BulkOrderItem {
  menu_item: string
  variant?: string | null
  quantity: number
  notes?: string
  modifiers?: string[]
}

export interface CreateOrderInput {
  table_uuid: string
  source?: string
  items: BulkOrderItem[]
}

export interface SerializedOrder {
  id: string
  location: string
  table: string | null
  table_label: string | null
  source: string
  status: string
  total: string
  customer_note: string
  created_at: string
  updated_at: string
  items: Array<{
    id: string
    menu_item: string
    menu_item_name: string
    variant: string | null
    quantity: number
    unit_price: string
    notes: string
    modifiers: Array<{ id: string; name: string; price: string }>
  }>
}
