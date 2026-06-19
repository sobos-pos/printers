// Login screen. Cloud-only auth. On success routes to the ordering workspace. Surfaces a clear
// inline error for invalid credentials vs. an unreachable server (which usually means the cloud URL
// needs setting in Settings).

import { Link, router } from 'expo-router'
import { useState } from 'react'
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useAuth } from '../auth/store'
import { ApiError, NetworkError } from '../net/apiClient'
import { colors, radius, spacing } from '../ui/theme'

export default function LoginScreen() {
  const login = useAuth((s) => s.login)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const onSubmit = async () => {
    if (!email || !password) {
      setError('Enter your email and password.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await login(email.trim(), password)
      router.replace('/ordering')
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) setError('Invalid credentials')
      else if (err instanceof NetworkError)
        setError('Can’t reach the server. Check the cloud URL in Settings.')
      else setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
    >
      <View style={styles.card}>
        <Text style={styles.title}>Soboss Waiter</Text>
        <Text style={styles.subtitle}>Sign in to start taking orders</Text>

        <TextInput
          style={styles.input}
          placeholder="Email or username"
          placeholderTextColor={colors.textMuted}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          value={email}
          onChangeText={setEmail}
        />
        <TextInput
          style={styles.input}
          placeholder="Password"
          placeholderTextColor={colors.textMuted}
          secureTextEntry
          value={password}
          onChangeText={setPassword}
          onSubmitEditing={onSubmit}
        />

        {!!error && <Text style={styles.error}>{error}</Text>}

        <Pressable style={[styles.btn, busy && styles.disabled]} disabled={busy} onPress={onSubmit}>
          {busy ? (
            <ActivityIndicator color={colors.primaryText} />
          ) : (
            <Text style={styles.btnText}>Sign in</Text>
          )}
        </Pressable>

        <Link href="/settings" style={styles.link}>
          Server settings
        </Link>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, justifyContent: 'center', backgroundColor: colors.bg, padding: spacing.lg },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    padding: spacing.xl,
    gap: spacing.md,
    borderWidth: 1,
    borderColor: colors.border,
  },
  title: { fontSize: 26, fontWeight: '800', color: colors.text, textAlign: 'center' },
  subtitle: { color: colors.textMuted, textAlign: 'center', marginBottom: spacing.sm },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: 16,
    color: colors.text,
  },
  error: { color: colors.danger, fontWeight: '600' },
  btn: {
    backgroundColor: colors.primary,
    borderRadius: radius.md,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.sm,
  },
  btnText: { color: colors.primaryText, fontWeight: '700', fontSize: 16 },
  disabled: { opacity: 0.5 },
  link: { color: colors.primary, textAlign: 'center', marginTop: spacing.sm, fontWeight: '600' },
})
