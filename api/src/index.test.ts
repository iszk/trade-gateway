import test from 'node:test'
import assert from 'node:assert/strict'

import { SaxoClient } from './brokers/saxo.js'
import { config } from './config.js'
import { createApp } from './index.js'
import type { DispatchOrderFn, BrokerName } from './types/order.js'
import type { OrderV2 } from './types/order-v2.js'
import type { Position } from './types/position.js'
import { DuplicateEventError } from './services/webhook-events.js'
import type { CreateWebhookEventFn } from './services/webhook-events.js'
import type { CreateOrderDispatchLogFn } from './services/order-dispatch-logs.js'
import type { OrderUpdate } from './services/orders-v2.js'
import type { SlotScheduler, RunIfNewSlotParams } from './services/slot-scheduler.js'
import type { TradableSymbol } from './types/tradable-symbol.js'

const createLoggerStub = () => {
    const calls: Record<string, unknown>[] = []
    const logger = {
        info: (obj: Record<string, unknown>) => calls.push(obj),
        warn: (obj: Record<string, unknown>) => calls.push(obj),
        error: (obj: Record<string, unknown>) => calls.push(obj),
        child: (_bindings: Record<string, unknown>) => logger,
    }
    return { logger, calls }
}

const stringifyLogCalls = (calls: Record<string, unknown>[]): string =>
    JSON.stringify(calls, (_key, value) => value instanceof Error
        ? { name: value.name, message: value.message }
        : value)

const createPositionFetcherStub = (positions: Position[] = []) => ({
    fetchAllPositions: async (_broker?: BrokerName) => positions,
})

const createAppForTests = (options: Parameters<typeof createApp>[0] = {}) =>
    createApp({
        positionFetcher: createPositionFetcherStub(),
        getTradableSymbol: async () => null,
        listTradableSymbols: async () => [],
        upsertTradableSymbol: async (input) => ({
            id: input.id,
            broker: input.broker,
            ticker: input.ticker,
            display_name: input.display_name,
            currency: input.currency,
            note: input.note,
            trade_control: {
                status: input.trade_control?.status ?? 'active',
                reason: input.trade_control?.reason,
                updated_at: new Date(),
                updated_by: input.trade_control?.updated_by,
            },
            created_at: new Date(),
            updated_at: new Date(),
        }),
        updateTradeControl: async (symbolId, input) => {
            const [broker, ...tickerParts] = symbolId.split(':')
            return {
                id: symbolId,
                broker: broker as BrokerName,
                ticker: tickerParts.join(':'),
                currency: 'JPY',
                trade_control: {
                    status: input.status,
                    reason: input.reason,
                    updated_at: new Date(),
                    updated_by: input.updated_by,
                },
                created_at: new Date(),
                updated_at: new Date(),
            }
        },
        ensureTradableSymbol: async () => {},
        listOrderUpdates: async () => [],
        ...options,
    })

const makePayload = (eventId: string, webhookSecret = 'test-secret') => ({
    event_id: eventId,
    time: new Date().toISOString(),
    occurred_at: 1773837296000,
    symbol: 'bitflyer:BTC_JPY',
    side: 'BUY',
    order_type: 'MARKET',
    size: 0.01,
    webhook_secret: webhookSecret,
})

const postWebhook = async (
    app: ReturnType<typeof createApp>,
    payload: unknown,
    sourceIp = '52.89.214.238',
) => {
    return app.request('/api/webhooks/tradingview', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-forwarded-for': sourceIp,
        },
        body: JSON.stringify(payload),
    })
}

const createDispatchStub = (override?: DispatchOrderFn) => {
    const calls: Parameters<DispatchOrderFn>[0][] = []
    const dispatchOrder: DispatchOrderFn = async (order) => {
        calls.push(order)
        if (override) {
            return override(order)
        }

        return {
            ok: true,
            broker: 'bitflyer',
            providerOrderId: 'JRF-test-1',
        }
    }

    return { dispatchOrder, calls }
}

const createWebhookEventStub = (): { createWebhookEvent: CreateWebhookEventFn; seen: Set<string>; events: Parameters<CreateWebhookEventFn>[0][] } => {
    const seen = new Set<string>()
    const events: Parameters<CreateWebhookEventFn>[0][] = []
    const createWebhookEvent: CreateWebhookEventFn = async (data) => {
        if (seen.has(data.event_id)) {
            throw new DuplicateEventError(data.event_id)
        }
        seen.add(data.event_id)
        events.push(data)
    }
    return { createWebhookEvent, seen, events }
}

const createOrderDispatchLogStub = (): { createOrderDispatchLog: CreateOrderDispatchLogFn; logs: Parameters<CreateOrderDispatchLogFn>[0][] } => {
    const logs: Parameters<CreateOrderDispatchLogFn>[0][] = []
    const createOrderDispatchLog: CreateOrderDispatchLogFn = async (data) => {
        logs.push(data)
    }
    return { createOrderDispatchLog, logs }
}

const makeTradableSymbol = (overrides: Partial<TradableSymbol> = {}): TradableSymbol => ({
    id: 'bitflyer:BTC_JPY',
    broker: 'bitflyer',
    ticker: 'BTC_JPY',
    display_name: 'BTC/JPY',
    currency: 'JPY',
    trade_control: {
        status: 'active',
        updated_at: new Date('2026-01-01T00:00:00Z'),
    },
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
})

const makeOrderV2 = (overrides: Partial<OrderV2> = {}): OrderV2 => ({
    id: `ord-${Math.random()}`,
    strategy: 'alpha',
    broker: 'bitflyer',
    ticker: 'BTC_JPY',
    side: 'BUY',
    order_type: 'MARKET',
    requested_size: 0.01,
    executed_size: 0.01,
    executed_price: 1000000,
    executed_at: new Date('2026-01-01T00:00:00Z'),
    status: 'EXECUTED',
    provider_order_ids: ['provider-1'],
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
} as OrderV2)

const makeOrderUpdate = (overrides: Partial<OrderUpdate> = {}): OrderUpdate => ({
    id: `ord-${Math.random()}`,
    strategy: 'alpha',
    broker: 'bitflyer',
    ticker: 'FX_BTC_JPY',
    side: 'BUY',
    order_type: 'MARKET',
    requested_size: 0.01,
    executed_size: 0,
    executed_price: null,
    fill_status: 'UNFILLED',
    status: 'PENDING',
    provider_order_ids: ['provider-1'],
    execution_costs: { commission: null },
    exit_sync_status: null,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    executed_at: null,
    ...overrides,
})

