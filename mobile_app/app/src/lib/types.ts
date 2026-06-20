// Shared domain types mirroring the backend contracts.
// All money values arrive from the backend as decimal STRINGS — never parse as float.

export type Role = 'owner' | 'manager' | 'staff' | 'waiter' | 'kiosk'

export type OrderStatus =
  | 'Pending'
  | 'Confirmed'
  | 'Preparing'
  | 'Ready'
  | 'Served'
  | 'Cancelled'

export type OrderSource =
  | 'Staff_POS'
  | 'Waiter_App'
  | 'User_App_QR'
  | 'ONDC'
  | 'Web_Direct'

export interface LocationCtx {
  id: string
  name: string
  // Geofence centre + radius for clock-in. latitude/longitude are null when the
  // location has no geofence configured (staff may clock in from anywhere).
  latitude?: number | null
  longitude?: number | null
  geofence_radius_m?: number
}

export interface RestaurantCtx {
  id: string
  name: string
  locations: LocationCtx[]
}

export interface UserCtx {
  name: string
  role: Role
  username?: string
  email?: string
  location?: LocationCtx | null
}

export interface AuthContext {
  user: UserCtx
  restaurants: RestaurantCtx[]
}

export interface LoginResponse extends AuthContext {
  session_token: string
  // Staff shift JWT signed by the restaurant's HS256 secret. Absent for superusers
  // (no restaurant). Used by the node for offline auth; must NOT be sent to the cloud.
  access_token?: string
  expires_at?: string
  expires_in?: number
}

// ---- Attendance ----

export interface AttendanceStatus {
  clocked_in: boolean
  shift_id: string | null
  clock_in_at: string | null
}

/** A single day's worked total, used by the profile heatmap. */
export interface AttendanceDay {
  date: string // YYYY-MM-DD (location-local)
  minutes: number
  shifts: number
}

export interface AttendanceHistory {
  from: string
  to: string
  days: AttendanceDay[]
  total_minutes: number
  total_days: number
}

/** Device coordinates sent with clock in/out. */
export interface Coords {
  latitude: number
  longitude: number
}

export interface TableSummary {
  id: string
  label: string
  location: string
}

export interface Station {
  code: string
  name: string
}

export interface DietaryTag {
  label: string
  icon: string
}

export interface Variant {
  id: string
  name: string
  price_delta: string // decimal string
}

export interface ModifierOption {
  id: string
  name: string
  price_delta: string // decimal string
  is_available: boolean
}

export interface ModifierGroup {
  id: string
  name: string
  min_select: number
  max_select: number
  options: ModifierOption[]
}

export interface MenuItem {
  id: string
  name: string
  description: string
  base_price: string // decimal string
  is_available: boolean
  image: string | null
  station: Station | null
  dietary_tags: DietaryTag[]
  variants: Variant[]
  modifier_groups: ModifierGroup[]
}

export interface MenuCategory {
  id: string
  name: string
  display_order: number
  items: MenuItem[]
}

export interface MenuResponse {
  table: { id: string; label: string }
  menu_version: number
  categories: MenuCategory[]
}

// ---- Order placement ----

export interface OrderItemInput {
  menu_item: string
  variant: string | null
  quantity: number
  notes: string
  modifiers: string[]
}

export interface CreateOrderInput {
  table_uuid: string
  source: OrderSource
  customer_note: string
  items: OrderItemInput[]
}

export interface OrderModifier {
  id: string
  name: string
  price: string
}

export interface OrderItem {
  id: string
  menu_item: string
  menu_item_name: string
  variant: string | null
  quantity: number
  unit_price: string
  notes: string
  modifiers: OrderModifier[]
}

export interface Order {
  id: string
  location: string
  table: string | null
  table_label: string | null
  source: OrderSource
  status: OrderStatus
  total: string
  customer_note: string
  created_by: string | null
  created_by_name: string | null
  created_at: string
  updated_at: string
  items: OrderItem[]
}

export interface HealthResponse {
  ok: boolean
  node_id: string
  cluster_role: string
  uptime_seconds: number
  printer_online: boolean
  pending_print_jobs: number
}

// Network mode for the dual-path (LAN node vs cloud) strategy.
export type ConnMode = 'probing' | 'local' | 'cloud'
