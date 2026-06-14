// Connection mode indicator (🟢 Local / 🟡 Cloud / probing) driven by the connection store.
// Tapping it forces a re-probe + mDNS rediscovery.

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { useConnection } from '../../net/connection'
import { colors, radius, spacing } from '../theme'

export function ModeBadge() {
  const mode = useConnection((s) => s.mode)
  const probe = useConnection((s) => s.probe)

  const label =
    mode === 'local' ? '🟢 Local (Node)' : mode === 'cloud' ? '🟡 Cloud (Online)' : 'Probing…'
  const dotColor =
    mode === 'local' ? colors.localBadge : mode === 'cloud' ? colors.cloudBadge : colors.textMuted

  return (
    <Pressable onPress={() => probe(true)} style={[styles.badge, { borderColor: dotColor }]}>
      {mode === 'probing' ? (
        <ActivityIndicator size="small" color={dotColor} />
      ) : (
        <View style={[styles.dot, { backgroundColor: dotColor }]} />
      )}
      <Text style={styles.text}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  badge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    borderWidth: 1,
    borderRadius: radius.lg,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
    backgroundColor: colors.surface,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  text: { fontSize: 12, fontWeight: '600', color: colors.text },
})