test('GET /api/order-updates requires the shared Bearer token', async () => {
    const app = createAppForTests({ apiSecret: 'test-secret' })

    for (const headers of [undefined, { Authorization: 'Bearer wrong-secret' }]) {
        const res = await app.request('/api/order-updates', { headers })
        assert.equal(res.status, 401)
        assert.deepEqual(await res.json(), {
            error: {
                code: 'UNAUTHORIZED',
                message: 'invalid or missing token',
            },
        })
    }
})

test('GET /api/order-updates passes the half-open period and paginates all lifecycle statuses', async () => {
    const calls: { updatedFrom: Date; updatedTo: Date }[] = []
    const allOrders = [
        makeOrderUpdate({ id: 'pending', status: 'PENDING' }),
        makeOrderUpdate({ id: 'executed', status: 'EXECUTED', fill_status: 'FILLED', executed_size: 0.01, executed_price: 100, executed_at: '2026-01-02T00:00:00.000Z', execution_costs: { commission: 0 } }),
        makeOrderUpdate({ id: 'failed', status: 'FAILED' }),
        makeOrderUpdate({ id: 'canceled', status: 'CANCELED' }),
    ]
    const app = createAppForTests({
        apiSecret: 'test-secret',
        listOrderUpdates: async (updatedFrom, updatedTo) => {
            calls.push({ updatedFrom, updatedTo })
            return allOrders
        },
    })

    const res = await app.request(
        '/api/order-updates?updated_from=2026-01-01T09%3A00%3A00%2B09%3A00&updated_to=2026-02-01T09%3A00%3A00%2B09%3A00&limit=2&page=2',
        { headers: { Authorization: 'Bearer test-secret' } },
    )

    assert.equal(res.status, 200)
    assert.deepEqual(calls, [{
        updatedFrom: new Date('2026-01-01T00:00:00.000Z'),
        updatedTo: new Date('2026-02-01T00:00:00.000Z'),
    }])
    assert.deepEqual(await res.json(), {
        orders: [allOrders[2], allOrders[3]],
        total: 4,
        page: 2,
        limit: 2,
        total_pages: 2,
        updated_from: '2026-01-01T00:00:00.000Z',
        updated_to: '2026-02-01T00:00:00.000Z',
    })
})

test('GET /api/order-updates uses one current time for the default 30-day period and returns an empty page', async () => {
    const calls: { updatedFrom: Date; updatedTo: Date }[] = []
    const before = Date.now()
    const app = createAppForTests({
        apiSecret: 'test-secret',
        listOrderUpdates: async (updatedFrom, updatedTo) => {
            calls.push({ updatedFrom, updatedTo })
            return []
        },
    })

    const res = await app.request('/api/order-updates?page=99', {
        headers: { Authorization: 'Bearer test-secret' },
    })
    const after = Date.now()
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.equal(calls.length, 1)
    assert.ok(calls[0]!.updatedTo.getTime() >= before)
    assert.ok(calls[0]!.updatedTo.getTime() <= after)
    assert.equal(
        calls[0]!.updatedTo.getTime() - calls[0]!.updatedFrom.getTime(),
        30 * 24 * 60 * 60 * 1000,
    )
    assert.deepEqual(body, {
        orders: [],
        total: 0,
        page: 99,
        limit: 50,
        total_pages: 1,
        updated_from: calls[0]!.updatedFrom.toISOString(),
        updated_to: calls[0]!.updatedTo.toISOString(),
    })
})

test('GET /api/order-updates rejects invalid periods and pagination without calling the reader', async () => {
    let callCount = 0
    const app = createAppForTests({
        apiSecret: 'test-secret',
        listOrderUpdates: async () => {
            callCount += 1
            return []
        },
    })
    const invalidQueries = [
        'updated_from=2026-01-01',
        'updated_from=2026-01-01T00%3A00%3A00',
        'updated_from=2026-02-30T00%3A00%3A00Z',
        'updated_from=invalid',
        'updated_from=2026-02-01T00%3A00%3A00Z&updated_to=2026-01-01T00%3A00%3A00Z',
        'updated_from=2026-01-01T00%3A00%3A00Z&updated_to=2026-01-01T00%3A00%3A00Z',
        'limit=0',
        'limit=201',
        'limit=1.5',
        'limit=abc',
        'page=0',
        'page=1.5',
        'page=abc',
    ]

    for (const query of invalidQueries) {
        const res = await app.request(`/api/order-updates?${query}`, {
            headers: { Authorization: 'Bearer test-secret' },
        })
        const body = await res.json()
        assert.equal(res.status, 400, query)
        assert.equal(body.error.code, 'INVALID_REQUEST', query)
    }
    assert.equal(callCount, 0)
})

test('GET /api/order-updates returns a fixed 500 body and warning when the reader fails', async () => {
    const { logger, calls } = createLoggerStub()
    const app = createAppForTests({
        apiSecret: 'test-secret',
        logger,
        listOrderUpdates: async () => {
            throw new Error('firestore details')
        },
    })

    const res = await app.request('/api/order-updates', {
        headers: { Authorization: 'Bearer test-secret' },
    })

    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), {
        error: {
            code: 'INTERNAL_ERROR',
            message: 'failed to fetch order updates',
        },
    })
    assert.equal(calls.some((call) => call.event === 'order_updates:fetch_failed'), true)
})

test('GET /api/health returns 200', async () => {
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
    })

    const res = await app.request('/api/health')
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { status: 'ok' })
})

test('GET /api/balances is not exposed', async () => {
    const app = createAppForTests({
        apiSecret: 'test-secret',
    })

    const res = await app.request('/api/balances', {
        headers: {
            Authorization: 'Bearer test-secret',
        },
    })

    assert.equal(res.status, 404)
})

test('GET /api/symbols returns tradable symbols', async () => {
    const symbols = [makeTradableSymbol()]
    const app = createAppForTests({
        apiSecret: 'test-secret',
        listTradableSymbols: async () => symbols,
    })

    const res = await app.request('/api/symbols', {
        headers: {
            Authorization: 'Bearer test-secret',
        },
    })
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.equal(body.symbols[0].id, 'bitflyer:BTC_JPY')
})

test('PUT /api/symbols/:symbol_id upserts symbol metadata', async () => {
    const upserts: unknown[] = []
    const app = createAppForTests({
        apiSecret: 'test-secret',
        upsertTradableSymbol: async (input) => {
            upserts.push(input)
            return makeTradableSymbol({
                id: input.id,
                broker: input.broker,
                ticker: input.ticker,
                display_name: input.display_name,
                currency: input.currency,
                note: input.note,
            })
        },
    })

    const res = await app.request('/api/symbols/saxo%3AFX%3ANAS100', {
        method: 'PUT',
        headers: {
            Authorization: 'Bearer test-secret',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            display_name: 'NASDAQ 100',
            currency: 'usd',
            note: 'cfd',
        }),
    })
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.deepEqual(upserts[0], {
        id: 'saxo:FX:NAS100',
        broker: 'saxo',
        ticker: 'FX:NAS100',
        display_name: 'NASDAQ 100',
        currency: 'USD',
        note: 'cfd',
    })
    assert.equal(body.symbol.display_name, 'NASDAQ 100')
})

