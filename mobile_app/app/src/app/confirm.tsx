// Confirmation screen. Shows the placed order id + status + total, polls for status updates, and
// offers "Start next table order".

import { router, useLocalSearchParams } from 'expo-router'
import { useState } from 'react'
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native'
import { formatMoney, toCents } from '../lib/money'
import { useOrderStatus } from '../ordering/hooks'
import { colors, radius, spacing } from '../ui/theme'

export default function ConfirmScreen() {
  const { orderId } = useLocalSearchParams<{ orderId: string }>()
  const [poll, setPoll] = useState(true)
  const q = useOrderStatus(orderId ?? null, poll)

  const order = q.data

  return (
    <View style={styles.container}>
      <View style={styles.card}>
        <Text style={styles.check}>✓</Text>
        <Text style={styles.title}>Order placed</Text>

        {q.isLoading ? (
          <ActivityIndicator color={colors.primary} />
        ) : order ? (
          <>
            <Text style={styles.row}>
              Order: <Text style={styles.value}>{order.id}</Text>
            </Text>
            {!!order.table_label && (
              <Text style={styles.row}>
                Table: <Text style={styles.value}>{order.table_label}</Text>
              </Text>
            )}
            <Text style={styles.row}>
              Status: <Text style={styles.value}>{order.status}</Text>
            </Text>
            <Text style={styles.row}>
              Total: <Text style={styles.value}>{formatMoney(toCents(order.total))}</Text>
            </Text>
          </>
        ) : (
          <Text style={styles.row}>Order #{orderId} placed.</Text>
        )}

        <Pressable style={styles.pollToggle} onPress={() => setPoll((p) => !p)}>
          <Text style={styles.pollText}>
            {poll ? 'Auto-refresh: on' : 'Auto-refresh: off'}
          </Text>
        </Pressable>
      </View>

      <Pressable style={styles.nextBtn} onPress={() => router.replace('/ordering')}>
        <Text style={styles.nextText}>Start next table order</Text>
      </Pressable>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.bg,
    padding: spacing.lg,
    justifyContent: 'center',
    gap: spacing.lg,
  },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.xl,
    gap: spacing.sm,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
  },
  check: { fontSize: 48, color: colors.success },
  title: { fontSize: 22, fontWeight: '800', color: colors.text, marginBottom: spacing.sm },
  row: { color: colors.textMuted, fontSize: 15 },
  value: { color: colors.text, fontWeight: '700' },
  pollToggle: { marginTop: spacing.md },
  pollText: { color: colors.primary, fontWeight: '600' },
  nextBtn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
  },
  nextText: { color: colors.primaryText, fontWeight: '700', fontSize: 16 },
})
