import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Hono } from 'hono'
import { jsxRenderer } from 'hono/jsx-renderer'
import type { OrderConstraints, TradableSymbol } from '@trade-gateway/api'
import detailRoute, { POST as postDetail } from './symbols/[symbol_id]'

type FetchCall = {
  url: string
  method: string
  body?: unknown
}

const originalFetch = globalThis.fetch

const testRenderer = jsxRenderer(({ children }) => (
  <html lang="en">
    <body>{children}</body>
  </html>
))

const makeSymbol = (orderConstraints?: OrderConstraints): TradableSymbol => ({
  id: 'saxo:FX:NAS100',
  broker: 'saxo',
  ticker: 'FX:NAS100',
  display_name: 'NAS100',
  currency: 'USD',
  note: 'index CFD',
  ...(orderConstraints === undefined ? {} : { order_constraints: orderConstraints }),
  trade_control: {
    status: 'active',
    reason: undefined,
    updated_at: new Date('2026-08-23T00:00:00.000Z'),
    updated_by: 'operator',
  },
  created_at: new Date('2026-01-01T00:00:00.000Z'),
  updated_at: new Date('2026-08-23T00:00:00.000Z'),
})

const setFetchMock = (
  handler: (call: FetchCall) => Response | Promise<Response>,
): FetchCall[] => {
  const calls: FetchCall[] = []
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url
    const method = init?.method || (input instanceof Request ? input.method : 'GET')
    let body: unknown
    if (typeof init?.body === 'string') {
      body = JSON.parse(init.body)
    }
    const call = { url, method, ...(body === undefined ? {} : { body }) }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
  return calls
}

const createApp = (): Hono => {
  const app = new Hono()
  app.use('*', testRenderer)
  app.get('/symbols/:symbol_id', ...detailRoute)
  app.post('/symbols/:symbol_id', ...postDetail)
  return app
}