test('PATCH /api/symbols/:symbol_id/trade-control updates status and logs info', async () => {
    const { logger, calls } = createLoggerStub()
    const updates: unknown[] = []
    const app = createAppForTests({
        apiSecret: 'test-secret',
        logger,
        updateTradeControl: async (symbolId, input) => {
            updates.push({ symbolId, input })
            return makeTradableSymbol({
                id: symbolId,
                trade_control: {
                    status: input.status,
                    reason: input.reason,
                    updated_at: new Date('2026-01-01T00:00:00Z'),
                    updated_by: input.updated_by,
                },
            })
        },
    })

    const res = await app.request('/api/symbols/bitflyer%3ABTC_JPY/trade-control', {
        method: 'PATCH',
        headers: {
            Authorization: 'Bearer test-secret',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            status: 'paused',
            reason: 'manual stop',
        }),
    })
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.deepEqual(updates[0], {
        symbolId: 'bitflyer:BTC_JPY',
        input: {
            status: 'paused',
            reason: 'manual stop',
            updated_by: 'ui',
        },
    })
    assert.equal(body.symbol.trade_control.status, 'paused')
    assert.equal(calls.find((call) => call.event === 'symbol_trade_control:updated')?.status, 'paused')
})

test('GET /api/positions returns positions when the shared key matches', async () => {
    const samplePositions: Position[] = [
        {
            broker: 'bitflyer',
            ticker: 'BTC_JPY',
            side: 'BUY',
            size: 0.02,
        },
    ]

    const app = createAppForTests({
        apiSecret: 'test-secret',
        positionFetcher: createPositionFetcherStub(samplePositions),
    })

    const res = await app.request('/api/positions', {
        headers: {
            Authorization: 'Bearer test-secret',
        },
    })
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.deepEqual(body.positions, samplePositions)
    assert.equal(typeof body.updated_at, 'number')
})

test('GET /api/saxo/portfolio-snapshot returns Saxo portfolio snapshot when authorized', async () => {
    const snapshot = {
        schemaVersion: 'portfolio-snapshot.v1' as const,
        source: {
            id: 'saxo-bank',
            provider: 'Saxo Bank',
            exporter: 'trade-gateway',
        },
        generatedAt: '2026-07-06T00:00:00.000Z',
        dataAsOf: '2026-07-06T00:00:00.000Z',
        baseCurrency: 'JPY',
        accounts: [
            {
                sourceAccountId: 'account-1',
                name: 'Main Account',
                baseCurrency: 'JPY',
            },
        ],
        cashBalances: [
            {
                sourceAccountId: 'account-1',
                currency: 'JPY',
                amount: '100000',
                valueJpy: '100000',
            },
        ],
        positions: [],
    }
    const app = createAppForTests({
        apiSecret: 'test-secret',
        saxoPortfolioSnapshotClient: {
            getPortfolioSnapshot: async () => snapshot,
        },
    })

    const res = await app.request('/api/saxo/portfolio-snapshot', {
        headers: {
            Authorization: 'Bearer test-secret',
        },
    })
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.deepEqual(body, snapshot)
})

test('GET /api/v2/orders/stats includes pending orders in open_orders', async () => {
    const listedRanges: { from: Date; to: Date }[] = []
    const app = createAppForTests({
        apiSecret: 'test-secret',
        listOrdersV2ByDateRange: async (from, to) => {
            listedRanges.push({ from, to })
            return [
                makeOrderV2({
                    id: 'alpha-entry',
                    strategy: 'alpha',
                    side: 'BUY',
                    executed_price: 1000000,
                    executed_at: new Date('2026-01-01T00:00:00Z'),
                }),
                makeOrderV2({
                    id: 'alpha-exit',
                    strategy: 'alpha',
                    side: 'SELL',
                    executed_price: 1100000,
                    executed_at: new Date('2026-01-02T00:00:00Z'),
                }),
            ]
        },
        getPendingOrdersV2: async () => [
            makeOrderV2({
                id: 'alpha-pending',
                strategy: 'alpha',
                status: 'PENDING',
                executed_size: 0,
                executed_price: null,
                executed_at: undefined,
            }),
            makeOrderV2({
                id: 'beta-pending',
                strategy: 'beta',
                status: 'PENDING',
                executed_size: 0,
                executed_price: null,
                executed_at: undefined,
            }),
        ],
    })

    const res = await app.request('/api/v2/orders/stats?from=2026-01-01&to=2026-01-02', {
        headers: {
            Authorization: 'Bearer test-secret',
        },
    })
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.equal(listedRanges[0]?.from.toISOString(), '2025-12-31T15:00:00.000Z')
    assert.equal(listedRanges[0]?.to.toISOString(), '2026-01-02T15:00:00.000Z')
    assert.deepEqual(
        body.stats.map((stat: { strategy: string; open_orders: number; total_trades: number }) => ({
            strategy: stat.strategy,
            open_orders: stat.open_orders,
            total_trades: stat.total_trades,
        })),
        [
            { strategy: 'alpha', open_orders: 1, total_trades: 1 },
            { strategy: 'beta', open_orders: 1, total_trades: 0 },
        ],
    )
})

test('POST /api/webhooks/tradingview returns 202 on valid payload', async () => {
    const { dispatchOrder, calls: dispatchCalls } = createDispatchStub()
    const { createWebhookEvent } = createWebhookEventStub()
    const { logger, calls } = createLoggerStub()
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        dispatchOrder,
        createWebhookEvent,
        logger,
    })

    const payload = makePayload('evt-accepted-1')
    const res = await postWebhook(app, payload)
    const body = await res.json()

    assert.equal(res.status, 202)
    assert.deepEqual(body, {
        status: 'accepted',
        event_id: 'evt-accepted-1',
    })

    const receivedLog = calls[0]

    assert.equal(res.headers.get('x-request-id'), receivedLog?.request_id)
    assert.equal(receivedLog?.event, 'webhook:received')
    assert.deepEqual(receivedLog, {
        event: 'webhook:received',
        logged_at: receivedLog?.logged_at,
        request_id: receivedLog?.request_id,
        sourceIp: '52.89.214.238',
        contentType: 'application/json',
        payload: {
            ...payload,
            webhook_secret: '[REDACTED]',
        },
    })

    assert.equal(dispatchCalls.length, 1)
    assert.deepEqual(dispatchCalls[0], {
        eventId: 'evt-accepted-1',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        size: 0.01,
        requestId: receivedLog?.request_id,
    })
})

