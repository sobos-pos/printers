// Thin persistence layer. Session token lives in SecureStore; everything else (context, URLs,
// cached tables/menu) in AsyncStorage. All functions are async and swallow read errors to a
// sensible default so a corrupt cache never crashes the app.

import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'
import { STORAGE_KEYS } from './config'
import type { AuthContext, MenuResponse, TableSummary } from './types'

// ---- Session token (secure) ----
export async function saveToken(token: string): Promise<void> {
  await SecureStore.setItemAsync(STORAGE_KEYS.sessionToken, token)
}
export async function getToken(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(STORAGE_KEYS.sessionToken)
  } catch {
    return null
  }
}
export async function clearToken(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEYS.sessionToken)
  } catch {
    /* noop */
  }
}

// ---- Generic JSON helpers ----
async function getJson<T>(key: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}
async function setJson(key: string, value: unknown): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value))
}

// ---- Auth context ----
export const saveAuthContext = (ctx: AuthContext) => setJson(STORAGE_KEYS.authContext, ctx)
export const getAuthContext = () => getJson<AuthContext>(STORAGE_KEYS.authContext)
export const clearAuthContext = () => AsyncStorage.removeItem(STORAGE_KEYS.authContext)

// ---- URLs ----
export const saveNodeBaseUrl = (url: string) => AsyncStorage.setItem(STORAGE_KEYS.nodeBaseUrl, url)
export const getNodeBaseUrl = () => AsyncStorage.getItem(STORAGE_KEYS.nodeBaseUrl)
export const saveCloudBaseUrl = (url: string) =>
  AsyncStorage.setItem(STORAGE_KEYS.cloudBaseUrl, url)
export const getCloudBaseUrl = () => AsyncStorage.getItem(STORAGE_KEYS.cloudBaseUrl)

// ---- Tables cache (cloud-only endpoint => cache for Local mode) ----
export const saveTablesCache = (locationId: string, tables: TableSummary[]) =>
  setJson(STORAGE_KEYS.tablesCachePrefix + locationId, tables)
export const getTablesCache = (locationId: string) =>
  getJson<TableSummary[]>(STORAGE_KEYS.tablesCachePrefix + locationId)

// ---- Menu cache (by table uuid) ----
export const saveMenuCache = (tableUuid: string, menu: MenuResponse) =>
  setJson(STORAGE_KEYS.menuCachePrefix + tableUuid, menu)
export const getMenuCache = (tableUuid: string) =>
  getJson<MenuResponse>(STORAGE_KEYS.menuCachePrefix + tableUuid)
