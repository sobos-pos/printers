// Entry gate: route to ordering when authenticated, login otherwise. Shows a splash while the
// session is being restored.

import { Redirect } from 'expo-router'
import { ActivityIndicator, StyleSheet, View } from 'react-native'
import { useAuth } from '../auth/store'
import { colors } from '../ui/theme'

export default function Index() {
  const status = useAuth((s) => s.status)

  if (status === 'loading') {
    return (
      <View style={styles.center}>
        <ActivityIndicator size="large" color={colors.primary} />
      </View>
    )
  }
  return <Redirect href={status === 'authenticated' ? '/ordering' : '/login'} />
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.bg },
})
