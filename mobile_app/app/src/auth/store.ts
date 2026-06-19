// Auth store (zustand). Holds the session token + restaurant/location context, the selected
// location (needed to query tables), and exposes login / logout / bootstrap.
//
// On launch, bootstrap() restores the token + cached context so the waiter can keep ordering on the
// LAN even if the cloud is unreachable; if the cloud IS reachable it revalidates via /auth/me/.

import { create } from 'zustand'
import { useConnection } from '../net/connection'
import { ApiError } from '../net/apiClient'
import {
  clearAuthContext,
  clearToken,
  getAuthContext,
  getToken,
  saveAuthContext,
  saveToken,
} from '../lib/storage'
import type { AuthContext } from '../lib/types'
import { fetchMe, login as loginApi } from './api'

type AuthStatus = 'loading' | 'authenticated' | 'anonymous'

interface AuthStore {
  status: AuthStatus
  token: string | null
  context: AuthContext | null
  selectedLocationId: string | null

  bootstrap: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
  selectLocation: (locationId: string) => void
}

/** All locations across all restaurants, flattened. */
export function flattenLocations(ctx: AuthContext | null) {
  if (!ctx) return []
  return ctx.restaurants.flatMap((r) =>
    r.locations.map((l) => ({ ...l, restaurantName: r.name, restaurantId: r.id })),
  )
}

function defaultLocation(ctx: AuthContext | null): string | null {
  const locs = flattenLocations(ctx)
  return locs.length === 1 ? locs[0].id : null
}

export const useAuth = create<AuthStore>((set, get) => ({
  status: 'loading',
  token: null,
  context: null,
  selectedLocationId: null,

  bootstrap: async () => {
    const [token, cached] = await Promise.all([getToken(), getAuthContext()])
    if (!token) {
      set({ status: 'anonymous' })
      return
    }
    // Restore immediately from cache so the app is usable offline...
    set({
      token,
      context: cached,
      selectedLocationId: defaultLocation(cached),
      status: 'authenticated',
    })
    // ...then revalidate against the cloud if we can reach it (non-blocking on failure).
    const cloud = useConnection.getState().cloudBaseUrl
    if (!cloud) return
    try {
      const fresh = await fetchMe(cloud, token)
      await saveAuthContext(fresh)
      set((s) => ({
        context: fresh,
        selectedLocationId: s.selectedLocationId ?? defaultLocation(fresh),
      }))
    } catch (err) {
      // Only log out on a definitive 401; transient/offline errors keep the cached session.
      if (err instanceof ApiError && err.status === 401) {
        await get().logout()
      }
    }
  },

  login: async (email, password) => {
    const cloud = useConnection.getState().cloudBaseUrl
    const res = await loginApi(cloud, email, password)
    const { session_token, ...context } = res
    await Promise.all([saveToken(session_token), saveAuthContext(context)])
    set({
      token: session_token,
      context,
      selectedLocationId: defaultLocation(context),
      status: 'authenticated',
    })
  },

  logout: async () => {
    await Promise.all([clearToken(), clearAuthContext()])
    set({ status: 'anonymous', token: null, context: null, selectedLocationId: null })
  },

  selectLocation: (locationId) => set({ selectedLocationId: locationId }),
}))