test('POST /api/webhooks/tradingview suppresses dispatch when symbol is paused', async () => {
    const { dispatchOrder, calls: dispatchCalls } = createDispatchStub()
    const { createWebhookEvent, events } = createWebhookEventStub()
    const { createOrderDispatchLog, logs } = createOrderDispatchLogStub()
    const { logger, calls: logCalls } = createLoggerStub()
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        dispatchOrder,
        createWebhookEvent,
        createOrderDispatchLog,
        getTradableSymbol: async () => makeTradableSymbol({
            trade_control: {
                status: 'paused',
                reason: 'manual stop',
                updated_at: new Date('2026-01-01T00:00:00Z'),
            },
        }),
        logger,
    })

    const res = await postWebhook(app, makePayload('evt-symbol-paused-1'))
    const body = await res.json()

    assert.equal(res.status, 202)
    assert.deepEqual(body, {
        status: 'accepted',
        event_id: 'evt-symbol-paused-1',
        dispatch_status: 'suppressed',
    })
    assert.equal(dispatchCalls.length, 0)
    assert.equal(events[0]?.status, 'suppressed')
    assert.equal(events[0]?.rejection_reason, 'symbol_paused')
    assert.equal(logs[0]?.result, 'suppressed')
    assert.equal(logs[0]?.error_code, 'SYMBOL_PAUSED')
    assert.equal(logCalls.find((call) => call.event === 'webhook:suppressed')?.reason, 'symbol_paused')
})

test('POST /api/webhooks/tradingview creates default tradable symbol after unknown active symbol', async () => {
    const { dispatchOrder } = createDispatchStub()
    const { createWebhookEvent, events } = createWebhookEventStub()
    const ensuredSymbols: { broker: BrokerName; ticker: string }[] = []
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        dispatchOrder,
        createWebhookEvent,
        getTradableSymbol: async () => null,
        ensureTradableSymbol: async (input) => { ensuredSymbols.push(input) },
    })

    const res = await postWebhook(app, makePayload('evt-symbol-ensure-1'))

    assert.equal(res.status, 202)
    assert.deepEqual(ensuredSymbols, [{ broker: 'bitflyer', ticker: 'BTC_JPY' }])
    assert.equal(events[0]?.status, 'accepted')
})

test('POST /api/webhooks/tradingview accepts payload without order_type', async () => {
    const { dispatchOrder, calls: dispatchCalls } = createDispatchStub()
    const { createWebhookEvent } = createWebhookEventStub()
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        dispatchOrder,
        createWebhookEvent,
    })

    const { order_type: _, ...payloadWithoutOrderType } = makePayload('evt-accepted-no-order-type')
    const payload = {
        ...payloadWithoutOrderType,

        price: 123456.78,
        interval: '15',
    }

    const res = await postWebhook(app, payload)
    const body = await res.json()

    assert.equal(res.status, 202)
    assert.deepEqual(body, {
        status: 'accepted',
        event_id: 'evt-accepted-no-order-type',
    })
    assert.equal(dispatchCalls.length, 1)
    assert.equal(dispatchCalls[0]?.broker, 'bitflyer')
})

test('POST /api/webhooks/tradingview returns 400 for invalid time string', async () => {
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
    })

    const payload = {
        ...makePayload('evt-invalid-time'),
        time: 'not-a-date',
    }

    const res = await postWebhook(app, payload)
    const body = await res.json()

    assert.equal(res.status, 400)
    assert.equal(body.error.code, 'INVALID_REQUEST')
    assert.match(body.error.message, /time/)
})

test('POST /api/webhooks/tradingview returns 400 on validation error', async () => {
    const { logger, calls } = createLoggerStub()
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        logger,
    })

    const invalidPayload = {
        ...makePayload('evt-invalid-1'),
        time: 'bad-date-ms',
    }

    const res = await postWebhook(app, invalidPayload)
    const body = await res.json()

    assert.equal(res.status, 400)
    assert.equal(body.error.code, 'INVALID_REQUEST')
    const rejectedLog = calls.find(c => c['event'] === 'webhook:rejected')

    assert.equal(rejectedLog?.event, 'webhook:rejected')
    assert.equal(res.headers.get('x-request-id'), rejectedLog?.request_id)
    assert.equal(rejectedLog?.reason, 'validation_error')
    assert.deepEqual(rejectedLog?.payload, {
        ...invalidPayload,
        webhook_secret: '[REDACTED]',
    })
    assert.match((rejectedLog?.error as any)?.message, /time/)
    assert.equal(
        rejectedLog?.rawBody,
        JSON.stringify({
            ...invalidPayload,
            webhook_secret: '[REDACTED]',
        }),
    )
})

test('POST /api/webhooks/tradingview masks webhook_secret in invalid secret logs', async () => {
    const { logger, calls } = createLoggerStub()
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        logger,
    })

    const payload = makePayload('evt-unauth-1', 'wrong-secret')
    const res = await postWebhook(app, payload)
    const body = await res.json()
    const rejectedLog = calls.find(c => c['event'] === 'webhook:rejected')

    assert.equal(res.status, 401)
    assert.equal(body.error.code, 'INVALID_WEBHOOK_SECRET')
    assert.equal(rejectedLog?.event, 'webhook:rejected')
    assert.equal(res.headers.get('x-request-id'), rejectedLog?.request_id)
    assert.deepEqual(rejectedLog?.payload, {
        ...payload,
        webhook_secret: '[REDACTED]',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
    })
    assert.equal(
        rejectedLog?.rawBody,
        JSON.stringify({
            ...payload,
            webhook_secret: '[REDACTED]',
        }),
    )
})

test('POST /api/webhooks/tradingview uses incoming x-request-id when provided', async () => {
    const { createWebhookEvent } = createWebhookEventStub()
    const { logger, calls } = createLoggerStub()
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        createWebhookEvent,
        logger,
    })

    const payload = makePayload('evt-request-id-1')
    const res = await app.request('/api/webhooks/tradingview', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-forwarded-for': '52.89.214.238',
            'x-request-id': 'req-test-123',
        },
        body: JSON.stringify(payload),
    })

    const receivedLog = calls[0]

    assert.equal(res.status, 202)
    assert.equal(res.headers.get('x-request-id'), 'req-test-123')
    assert.equal(receivedLog?.request_id, 'req-test-123')
})

