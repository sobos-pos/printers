// Profile screen: identity + a GitHub-style attendance heatmap, one month at a time
// with prev/next navigation. Tapping a day shows that day's worked total.

import { Redirect } from 'expo-router'
import { useMemo, useState } from 'react'
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { useAuth } from '../auth/store'
import { NetworkError } from '../net/apiClient'
import { useAttendanceHistory } from '../ordering/hooks'
import { AttendanceHeatmap, formatHm } from '../ui/components/AttendanceHeatmap'
import type { AttendanceDay } from '../lib/types'
import { colors, radius, spacing } from '../ui/theme'

function fmtLocal(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function initialsOf(name: string | undefined): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export default function ProfileScreen() {
  const status = useAuth((s) => s.status)
  const user = useAuth((s) => s.context?.user ?? null)

  // The month currently shown (anchored to its 1st). Starts at the current month.
  const [monthDate, setMonthDate] = useState(() => {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), 1)
  })
  const [selected, setSelected] = useState<{ date: string; day: AttendanceDay | null } | null>(null)

  const range = useMemo(() => {
    const first = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1)
    const last = new Date(monthDate.getFullYear(), monthDate.getMonth() + 1, 0)
    return { from: fmtLocal(first), to: fmtLocal(last) }
  }, [monthDate])

  const historyQ = useAttendanceHistory(range.from, range.to)

  if (status === 'anonymous') return <Redirect href="/login" />

  const now = new Date()
  const isCurrentMonth =
    monthDate.getFullYear() === now.getFullYear() && monthDate.getMonth() === now.getMonth()

  const goPrev = () => {
    setSelected(null)
    setMonthDate((d) => new Date(d.getFullYear(), d.getMonth() - 1, 1))
  }
  const goNext = () => {
    if (isCurrentMonth) return
    setSelected(null)
    setMonthDate((d) => new Date(d.getFullYear(), d.getMonth() + 1, 1))
  }

  const days = historyQ.data?.days ?? []
  const totalMinutes = historyQ.data?.total_minutes ?? 0
  const totalDays = historyQ.data?.total_days ?? 0

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <ScrollView contentContainerStyle={styles.content}>
        {/* Identity card */}
        <View style={styles.idCard}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initialsOf(user?.name)}</Text>
          </View>
          <View style={styles.idInfo}>
            <Text style={styles.name}>{user?.name ?? '—'}</Text>
            {!!user?.role && <Text style={styles.role}>{user.role}</Text>}
            {!!user?.email && <Text style={styles.meta}>{user.email}</Text>}
            {!!user?.location?.name && <Text style={styles.meta}>📍 {user.location.name}</Text>}
          </View>
        </View>

        {/* Month summary */}
        <View style={styles.statsRow}>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{formatHm(totalMinutes)}</Text>
            <Text style={styles.statLabel}>Worked this month</Text>
          </View>
          <View style={styles.statCard}>
            <Text style={styles.statValue}>{totalDays}</Text>
            <Text style={styles.statLabel}>Days present</Text>
          </View>
        </View>

        {/* Heatmap */}
        <View style={styles.card}>
          <Text style={styles.cardTitle}>Attendance</Text>

          {historyQ.isLoading ? (
            <ActivityIndicator style={styles.pad} color={colors.primary} />
          ) : historyQ.isError ? (
            <Text style={styles.error}>
              {historyQ.error instanceof NetworkError
                ? 'Could not reach the server. Pull up later to retry.'
                : (historyQ.error as Error)?.message ?? 'Failed to load attendance.'}
            </Text>
          ) : (
            <>
              <AttendanceHeatmap
                monthDate={monthDate}
                days={days}
                onPrev={goPrev}
                onNext={goNext}
                canGoNext={!isCurrentMonth}
                onSelectDay={(day, date) => setSelected({ date, day })}
              />
              {selected && (
                <Text style={styles.selectedText}>
                  {new Date(selected.date + 'T00:00:00').toLocaleDateString(undefined, {
                    weekday: 'short',
                    day: 'numeric',
                    month: 'short',
                  })}
                  {' — '}
                  {selected.day && selected.day.minutes > 0
                    ? `${formatHm(selected.day.minutes)} across ${selected.day.shifts} shift${
                        selected.day.shifts === 1 ? '' : 's'
                      }`
                    : 'No attendance'}
                </Text>
              )}
            </>
          )}
        </View>
      </ScrollView>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.md },
  idCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  avatar: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.primaryText, fontWeight: '800', fontSize: 20 },
  idInfo: { flex: 1, gap: 2 },
  name: { fontSize: 18, fontWeight: '800', color: colors.text },
  role: { fontSize: 13, color: colors.primary, fontWeight: '700', textTransform: 'capitalize' },
  meta: { fontSize: 13, color: colors.textMuted },
  statsRow: { flexDirection: 'row', gap: spacing.md },
  statCard: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    alignItems: 'center',
  },
  statValue: { fontSize: 20, fontWeight: '800', color: colors.text },
  statLabel: { fontSize: 12, color: colors.textMuted, marginTop: 2 },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  cardTitle: { fontSize: 15, fontWeight: '800', color: colors.text, marginBottom: spacing.md },
  pad: { padding: spacing.lg },
  error: { color: colors.danger, fontSize: 13, paddingVertical: spacing.sm },
  selectedText: {
    marginTop: spacing.md,
    textAlign: 'center',
    color: colors.text,
    fontWeight: '600',
    fontSize: 13,
  },
})
