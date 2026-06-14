// Settings: the manual fallback for leader discovery. Edit + persist the node and cloud base URLs,
// see whether mDNS is available and what it discovered, and test connectivity (forces a re-probe).

import { useState } from 'react'
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

export default function SettingsScreen() {
  const settingsNodeUrl = useConnection((s) => s.settingsNodeUrl)
  const cloudBaseUrl = useConnection((s) => s.cloudBaseUrl)
  const discoveredNodeUrl = useConnection((s) => s.discoveredNodeUrl)
  const mdnsAvailable = useConnection((s) => s.mdnsAvailable)
  const mode = useConnection((s) => s.mode)
  const setSettingsNodeUrl = useConnection((s) => s.setSettingsNodeUrl)
  const setCloudBaseUrl = useConnection((s) => s.setCloudBaseUrl)
  const probe = useConnection((s) => s.probe)

  const [node, setNode] = useState(settingsNodeUrl)
  const [cloud, setCloud] = useState(cloudBaseUrl)
  const [testing, setTesting] = useState(false)
  const [result, setResult] = useState<string | null>(null)

  const save = async () => {
    await Promise.all([setSettingsNodeUrl(node.trim()), setCloudBaseUrl(cloud.trim())])
    setResult('Saved.')
  }

  const test = async () => {
    await save()
    setTesting(true)
    setResult(null)
    const m = await probe(true)
    setTesting(false)
    setResult(m === 'local' ? 'Connected to local node 🟢' : 'Using cloud 🟡 (node not reachable)')
  }

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.statusCard}>
        <Text style={styles.statusLine}>
          Current mode: <Text style={styles.bold}>{mode}</Text>
        </Text>
        <Text style={styles.statusLine}>
          mDNS discovery: <Text style={styles.bold}>{mdnsAvailable ? 'available' : 'unavailable'}</Text>
          {!mdnsAvailable ? ' (using manual URL)' : ''}
        </Text>
        {!!discoveredNodeUrl && (
          <Text style={styles.statusLine}>
            Discovered node: <Text style={styles.bold}>{discoveredNodeUrl}</Text>
          </Text>
        )}
      </View>

      <Text style={styles.label}>Node URL (local leader)</Text>
      <Text style={styles.help}>
        Auto-filled by mDNS when found; edit to override (e.g. http://192.168.1.50:3001).
      </Text>
      <TextInput
        style={styles.input}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        placeholder="http://192.168.1.50:3001"
        placeholderTextColor={colors.textMuted}
        value={node}
        onChangeText={setNode}
      />

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
        <Pressable style={[styles.btn, styles.primary]} disabled={testing} onPress={test}>
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
  bold: { color: colors.text, fontWeight: '700' },
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
  result: { color: colors.text, fontWeight: '600', marginTop: spacing.sm },
  row: { flexDirection: 'row', gap: spacing.md, marginTop: spacing.lg },
  btn: { flex: 1, paddingVertical: spacing.md, borderRadius: radius.md, alignItems: 'center' },
  secondary: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  secondaryText: { color: colors.text, fontWeight: '700' },
  primary: { backgroundColor: colors.primary },
  primaryText: { color: colors.primaryText, fontWeight: '700' },
})