const postForm = async (
  app: Hono,
  values: Record<string, string>,
): Promise<Response> => app.request('/symbols/saxo%3AFX%3ANAS100', {
  method: 'POST',
  body: new URLSearchParams(values),
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('save_constraints gets the latest symbol and preserves metadata in PUT payload', async () => {
  const symbol = makeSymbol({ quantity_step: 0.1, min_order_size: 1 })
  const calls = setFetchMock((call) => {
    if (call.method === 'GET') return Response.json({ symbol })
    return Response.json({ symbol })
  })
  const response = await postForm(createApp(), {
    action: 'save_constraints',
    quantity_step: '0.25',
    min_order_size: '2',
    max_order_size: '10',
  })

  assert.equal(response.status, 302)
  assert.equal(response.headers.get('location'), '/symbols/saxo%3AFX%3ANAS100?saved=1')
  assert.deepEqual(calls.map(({ method, url }) => ({ method, url })), [
    { method: 'GET', url: 'http://localhost:3000/api/symbols/saxo%3AFX%3ANAS100' },
    { method: 'PUT', url: 'http://localhost:3000/api/symbols/saxo%3AFX%3ANAS100' },
  ])
  assert.deepEqual(calls[1]?.body, {
    display_name: 'NAS100',
    currency: 'USD',
    note: 'index CFD',
    order_constraints: {
      quantity_step: 0.25,
      min_order_size: 2,
      max_order_size: 10,
    },
  })
  assert.equal(Object.hasOwn(calls[1]?.body as object, 'trade_control'), false)
})

test('save_constraints omits max_order_size when the optional field is blank', async () => {
  const symbol = makeSymbol()
  const calls = setFetchMock((call) => Response.json({ symbol }))
  await postForm(createApp(), {
    action: 'save_constraints',
    quantity_step: '0.01',
    min_order_size: '0.1',
    max_order_size: '',
  })

  assert.deepEqual(calls[1]?.body, {
    display_name: 'NAS100',
    currency: 'USD',
    note: 'index CFD',
    order_constraints: {
      quantity_step: 0.01,
      min_order_size: 0.1,
    },
  })
})

test('invalid constraint form values redirect without calling the API', async () => {
  const calls = setFetchMock(() => Response.json({ error: { message: 'unexpected call' } }, { status: 500 }))
  const response = await postForm(createApp(), {
    action: 'save_constraints',
    quantity_step: '1abc',
    min_order_size: '1',
    max_order_size: '',
  })

  assert.equal(response.status, 302)
  assert.match(response.headers.get('location') || '', /error=quantity_step%20must%20be%20a%20finite%20positive%20number/)
  assert.equal(calls.length, 0)
})

test('GET API errors are shown after the constraint save redirect', async () => {
  const calls = setFetchMock(() => Response.json(
    { error: { message: 'symbol backend unavailable' } },
    { status: 500 },
  ))
  const response = await postForm(createApp(), {
    action: 'save_constraints',
    quantity_step: '1',
    min_order_size: '1',
    max_order_size: '',
  })
  const location = response.headers.get('location')
  assert.equal(response.status, 302)
  assert.match(location || '', /symbol%20backend%20unavailable/)
  assert.equal(calls.length, 1)

  const detailResponse = await createApp().request(location || '/symbols/saxo%3AFX%3ANAS100')
  const html = await detailResponse.text()
  assert.equal(detailResponse.status, 200)
  assert.match(html, /Failed to fetch \/api\/symbols\/saxo%3AFX%3ANAS100: 500/)
  assert.match(html, /symbol backend unavailable/)
})

test('PUT API errors are shown after the constraint save redirect', async () => {
  const symbol = makeSymbol()
  const calls = setFetchMock((call) => {
    if (call.method === 'GET') return Response.json({ symbol })
    return Response.json(
      { error: { message: 'constraints rejected by API' } },
      { status: 400 },
    )
  })
  const response = await postForm(createApp(), {
    action: 'save_constraints',
    quantity_step: '1',
    min_order_size: '1',
    max_order_size: '',
  })
  const location = response.headers.get('location')
  assert.equal(response.status, 302)
  assert.match(location || '', /constraints%20rejected%20by%20API/)
  assert.equal(calls.length, 2)

  const detailResponse = await createApp().request(location || '/symbols/saxo%3AFX%3ANAS100')
  const html = await detailResponse.text()
  assert.equal(detailResponse.status, 200)
  assert.match(html, /constraints rejected by API/)
})

test('registered constraints are rendered as form values', async () => {
  const symbol = makeSymbol({ quantity_step: 0.1, min_order_size: 1, max_order_size: 10 })
  setFetchMock(() => Response.json({ symbol }))
  const response = await createApp().request('/symbols/saxo%3AFX%3ANAS100')
  const html = await response.text()

  assert.equal(response.status, 200)
  assert.match(html, /Order Constraints/)
  assert.match(html, /name="quantity_step"[^>]*value="0\.1"/)
  assert.match(html, /name="min_order_size"[^>]*value="1"/)
  assert.match(html, /name="max_order_size"[^>]*value="10"/)
  assert.match(html, /name="quantity_step"[^>]*required/)
  assert.match(html, /name="min_order_size"[^>]*required/)
  assert.match(html, /name="max_order_size"[^>]*step="any"/)
})

test('legacy symbols render all constraint fields empty', async () => {
  const symbol = makeSymbol()
  setFetchMock(() => Response.json({ symbol }))
  const response = await createApp().request('/symbols/saxo%3AFX%3ANAS100')
  const html = await response.text()

  assert.equal(response.status, 200)
  assert.match(html, /name="quantity_step"[^>]*value=""/)
  assert.match(html, /name="min_order_size"[^>]*value=""/)
  assert.match(html, /name="max_order_size"[^>]*value=""/)
})

test('metadata save and trade-control actions keep their existing API contracts', async () => {
  const symbol = makeSymbol()
  const calls = setFetchMock((call) => Response.json({ symbol }))
  const app = createApp()

  const metadataResponse = await postForm(app, {
    action: 'save',
    display_name: 'Updated NAS100',
    currency: 'EUR',
    note: 'updated note',
  })
  assert.equal(metadataResponse.status, 302)
  assert.deepEqual(calls[0]?.body, {
    display_name: 'Updated NAS100',
    currency: 'EUR',
    note: 'updated note',
  })

  const pauseResponse = await postForm(app, {
    action: 'pause',
    reason: 'maintenance',
  })
  assert.equal(pauseResponse.status, 302)
  assert.deepEqual(calls[1]?.body, {
    status: 'paused',
    reason: 'maintenance',
  })
  assert.equal(calls[1]?.method, 'PATCH')
  assert.match(calls[1]?.url || '', /\/trade-control$/)
})
