// Auth API calls. Login is CLOUD-ONLY (the node never authenticates), so these always target the
// cloud base URL. The session token is returned as "tok_<key>" and carried as `Bearer <token>`.

import { request } from '../net/apiClient'
import type { AuthContext, LoginResponse } from '../lib/types'

export function login(
  cloudBaseUrl: string,
  email: string,
  password: string,
): Promise<LoginResponse> {
  return request<LoginResponse>(cloudBaseUrl, '/api/v1/auth/login/', {
    method: 'POST',
    body: { email, password },
  })
}

/** Re-validate a stored token on relaunch. Returns the fresh context or throws ApiError(401). */
export function fetchMe(cloudBaseUrl: string, token: string): Promise<AuthContext> {
  return request<AuthContext>(cloudBaseUrl, '/api/v1/auth/me/', { token })
}

/** Mint a fresh staff shift JWT using the current session token (cloud must be reachable). */
export function refreshStaffToken(
  cloudBaseUrl: string,
  sessionToken: string,
): Promise<{ access_token: string; expires_at: string; expires_in: number }> {
  return request(cloudBaseUrl, '/api/v1/auth/staff-token/', {
    method: 'POST',
    token: sessionToken,
  })
}
