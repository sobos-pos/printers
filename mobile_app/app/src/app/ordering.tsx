// Ordering workspace: mode badge + table picker + category tabs + menu list + cart, in one screen.
// Picking a configurable item opens the variant/modifier modal; simple items add straight to cart.

import { Link, Redirect, router } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { flattenLocations, useAuth } from '../auth/store'
import { ApiError, NetworkError } from '../net/apiClient'
import { useCart } from '../ordering/cart'
import { useAttendanceStatus, useClockIn, useClockOut, useMenu, usePlaceOrder, useTables } from '../ordering/hooks'
import {
  LocationUnavailableError,
  OutsideGeofenceError,
  resolveClockInCoords,
  resolveClockOutCoords,
} from '../ordering/attendanceActions'
import { useGeofence, type GeofenceState } from '../ordering/useGeofence'
import { formatDistance } from '../lib/geo'
import type { AttendanceStatus, MenuItem } from '../lib/types'
import { CartPanel } from '../ui/components/CartPanel'
import { CategoryTabs } from '../ui/components/CategoryTabs'
import { ItemPickerModal } from '../ui/components/ItemPickerModal'
import { MenuList } from '../ui/components/MenuList'
import { ModeBadge } from '../ui/components/ModeBadge'
import { ProfileMenu } from '../ui/components/ProfileMenu'
import { TablePicker } from '../ui/components/TablePicker'
import { colors, spacing } from '../ui/theme'

