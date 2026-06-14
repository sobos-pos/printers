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
import { NetworkError } from '../net/apiClient'
import { useCart } from '../ordering/cart'
import { useMenu, usePlaceOrder, useTables } from '../ordering/hooks'
import type { MenuItem } from '../lib/types'
import { CartPanel } from '../ui/components/CartPanel'
import { CategoryTabs } from '../ui/components/CategoryTabs'
import { ItemPickerModal } from '../ui/components/ItemPickerModal'
import { MenuList } from '../ui/components/MenuList'
import { ModeBadge } from '../ui/components/ModeBadge'
import { TablePicker } from '../ui/components/TablePicker'
import { colors, spacing } from '../ui/theme'

export default function OrderingScreen() {
  const status = useAuth((s) => s.status)
  const context = useAuth((s) => s.context)
  const selectedLocationId = useAuth((s) => s.selectedLocationId)
  const selectLocation = useAuth((s) => s.selectLocation)
  const logout = useAuth((s) => s.logout)

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
          <Pressable onPress={() => logout()}>
            <Text style={styles.headerLink}>Sign out</Text>
          </Pressable>
        </View>
      </View>

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
})
