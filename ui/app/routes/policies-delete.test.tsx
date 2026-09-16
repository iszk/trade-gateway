import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Hono } from 'hono'
import { jsxRenderer } from 'hono/jsx-renderer'
import type { StrategySymbolPolicyDashboardResponse, SymbolsResponse } from '@trade-gateway/api'

import deleteRoute, { POST as postDelete } from './policies/[strategy_id]/[symbol_id]/delete'

type FetchCall = {
  url: string
  method: string
  headers: Record<string, string>
  body?: Record<string, unknown>
}

const originalFetch = globalThis.fetch
const testRenderer = jsxRenderer(({ children }) => (
  <html lang="en"><body>{children}</body></html>
))

const dashboard: StrategySymbolPolicyDashboardResponse = {
  entries: [{
    id: 'alpha:bitflyer:BTC_JPY',
    strategy_id: 'alpha',
    symbol_id: 'bitflyer:BTC_JPY',
    policy: {
      id: 'alpha:bitflyer:BTC_JPY',
      strategy_id: 'alpha',
      symbol_id: 'bitflyer:BTC_JPY',
      sizing_mode: 'WEBHOOK_CAPPED',
      enabled: true,
      max_abs_position: 2,
      no_flip: true,
      version: 2,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-01T00:00:00Z'),
    },
    position: {
      id: 'alpha:bitflyer:BTC_JPY',
      strategy_id: 'alpha',
      symbol_id: 'bitflyer:BTC_JPY',
      confirmed_position: 1,
      pending_delta: 0.2,
      status: 'MANUAL_REVIEW',
      policy_version: 2,
      updated_at: new Date('2026-01-01T00:00:00Z'),
      reconciled_at: null,
    },
    ledger_health: 'READY',
  }],
  updated_at: 1,
}

const symbols: SymbolsResponse = {
  symbols: [{
    id: 'bitflyer:BTC_JPY',
    broker: 'bitflyer',
    ticker: 'BTC_JPY',
    currency: 'JPY',
    trade_control: { status: 'active', updated_at: new Date('2026-01-01T00:00:00Z') },
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  }],
  updated_at: 1,
}

const createApp = (): Hono => {
  const app = new Hono()
  app.use('*', testRenderer)
  app.get('/policies/:strategy_id/:symbol_id/delete', ...deleteRoute)
  app.post('/policies/:strategy_id/:symbol_id/delete', ...postDelete)
  return app
}

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
    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined))
    let body: Record<string, unknown> | undefined
    if (typeof init?.body === 'string') {
      const parsed = JSON.parse(init.body) as unknown
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        body = parsed as Record<string, unknown>
      }
    }
    const headerRecord: Record<string, string> = {}
    headers.forEach((value, key) => { headerRecord[key] = value })
    const call = { url, method, headers: headerRecord, ...(body === undefined ? {} : { body }) }
    calls.push(call)
    return handler(call)
  }) as typeof fetch
  return calls
}

const postForm = async (app: Hono, values: Record<string, string>): Promise<Response> => (
  app.request('/policies/alpha/bitflyer%3ABTC_JPY/delete', {
    method: 'POST',
    body: new URLSearchParams(values),
  })
)

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('GET policy delete renders target quantities and destructive fallback warning', async () => {
  const calls = setFetchMock((call) => (
    new URL(call.url).pathname === '/api/strategy-symbol-policies'
      ? Response.json(dashboard)
      : Response.json(symbols)
  ))
  const response = await createApp().request('/policies/alpha/bitflyer%3ABTC_JPY/delete')
  const html = await response.text()

  assert.equal(response.status, 200)
  assert.match(html, /Force delete policy/)
  assert.match(html, /Effective position.*1\.2/)
  assert.match(html, /unregistered-policy fallback/)
  assert.doesNotMatch(html, /project_confirmation|Project ID/)
  assert.match(html, /target_confirmation/)
  assert.equal(calls.length, 2)
})

test('policy delete does not call API without target confirmation, then calls DELETE after exact match', async () => {
  const calls = setFetchMock(() => Response.json({ ok: true }))
  const app = createApp()

  const incomplete = await postForm(app, {})
  assert.equal(incomplete.status, 302)
  assert.equal(calls.length, 0)

  const success = await postForm(app, {
    target_confirmation: 'alpha:bitflyer:BTC_JPY',
  })
  assert.equal(success.status, 302)
  assert.match(success.headers.get('location') || '', /deleted=1/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.method, 'DELETE')
  assert.match(calls[0]?.url || '', /force=true/)
  assert.equal(calls[0]?.headers['x-confirm-project'], undefined)
  assert.deepEqual(calls[0]?.body, { confirmation: 'alpha:bitflyer:BTC_JPY' })
})

test('policy delete API errors are rendered on the confirmation page', async () => {
  setFetchMock((call) => (
    new URL(call.url).pathname === '/api/strategy-symbol-policies'
      ? Response.json(dashboard)
      : new URL(call.url).pathname === '/api/symbols'
        ? Response.json(symbols)
        : Response.json({ error: { message: 'delete rejected' } }, { status: 409 })
  ))
  const response = await postForm(createApp(), {
    target_confirmation: 'alpha:bitflyer:BTC_JPY',
  })
  const location = response.headers.get('location') || ''
  const getResponse = await createApp().request(location)
  const html = await getResponse.text()
  assert.match(html, /delete rejected/)
})
