// GitHub-style attendance heatmap for a SINGLE month (mobile shows one month at a
// time, with ◀ / ▶ to page between months). Columns are weeks, rows are weekdays —
// each cell's shade reflects minutes worked that day.

import { Pressable, StyleSheet, Text, View } from 'react-native'
import type { AttendanceDay } from '../../lib/types'
import { colors, radius, spacing } from '../theme'

const CELL = 34
const GAP = 5
const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]

// Five-step green scale (GitHub-like). Index 0 = no work.
const SCALE = ['#ebedf0', '#9be9a8', '#40c463', '#30a14e', '#216e39']

/** Local YYYY-MM-DD (NOT UTC — avoids the toISOString day-shift across timezones). */
function fmtLocal(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

function intensity(minutes: number): number {
  if (minutes <= 0) return 0
  const hours = minutes / 60
  if (hours < 2) return 1
  if (hours < 4) return 2
  if (hours < 6) return 3
  return 4
}

function formatHm(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h && m) return `${h}h ${m}m`
  if (h) return `${h}h`
  return `${m}m`
}

interface Props {
  /** Any date within the month to display. */
  monthDate: Date
  days: AttendanceDay[]
  onPrev: () => void
  onNext: () => void
  /** When false, the ▶ (future) button is disabled. */
  canGoNext: boolean
  onSelectDay?: (day: AttendanceDay | null, date: string) => void
}

export function AttendanceHeatmap({ monthDate, days, onPrev, onNext, canGoNext, onSelectDay }: Props) {
  const year = monthDate.getFullYear()
  const month = monthDate.getMonth()

  const byDate = new Map(days.map((d) => [d.date, d]))

  // Grid starts on the Sunday on/before the 1st, ends on the Saturday on/after the last day.
  const firstOfMonth = new Date(year, month, 1)
  const lastOfMonth = new Date(year, month + 1, 0)
  const gridStart = new Date(firstOfMonth)
  gridStart.setDate(firstOfMonth.getDate() - firstOfMonth.getDay())
  // Number of week-columns needed to cover the month (leading offset + days).
  const weeks = Math.ceil((firstOfMonth.getDay() + lastOfMonth.getDate()) / 7)

  const todayKey = fmtLocal(new Date())

  // Build columns (weeks) of 7 day-cells each.
  const columns: Array<Array<{ date: Date; key: string; inMonth: boolean }>> = []
  for (let w = 0; w < weeks; w++) {
    const col: Array<{ date: Date; key: string; inMonth: boolean }> = []
    for (let r = 0; r < 7; r++) {
      const d = new Date(gridStart)
      d.setDate(gridStart.getDate() + w * 7 + r)
      col.push({ date: d, key: fmtLocal(d), inMonth: d.getMonth() === month })
    }
    columns.push(col)
  }

  return (
    <View>
      {/* Month navigation */}
      <View style={styles.navRow}>
        <Pressable onPress={onPrev} style={styles.navBtn} hitSlop={8} accessibilityLabel="Previous month">
          <Text style={styles.navArrow}>‹</Text>
        </Pressable>
        <Text style={styles.navTitle}>
          {MONTHS[month]} {year}
        </Text>
        <Pressable
          onPress={canGoNext ? onNext : undefined}
          disabled={!canGoNext}
          style={[styles.navBtn, !canGoNext && styles.navBtnDisabled]}
          hitSlop={8}
          accessibilityLabel="Next month"
        >
          <Text style={styles.navArrow}>›</Text>
        </Pressable>
      </View>

      {/* Grid: left weekday labels + week columns */}
      <View style={styles.gridRow}>
        <View style={styles.labelCol}>
          {WEEKDAY_LABELS.map((l, i) => (
            <View key={i} style={styles.labelCell}>
              <Text style={styles.labelText}>{l}</Text>
            </View>
          ))}
        </View>

        <View style={styles.weeks}>
          {columns.map((col, ci) => (
            <View key={ci} style={styles.weekCol}>
              {col.map((cell) => {
                const rec = byDate.get(cell.key)
                const mins = rec?.minutes ?? 0
                const level = cell.inMonth ? intensity(mins) : 0
                const isToday = cell.key === todayKey
                return (
                  <Pressable
                    key={cell.key}
                    onPress={onSelectDay ? () => onSelectDay(rec ?? null, cell.key) : undefined}
                    style={[
                      styles.cell,
                      { backgroundColor: cell.inMonth ? SCALE[level] : 'transparent' },
                      isToday && cell.inMonth && styles.cellToday,
                    ]}
                  >
                    {cell.inMonth && (
                      <Text style={[styles.dateNum, level >= 3 && styles.dateNumLight]}>
                        {cell.date.getDate()}
                      </Text>
                    )}
                  </Pressable>
                )
              })}
            </View>
          ))}
        </View>
      </View>

      {/* Legend */}
      <View style={styles.legend}>
        <Text style={styles.legendText}>Less</Text>
        {SCALE.map((c, i) => (
          <View key={i} style={[styles.legendCell, { backgroundColor: c }]} />
        ))}
        <Text style={styles.legendText}>More</Text>
      </View>
    </View>
  )
}

export { formatHm }

const styles = StyleSheet.create({
  navRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  navBtn: {
    width: 40,
    height: 40,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  navBtnDisabled: { opacity: 0.35 },
  navArrow: { fontSize: 22, color: colors.text, fontWeight: '700', lineHeight: 24 },
  navTitle: { fontSize: 16, fontWeight: '800', color: colors.text },
  gridRow: { flexDirection: 'row', justifyContent: 'center' },
  labelCol: { marginRight: GAP },
  labelCell: { height: CELL, marginBottom: GAP, width: 16, alignItems: 'center', justifyContent: 'center' },
  labelText: { fontSize: 10, color: colors.textMuted, fontWeight: '600' },
  weeks: { flexDirection: 'row' },
  weekCol: { marginRight: GAP },
  cell: {
    width: CELL,
    height: CELL,
    marginBottom: GAP,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cellToday: { borderWidth: 1.5, borderColor: colors.primary },
  dateNum: { fontSize: 10, color: colors.textMuted, fontWeight: '600' },
  dateNumLight: { color: 'rgba(255,255,255,0.9)' },
  legend: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    marginTop: spacing.md,
  },
  legendText: { fontSize: 11, color: colors.textMuted, marginHorizontal: 4 },
  legendCell: { width: 14, height: 14, borderRadius: 3 },
})