export default function OrderingScreen() {
  const status = useAuth((s) => s.status)
  const context = useAuth((s) => s.context)
  const selectedLocationId = useAuth((s) => s.selectedLocationId)
  const selectLocation = useAuth((s) => s.selectLocation)

  const [tableUuid, setTableUuid] = useState<string | null>(null)
  const [categoryId, setCategoryId] = useState<string | null>(null)
  const [pickerItem, setPickerItem] = useState<MenuItem | null>(null)

  const addLine = useCart((s) => s.addLine)
  const clearCart = useCart((s) => s.clear)
  const itemCount = useCart((s) => s.itemCount())

  const locations = flattenLocations(context)
  const tablesQ = useTables(selectedLocationId)
  const menuQ = useMenu(tableUuid)
  const placeOrder = usePlaceOrder()
  const attendanceQ = useAttendanceStatus()
  const clockInMut = useClockIn()
  const clockOutMut = useClockOut()
  const geo = useGeofence({ watchActive: !attendanceQ.data?.clocked_in })
  const [clockInLocalError, setClockInLocalError] = useState<string | null>(null)

  // Default the category to the first one whenever a menu loads.
  useEffect(() => {
    if (menuQ.data?.categories.length) setCategoryId((c) => c ?? menuQ.data!.categories[0].id)
  }, [menuQ.data])

  const activeCategory = useMemo(
    () => menuQ.data?.categories.find((c) => c.id === categoryId) ?? menuQ.data?.categories[0],
    [menuQ.data, categoryId],
  )

  if (status === 'anonymous') return <Redirect href="/login" />

  const onItemPress = (item: MenuItem) => {
    const configurable = item.variants.length > 0 || item.modifier_groups.length > 0
    if (configurable) setPickerItem(item)
    else addLine(item, null, [])
  }

  const onPlace = () => {
    if (!tableUuid) return
    placeOrder.mutate(
      { tableUuid },
      {
        onSuccess: (order) => {
          clearCart()
          setTableUuid(null)
          router.push({ pathname: '/confirm', params: { orderId: order.id } })
        },
      },
    )
  }

  return (
    <SafeAreaView style={styles.container} edges={['top']}>
      {/* Header */}
      <View style={styles.header}>
        <ModeBadge />
        <View style={styles.headerRight}>
          <Link href="/settings" style={styles.headerLink}>
            Settings
          </Link>
          <ProfileMenu />
        </View>
      </View>

      {/* Clock in / out bar */}
      <ClockBar
        status={attendanceQ.data ?? null}
        loading={attendanceQ.isLoading}
        clockingIn={clockInMut.isPending}
        clockingOut={clockOutMut.isPending}
        geo={geo}
        clockInError={
          clockInMut.error ??
          (clockInLocalError ? new Error(clockInLocalError) : null)
        }
        onClockIn={async () => {
          clockInMut.reset()
          setClockInLocalError(null)
          try {
            const coords = await resolveClockInCoords(geo)
            await clockInMut.mutateAsync(coords)
          } catch (e) {
            if (e instanceof LocationUnavailableError || e instanceof OutsideGeofenceError) {
              setClockInLocalError(e.message)
            }
          }
        }}
        onClockOut={async () => {
          const coords = await resolveClockOutCoords(geo)
          await clockOutMut.mutateAsync(coords)
        }}
      />

      {/* Location selector (only when the user has more than one) */}
      {locations.length > 1 && (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.locRow}>
          {locations.map((l) => (
            <Pressable
              key={l.id}
              onPress={() => selectLocation(l.id)}
              style={[styles.locChip, l.id === selectedLocationId && styles.locChipActive]}
            >
              <Text
                style={l.id === selectedLocationId ? styles.locTextActive : styles.locText}
              >
                {l.name}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      {!selectedLocationId ? (
        <Text style={styles.hint}>Select a location to begin.</Text>
      ) : (
        <>
          {/* Tables */}
          <SectionLabel text="Table" />
          {tablesQ.isLoading ? (
            <ActivityIndicator style={styles.pad} color={colors.primary} />
          ) : tablesQ.isError ? (
            <ErrorRow error={tablesQ.error} onRetry={() => tablesQ.refetch()} />
          ) : (
            <TablePicker
              tables={tablesQ.data ?? []}
              selectedUuid={tableUuid}
              onSelect={setTableUuid}
            />
          )}

          {/* Menu */}
          {tableUuid && (
            <>
              {menuQ.isLoading ? (
                <ActivityIndicator style={styles.pad} color={colors.primary} />
              ) : menuQ.isError ? (
                <ErrorRow error={menuQ.error} onRetry={() => menuQ.refetch()} />
              ) : (
                <View style={styles.menuArea}>
                  <CategoryTabs
                    categories={menuQ.data!.categories}
                    selectedId={activeCategory?.id ?? null}
                    onSelect={setCategoryId}
                  />
                  <MenuList items={activeCategory?.items ?? []} onItemPress={onItemPress} />
                </View>
              )}
            </>
          )}
        </>
      )}

      {/* Cart */}
      <CartPanel
        canPlace={!!tableUuid && itemCount > 0}
        placing={placeOrder.isPending}
        onPlace={onPlace}
      />
      {placeOrder.isError && (
        <Text style={styles.placeError}>
          {placeOrder.error instanceof NetworkError
            ? 'Could not reach the node or cloud. Order not placed — try again.'
            : (placeOrder.error as Error)?.message}
        </Text>
      )}

      <ItemPickerModal
        key={pickerItem?.id}
        item={pickerItem}
        visible={!!pickerItem}
        onClose={() => setPickerItem(null)}
        onAdd={(variant, modifiers) => {
          if (pickerItem) addLine(pickerItem, variant, modifiers)
          setPickerItem(null)
        }}
      />
    </SafeAreaView>
  )
}

function SectionLabel({ text }: { text: string }) {
  return <Text style={styles.sectionLabel}>{text}</Text>
}

function ClockBar({
  status,
  loading,
  clockingIn,
  clockingOut,
  geo,
  clockInError,
  onClockIn,
  onClockOut,
}: {
  status: AttendanceStatus | null
  loading: boolean
  clockingIn: boolean
  clockingOut: boolean
  geo: GeofenceState
  clockInError: Error | null
  onClockIn: () => void
  onClockOut: () => void
}) {
  if (loading) return null

  if (!status || !status.clocked_in) {
    // Resolve the geofence gate. The server re-validates on clock-in regardless.
    const { geofenceEnabled, locationConfigured, permission, check, loading: geoLoading, coords } =
      geo
    const nativeModuleMissing = locationConfigured && !geo.locationNativeAvailable
    const locating = geofenceEnabled && geoLoading && !coords
    const permissionBlocked = geofenceEnabled && permission !== 'granted' && !geoLoading
    const outOfRange = geofenceEnabled && permission === 'granted' && !check.within
    const blocked = locating || permissionBlocked || outOfRange || nativeModuleMissing

    // Status line describing why clock-in is (un)available.
    let info: string | null = null
    let tone: 'muted' | 'danger' | 'success' = 'muted'
    if (nativeModuleMissing) {
      info = geo.error ?? 'Location module missing — rebuild the dev app for geofence.'
      tone = 'danger'
    } else if (locating) {
      info = 'Finding your location…'
    } else if (permissionBlocked) {
      info = 'Location permission needed to clock in'
      tone = 'danger'
    } else if (outOfRange) {
      info =
        check.distanceM != null
          ? `You're ${formatDistance(check.distanceM)} away — must be within ${check.radiusM} m`
          : `You must be within ${check.radiusM} m of the restaurant`
      tone = 'danger'
    } else if (geofenceEnabled && check.within && check.distanceM != null) {
      info = `Within range (${formatDistance(check.distanceM)})`
      tone = 'success'
    }

    // Server-side rejection (e.g. spoofed/edge-of-fence) surfaces here.
    const serverMsg =
      clockInError instanceof ApiError
        ? clockInError.message
        : clockInError instanceof NetworkError
          ? 'Could not reach the server. Try again.'
          : null

    return (
      <View style={styles.clockBarCol}>
        <View style={styles.clockInnerRow}>
          <Text style={styles.clockLabel}>Not clocked in</Text>
          <View style={styles.clockActions}>
            {permissionBlocked && (
              <Pressable style={styles.linkBtn} onPress={() => geo.refresh(true)}>
                <Text style={styles.linkBtnText}>Enable</Text>
              </Pressable>
            )}
            {outOfRange && (
              <Pressable
                style={styles.linkBtn}
                onPress={() => geo.refresh(false)}
                disabled={geoLoading}
              >
                <Text style={styles.linkBtnText}>{geoLoading ? '…' : 'Refresh'}</Text>
              </Pressable>
            )}
            <Pressable
              style={[styles.clockBtn, styles.clockInBtn, (clockingIn || blocked) && styles.disabled]}
              disabled={clockingIn || blocked}
              onPress={onClockIn}
            >
              {clockingIn ? (
                <ActivityIndicator size="small" color="#fff" />
              ) : (
                <Text style={styles.clockBtnText}>Clock In</Text>
              )}
            </Pressable>
          </View>
        </View>
        {(info || serverMsg || geo.error) && (
          <Text
            style={[
              styles.clockInfo,
              tone === 'danger' && styles.clockInfoDanger,
              tone === 'success' && styles.clockInfoSuccess,
            ]}
          >
            {serverMsg ?? info ?? geo.error}
          </Text>
        )}
      </View>
    )
  }

  const sinceText = status.clock_in_at
    ? new Date(status.clock_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : ''

  return (
    <View style={styles.clockBarRow}>
      <Text style={styles.clockLabel}>Clocked in{sinceText ? ` since ${sinceText}` : ''}</Text>
      <Pressable
        style={[styles.clockBtn, styles.clockOutBtn, clockingOut && styles.disabled]}
        disabled={clockingOut}
        onPress={onClockOut}
      >
        {clockingOut ? (
          <ActivityIndicator size="small" color="#fff" />
        ) : (
          <Text style={styles.clockBtnText}>Clock Out</Text>
        )}
      </Pressable>
    </View>
  )
}

function ErrorRow({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const msg =
    error instanceof NetworkError
      ? 'Network unreachable.'
      : error instanceof Error
        ? error.message
        : 'Something went wrong.'
  return (
    <View style={styles.errorRow}>
      <Text style={styles.errorText}>{msg}</Text>
      <Pressable onPress={onRetry}>
        <Text style={styles.retry}>Retry</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  headerRight: { flexDirection: 'row', gap: spacing.lg, alignItems: 'center' },
  headerLink: { color: colors.primary, fontWeight: '600' },
  locRow: { maxHeight: 48, paddingHorizontal: spacing.md },
  locChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    marginRight: spacing.sm,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    alignSelf: 'flex-start',
  },
  locChipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  locText: { color: colors.text },
  locTextActive: { color: colors.primaryText, fontWeight: '600' },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.textMuted,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
    textTransform: 'uppercase',
  },
  menuArea: { flex: 1 },
  pad: { padding: spacing.lg },
  hint: { padding: spacing.lg, color: colors.textMuted },
  errorRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: spacing.md,
  },
  errorText: { color: colors.danger, flex: 1 },
  retry: { color: colors.primary, fontWeight: '700' },
  placeError: { color: colors.danger, paddingHorizontal: spacing.md, paddingBottom: spacing.sm },
  clockBarCol: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  clockBarRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surface,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  clockInnerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  clockActions: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  linkBtn: { paddingHorizontal: spacing.sm, paddingVertical: 6 },
  linkBtnText: { color: colors.primary, fontWeight: '700', fontSize: 13 },
  clockInfo: { fontSize: 12, color: colors.textMuted, paddingBottom: 6 },
  clockInfoDanger: { color: colors.danger },
  clockInfoSuccess: { color: colors.success },
  clockLabel: { color: colors.textMuted, fontSize: 13 },
  clockBtn: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 14,
    minWidth: 90,
    alignItems: 'center',
  },
  clockInBtn: { backgroundColor: colors.primary },
  clockOutBtn: { backgroundColor: colors.danger },
  clockBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  disabled: { opacity: 0.5 },
})