test('POST /api/webhooks/tradingview returns 401 on invalid secret', async () => {
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
    })

    const res = await postWebhook(app, makePayload('evt-unauth-1', 'wrong-secret'))
    const body = await res.json()

    assert.equal(res.status, 401)
    assert.equal(body.error.code, 'INVALID_WEBHOOK_SECRET')
})

test('POST /api/webhooks/tradingview returns 403 on forbidden source ip', async () => {
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
    })

    const res = await postWebhook(app, makePayload('evt-forbidden-1'), '1.1.1.1')
    const body = await res.json()

    assert.equal(res.status, 403)
    assert.equal(body.error.code, 'FORBIDDEN_SOURCE_IP')
})

test('POST /api/webhooks/tradingview still returns 202 when dispatch failed', async () => {
    const { dispatchOrder } = createDispatchStub(async () => ({
        ok: false,
        broker: 'bitflyer',
        code: 'BROKER_REQUEST_FAILED',
        message: 'bitflyer api timeout',
    }))
    const { createWebhookEvent } = createWebhookEventStub()
    const { logger, calls } = createLoggerStub()
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        dispatchOrder,
        createWebhookEvent,
        logger,
    })

    const res = await postWebhook(app, makePayload('evt-dispatch-failure-1'))
    const body = await res.json()
    const rejectedLog = calls.find(c => c['reason'] === 'broker_dispatch_failed')

    assert.equal(res.status, 202)
    assert.deepEqual(body, {
        status: 'accepted',
        event_id: 'evt-dispatch-failure-1',
    })
    assert.equal(rejectedLog?.reason, 'broker_dispatch_failed')
    assert.deepEqual(rejectedLog?.error, {
        code: 'BROKER_REQUEST_FAILED',
        message: 'bitflyer api timeout',
    })
})

test('POST /api/webhooks/tradingview returns 409 on duplicate event_id', async () => {
    const { dispatchOrder } = createDispatchStub()
    const { createWebhookEvent } = createWebhookEventStub()
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        dispatchOrder,
        createWebhookEvent,
    })

    const first = await postWebhook(app, makePayload('evt-dup-1'))
    const second = await postWebhook(app, makePayload('evt-dup-1'))
    const body = await second.json()

    assert.equal(first.status, 202)
    assert.equal(second.status, 409)
    assert.equal(body.error.code, 'DUPLICATED_EVENT')
})

test('GET /api/auth/saxo/login redirects to Saxo login page', async () => {
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        saxoConfig: {
            appKey: 'test-key',
            appSecret: 'test-secret',
            authBaseUrl: 'https://sim.logonvalidation.net',
            redirectUri: 'http://localhost/callback',
        },
    })

    const res = await app.request('/api/auth/saxo/login')
    assert.equal(res.status, 302)
    const location = res.headers.get('location')
    assert.ok(location?.includes('sim.logonvalidation.net/authorize'))
    assert.ok(location?.includes('response_type=code'))
})

test('createApp は partial saxoConfig で省略された tokenEncryptionKey を既定設定から補う', async (t) => {
    const defaultTokenEncryptionKey = Buffer.alloc(32, 9).toString('base64')
    const originalTokenEncryptionKey = config.saxo.tokenEncryptionKey
    config.saxo.tokenEncryptionKey = defaultTokenEncryptionKey
    t.after(() => {
        config.saxo.tokenEncryptionKey = originalTokenEncryptionKey
    })

    let capturedTokenEncryptionKey: string | undefined
    t.mock.method(SaxoClient.prototype, 'exchangeCodeForToken', async function (this: SaxoClient) {
        capturedTokenEncryptionKey = (this as unknown as { tokenEncryptionKey?: string }).tokenEncryptionKey
        return {
            accessToken: 'test-access-token',
            refreshToken: 'test-refresh-token',
            accessTokenExpiresAt: Date.now() + 1_200_000,
            refreshTokenExpiresAt: Date.now() + 86_400_000,
        }
    })
    const app = createAppForTests({
        saxoConfig: {
            appKey: 'test-key',
            appSecret: 'test-secret',
        },
    })

    const res = await app.request('/api/auth/saxo/callback?code=test-code')

    assert.equal(res.status, 200)
    assert.equal(capturedTokenEncryptionKey, defaultTokenEncryptionKey)
})

test('GET /api/auth/saxo/callback returns 400 if code is missing', async () => {
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
    })

    const res = await app.request('/api/auth/saxo/callback')
    assert.equal(res.status, 400)
    const body = await res.json()
    assert.equal(body.error, 'code is missing')
})

test('GET /api/auth/saxo/callback の OAuth failure ログに raw response body を含めない', async (t) => {
    const sensitiveValues = [
        'callback-body-access-token',
        'callback-body-refresh-token',
        Buffer.alloc(32, 41).toString('base64'),
    ]
    t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
        access_token: sensitiveValues[0],
        refresh_token: sensitiveValues[1],
        diagnostic: sensitiveValues[2],
    }), { status: 401 }))
    const { logger, calls } = createLoggerStub()
    const app = createAppForTests({
        logger,
        saxoConfig: {
            appKey: 'test-key',
            appSecret: 'test-secret',
            authBaseUrl: 'https://auth.example.com',
            redirectUri: 'http://localhost/callback',
        },
    })

    const response = await app.request('/api/auth/saxo/callback?code=test-code')

    assert.equal(response.status, 500)
    const captured = stringifyLogCalls(calls)
    assert.equal(captured.includes('Failed to exchange Saxo code (HTTP 401)'), true)
    for (const secret of sensitiveValues) {
        assert.equal(captured.includes(secret), false)
    }
})

const sideNormalizationCases: { input: string; expected: 'BUY' | 'SELL' }[] = [
    { input: 'BUY', expected: 'BUY' },
    { input: 'buy', expected: 'BUY' },
    { input: 'Buy', expected: 'BUY' },
    { input: 'LONG', expected: 'BUY' },
    { input: 'long', expected: 'BUY' },
    { input: 'Long', expected: 'BUY' },
    { input: 'SELL', expected: 'SELL' },
    { input: 'sell', expected: 'SELL' },
    { input: 'Sell', expected: 'SELL' },
    { input: 'SHORT', expected: 'SELL' },
    { input: 'short', expected: 'SELL' },
    { input: 'Short', expected: 'SELL' },
]

