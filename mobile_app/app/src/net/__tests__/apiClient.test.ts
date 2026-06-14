import { afterEach, describe, expect, it, jest } from '@jest/globals'
import { ApiError, NetworkError, request } from '../apiClient'

function mockFetch(impl: (url: string, init: RequestInit) => Partial<Response> | Promise<Partial<Response>>) {
  globalThis.fetch = jest.fn(async (url: any, init: any) => {
    const res = await impl(url, init)
    return res as Response
  }) as unknown as typeof fetch
}

const okResponse = (body: unknown): Partial<Response> => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify(body),
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('apiClient.request', () => {
  it('returns parsed JSON on success', async () => {
    mockFetch(() => okResponse({ id: 'order-1', status: 'Pending' }))
    const data = await request<{ id: string }>('http://node:3001', '/api/v1/orders/order-1/')
    expect(data.id).toBe('order-1')
  })

  it('attaches Bearer token and Idempotency-Key headers', async () => {
    let captured: any
    mockFetch((_url, init) => {
      captured = init
      return okResponse({ id: 'x' })
    })
    await request('http://node:3001', '/api/v1/orders/', {
      method: 'POST',
      body: { a: 1 },
      token: 'tok_abc',
      idempotencyKey: 'idem-123',
    })
    expect(captured.headers.Authorization).toBe('Bearer tok_abc')
    expect(captured.headers['Idempotency-Key']).toBe('idem-123')
    expect(captured.headers['Content-Type']).toBe('application/json')
  })

  it('maps the {error:{code,message}} envelope to ApiError', async () => {
    mockFetch(() => ({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Table not found' } }),
    }))
    await expect(request('http://c', '/x')).rejects.toMatchObject({
      name: 'ApiError',
      code: 'NOT_FOUND',
      status: 404,
      message: 'Table not found',
    })
  })

  it('maps the login {error:"..."} string shape to ApiError', async () => {
    mockFetch(() => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ error: 'Invalid credentials' }),
    }))
    const err = (await request('http://c', '/api/v1/auth/login/', {
      method: 'POST',
      body: {},
    }).catch((e) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.status).toBe(401)
    expect(err.message).toBe('Invalid credentials')
  })

  it('throws NetworkError when fetch rejects', async () => {
    mockFetch(() => {
      throw new Error('connection refused')
    })
    await expect(request('http://node', '/health/')).rejects.toBeInstanceOf(NetworkError)
  })

  it('throws NetworkError when no base URL is configured', async () => {
    await expect(request('', '/x')).rejects.toBeInstanceOf(NetworkError)
  })
})
