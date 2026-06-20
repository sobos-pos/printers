// Header profile control: a circular avatar (user initials). Tapping opens a small
// menu with "Profile" and "Sign out". Signing out while still clocked in prompts the
// user to clock out first (per requirement) rather than silently leaving a shift open.

import { router } from 'expo-router'
import { useState } from 'react'
import { Alert, Modal, Pressable, StyleSheet, Text, View } from 'react-native'
import { useAuth } from '../../auth/store'
import { resolveClockOutCoords } from '../../ordering/attendanceActions'
import { useAttendanceStatus, useClockOut } from '../../ordering/hooks'
import { useGeofence } from '../../ordering/useGeofence'
import { colors, radius, spacing } from '../theme'

function initialsOf(name: string | undefined): string {
  if (!name) return '?'
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

export function ProfileMenu() {
  const user = useAuth((s) => s.context?.user ?? null)
  const logout = useAuth((s) => s.logout)
  const attendanceQ = useAttendanceStatus()
  const clockOut = useClockOut()
  const geo = useGeofence()
  const [open, setOpen] = useState(false)

  const close = () => setOpen(false)

  const doLogout = async () => {
    await logout()
    router.replace('/login')
  }

  const onSignOut = () => {
    close()
    if (attendanceQ.data?.clocked_in) {
      Alert.alert(
        'You’re still clocked in',
        'Do you want to clock out before signing out?',
        [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Sign out anyway', style: 'destructive', onPress: doLogout },
          {
            text: 'Clock out & sign out',
            onPress: async () => {
              try {
                const coords = await resolveClockOutCoords(geo)
                await clockOut.mutateAsync(coords)
              } catch {
                // Even if clock-out fails (offline), don't trap the user — sign out anyway.
              }
              await doLogout()
            },
          },
        ],
      )
    } else {
      Alert.alert('Sign out', 'Are you sure you want to sign out?', [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Sign out', style: 'destructive', onPress: doLogout },
      ])
    }
  }

  const onProfile = () => {
    close()
    router.push('/profile')
  }

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        style={styles.avatar}
        accessibilityRole="button"
        accessibilityLabel="Open profile menu"
      >
        <Text style={styles.avatarText}>{initialsOf(user?.name)}</Text>
      </Pressable>

      <Modal visible={open} transparent animationType="fade" onRequestClose={close}>
        <Pressable style={styles.backdrop} onPress={close}>
          <View style={styles.menu}>
            <View style={styles.menuHeader}>
              <Text style={styles.menuName} numberOfLines={1}>
                {user?.name ?? 'Signed in'}
              </Text>
              {!!user?.role && <Text style={styles.menuRole}>{user.role}</Text>}
            </View>
            <Pressable
              style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
              onPress={onProfile}
            >
              <Text style={styles.itemText}>Profile</Text>
            </Pressable>
            <Pressable
              style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
              onPress={onSignOut}
            >
              <Text style={[styles.itemText, styles.signOut]}>Sign out</Text>
            </Pressable>
          </View>
        </Pressable>
      </Modal>
    </>
  )
}

const styles = StyleSheet.create({
  avatar: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: colors.primary,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { color: colors.primaryText, fontWeight: '800', fontSize: 13 },
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.15)' },
  menu: {
    position: 'absolute',
    top: 52,
    right: spacing.md,
    minWidth: 180,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    paddingVertical: spacing.xs,
    shadowColor: '#000',
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 6,
  },
  menuHeader: {
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  menuName: { color: colors.text, fontWeight: '700', fontSize: 14 },
  menuRole: { color: colors.textMuted, fontSize: 12, textTransform: 'capitalize', marginTop: 2 },
  item: { paddingHorizontal: spacing.md, paddingVertical: spacing.md },
  itemPressed: { backgroundColor: colors.bg },
  itemText: { color: colors.text, fontSize: 15, fontWeight: '600' },
  signOut: { color: colors.danger },
})
