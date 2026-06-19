// Variant + modifier picker. Enforces: pick exactly one variant when the item has variants, and
// each modifier group's min_select/max_select. Shows a running unit price and only enables
// "Add to cart" when the selection is valid.

import { useEffect, useState } from 'react'
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native'
import { formatMoney, toCents } from '../../lib/money'
import type { MenuItem, ModifierOption, Variant } from '../../lib/types'
import { colors, radius, spacing } from '../theme'

interface Props {
  item: MenuItem | null
  visible: boolean
  onClose: () => void
  onAdd: (variant: Variant | null, modifiers: ModifierOption[]) => void
}

export function ItemPickerModal({ item, visible, onClose, onAdd }: Props) {
  const [variantId, setVariantId] = useState<string | null>(null)
  // group id -> selected option ids
  const [selected, setSelected] = useState<Record<string, string[]>>({})

  // Reset selection whenever a new item opens.
  const itemId = item?.id
  useEffect(() => {
    setVariantId(item?.variants?.[0]?.id ?? null)
    setSelected({})
  }, [itemId]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!item) return null

  const hasVariants = item.variants.length > 0
  const variant = item.variants.find((v) => v.id === variantId) ?? null

  const toggleOption = (groupId: string, optionId: string, maxSelect: number) => {
    setSelected((prev) => {
      const cur = prev[groupId] ?? []
      if (cur.includes(optionId)) {
        return { ...prev, [groupId]: cur.filter((id) => id !== optionId) }
      }
      if (maxSelect === 1) return { ...prev, [groupId]: [optionId] } // single-select radio
      if (cur.length >= maxSelect) return prev // at cap
      return { ...prev, [groupId]: [...cur, optionId] }
    })
  }

  const groupsValid = item.modifier_groups.every((g) => {
    const count = (selected[g.id] ?? []).length
    return count >= g.min_select && count <= g.max_select
  })
  const variantValid = !hasVariants || !!variant
  const valid = groupsValid && variantValid

  const selectedModifiers: ModifierOption[] = item.modifier_groups.flatMap((g) =>
    g.options.filter((o) => (selected[g.id] ?? []).includes(o.id)),
  )

  const unitCents =
    toCents(item.base_price) +
    (variant ? toCents(variant.price_delta) : 0) +
    selectedModifiers.reduce((sum, m) => sum + toCents(m.price_delta), 0)

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.sheet}>
          <Text style={styles.title}>{item.name}</Text>
          {!!item.description && <Text style={styles.desc}>{item.description}</Text>}

          <ScrollView style={styles.scroll}>
            {hasVariants && (
              <View style={styles.group}>
                <Text style={styles.groupTitle}>Choose one</Text>
                {item.variants.map((v) => (
                  <Pressable
                    key={v.id}
                    style={styles.optionRow}
                    onPress={() => setVariantId(v.id)}
                  >
                    <Text style={styles.radio}>{variantId === v.id ? '◉' : '○'}</Text>
                    <Text style={styles.optionName}>{v.name}</Text>
                    {toCents(v.price_delta) !== 0 && (
                      <Text style={styles.optionPrice}>
                        {toCents(v.price_delta) > 0 ? '+' : ''}
                        {formatMoney(toCents(v.price_delta))}
                      </Text>
                    )}
                  </Pressable>
                ))}
              </View>
            )}

            {item.modifier_groups.map((g) => {
              const count = (selected[g.id] ?? []).length
              const rule =
                g.min_select > 0
                  ? `Choose ${g.min_select === g.max_select ? g.min_select : `${g.min_select}–${g.max_select}`}`
                  : `Up to ${g.max_select} (optional)`
              return (
                <View key={g.id} style={styles.group}>
                  <Text style={styles.groupTitle}>
                    {g.name} · {rule}
                  </Text>
                  {g.options.map((o) => {
                    const isSel = (selected[g.id] ?? []).includes(o.id)
                    const disabled = !o.is_available
                    return (
                      <Pressable
                        key={o.id}
                        disabled={disabled}
                        style={[styles.optionRow, disabled && styles.disabled]}
                        onPress={() => toggleOption(g.id, o.id, g.max_select)}
                      >
                        <Text style={styles.radio}>
                          {g.max_select === 1 ? (isSel ? '◉' : '○') : isSel ? '☑' : '☐'}
                        </Text>
                        <Text style={styles.optionName}>{o.name}</Text>
                        {toCents(o.price_delta) !== 0 && (
                          <Text style={styles.optionPrice}>
                            {toCents(o.price_delta) > 0 ? '+' : ''}
                            {formatMoney(toCents(o.price_delta))}
                          </Text>
                        )}
                      </Pressable>
                    )
                  })}
                  {count < g.min_select && (
                    <Text style={styles.err}>Select at least {g.min_select}.</Text>
                  )}
                </View>
              )
            })}
          </ScrollView>

          <View style={styles.footer}>
            <Pressable style={styles.cancelBtn} onPress={onClose}>
              <Text style={styles.cancelText}>Cancel</Text>
            </Pressable>
            <Pressable
              style={[styles.addBtn, !valid && styles.disabled]}
              disabled={!valid}
              onPress={() => onAdd(variant, selectedModifiers)}
            >
              <Text style={styles.addText}>Add · {formatMoney(unitCents)}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  )
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.35)', justifyContent: 'flex-end' },
  sheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: radius.lg,
    borderTopRightRadius: radius.lg,
    padding: spacing.lg,
    maxHeight: '85%',
  },
  title: { fontSize: 20, fontWeight: '700', color: colors.text },
  desc: { color: colors.textMuted, marginTop: spacing.xs },
  scroll: { marginVertical: spacing.md },
  group: { marginBottom: spacing.lg },
  groupTitle: { fontWeight: '600', color: colors.text, marginBottom: spacing.sm },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: spacing.sm,
    gap: spacing.sm,
  },
  radio: { fontSize: 18, color: colors.primary, width: 22 },
  optionName: { flex: 1, color: colors.text },
  optionPrice: { color: colors.textMuted },
  err: { color: colors.danger, fontSize: 12, marginTop: spacing.xs },
  disabled: { opacity: 0.4 },
  footer: { flexDirection: 'row', gap: spacing.md },
  cancelBtn: {
    flex: 1,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  cancelText: { color: colors.text, fontWeight: '600' },
  addBtn: {
    flex: 2,
    paddingVertical: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.primary,
    alignItems: 'center',
  },
  addText: { color: colors.primaryText, fontWeight: '700' },
})