for (const { input, expected } of sideNormalizationCases) {
    test(`POST /api/webhooks/tradingview normalizes side "${input}" to "${expected}"`, async () => {
        const { dispatchOrder, calls: dispatchCalls } = createDispatchStub()
        const { createWebhookEvent } = createWebhookEventStub()
        const app = createAppForTests({
            webhookSecret: 'test-secret',
            sourceIpAllowlist: new Set(['52.89.214.238']),
            dispatchOrder,
            createWebhookEvent,
        })

        const payload = { ...makePayload(`evt-side-${input}`), side: input }
        const res = await postWebhook(app, payload)
        const body = await res.json()

        assert.equal(res.status, 202, `expected 202 for side="${input}"`)
        assert.equal(body.status, 'accepted')
        assert.equal(dispatchCalls[0]?.side, expected, `expected side to be normalized to "${expected}"`)
    })
}

test('POST /api/webhooks/tradingview returns 400 for invalid side value', async () => {
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
    })

    const payload = { ...makePayload('evt-side-invalid'), side: 'HOLD' }
    const res = await postWebhook(app, payload)
    const body = await res.json()

    assert.equal(res.status, 400)
    assert.equal(body.error.code, 'INVALID_REQUEST')
})

test('POST /api/webhooks/tradingview with dry_run=true skips dispatch and returns 202', async () => {
    const { dispatchOrder, calls: dispatchCalls } = createDispatchStub()
    const { createWebhookEvent } = createWebhookEventStub()
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        dispatchOrder,
        createWebhookEvent,
    })

    const payload = { ...makePayload('evt-dry-run-1'), dry_run: true }
    const res = await postWebhook(app, payload)
    const body = await res.json()

    assert.equal(res.status, 202)
    assert.deepEqual(body, { status: 'accepted', event_id: 'evt-dry-run-1' })
    assert.equal(dispatchCalls.length, 1)
    assert.equal(dispatchCalls[0]?.dryRun, true)
})

test('POST /api/webhooks/tradingview without dry_run does not set dryRun flag', async () => {
    const { dispatchOrder, calls: dispatchCalls } = createDispatchStub()
    const { createWebhookEvent } = createWebhookEventStub()
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        dispatchOrder,
        createWebhookEvent,
    })

    const res = await postWebhook(app, makePayload('evt-no-dry-run-1'))
    assert.equal(res.status, 202)
    assert.equal(dispatchCalls[0]?.dryRun, undefined)
})

// ---------------------------------------------------------------------------
// SlotScheduler stub helpers
// ---------------------------------------------------------------------------

const createSlotSchedulerStub = () => {
    const calls: Array<Pick<RunIfNewSlotParams, 'intervalSeconds' | 'slotKey'>> = []
    const slotScheduler: SlotScheduler = {
        runIfNewSlot: async ({ intervalSeconds, slotKey }: RunIfNewSlotParams) => {
            calls.push({ intervalSeconds, slotKey })
        },
    }
    return { slotScheduler, calls }
}

// ---------------------------------------------------------------------------
// /api/cron tests
// ---------------------------------------------------------------------------

test('GET /api/cron calls slot-scheduler for 10m and 1h tasks', async () => {
    const { slotScheduler, calls } = createSlotSchedulerStub()
    const app = createAppForTests({
        apiSecret: 'test-secret',
        slotScheduler,
    })

    const res = await app.request('/api/cron', {
        headers: { Authorization: 'Bearer test-secret' },
    })

    assert.equal(res.status, 200)

    const call10m = calls.find(c => c.slotKey === 'last_slot_10m')
    const call1h = calls.find(c => c.slotKey === 'last_slot_1h')

    assert.ok(call10m, 'should have called slot-scheduler for 10m task')
    assert.equal(call10m?.intervalSeconds, 600)

    assert.ok(call1h, 'should have called slot-scheduler for 1h task')
    assert.equal(call1h?.intervalSeconds, 3600)
})

test('GET /api/cron returns 200 even if slot-scheduler throws internally', async () => {
    const failingSlotScheduler: SlotScheduler = {
        runIfNewSlot: async () => {
            throw new Error('unexpected internal error')
        },
    }
    const app = createAppForTests({
        apiSecret: 'test-secret',
        slotScheduler: failingSlotScheduler,
    })

    const res = await app.request('/api/cron', {
        headers: { Authorization: 'Bearer test-secret' },
    })

    // The main cron handler should still succeed even if the scheduler throws.
    // (In production, runIfNewSlot catches errors internally; this tests the
    //  defence-in-depth case where that boundary is breached.)
    assert.equal(res.status, 200)
})

// ─────────────── Phase 2 新フロー: orders_v2 即時作成 ───────────────

test('POST /api/webhooks/tradingview: dispatch 成功 & strategy/interval あり時に addOrderV2 を呼ぶ', async () => {
    const { createWebhookEvent } = createWebhookEventStub()
    const { dispatchOrder } = createDispatchStub()
    const addedOrdersV2: any[] = []

    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        createWebhookEvent,
        dispatchOrder,
        addOrderV2: async (order) => { addedOrdersV2.push(order) },
    })

    const res = await postWebhook(app, {
        ...makePayload('evt-open-trade-1'),
        strategy: 'MA Crossover',
        interval: '4H',
    })

    assert.equal(res.status, 202)
    assert.equal(addedOrdersV2.length, 1)
    assert.equal(addedOrdersV2[0]?.id, 'evt-open-trade-1')
    assert.equal(addedOrdersV2[0]?.strategy, 'MA Crossover')
    assert.equal(addedOrdersV2[0]?.broker, 'bitflyer')
    assert.equal(addedOrdersV2[0]?.status, 'PENDING')
    assert.equal(addedOrdersV2[0]?.order_type, 'MARKET')
    assert.deepEqual(addedOrdersV2[0]?.provider_order_ids, ['JRF-test-1'])
    assert.equal(addedOrdersV2[0]?.broker_order_metadata, undefined)
})

