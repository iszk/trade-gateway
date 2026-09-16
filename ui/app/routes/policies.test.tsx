import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { Hono } from 'hono'
import { jsxRenderer } from 'hono/jsx-renderer'
import type { StrategySymbolPolicyDashboardResponse, TradableSymbol } from '@trade-gateway/api'

import policyRoute, { POST as postPolicy } from './policies'

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

const symbol: TradableSymbol = {
  id: 'bitflyer:BTC_JPY',
  broker: 'bitflyer',
  ticker: 'BTC_JPY',
  display_name: 'BTC/JPY',
  currency: 'JPY',
  trade_control: { status: 'active', updated_at: new Date('2026-01-01T00:00:00Z') },
  created_at: new Date('2026-01-01T00:00:00Z'),
  updated_at: new Date('2026-01-01T00:00:00Z'),
}

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
      version: 1,
      created_at: new Date('2026-01-01T00:00:00Z'),
      updated_at: new Date('2026-01-01T00:00:00Z'),
    },
    position: {
      id: 'alpha:bitflyer:BTC_JPY',
      strategy_id: 'alpha',
      symbol_id: 'bitflyer:BTC_JPY',
      confirmed_position: 0,
      pending_delta: 0,
      status: 'READY',
      policy_version: 1,
      updated_at: new Date('2026-01-01T00:00:00Z'),
      reconciled_at: null,
    },
    ledger_health: 'READY',
  }],
  updated_at: 1,
}

