import { ScrollView, StyleSheet, Text, Pressable } from 'react-native'
import type { TableSummary } from '../../lib/types'
import { colors, radius, spacing } from '../theme'

interface Props {
  tables: TableSummary[]
  selectedUuid: string | null
  onSelect: (uuid: string) => void
}

export function TablePicker({ tables, selectedUuid, onSelect }: Props) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
    >
      {tables.map((t) => {
        const active = t.id === selectedUuid
        return (
          <Pressable
            key={t.id}
            onPress={() => onSelect(t.id)}
            style={[styles.chip, active && styles.chipActive]}
          >
            <Text style={[styles.label, active && styles.labelActive]}>{t.label}</Text>
          </Pressable>
        )
      })}
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  row: { gap: spacing.sm, paddingHorizontal: spacing.md, paddingVertical: spacing.sm },
  chip: {
    minWidth: 48,
    alignItems: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.primary, borderColor: colors.primary },
  label: { color: colors.text, fontWeight: '700' },
  labelActive: { color: colors.primaryText },
})