test('POST /api/webhooks/tradingview: bitflyer parent order metadata を orders_v2 に保存する', async () => {
    const { createWebhookEvent } = createWebhookEventStub()
    const addedOrdersV2: any[] = []

    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        createWebhookEvent,
        dispatchOrder: async () => ({
            ok: true,
            broker: 'bitflyer',
            providerOrderId: 'JRF-parent-meta-1',
            brokerOrderMetadata: {
                kind: 'bitflyer_parent_order_v1',
                parent_order_acceptance_id: 'JRF-parent-meta-1',
                order_method: 'IFDOCO',
                entry: {
                    expected: {
                        role: 'ENTRY',
                        side: 'BUY',
                        condition_type: 'MARKET',
                        size: 0.01,
                    },
                    resolved: {
                        acceptance_id: null,
                    },
                },
                exits: [
                    {
                        expected: {
                            role: 'STOP_LOSS',
                            side: 'SELL',
                            condition_type: 'STOP',
                            size: 0.01,
                            trigger_price: 9500000,
                        },
                        resolved: {
                            acceptance_id: null,
                        },
                    },
                ],
            },
        }),
        addOrderV2: async (order) => { addedOrdersV2.push(order) },
    })

    const res = await postWebhook(app, {
        ...makePayload('evt-order-meta-1'),
        strategy: 'MA Crossover',
        interval: '4H',
        price: 9700000,
        stop_loss_pct: 2,
        take_profit_pct: 3,
    })

    assert.equal(res.status, 202)
    assert.equal(addedOrdersV2.length, 1)
    assert.deepEqual(addedOrdersV2[0]?.broker_order_metadata, {
        kind: 'bitflyer_parent_order_v1',
        parent_order_acceptance_id: 'JRF-parent-meta-1',
        order_method: 'IFDOCO',
        entry: {
            expected: {
                role: 'ENTRY',
                side: 'BUY',
                condition_type: 'MARKET',
                size: 0.01,
            },
            resolved: {
                acceptance_id: null,
            },
        },
        exits: [
            {
                expected: {
                    role: 'STOP_LOSS',
                    side: 'SELL',
                    condition_type: 'STOP',
                    size: 0.01,
                    trigger_price: 9500000,
                },
                resolved: {
                    acceptance_id: null,
                },
            },
        ],
    })
    assert.equal(addedOrdersV2[0]?.exit_sync_status, 'MONITORING')
})

test('POST /api/webhooks/tradingview: dispatch 失敗時は addOrderV2 を呼ばない', async () => {
    const { createWebhookEvent } = createWebhookEventStub()
    const addedOrdersV2: any[] = []

    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        createWebhookEvent,
        dispatchOrder: async () => ({ ok: false, broker: 'bitflyer', code: 'BROKER_REQUEST_FAILED', message: 'fail' }),
        addOrderV2: async (order) => { addedOrdersV2.push(order) },
    })

    const res = await postWebhook(app, {
        ...makePayload('evt-dispatch-fail'),
        strategy: 'MA',
        interval: '4H',
    })

    assert.equal(res.status, 202)
    assert.equal(addedOrdersV2.length, 0)
})

// ---------------------------------------------------------------------------
// /api/webhooks/foo tests
// ---------------------------------------------------------------------------

const makeFooPayload = (eventId: string) => ({
    event_id: eventId,
    time: new Date().toISOString(),
    occurred_at: 1773837296000,
    symbol: 'bitflyer:BTC_JPY',
    side: 'BUY',
    order_type: 'MARKET',
    size: 0.01,
})

const postFooWebhook = async (
    app: ReturnType<typeof createApp>,
    payload: unknown,
    apiSecret = 'test-secret',
    sourceIp = '1.2.3.4',
) => {
    return app.request('/api/webhooks/foods', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            'x-forwarded-for': sourceIp,
            ...(apiSecret ? { Authorization: `Bearer ${apiSecret}` } : {}),
        },
        body: JSON.stringify(payload),
    })
}

test('POST /api/webhooks/foods returns 401 without Authorization header', async () => {
    const app = createAppForTests({ apiSecret: 'test-secret' })
    const res = await app.request('/api/webhooks/foods', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(makeFooPayload('evt-foo-unauth-1')),
    })
    const body = await res.json()
    assert.equal(res.status, 401)
    assert.equal(body.error.code, 'UNAUTHORIZED')
})

test('POST /api/webhooks/foods returns 401 with wrong API secret', async () => {
    const app = createAppForTests({ apiSecret: 'test-secret' })
    const res = await postFooWebhook(app, makeFooPayload('evt-foo-unauth-2'), 'wrong-secret')
    const body = await res.json()
    assert.equal(res.status, 401)
    assert.equal(body.error.code, 'UNAUTHORIZED')
})

test('POST /api/webhooks/foods returns 202 on valid payload with correct API secret', async () => {
    const { dispatchOrder, calls: dispatchCalls } = createDispatchStub()
    const { createWebhookEvent } = createWebhookEventStub()
    const { logger, calls } = createLoggerStub()
    const app = createAppForTests({
        apiSecret: 'test-secret',
        dispatchOrder,
        createWebhookEvent,
        logger,
    })

    const payload = makeFooPayload('evt-foo-accepted-1')
    const res = await postFooWebhook(app, payload)
    const body = await res.json()

    assert.equal(res.status, 202)
    assert.deepEqual(body, { status: 'accepted', event_id: 'evt-foo-accepted-1' })
    assert.equal(dispatchCalls.length, 1)
    assert.deepEqual(dispatchCalls[0], {
        eventId: 'evt-foo-accepted-1',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        size: 0.01,
        requestId: calls[0]?.request_id,
    })
})

test('POST /api/webhooks/foods accepts any source IP', async () => {
    const { dispatchOrder } = createDispatchStub()
    const { createWebhookEvent } = createWebhookEventStub()
    const app = createAppForTests({
        apiSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        dispatchOrder,
        createWebhookEvent,
    })

    const res = await postFooWebhook(app, makeFooPayload('evt-foo-any-ip'), 'test-secret', '9.9.9.9')
    const body = await res.json()

    assert.equal(res.status, 202)
    assert.equal(body.status, 'accepted')
})

test('POST /api/webhooks/foods   ignores webhook_secret field in body', async () => {
    const { dispatchOrder } = createDispatchStub()
    const { createWebhookEvent } = createWebhookEventStub()
    const app = createAppForTests({
        apiSecret: 'test-secret',
        webhookSecret: 'real-secret',
        dispatchOrder,
        createWebhookEvent,
    })

    const payload = { ...makeFooPayload('evt-foo-no-body-secret'), webhook_secret: 'wrong-secret' }
    const res = await postFooWebhook(app, payload)
    const body = await res.json()

    assert.equal(res.status, 202)
    assert.equal(body.status, 'accepted')
})

test('POST /api/webhooks/foods returns 400 for invalid content-type', async () => {
    const app = createAppForTests({ apiSecret: 'test-secret' })
    const res = await app.request('/api/webhooks/foods', {
        method: 'POST',
        headers: {
            'content-type': 'text/plain',
            Authorization: 'Bearer test-secret',
        },
        body: 'hello',
    })
    const body = await res.json()
    assert.equal(res.status, 400)
    assert.equal(body.error.code, 'INVALID_REQUEST')
    assert.match(body.error.message, /application\/json/)
})

