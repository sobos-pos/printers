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
  clearStaffToken,
  clearToken,
  getAuthContext,
  getStaffToken,
  getToken,
  saveAuthContext,
  saveStaffToken,
  saveToken,
} from '../lib/storage'
import type { AuthContext } from '../lib/types'
import { fetchMe, login as loginApi, refreshStaffToken } from './api'

type AuthStatus = 'loading' | 'authenticated' | 'anonymous'

interface AuthStore {
  status: AuthStatus
  /** Session token (tok_xxx) — used for cloud API calls. */
  token: string | null
  /** Staff shift JWT — used for node (local mode) API calls. */
  staffToken: string | null
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
  staffToken: null,
  context: null,
  selectedLocationId: null,

  bootstrap: async () => {
    const [token, staffToken, cached] = await Promise.all([
      getToken(),
      getStaffToken(),
      getAuthContext(),
    ])
    if (!token) {
      set({ status: 'anonymous' })
      return
    }
    // Restore immediately from cache so the app is usable offline...
    set({
      token,
      staffToken,
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
      // Refresh the staff JWT so the node token doesn't expire mid-shift.
      try {
        const { access_token } = await refreshStaffToken(cloud, token)
        await saveStaffToken(access_token)
        set({ staffToken: access_token })
      } catch {
        // Not fatal — old staffToken still works until it expires (12h TTL).
      }
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
    const { session_token, access_token, expires_at, expires_in, ...context } = res
    const saves: Promise<void>[] = [saveToken(session_token), saveAuthContext(context)]
    if (access_token) saves.push(saveStaffToken(access_token))
    await Promise.all(saves)
    set({
      token: session_token,
      staffToken: access_token ?? null,
      context,
      selectedLocationId: defaultLocation(context),
      status: 'authenticated',
    })
  },

  logout: async () => {
    await Promise.all([clearToken(), clearStaffToken(), clearAuthContext()])
    set({ status: 'anonymous', token: null, staffToken: null, context: null, selectedLocationId: null })
  },

  selectLocation: (locationId) => set({ selectedLocationId: locationId }),
}))
