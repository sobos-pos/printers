import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { formatMoney } from '../../lib/money'
import { lineTotalCents, lineUnitCents, useCart } from '../../ordering/cart'
import { colors, radius, spacing } from '../theme'

interface Props {
  canPlace: boolean
  placing: boolean
  onPlace: () => void
}

export function CartPanel({ canPlace, placing, onPlace }: Props) {
  const lines = useCart((s) => s.lines)
  const orderNote = useCart((s) => s.orderNote)
  const setQty = useCart((s) => s.setQty)
  const setLineNote = useCart((s) => s.setLineNote)
  const setOrderNote = useCart((s) => s.setOrderNote)
  const subtotalCents = useCart((s) => s.subtotalCents())

  return (
    <View style={styles.panel}>
      <Text style={styles.heading}>Cart</Text>
      <ScrollView style={styles.lines}>
        {lines.length === 0 && <Text style={styles.empty}>Add items to start an order.</Text>}
        {lines.map((l) => (
          <View key={l.key} style={styles.line}>
            <View style={styles.lineHeader}>
              <Text style={styles.lineName}>
                {l.item.name}
                {l.variant ? ` · ${l.variant.name}` : ''}
              </Text>
              <Text style={styles.linePrice}>{formatMoney(lineTotalCents(l))}</Text>
            </View>
            {l.modifiers.length > 0 && (
              <Text style={styles.mods}>{l.modifiers.map((m) => m.name).join(', ')}</Text>
            )}
            <Text style={styles.unit}>{formatMoney(lineUnitCents(l))} each</Text>
            <View style={styles.qtyRow}>
              <Pressable style={styles.qtyBtn} onPress={() => setQty(l.key, l.qty - 1)}>
                <Text style={styles.qtyBtnText}>−</Text>
              </Pressable>
              <Text style={styles.qty}>{l.qty}</Text>
              <Pressable style={styles.qtyBtn} onPress={() => setQty(l.key, l.qty + 1)}>
                <Text style={styles.qtyBtnText}>+</Text>
              </Pressable>
            </View>
            <TextInput
              style={styles.noteInput}
              placeholder="Line note (e.g. no onions)"
              placeholderTextColor={colors.textMuted}
              value={l.note}
              onChangeText={(t) => setLineNote(l.key, t)}
            />
          </View>
        ))}
      </ScrollView>

      <TextInput
        style={styles.orderNote}
        placeholder="Order note (optional)"
        placeholderTextColor={colors.textMuted}
        value={orderNote}
        onChangeText={setOrderNote}
      />

      <View style={styles.totalRow}>
        <Text style={styles.totalLabel}>Subtotal</Text>
        <Text style={styles.totalValue}>{formatMoney(subtotalCents)}</Text>
      </View>

      <Pressable
        style={[styles.placeBtn, (!canPlace || placing) && styles.disabled]}
        disabled={!canPlace || placing}
        onPress={onPlace}
      >
        {placing ? (
          <ActivityIndicator color={colors.primaryText} />
        ) : (
          <Text style={styles.placeText}>Place order</Text>
        )}
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  panel: {
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.sm,
  },
  heading: { fontSize: 16, fontWeight: '700', color: colors.text },
  lines: { maxHeight: 220 },
  empty: { color: colors.textMuted, paddingVertical: spacing.md },
  line: {
    borderBottomWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.sm,
    gap: 2,
  },
  lineHeader: { flexDirection: 'row', justifyContent: 'space-between' },
  lineName: { fontWeight: '600', color: colors.text, flex: 1 },
  linePrice: { fontWeight: '700', color: colors.text },
  mods: { color: colors.textMuted, fontSize: 12 },
  unit: { color: colors.textMuted, fontSize: 12 },
  qtyRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.xs },
  qtyBtn: {
    width: 32,
    height: 32,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  qtyBtnText: { fontSize: 18, color: colors.text },
  qty: { fontSize: 16, fontWeight: '600', minWidth: 24, textAlign: 'center', color: colors.text },
  noteInput: {
    marginTop: spacing.xs,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
    color: colors.text,
  },
  orderNote: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.sm,
    color: colors.text,
  },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  totalLabel: { fontSize: 16, color: colors.textMuted },
  totalValue: { fontSize: 20, fontWeight: '700', color: colors.text },
  placeBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  placeText: { color: colors.primaryText, fontWeight: '700', fontSize: 16 },
  disabled: { opacity: 0.4 },
})