test('POST /api/webhooks/foods returns 400 on validation error', async () => {
    const app = createAppForTests({ apiSecret: 'test-secret' })
    const payload = { ...makeFooPayload('evt-foo-invalid'), time: 'bad-date' }
    const res = await postFooWebhook(app, payload)
    const body = await res.json()
    assert.equal(res.status, 400)
    assert.equal(body.error.code, 'INVALID_REQUEST')
    assert.match(body.error.message, /time/)
})

test('POST /api/webhooks/foods returns 409 on duplicate event_id', async () => {
    const { dispatchOrder } = createDispatchStub()
    const { createWebhookEvent } = createWebhookEventStub()
    const app = createAppForTests({
        apiSecret: 'test-secret',
        dispatchOrder,
        createWebhookEvent,
    })

    const first = await postFooWebhook(app, makeFooPayload('evt-foo-dup-1'))
    const second = await postFooWebhook(app, makeFooPayload('evt-foo-dup-1'))
    const body = await second.json()

    assert.equal(first.status, 202)
    assert.equal(second.status, 409)
    assert.equal(body.error.code, 'DUPLICATED_EVENT')
})

test('POST /api/webhooks/foods: dispatch 成功 & strategy/interval あり時に addOrderV2 を呼ぶ', async () => {
    const { createWebhookEvent } = createWebhookEventStub()
    const { dispatchOrder } = createDispatchStub()
    const addedOrdersV2: any[] = []

    const app = createAppForTests({
        apiSecret: 'test-secret',
        createWebhookEvent,
        dispatchOrder,
        addOrderV2: async (order) => { addedOrdersV2.push(order) },
    })

    const res = await postFooWebhook(app, {
        ...makeFooPayload('evt-foo-open-trade-1'),
        strategy: 'MA Crossover',
        interval: '4H',
    })

    assert.equal(res.status, 202)
    assert.equal(addedOrdersV2.length, 1)
    assert.equal(addedOrdersV2[0]?.id, 'evt-foo-open-trade-1')
    assert.equal(addedOrdersV2[0]?.strategy, 'MA Crossover')
})

// ---------------------------------------------------------------------------
// stop_loss_pct / take_profit_pct テスト
// ---------------------------------------------------------------------------

test('POST /api/webhooks/tradingview: stop_loss_pct (文字列) が stop_loss より優先されて stopLoss に渡される', async () => {
    const { dispatchOrder, calls: dispatchCalls } = createDispatchStub()
    const { createWebhookEvent } = createWebhookEventStub()
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        dispatchOrder,
        createWebhookEvent,
    })

    const payload = {
        ...makePayload('evt-slpct-str'),
        stop_loss: '1%',
        stop_loss_pct: '2%',
    }
    const res = await postWebhook(app, payload)

    assert.equal(res.status, 202)
    assert.equal(dispatchCalls[0]?.stopLoss, '2%')
})

test('POST /api/webhooks/tradingview: stop_loss_pct (数値) は "N%" 文字列に変換されて stopLoss に渡される', async () => {
    const { dispatchOrder, calls: dispatchCalls } = createDispatchStub()
    const { createWebhookEvent } = createWebhookEventStub()
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        dispatchOrder,
        createWebhookEvent,
    })

    const payload = {
        ...makePayload('evt-slpct-num'),
        stop_loss_pct: 2,
    }
    const res = await postWebhook(app, payload)

    assert.equal(res.status, 202)
    assert.equal(dispatchCalls[0]?.stopLoss, '2%')
})

test('POST /api/webhooks/tradingview: take_profit_pct (文字列) が take_profit より優先されて takeProfit に渡される', async () => {
    const { dispatchOrder, calls: dispatchCalls } = createDispatchStub()
    const { createWebhookEvent } = createWebhookEventStub()
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        dispatchOrder,
        createWebhookEvent,
    })

    const payload = {
        ...makePayload('evt-tppct-str'),
        take_profit: '1%',
        take_profit_pct: '3%',
    }
    const res = await postWebhook(app, payload)

    assert.equal(res.status, 202)
    assert.equal(dispatchCalls[0]?.takeProfit, '3%')
})

test('POST /api/webhooks/tradingview: take_profit_pct (数値) は "N%" 文字列に変換されて takeProfit に渡される', async () => {
    const { dispatchOrder, calls: dispatchCalls } = createDispatchStub()
    const { createWebhookEvent } = createWebhookEventStub()
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        dispatchOrder,
        createWebhookEvent,
    })

    const payload = {
        ...makePayload('evt-tppct-num'),
        take_profit_pct: 3,
    }
    const res = await postWebhook(app, payload)

    assert.equal(res.status, 202)
    assert.equal(dispatchCalls[0]?.takeProfit, '3%')
})

test('POST /api/webhooks/tradingview: stop_loss_pct なし時は stop_loss がそのまま stopLoss に渡される', async () => {
    const { dispatchOrder, calls: dispatchCalls } = createDispatchStub()
    const { createWebhookEvent } = createWebhookEventStub()
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        dispatchOrder,
        createWebhookEvent,
    })

    const payload = {
        ...makePayload('evt-sl-fallback'),
        stop_loss: '1.5%',
    }
    const res = await postWebhook(app, payload)

    assert.equal(res.status, 202)
    assert.equal(dispatchCalls[0]?.stopLoss, '1.5%')
})

test('POST /api/webhooks/tradingview: stop_loss_pct も stop_loss もなければ stopLoss は undefined', async () => {
    const { dispatchOrder, calls: dispatchCalls } = createDispatchStub()
    const { createWebhookEvent } = createWebhookEventStub()
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        dispatchOrder,
        createWebhookEvent,
    })

    const res = await postWebhook(app, makePayload('evt-sl-none'))

    assert.equal(res.status, 202)
    assert.equal(dispatchCalls[0]?.stopLoss, undefined)
    assert.equal(dispatchCalls[0]?.takeProfit, undefined)
})

test('POST /api/webhooks/tradingview: stop_loss_pct + take_profit_pct 両方あれば orderMethod が IFDOCO になる', async () => {
    const { createWebhookEvent } = createWebhookEventStub()
    const { dispatchOrder } = createDispatchStub()
    const addedOrdersV2: any[] = []

    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        createWebhookEvent,
        dispatchOrder,
        addOrderV2: async (order) => { addedOrdersV2.push(order) },
    })

    const payload = {
        ...makePayload('evt-ifdoco-pct'),
        strategy: 'TEST',
        interval: '1H',
        stop_loss_pct: 2,
        take_profit_pct: 3,
    }
    const res = await postWebhook(app, payload)

    assert.equal(res.status, 202)
    assert.equal(addedOrdersV2[0]?.order_type, 'IFDOCO')
    assert.equal(addedOrdersV2[0]?.exit_sync_status, 'MONITORING')
})
