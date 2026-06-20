// Root layout: sets up React Query + safe area providers, bootstraps the connection (URLs + mDNS
// probe) and auth session on launch, and runs the periodic connectivity re-probe.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Stack } from 'expo-router'
import { useEffect, useRef } from 'react'
import { SafeAreaProvider } from 'react-native-safe-area-context'
import { StatusBar } from 'expo-status-bar'
import { useAuth } from '../auth/store'
import { useConnection } from '../net/connection'
import type { ConnMode } from '../lib/types'

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 30_000 } },
})

export default function RootLayout() {
  const bootstrapped = useRef(false)
  const mode = useConnection((s) => s.mode)
  const prevModeRef = useRef<ConnMode>(mode)

  // When the connection flips between local ↔ cloud the menu data is stale because
  // it was fetched from a different source. Invalidate so the hook re-fetches from
  // the new activeBaseUrl immediately — prevents "menu item not found" on the node
  // when the app still holds cloud-sourced item IDs in its React Query cache.
  useEffect(() => {
    const prev = prevModeRef.current
    prevModeRef.current = mode
    if (prev !== 'probing' && mode !== 'probing' && prev !== mode) {
      queryClient.invalidateQueries({ queryKey: ['menu'] })
    }
  }, [mode])

  useEffect(() => {
    if (bootstrapped.current) return
    bootstrapped.current = true
    ;(async () => {
      // Connection first (loads cloud URL needed for auth revalidation), then auth.
      await useConnection.getState().init()
      await useAuth.getState().bootstrap()
      useConnection.getState().startAutoProbe()
      // Dedicated Wi-Fi-ON handler: recover to Local the moment the network returns.
      useConnection.getState().startNetworkListener()
    })()
    return () => {
      useConnection.getState().stopAutoProbe()
      useConnection.getState().stopNetworkListener()
    }
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
          <Stack.Screen name="profile" options={{ headerShown: true, title: 'Profile' }} />
          <Stack.Screen name="confirm" options={{ headerShown: true, title: 'Order placed' }} />
        </Stack>
      </SafeAreaProvider>
    </QueryClientProvider>
  )
}
