import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native'
import { formatMoney, toCents } from '../../lib/money'
import type { MenuItem } from '../../lib/types'
import { colors, radius, spacing } from '../theme'

interface Props {
  items: MenuItem[]
  onItemPress: (item: MenuItem) => void
}

export function MenuList({ items, onItemPress }: Props) {
  return (
    <FlatList
      data={items}
      keyExtractor={(i) => i.id}
      contentContainerStyle={styles.list}
      renderItem={({ item }) => {
        const configurable = item.variants.length > 0 || item.modifier_groups.length > 0
        return (
          <Pressable
            style={[styles.row, !item.is_available && styles.disabled]}
            disabled={!item.is_available}
            onPress={() => onItemPress(item)}
          >
            <View style={styles.info}>
              <Text style={styles.name}>{item.name}</Text>
              {!!item.description && (
                <Text style={styles.desc} numberOfLines={2}>
                  {item.description}
                </Text>
              )}
              <Text style={styles.price}>
                {formatMoney(toCents(item.base_price))}
                {configurable ? ' +' : ''}
              </Text>
            </View>
            <Text style={styles.add}>{configurable ? 'Choose' : 'Add'}</Text>
          </Pressable>
        )
      }}
      ListEmptyComponent={<Text style={styles.empty}>No items in this category.</Text>}
    />
  )
}

const styles = StyleSheet.create({
  list: { padding: spacing.md, gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  disabled: { opacity: 0.4 },
  info: { flex: 1, gap: 2 },
  name: { fontSize: 16, fontWeight: '600', color: colors.text },
  desc: { color: colors.textMuted, fontSize: 13 },
  price: { color: colors.text, fontWeight: '600', marginTop: spacing.xs },
  add: { color: colors.primary, fontWeight: '700', paddingLeft: spacing.md },
  empty: { textAlign: 'center', color: colors.textMuted, padding: spacing.xl },
})
