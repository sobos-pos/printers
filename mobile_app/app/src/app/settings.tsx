// Settings: node/cloud URL configuration + mDNS status.
// The node URL is auto-populated from mDNS on the same Wi-Fi; the manual field is an override
// of last resort. A "Re-discover" button runs a fresh mDNS scan without leaving this screen.

import { useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useConnection } from '../net/connection'
import { colors, radius, spacing } from '../ui/theme'

/** Human-readable label for where the current node URL came from. */
function urlSourceLabel(
  discoveredNodeUrl: string | null,
  settingsNodeUrl: string,
  mdnsAvailable: boolean,
): string {
  if (discoveredNodeUrl) return '📡 Auto-discovered via mDNS'
  if (settingsNodeUrl) return '✏️ Manual (entered in Settings)'
  if (!mdnsAvailable) return '⚠️ mDNS unavailable — use a dev client or production build'
  return '⏳ Not yet discovered — tap Re-discover'
}

export default function SettingsScreen() {
  const discoveredNodeUrl = useConnection((s) => s.discoveredNodeUrl)
  const settingsNodeUrl = useConnection((s) => s.settingsNodeUrl)
  const cloudBaseUrl = useConnection((s) => s.cloudBaseUrl)
  const mdnsAvailable = useConnection((s) => s.mdnsAvailable)
  const mdnsScanning = useConnection((s) => s.mdnsScanning)
  const mode = useConnection((s) => s.mode)
  const setSettingsNodeUrl = useConnection((s) => s.setSettingsNodeUrl)
  const setCloudBaseUrl = useConnection((s) => s.setCloudBaseUrl)
  const probe = useConnection((s) => s.probe)
  const rediscover = useConnection((s) => s.rediscover)

  // Local draft values for the text inputs.
  const [nodeOverride, setNodeOverride] = useState<string | null>(null)
  const [cloud, setCloud] = useState(cloudBaseUrl)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  // The displayed node URL: prefer the live mDNS result, then the manual setting.
  const displayedNode = discoveredNodeUrl || settingsNodeUrl

  // nodeOverride is non-null only while the user is actively editing.
  const nodeFieldValue = nodeOverride !== null ? nodeOverride : displayedNode

  useFocusEffect(
    useCallback(() => {
      // Reset draft and sync with store on every screen focus.
      setNodeOverride(null)
      setCloud(useConnection.getState().cloudBaseUrl)
      setResult(null)
    }, []),
  )

  const save = async () => {
    // Only persist the manual override if the user actually edited the field
    // (or if there's no mDNS result and they want to set it manually).
    if (nodeOverride !== null) {
      await setSettingsNodeUrl(nodeOverride.trim())
      setNodeOverride(null)
    }
    await setCloudBaseUrl(cloud.trim())
    setResult('Saved.')
  }

  const test = async () => {
    await save()
    setTesting(true)
    setResult(null)
    const m = await probe(true) // force=true: re-run mDNS then health-check
    setTesting(false)
    setResult(m === 'local' ? 'Connected to local node 🟢' : 'Using cloud 🟡 (node not reachable)')
  }

  const handleRediscover = async () => {
    setResult(null)
    await rediscover()
    // After mDNS, do a quick health check so the mode badge updates.
    await probe(false)
    const s = useConnection.getState()
    setResult(
      s.discoveredNodeUrl
        ? `Found: ${s.discoveredNodeUrl} 🟢`
        : 'No node found on this Wi-Fi — check that the leader is running.',
    )
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>

      {/* Status card */}
      <View style={styles.statusCard}>
        <Text style={styles.statusLine}>
          Mode: <Text style={styles.bold}>{mode}</Text>
        </Text>
        <Text style={styles.statusLine}>
          mDNS: <Text style={styles.bold}>{mdnsAvailable ? 'available' : 'unavailable (Expo Go?)'}</Text>
        </Text>
        <Text style={[styles.statusLine, styles.sourceLabel]}>
          {urlSourceLabel(discoveredNodeUrl, settingsNodeUrl, mdnsAvailable)}
        </Text>
      </View>

      {/* Node URL */}
      <View style={styles.labelRow}>
        <Text style={styles.label}>Node URL</Text>
        <Pressable
          style={[styles.smallBtn, (mdnsScanning || testing) && styles.smallBtnDisabled]}
          onPress={handleRediscover}
          disabled={mdnsScanning || testing}
        >
          {mdnsScanning ? (
            <ActivityIndicator size="small" color={colors.primary} />
          ) : (
            <Text style={styles.smallBtnText}>Re-discover</Text>
          )}
        </Pressable>
      </View>
      <Text style={styles.help}>
        Auto-filled from mDNS when the leader is on the same Wi-Fi. Edit only if auto-discovery
        doesn't work (e.g. http://192.168.1.50:3001).
      </Text>
      <TextInput
        style={[styles.input, !!discoveredNodeUrl && nodeOverride === null && styles.inputAutoFilled]}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="Waiting for mDNS… or enter manually"
        placeholderTextColor={colors.textMuted}
        value={nodeFieldValue}
        onChangeText={(v) => setNodeOverride(v)}
      />
      {discoveredNodeUrl && nodeOverride === null && (
        <Text style={styles.autoTag}>auto-discovered</Text>
      )}

      {/* Cloud URL */}
      <Text style={styles.label}>Cloud URL</Text>
      <Text style={styles.help}>Used for login and as the fallback when the node is unreachable.</Text>
      <TextInput
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="https://api.soboss.example"
        placeholderTextColor={colors.textMuted}
        value={cloud}
        onChangeText={setCloud}
      />

      {!!result && <Text style={styles.result}>{result}</Text>}

      <View style={styles.row}>
        <Pressable style={[styles.btn, styles.secondary]} onPress={save}>
          <Text style={styles.secondaryText}>Save</Text>
        </Pressable>
        <Pressable style={[styles.btn, styles.primary]} disabled={testing || mdnsScanning} onPress={test}>
          {testing ? (
            <ActivityIndicator color={colors.primaryText} />
          ) : (
            <Text style={styles.primaryText}>Save & test</Text>
          )}
        </Pressable>
      </View>
    </ScrollView>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bg },
  content: { padding: spacing.lg, gap: spacing.sm },
  statusCard: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    gap: spacing.xs,
    marginBottom: spacing.md,
  },
  statusLine: { color: colors.textMuted },
  sourceLabel: { fontSize: 13, marginTop: 2 },
  bold: { color: colors.text, fontWeight: '700' },
  labelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
  },
  label: { fontWeight: '700', color: colors.text, marginTop: spacing.md },
  help: { color: colors.textMuted, fontSize: 13 },
  input: {
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
    fontSize: 16,
    color: colors.text,
    backgroundColor: colors.surface,
  },
  inputAutoFilled: {
    borderColor: colors.primary,
    backgroundColor: colors.surface,
  },
  autoTag: {
    fontSize: 11,
    color: colors.primary,
    marginTop: 2,
    fontWeight: '600',
  },
  smallBtn: {
    paddingHorizontal: spacing.sm,
    paddingVertical: 4,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.primary,
    minWidth: 90,
    alignItems: 'center',
  },
  smallBtnDisabled: { opacity: 0.5 },
  smallBtnText: { color: colors.primary, fontWeight: '600', fontSize: 13 },
  result: { color: colors.text, fontWeight: '600', marginTop: spacing.sm },
  row: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg },
  btn: { flex: 1, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: 'center' },
  secondary: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  secondaryText: { color: colors.text, fontWeight: '700' },
  primary: { backgroundColor: colors.primary },
  primaryText: { color: colors.primaryText, fontWeight: '700' },
})
