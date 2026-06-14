// Base-URL-aware fetch wrapper. Every call takes an explicit base URL (cloud for auth/tables,
// the active node-or-cloud base for menu/orders) so the networking layer stays pure and testable.
// It attaches the Bearer token and Idempotency-Key, enforces a timeout, and maps backend errors
// (the `{ error: { code, message } }` shape) and transport failures into typed errors — so the UI
// can always show a clear message (acceptance criterion #7: no silent failures).

export class ApiError extends Error {
  code: string
  status: number
  constructor(message: string, code: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
  }
}

export class NetworkError extends Error {
  constructor(message = 'Network request failed') {
    super(message)
    this.name = 'NetworkError'
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  token?: string | null
  idempotencyKey?: string
  timeoutMs?: number
  signal?: AbortSignal
}

const DEFAULT_TIMEOUT = 10000

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : `/${path}`
  return `${b}${p}`
}

export async function request<T>(
  baseUrl: string,
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const { method = 'GET', body, token, idempotencyKey, timeoutMs = DEFAULT_TIMEOUT } = opts

  if (!baseUrl) {
    throw new NetworkError('No server URL configured. Set the node/cloud URL in Settings.')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  // If the caller passed their own signal, abort when either fires.
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (token) headers['Authorization'] = `Bearer ${token}`
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

  let res: Response
  try {
    res = await fetch(joinUrl(baseUrl, path), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
  } catch (err) {
    if (controller.signal.aborted) throw new NetworkError('Request timed out')
    throw new NetworkError(err instanceof Error ? err.message : 'Network request failed')
  } finally {
    clearTimeout(timer)
  }

  // 204 / empty body
  const text = await res.text()
  const data = text ? safeJson(text) : null

  if (!res.ok) {
    // Backend error envelope: { error: { code, message } } OR { error: "..." } (login)
    const errObj = (data as any)?.error
    if (errObj && typeof errObj === 'object') {
      throw new ApiError(errObj.message ?? 'Request failed', errObj.code ?? 'ERROR', res.status)
    }
    const msg = typeof errObj === 'string' ? errObj : `HTTP ${res.status}`
    throw new ApiError(msg, 'ERROR', res.status)
  }

  return data as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