const createApp = (): Hono => {
  const app = new Hono()
  app.use('*', testRenderer)
  app.get('/policies', ...policyRoute)
  app.post('/policies', ...postPolicy)
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
      try {
        const parsed = JSON.parse(init.body) as unknown
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          body = parsed as Record<string, unknown>
        }
      } catch {
        body = undefined
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

const postForm = async (
  app: Hono,
  values: Record<string, string>,
): Promise<Response> => app.request('/policies', {
  method: 'POST',
  body: new URLSearchParams(values),
})

const policyFormValues = {
  strategy_id: 'alpha',
  symbol_id: 'bitflyer:BTC_JPY',
  sizing_mode: 'WEBHOOK_CAPPED',
  max_abs_position: '2',
  no_flip: 'on',
}

const redirectParams = (response: Response): URLSearchParams => {
  const location = response.headers.get('location')
  assert.ok(location)
  return new URL(location, 'http://localhost').searchParams
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

test('GET /policies renders policy, virtual position, summary, and symbol display name', async () => {
  const calls = setFetchMock((call) => (
    new URL(call.url).pathname === '/api/symbols'
      ? Response.json({ symbols: [symbol] })
      : Response.json(dashboard)
  ))
  const response = await createApp().request('/policies')
  const html = await response.text()

  assert.equal(response.status, 200)
  assert.match(html, /Policies/)
  assert.match(html, /BTC\/JPY/)
  assert.match(html, /WEBHOOK_CAPPED/)
  assert.match(html, /effective 0/)
  assert.match(html, /Ledger anomalies/)
  assert.equal(calls.length, 2)
})

test('policy fresh-start runs dry-run, pause, apply, read-back, then resumes only after success', async () => {
  const calls = setFetchMock((call) => {
    const url = new URL(call.url)
    if (url.pathname === '/api/symbols') return Response.json({ symbols: [symbol] })
    if (url.pathname === '/api/strategy-symbol-policies/alpha/bitflyer%3ABTC_JPY/fresh-start') {
      return Response.json({ status: url.searchParams.has('apply') ? 'APPLIED' : 'CREATE', mode: url.searchParams.has('apply') ? 'APPLY' : 'DRY_RUN', issues: [] })
    }
    if (url.pathname === '/api/strategy-symbol-policies') return Response.json(dashboard)
    return Response.json({ symbol })
  })

  const response = await postForm(createApp(), {
    strategy_id: 'alpha',
    symbol_id: 'bitflyer:BTC_JPY',
    sizing_mode: 'WEBHOOK_CAPPED',
    max_abs_position: '2',
    no_flip: 'on',
  })

  assert.equal(response.status, 302)
  assert.match(response.headers.get('location') || '', /created=1/)
  assert.deepEqual(calls.map((call) => [call.method, new URL(call.url).pathname]), [
    ['GET', '/api/symbols'],
    ['POST', '/api/strategy-symbol-policies/alpha/bitflyer%3ABTC_JPY/fresh-start'],
    ['PATCH', '/api/symbols/bitflyer%3ABTC_JPY/trade-control'],
    ['POST', '/api/strategy-symbol-policies/alpha/bitflyer%3ABTC_JPY/fresh-start'],
    ['GET', '/api/strategy-symbol-policies'],
    ['PATCH', '/api/symbols/bitflyer%3ABTC_JPY/trade-control'],
  ])
  assert.equal(calls[1]?.body?.no_flip, true)
  assert.equal(calls[3]?.headers['x-confirm-project'], undefined)
  assert.equal(calls[3]?.url.includes('apply=true'), true)
  assert.equal(calls[5]?.body?.status, 'active')
})

test('policy fresh-start keeps an originally paused symbol paused and does not resume after apply failure', async () => {
  const pausedSymbol = { ...symbol, trade_control: { ...symbol.trade_control, status: 'paused' as const } }
  const calls = setFetchMock((call) => {
    const url = new URL(call.url)
    if (url.pathname === '/api/symbols') return Response.json({ symbols: [pausedSymbol] })
    if (url.pathname.endsWith('/fresh-start') && !url.searchParams.has('apply')) return Response.json({ status: 'CREATE', mode: 'DRY_RUN', issues: [] })
    if (url.pathname.endsWith('/fresh-start')) return Response.json({ error: { message: 'apply failed' } }, { status: 500 })
    return Response.json({ entries: [] })
  })

  const response = await postForm(createApp(), {
    strategy_id: 'alpha',
    symbol_id: 'bitflyer:BTC_JPY',
    sizing_mode: 'WEBHOOK_CAPPED',
    max_abs_position: '2',
    no_flip: 'on',
  })
  assert.equal(response.status, 302)
  assert.match(response.headers.get('location') || '', /error=/)
  assert.deepEqual(calls.map((call) => call.method), ['GET', 'POST', 'POST'])
  assert.equal(calls.some((call) => call.method === 'PATCH'), false)
})

test('GET /policies renders the empty state without ledger entries', async () => {
  const calls = setFetchMock((call) => (
    new URL(call.url).pathname === '/api/symbols'
      ? Response.json({ symbols: [] })
      : Response.json({ entries: [], updated_at: 1 })
  ))
  const response = await createApp().request('/policies')
  const html = await response.text()

  assert.equal(response.status, 200)
  assert.match(html, /No policy or virtual position ledger found\./)
  assert.match(html, /Policies<\/div><div[^>]*>0<\/div>/)
  assert.equal(calls.length, 2)
})

test('GET /policies renders MANAGED parameters and does not invent invalid ledger quantities', async () => {
  const managedDashboard: StrategySymbolPolicyDashboardResponse = {
    entries: [
      {
        id: 'alpha:bitflyer:BTC_JPY',
        strategy_id: 'alpha',
        symbol_id: 'bitflyer:BTC_JPY',
        ledger_health: 'INVALID_POSITION',
        policy: dashboard.entries[0]?.policy,
        issue: 'position document is invalid',
      },
      {
        id: 'managed:bitflyer:BTC_JPY',
        strategy_id: 'managed',
        symbol_id: 'bitflyer:BTC_JPY',
        policy: {
          id: 'managed:bitflyer:BTC_JPY',
          strategy_id: 'managed',
          symbol_id: 'bitflyer:BTC_JPY',
          sizing_mode: 'MANAGED',
          enabled: true,
          max_abs_position: 4,
          no_flip: false,
          base_order_size: 1.5,
          taper_strength: 0.75,
          version: 2,
          created_at: new Date('2026-01-01T00:00:00Z'),
          updated_at: new Date('2026-01-02T00:00:00Z'),
        },
        position: {
          id: 'managed:bitflyer:BTC_JPY',
          strategy_id: 'managed',
          symbol_id: 'bitflyer:BTC_JPY',
          confirmed_position: 0,
          pending_delta: 0,
          status: 'READY',
          policy_version: 2,
          updated_at: new Date('2026-01-02T00:00:00Z'),
          reconciled_at: null,
        },
        ledger_health: 'READY',
      },
    ],
    updated_at: 1,
  }
  setFetchMock((call) => (
    new URL(call.url).pathname === '/api/symbols'
      ? Response.json({ symbols: [symbol] })
      : Response.json(managedDashboard)
  ))
  const response = await createApp().request('/policies')
  const html = await response.text()

  assert.equal(response.status, 200)
  assert.match(html, /Invalid position/)
  assert.match(html, /base 1\.5 \/ taper 0\.75/)
  assert.match(html, /position missing or invalid/)
  assert.doesNotMatch(html, /confirmed 999|pending 999|effective 999/)
})

test('policy fresh-start apply succeeds without project confirmation', async () => {
  const calls = setFetchMock((call) => {
    const url = new URL(call.url)
    if (url.pathname === '/api/symbols') return Response.json({ symbols: [symbol] })
    if (url.pathname.endsWith('/fresh-start') && !url.searchParams.has('apply')) {
      return Response.json({ status: 'CREATE', mode: 'DRY_RUN', issues: [] })
    }
    if (url.pathname.endsWith('/fresh-start')) {
      return Response.json({ status: 'APPLIED', mode: 'APPLY', issues: [] })
    }
    if (call.method === 'PATCH') {
      return Response.json({ symbol: { ...symbol, trade_control: { ...symbol.trade_control, status: call.body?.status } } })
    }
    return Response.json(dashboard)
  })

  const response = await postForm(createApp(), policyFormValues)

  assert.equal(response.status, 302)
  assert.match(response.headers.get('location') || '', /created=1/)
  assert.equal(calls[3]?.headers['x-confirm-project'], undefined)
})

test('policy fresh-start does not apply after pause failure and reports unknown status', async () => {
  const calls = setFetchMock((call) => {
    const url = new URL(call.url)
    if (url.pathname === '/api/symbols') return Response.json({ symbols: [symbol] })
    if (call.method === 'POST' && url.pathname.endsWith('/fresh-start') && !url.searchParams.has('apply')) {
      return Response.json({ status: 'CREATE', mode: 'DRY_RUN', issues: [] })
    }
    if (call.method === 'PATCH') return Response.json({ error: { message: 'pause failed' } }, { status: 503 })
    return Response.json({ entries: [] })
  })

  const response = await postForm(createApp(), policyFormValues)
  const params = redirectParams(response)

  assert.deepEqual(calls.map((call) => call.method), ['GET', 'POST', 'PATCH'])
  assert.equal(params.get('failed_step'), 'pause')
  assert.equal(params.get('symbol_status'), 'unknown')
})

test('policy fresh-start does not read back or resume after apply failure', async () => {
  const calls = setFetchMock((call) => {
    const url = new URL(call.url)
    if (url.pathname === '/api/symbols') return Response.json({ symbols: [symbol] })
    if (call.method === 'POST' && url.pathname.endsWith('/fresh-start') && !url.searchParams.has('apply')) {
      return Response.json({ status: 'CREATE', mode: 'DRY_RUN', issues: [] })
    }
    if (call.method === 'PATCH') return Response.json({ symbol: { ...symbol, trade_control: { ...symbol.trade_control, status: 'paused' as const } } })
    if (call.method === 'POST') return Response.json({ error: { message: 'apply failed' } }, { status: 500 })
    return Response.json({ entries: [] })
  })

  const response = await postForm(createApp(), policyFormValues)
  const params = redirectParams(response)

  assert.deepEqual(calls.map((call) => call.method), ['GET', 'POST', 'PATCH', 'POST'])
  assert.equal(params.get('failed_step'), 'apply')
  assert.equal(params.get('symbol_status'), 'paused')
})

test('policy fresh-start does not resume after read-back mismatch', async () => {
  const mismatchedDashboard: StrategySymbolPolicyDashboardResponse = {
    ...dashboard,
    entries: [{
      ...dashboard.entries[0]!,
      policy: { ...dashboard.entries[0]!.policy!, max_abs_position: 3 },
    }],
  }
  const calls = setFetchMock((call) => {
    const url = new URL(call.url)
    if (url.pathname === '/api/symbols') return Response.json({ symbols: [symbol] })
    if (call.method === 'POST' && url.pathname.endsWith('/fresh-start') && !url.searchParams.has('apply')) {
      return Response.json({ status: 'CREATE', mode: 'DRY_RUN', issues: [] })
    }
    if (call.method === 'POST' && url.pathname.endsWith('/fresh-start')) {
      return Response.json({ status: 'APPLIED', mode: 'APPLY', issues: [] })
    }
    if (call.method === 'PATCH') return Response.json({ symbol: { ...symbol, trade_control: { ...symbol.trade_control, status: 'paused' as const } } })
    return Response.json(mismatchedDashboard)
  })

  const response = await postForm(createApp(), policyFormValues)
  const params = redirectParams(response)

  assert.deepEqual(calls.map((call) => call.method), ['GET', 'POST', 'PATCH', 'POST', 'GET'])
  assert.equal(params.get('failed_step'), 'read-back')
  assert.equal(params.get('symbol_status'), 'paused')
})

test('policy fresh-start reports unknown status on resume failure without retry or rollback', async () => {
  const calls = setFetchMock((call) => {
    const url = new URL(call.url)
    if (url.pathname === '/api/symbols') return Response.json({ symbols: [symbol] })
    if (call.method === 'POST' && url.pathname.endsWith('/fresh-start') && !url.searchParams.has('apply')) {
      return Response.json({ status: 'CREATE', mode: 'DRY_RUN', issues: [] })
    }
    if (call.method === 'POST' && url.pathname.endsWith('/fresh-start')) {
      return Response.json({ status: 'APPLIED', mode: 'APPLY', issues: [] })
    }
    if (call.method === 'PATCH' && call.body?.status === 'active') {
      return Response.json({ error: { message: 'resume response lost' } }, { status: 503 })
    }
    if (call.method === 'PATCH') return Response.json({ symbol: { ...symbol, trade_control: { ...symbol.trade_control, status: 'paused' as const } } })
    return Response.json(dashboard)
  })

  const response = await postForm(createApp(), policyFormValues)
  const params = redirectParams(response)

  assert.deepEqual(calls.map((call) => call.method), ['GET', 'POST', 'PATCH', 'POST', 'GET', 'PATCH'])
  assert.equal(calls.filter((call) => call.method === 'PATCH').length, 2)
  assert.equal(params.get('failed_step'), 'resume')
  assert.equal(params.get('symbol_status'), 'unknown')
})
