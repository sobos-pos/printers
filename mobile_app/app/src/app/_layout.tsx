// Root layout: sets up React Query + safe area providers, bootstraps the connection (URLs + mDNS
// probe) and auth session on launch, and runs the periodic connectivity re-probe.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Stack } from 'expo-router'
import { useEffect, useRef } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { useAuth } from '../auth/store'
import { useConnection } from '../net/connection'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
})

export default function RootLayout() {
  const bootstrapped = useRef(false)

  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    ;(async () => {
      // Connection first (loads cloud URL needed for auth revalidation), then auth.
      await useConnection.getState().init()
      await useAuth.getState().bootstrap()
      useConnection.getState().startAutoProbe()
    })()
    return () => useConnection.getState().stopAutoProbe()
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <SafeAreaProvider>
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Screen name="index" />
          <Stack.Screen name="login" />
          <Stack.Screen name="ordering" />
          <Stack.Screen name="settings" options={{ headerShown: true, title: 'Settings', presentation: 'modal' }} />
          <Stack.Screen name="confirm" options={{ headerShown: true, title: 'Order placed' }} />
        </Stack>
      </SafeAreaProvider>
    </QueryClientProvider>
  )
}
