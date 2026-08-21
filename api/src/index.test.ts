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
import type { StrategySymbolPolicy } from './types/strategy-symbol-policy.js'
import type { StrategySymbolPosition } from './types/strategy-symbol-position.js'
import { InvalidStrategySymbolPolicyError, SymbolConstraintsRequiredError, SymbolNotFoundError } from './services/strategy-symbol-policies.js'
import { InvalidStoredTradableSymbolError } from './services/tradable-symbols.js'
import { calculateOrderSize } from './services/order-size-calculator.js'
import type { ReserveStrategySymbolOrderResult } from './services/strategy-symbol-reservation-service.js'
import type { GetStrategySymbolPositionFn } from './services/strategy-symbol-positions.js'

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
        // The production default always resolves the policy, including when a
        // symbol is missing. Keep unrelated legacy route tests deterministic;
        // policy-specific tests override this seam explicitly.
        getStrategySymbolPolicy: async () => null,
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

const makeSizingPolicy = (overrides: Partial<StrategySymbolPolicy> = {}): StrategySymbolPolicy => ({
    id: 'alpha:bitflyer:BTC_JPY',
    strategy_id: 'alpha',
    symbol_id: 'bitflyer:BTC_JPY',
    sizing_mode: 'WEBHOOK_CAPPED',
    enabled: true,
    max_abs_position: 5,
    no_flip: true,
    version: 3,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
} as StrategySymbolPolicy)

const makeStrategySymbolPosition = (overrides: Partial<StrategySymbolPosition> = {}): StrategySymbolPosition => ({
    id: 'alpha:bitflyer:BTC_JPY',
    strategy_id: 'alpha',
    symbol_id: 'bitflyer:BTC_JPY',
    confirmed_position: 0,
    pending_delta: 0,
    status: 'READY',
    policy_version: 3,
    updated_at: new Date('2026-01-01T00:00:00Z'),
    reconciled_at: null,
    ...overrides,
})

type SizingRouteFixtureOptions = Parameters<typeof createApp>[0] & {
    getStrategySymbolPosition?: GetStrategySymbolPositionFn
}

const createSizingRouteFixture = (options: SizingRouteFixtureOptions = {}) => {
    const { getStrategySymbolPosition, ...appOptions } = options
    const { dispatchOrder, calls: dispatchCalls } = createDispatchStub()
    const configuredDispatchOrder = appOptions.dispatchOrder
    const observedDispatchOrder: DispatchOrderFn = configuredDispatchOrder === undefined
        ? dispatchOrder
        : async (order) => {
            dispatchCalls.push(order)
            return configuredDispatchOrder(order)
        }
    const { createWebhookEvent, events } = createWebhookEventStub()
    const { createOrderDispatchLog, logs } = createOrderDispatchLogStub()
    const { logger, calls: loggerCalls } = createLoggerStub()
    const addedOrders: unknown[] = []
    const reservationByEvent = new Map<string, Extract<ReserveStrategySymbolOrderResult, { kind: 'DISPATCH' }>>()
    const defaultReserveStrategySymbolOrder = async (input: {
        eventId: string
        orderId: string
        strategyId: string
        symbolId: string
        side: 'BUY' | 'SELL'
        inputSize?: number
    }): Promise<ReserveStrategySymbolOrderResult> => {
        const resolvedPolicy = await (options.getStrategySymbolPolicy ?? (async () => makeSizingPolicy()))(input.strategyId, input.symbolId)
        const resolvedSymbol = await (options.getTradableSymbol ?? (async () => makeTradableSymbol({
            order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
        })))(input.symbolId)
        const resolvedPosition = await (getStrategySymbolPosition ?? (async () => makeStrategySymbolPosition()))(input.strategyId, input.symbolId)
        if (resolvedPolicy === null) return { kind: 'REJECT', reason: 'POLICY_NOT_FOUND' }
        if (resolvedSymbol === null) return { kind: 'REJECT', reason: 'SYMBOL_NOT_FOUND' }
        if (resolvedSymbol.order_constraints === undefined) return { kind: 'REJECT', reason: 'SYMBOL_CONSTRAINTS_REQUIRED' }
        if (!Number.isFinite(resolvedSymbol.order_constraints.quantity_step) || resolvedSymbol.order_constraints.quantity_step <= 0 ||
            !Number.isFinite(resolvedSymbol.order_constraints.min_order_size) || resolvedSymbol.order_constraints.min_order_size <= 0 ||
            (resolvedSymbol.order_constraints.max_order_size !== undefined &&
                (!Number.isFinite(resolvedSymbol.order_constraints.max_order_size) ||
                    resolvedSymbol.order_constraints.max_order_size < resolvedSymbol.order_constraints.min_order_size))) {
            return { kind: 'REJECT', reason: 'INVALID_STORED_STATE' }
        }
        if (resolvedPosition === null) return { kind: 'REJECT', reason: 'POSITION_NOT_FOUND' }
        if (!Number.isFinite(resolvedPosition.confirmed_position) || !Number.isFinite(resolvedPosition.pending_delta)) {
            return { kind: 'REJECT', reason: 'INVALID_STORED_STATE' }
        }
        if (resolvedPosition.status !== 'READY') {
            return {
                kind: 'SUPPRESS',
                reason: 'POSITION_NOT_READY',
                position: resolvedPosition,
            }
        }
        const decision = calculateOrderSize({
            policy: resolvedPolicy,
            constraints: resolvedSymbol.order_constraints,
            confirmedPosition: resolvedPosition.confirmed_position,
            pendingDelta: resolvedPosition.pending_delta,
            side: input.side,
            inputSize: input.inputSize,
        })
        if (decision.kind === 'SUPPRESS') return { kind: 'SUPPRESS', reason: decision.reason, decision }
        if (decision.kind === 'REJECT') return { kind: 'REJECT', reason: decision.reason, decision }
        const positionBefore = resolvedPosition.confirmed_position + resolvedPosition.pending_delta
        const signedDelta = input.side === 'BUY' ? decision.effectiveSize : -decision.effectiveSize
        const positionAfter = positionBefore + signedDelta
        const reservation = {
            id: `reservation-${input.eventId}`,
            event_id: input.eventId,
            position_id: resolvedPosition.id,
            strategy_id: input.strategyId,
            symbol_id: input.symbolId,
            order_id: input.orderId,
            reserved_delta: signedDelta,
            status: 'RESERVED' as const,
            policy_version: resolvedPolicy.version,
            created_at: new Date('2026-01-01T00:00:00Z'),
            updated_at: new Date('2026-01-01T00:00:00Z'),
        }
        const result = {
            kind: 'DISPATCH' as const,
            reason: 'CALCULATED' as const,
            effectiveSize: decision.effectiveSize,
            decision,
            audit: {
                sizingMode: resolvedPolicy.sizing_mode,
                policyVersion: resolvedPolicy.version,
                positionBefore,
                positionAfter,
            },
            reservation,
            position: {
                ...resolvedPosition,
                pending_delta: resolvedPosition.pending_delta + signedDelta,
            },
        }
        reservationByEvent.set(input.eventId, result)
        return result
    }
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        createWebhookEvent,
        createOrderDispatchLog,
        addOrderV2: async (order) => { addedOrders.push(order) },
        getTradableSymbol: async () => makeTradableSymbol({
            order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
        }),
        getStrategySymbolPolicy: async () => makeSizingPolicy(),
        logger,
        reserveStrategySymbolOrder: defaultReserveStrategySymbolOrder,
        applyStrategySymbolDispatchOutcome: async (input) => {
            const result = reservationByEvent.get(input.eventId)
            if (!result) return { kind: 'REJECT', reason: 'RESERVATION_NOT_FOUND' as const }
            return {
                kind: 'UPDATED' as const,
                reservation: {
                    ...result.reservation,
                    status: input.outcome === 'CONFIRMED_SUCCESS'
                        ? 'DISPATCHED' as const
                        : input.outcome === 'CONFIRMED_FAILURE'
                            ? 'RELEASED' as const
                            : 'MANUAL_REVIEW' as const,
                },
                position: result.position,
            }
        },
        ...appOptions,
        dispatchOrder: observedDispatchOrder,
    })
    return { app, dispatchCalls, events, logs, addedOrders, loggerCalls }
}

const makeDispatchReservationResult = (
    eventId: string,
    effectiveSize: number,
    overrides: Partial<Extract<ReserveStrategySymbolOrderResult, { kind: 'DISPATCH' }>> = {},
): Extract<ReserveStrategySymbolOrderResult, { kind: 'DISPATCH' }> => {
    const reservation = {
        id: `reservation-${eventId}`,
        event_id: eventId,
        position_id: 'alpha:bitflyer:BTC_JPY',
        strategy_id: 'alpha',
        symbol_id: 'bitflyer:BTC_JPY',
        order_id: eventId,
        reserved_delta: effectiveSize,
        status: 'RESERVED' as const,
        policy_version: 3,
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
    }
    return {
        kind: 'DISPATCH',
        reason: 'CALCULATED',
        effectiveSize,
        decision: {
            kind: 'DISPATCH',
            reason: 'CALCULATED',
            effectiveSize,
            details: { appliedConstraints: [] },
        },
        audit: {
            sizingMode: 'WEBHOOK_CAPPED',
            policyVersion: 3,
            positionBefore: 0,
            positionAfter: effectiveSize,
        },
        reservation,
        position: makeStrategySymbolPosition({ pending_delta: effectiveSize }),
        ...overrides,
    }
}

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

test('GET /api/symbols returns configured order constraints unchanged', async () => {
    const orderConstraints = {
        quantity_step: 0.001,
        min_order_size: 0.1,
        max_order_size: 0.25,
    }
    const app = createAppForTests({
        apiSecret: 'test-secret',
        listTradableSymbols: async () => [makeTradableSymbol({ order_constraints: orderConstraints })],
    })

    const res = await app.request('/api/symbols', {
        headers: {
            Authorization: 'Bearer test-secret',
        },
    })
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.deepEqual(body.symbols[0].order_constraints, orderConstraints)
})

test('GET /api/symbols/:symbol_id returns configured order constraints unchanged', async () => {
    const orderConstraints = {
        quantity_step: 0.001,
        min_order_size: 0.1,
        max_order_size: 0.25,
    }
    const app = createAppForTests({
        apiSecret: 'test-secret',
        getTradableSymbol: async () => makeTradableSymbol({ order_constraints: orderConstraints }),
    })

    const res = await app.request('/api/symbols/bitflyer%3ABTC_JPY', {
        headers: {
            Authorization: 'Bearer test-secret',
        },
    })
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.deepEqual(body.symbol.order_constraints, orderConstraints)
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

test('PUT /api/symbols/:symbol_id accepts and returns order constraints', async () => {
    const orderConstraints = {
        quantity_step: 0.001,
        min_order_size: 0.1,
        max_order_size: 0.25,
    }
    const upserts: unknown[] = []
    const app = createAppForTests({
        apiSecret: 'test-secret',
        upsertTradableSymbol: async (input) => {
            upserts.push(input)
            return makeTradableSymbol({
                id: input.id,
                broker: input.broker,
                ticker: input.ticker,
                currency: input.currency,
                order_constraints: input.order_constraints,
            })
        },
    })

    const res = await app.request('/api/symbols/bitflyer%3ABTC_JPY', {
        method: 'PUT',
        headers: {
            Authorization: 'Bearer test-secret',
            'content-type': 'application/json',
        },
        body: JSON.stringify({
            currency: 'jpy',
            order_constraints: orderConstraints,
        }),
    })
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.deepEqual((upserts[0] as { order_constraints?: unknown }).order_constraints, orderConstraints)
    assert.deepEqual(body.symbol.order_constraints, orderConstraints)
})

test('PUT /api/symbols/:symbol_id accepts order constraints without max and with equal bounds', async () => {
    const calls: unknown[] = []
    const app = createAppForTests({
        apiSecret: 'test-secret',
        upsertTradableSymbol: async (input) => {
            calls.push(input)
            return makeTradableSymbol({ order_constraints: input.order_constraints })
        },
    })

    for (const order_constraints of [
        { quantity_step: 0.25, min_order_size: 2 },
        { quantity_step: 0.1, min_order_size: 1, max_order_size: 1 },
    ]) {
        const res = await app.request('/api/symbols/bitflyer%3ABTC_JPY', {
            method: 'PUT',
            headers: {
                Authorization: 'Bearer test-secret',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ currency: 'JPY', order_constraints }),
        })

        assert.equal(res.status, 200)
    }
    assert.equal(calls.length, 2)
})

test('PUT /api/symbols/:symbol_id rejects invalid order constraints without calling service', async () => {
    const invalidBodies = [
        { quantity_step: 0, min_order_size: 0.1 },
        { quantity_step: -0.001, min_order_size: 0.1 },
        { quantity_step: 0.001, min_order_size: 0 },
        { quantity_step: 0.001, min_order_size: -0.1 },
        { quantity_step: 0.001, min_order_size: 0.1, max_order_size: 0.01 },
        { quantity_step: 0.001, min_order_size: 0.1, max_order_size: null },
    ]
    let upsertCalls = 0
    const app = createAppForTests({
        apiSecret: 'test-secret',
        upsertTradableSymbol: async (input) => {
            upsertCalls += 1
            return makeTradableSymbol({ order_constraints: input.order_constraints })
        },
    })

    for (const order_constraints of invalidBodies) {
        const res = await app.request('/api/symbols/bitflyer%3ABTC_JPY', {
            method: 'PUT',
            headers: {
                Authorization: 'Bearer test-secret',
                'content-type': 'application/json',
            },
            body: JSON.stringify({ currency: 'JPY', order_constraints }),
        })
        const body = await res.json()

        assert.equal(res.status, 400)
        assert.equal(body.error.code, 'INVALID_REQUEST')
    }
    assert.equal(upsertCalls, 0)
})

const makeStrategySymbolPolicy = (overrides: Partial<StrategySymbolPolicy> = {}): StrategySymbolPolicy => ({
    id: 'strategy-1:bitflyer:BTC_JPY',
    strategy_id: 'strategy-1',
    symbol_id: 'bitflyer:BTC_JPY',
    sizing_mode: 'WEBHOOK_CAPPED',
    enabled: true,
    max_abs_position: 1,
    no_flip: true,
    version: 2,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
} as StrategySymbolPolicy)

test('strategy-symbol policy GET/PUT require the shared Bearer token', async () => {
    let getCalls = 0
    let putCalls = 0
    const app = createAppForTests({
        apiSecret: 'test-secret',
        getStrategySymbolPolicy: async () => {
            getCalls += 1
            return makeStrategySymbolPolicy()
        },
        putStrategySymbolPolicy: async () => {
            putCalls += 1
            return makeStrategySymbolPolicy()
        },
    })

    for (const headers of [undefined, { Authorization: 'Bearer wrong-secret' }]) {
        const getResponse = await app.request('/api/strategy-symbol-policies/strategy-1/bitflyer%3ABTC_JPY', { headers })
        assert.equal(getResponse.status, 401)
        assert.equal((await getResponse.json()).error.code, 'UNAUTHORIZED')

        const putResponse = await app.request('/api/strategy-symbol-policies/strategy-1/bitflyer%3ABTC_JPY', {
            method: 'PUT',
            headers: { ...(headers ?? {}), 'content-type': 'application/json' },
            body: JSON.stringify({
                sizing_mode: 'WEBHOOK_CAPPED',
                enabled: true,
                max_abs_position: 1,
                no_flip: true,
            }),
        })
        assert.equal(putResponse.status, 401)
        assert.equal((await putResponse.json()).error.code, 'UNAUTHORIZED')
    }
    assert.equal(getCalls, 0)
    assert.equal(putCalls, 0)
})

test('strategy-symbol policy GET supports encoded symbol IDs and returns POLICY_NOT_FOUND', async () => {
    const calls: { strategyId: string; symbolId: string }[] = []
    const policy = makeStrategySymbolPolicy({
        id: 'strategy-1:saxo:FX:NAS100',
        strategy_id: 'strategy-1',
        symbol_id: 'saxo:FX:NAS100',
        version: 3,
    })
    const app = createAppForTests({
        apiSecret: 'test-secret',
        getStrategySymbolPolicy: async (strategyId, symbolId) => {
            calls.push({ strategyId, symbolId })
            return symbolId === 'saxo:FX:NAS100' ? policy : null
        },
    })

    const success = await app.request('/api/strategy-symbol-policies/strategy-1/saxo%3AFX%3ANAS100', {
        headers: { Authorization: 'Bearer test-secret' },
    })
    assert.equal(success.status, 200)
    assert.equal((await success.json()).policy.version, 3)
    assert.deepEqual(calls[0], { strategyId: 'strategy-1', symbolId: 'saxo:FX:NAS100' })

    const missing = await app.request('/api/strategy-symbol-policies/strategy-1/bitflyer%3ABTC_JPY', {
        headers: { Authorization: 'Bearer test-secret' },
    })
    assert.equal(missing.status, 404)
    assert.equal((await missing.json()).error.code, 'POLICY_NOT_FOUND')
})

test('strategy-symbol policy PUT passes both mode payloads without generated fields', async () => {
    const calls: unknown[] = []
    const app = createAppForTests({
        apiSecret: 'test-secret',
        putStrategySymbolPolicy: async (input) => {
            calls.push(input)
            return makeStrategySymbolPolicy({
                ...input,
                id: `${input.strategy_id}:${input.symbol_id}`,
                version: 1,
            } as Partial<StrategySymbolPolicy>)
        },
    })

    const webhookResponse = await app.request('/api/strategy-symbol-policies/strategy-1/bitflyer%3ABTC_JPY', {
        method: 'PUT',
        headers: { Authorization: 'Bearer test-secret', 'content-type': 'application/json' },
        body: JSON.stringify({
            sizing_mode: 'WEBHOOK_CAPPED',
            enabled: false,
            max_abs_position: 1,
            no_flip: true,
        }),
    })
    assert.equal(webhookResponse.status, 200)

    const managedResponse = await app.request('/api/strategy-symbol-policies/strategy-1/saxo%3AFX%3ANAS100', {
        method: 'PUT',
        headers: { Authorization: 'Bearer test-secret', 'content-type': 'application/json' },
        body: JSON.stringify({
            sizing_mode: 'MANAGED',
            enabled: true,
            max_abs_position: 2,
            no_flip: false,
            base_order_size: 0.5,
            taper_strength: 0,
        }),
    })
    assert.equal(managedResponse.status, 200)
    assert.deepEqual(calls, [
        {
            strategy_id: 'strategy-1',
            symbol_id: 'bitflyer:BTC_JPY',
            sizing_mode: 'WEBHOOK_CAPPED',
            enabled: false,
            max_abs_position: 1,
            no_flip: true,
        },
        {
            strategy_id: 'strategy-1',
            symbol_id: 'saxo:FX:NAS100',
            sizing_mode: 'MANAGED',
            enabled: true,
            max_abs_position: 2,
            no_flip: false,
            base_order_size: 0.5,
            taper_strength: 0,
        },
    ])
})

test('strategy-symbol policy PUT rejects strict schema and path errors without calling service', async () => {
    let calls = 0
    const app = createAppForTests({
        apiSecret: 'test-secret',
        putStrategySymbolPolicy: async () => {
            calls += 1
            return makeStrategySymbolPolicy()
        },
    })
    const invalidBodies = [
        { sizing_mode: 'WEBHOOK_CAPPED', enabled: true, max_abs_position: 1, no_flip: true, base_order_size: 0.1 },
        { sizing_mode: 'MANAGED', enabled: true, max_abs_position: 1, no_flip: true, taper_strength: 0 },
        { sizing_mode: 'MANAGED', enabled: true, max_abs_position: 1, no_flip: true, base_order_size: 0.1, taper_strength: 1.1 },
        { sizing_mode: 'MANAGED', enabled: true, max_abs_position: 1, no_flip: true, base_order_size: 0.1, taper_strength: 0, version: 1 },
    ]
    for (const body of invalidBodies) {
        const response = await app.request('/api/strategy-symbol-policies/strategy-1/bitflyer%3ABTC_JPY', {
            method: 'PUT',
            headers: { Authorization: 'Bearer test-secret', 'content-type': 'application/json' },
            body: JSON.stringify(body),
        })
        assert.equal(response.status, 400)
        assert.equal((await response.json()).error.code, 'INVALID_REQUEST')
    }

    const invalidPath = await app.request('/api/strategy-symbol-policies/strategy%2F1/bitflyer%3ABTC_JPY', {
        headers: { Authorization: 'Bearer test-secret' },
    })
    assert.equal(invalidPath.status, 400)
    assert.equal(calls, 0)
})

test('strategy-symbol policy PUT returns 400 for invalid JSON without calling service', async () => {
    let calls = 0
    const app = createAppForTests({
        apiSecret: 'test-secret',
        putStrategySymbolPolicy: async () => {
            calls += 1
            return makeStrategySymbolPolicy()
        },
    })

    const response = await app.request('/api/strategy-symbol-policies/strategy-1/bitflyer%3ABTC_JPY', {
        method: 'PUT',
        headers: { Authorization: 'Bearer test-secret', 'content-type': 'application/json' },
        body: '{"sizing_mode":"WEBHOOK_CAPPED",',
    })

    assert.equal(response.status, 400)
    assert.equal((await response.json()).error.code, 'INVALID_REQUEST')
    assert.equal(calls, 0)
})

test('strategy-symbol policy PUT maps domain errors and unexpected errors', async () => {
    const cases: { error: Error; status: number; code: string }[] = [
        { error: new InvalidStrategySymbolPolicyError('bad policy'), status: 400, code: 'INVALID_REQUEST' },
        { error: new SymbolNotFoundError('bitflyer:BTC_JPY'), status: 404, code: 'SYMBOL_NOT_FOUND' },
        { error: new SymbolConstraintsRequiredError('bitflyer:BTC_JPY'), status: 409, code: 'SYMBOL_CONSTRAINTS_REQUIRED' },
        { error: new Error('firestore unavailable'), status: 500, code: 'INTERNAL_ERROR' },
    ]
    for (const { error, status, code } of cases) {
        const app = createAppForTests({
            apiSecret: 'test-secret',
            putStrategySymbolPolicy: async () => { throw error },
        })
        const response = await app.request('/api/strategy-symbol-policies/strategy-1/bitflyer%3ABTC_JPY', {
            method: 'PUT',
            headers: { Authorization: 'Bearer test-secret', 'content-type': 'application/json' },
            body: JSON.stringify({
                sizing_mode: 'WEBHOOK_CAPPED',
                enabled: true,
                max_abs_position: 1,
                no_flip: true,
            }),
        })
        assert.equal(response.status, status)
        assert.equal((await response.json()).error.code, code)
    }
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

test('GET /api/v2/orders は Saxo IFDOCO の内部復旧状態を公開しない', async () => {
    const app = createAppForTests({
        apiSecret: 'test-secret',
        listOrdersV2ByDateRange: async () => [
            makeOrderV2({
                id: 'recovered-ifdoco',
                broker: 'saxo',
                ticker: 'FxSpot:21',
                order_type: 'IFDOCO',
                saxo_ifdoco_recovery: {
                    status: 'COMPLETED',
                    attempt_count: 2,
                    last_attempt_at: new Date('2026-01-01T00:10:00Z'),
                    result_kind: 'SUCCESS',
                },
            }),
        ],
    })

    const res = await app.request('/api/v2/orders?from=2026-01-01&to=2026-01-02', {
        headers: { Authorization: 'Bearer test-secret' },
    })
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.equal(body.orders.length, 1)
    assert.equal('saxo_ifdoco_recovery' in body.orders[0], false)
    assert.equal(JSON.stringify(body).includes('result_kind'), false)
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

test('POST /api/webhooks/tradingview policy-backed WEBHOOK_CAPPED returns sizing approval without dispatch', async () => {
    const fixture = createSizingRouteFixture({
        getTradableSymbol: async () => makeTradableSymbol({
            order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
        }),
        getStrategySymbolPolicy: async () => makeSizingPolicy(),
        getStrategySymbolPosition: async () => makeStrategySymbolPosition(),
    })

    const res = await postWebhook(fixture.app, {
        ...makePayload('evt-sizing-capped-1'),
        strategy: 'alpha',
        size: 0.2,
    })
    const body = await res.json()

    assert.equal(res.status, 202)
    assert.equal(body.dispatch_status, 'sizing_approved')
    assert.equal(body.sizing_decision.kind, 'DISPATCH')
    assert.equal(body.sizing_decision.sizing_mode, 'WEBHOOK_CAPPED')
    assert.equal(body.sizing_decision.policy_version, 3)
    assert.equal(body.sizing_decision.input_size, 0.2)
    assert.equal(body.sizing_decision.effective_size, 0.2)
    assert.equal(body.sizing_decision.input_size_ignored, false)
    assert.equal(fixture.dispatchCalls.length, 1)
    assert.equal(fixture.dispatchCalls[0]?.size, 0.2)
    assert.equal(fixture.events[0]?.status, 'accepted')
    assert.equal(fixture.events[0]?.decision_kind, 'DISPATCH')
    assert.equal(fixture.events[0]?.effective_strategy_id, 'alpha')
})

test('POST /api/webhooks/tradingview rejects missing size for WEBHOOK_CAPPED after policy resolution', async () => {
    const fixture = createSizingRouteFixture({
        getTradableSymbol: async () => makeTradableSymbol({
            order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
        }),
        getStrategySymbolPolicy: async () => makeSizingPolicy(),
        getStrategySymbolPosition: async () => makeStrategySymbolPosition(),
    })

    const { size: _size, ...withoutSize } = makePayload('evt-sizing-required-1')
    const res = await postWebhook(fixture.app, { ...withoutSize, strategy: 'alpha' })
    const body = await res.json()

    assert.equal(res.status, 400)
    assert.equal(body.error.code, 'SIZE_REQUIRED')
    assert.equal(body.sizing_decision.reason, 'SIZE_REQUIRED')
    assert.equal(fixture.dispatchCalls.length, 0)
    assert.equal(fixture.events[0]?.status, 'rejected')
    assert.equal(fixture.events[0]?.rejection_reason, 'SIZE_REQUIRED')
})

test('POST /api/webhooks/tradingview policy-backed MANAGED ignores a valid input size', async () => {
    const fixture = createSizingRouteFixture({
        getTradableSymbol: async () => makeTradableSymbol({
            order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
        }),
        getStrategySymbolPolicy: async () => makeSizingPolicy({
            id: 'managed:bitflyer:BTC_JPY',
            strategy_id: 'managed',
            sizing_mode: 'MANAGED',
            base_order_size: 0.5,
            taper_strength: 0,
        }),
        getStrategySymbolPosition: async () => makeStrategySymbolPosition({
            id: 'managed:bitflyer:BTC_JPY',
            strategy_id: 'managed',
        }),
    })

    const res = await postWebhook(fixture.app, {
        ...makePayload('evt-sizing-managed-1'),
        strategy: 'managed',
        size: 99,
    })
    const body = await res.json()

    assert.equal(res.status, 202)
    assert.equal(body.dispatch_status, 'sizing_approved')
    assert.equal(body.sizing_decision.sizing_mode, 'MANAGED')
    assert.equal(body.sizing_decision.input_size, 99)
    assert.equal(body.sizing_decision.input_size_ignored, true)
    assert.equal(body.sizing_decision.effective_size, 0.5)
    assert.equal(fixture.dispatchCalls.length, 1)
    assert.equal(fixture.dispatchCalls[0]?.size, 0.5)
    assert.equal(fixture.events[0]?.input_size, 99)
    assert.equal(fixture.events[0]?.input_size_ignored, true)
})

test('POST /api/webhooks/tradingview policy-backed suppresses without dispatch or dispatch log', async () => {
    const fixture = createSizingRouteFixture({
        getTradableSymbol: async () => makeTradableSymbol({
            order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
        }),
        getStrategySymbolPolicy: async () => makeSizingPolicy({ enabled: false }),
        getStrategySymbolPosition: async () => makeStrategySymbolPosition(),
    })

    const res = await postWebhook(fixture.app, { ...makePayload('evt-sizing-suppress-1'), strategy: 'alpha' })
    const body = await res.json()

    assert.equal(res.status, 202)
    assert.equal(body.dispatch_status, 'suppressed')
    assert.equal(body.sizing_decision.reason, 'POLICY_DISABLED')
    assert.equal(fixture.dispatchCalls.length, 0)
    assert.equal(fixture.logs.length, 0)
})

test('POST /api/webhooks/tradingview policy fallback OFF rejects unregistered policy', async () => {
    const { dispatchOrder, calls: dispatchCalls } = createDispatchStub()
    const { createWebhookEvent, events } = createWebhookEventStub()
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        allowUnregisteredStrategyPolicyFallback: false,
        dispatchOrder,
        createWebhookEvent,
        getTradableSymbol: async () => makeTradableSymbol(),
        getStrategySymbolPolicy: async () => null,
    })

    const res = await postWebhook(app, { ...makePayload('evt-sizing-policy-missing-1'), strategy: 'alpha' })
    const body = await res.json()

    assert.equal(res.status, 400)
    assert.equal(body.error.code, 'POLICY_NOT_FOUND')
    assert.equal(body.sizing_decision.reason, 'POLICY_NOT_FOUND')
    assert.equal(dispatchCalls.length, 0)
    assert.equal(events[0]?.status, 'rejected')
})

test('POST /api/webhooks/tradingview resolves policy before treating a missing symbol as fallback', async () => {
    const policyCalls: { strategyId: string; symbolId: string }[] = []
    const fixture = createSizingRouteFixture({
        getTradableSymbol: async () => null,
        getStrategySymbolPolicy: async (strategyId, symbolId) => {
            policyCalls.push({ strategyId, symbolId })
            return makeSizingPolicy()
        },
    })

    const res = await postWebhook(fixture.app, { ...makePayload('evt-sizing-symbol-missing-policy-1'), strategy: 'alpha' })
    const body = await res.json()

    assert.equal(res.status, 400)
    assert.equal(body.error.code, 'SYMBOL_NOT_FOUND')
    assert.equal(body.sizing_decision.reason, 'SYMBOL_NOT_FOUND')
    assert.deepEqual(policyCalls, [
        { strategyId: 'alpha', symbolId: 'bitflyer:BTC_JPY' },
        { strategyId: 'alpha', symbolId: 'bitflyer:BTC_JPY' },
    ])
    assert.equal(fixture.dispatchCalls.length, 0)
    assert.equal(fixture.addedOrders.length, 0)
    assert.equal(fixture.logs.length, 0)
    assert.equal(fixture.events[0]?.status, 'rejected')
    assert.equal(fixture.events[0]?.rejection_reason, 'SYMBOL_NOT_FOUND')
})

test('POST /api/webhooks/tradingview allows fallback only after an explicit missing-policy result', async () => {
    const policyCalls: string[] = []
    const fixture = createSizingRouteFixture({
        getTradableSymbol: async () => null,
        getStrategySymbolPolicy: async (strategyId) => {
            policyCalls.push(strategyId)
            return null
        },
    })

    const res = await postWebhook(fixture.app, { ...makePayload('evt-sizing-symbol-missing-fallback-1'), strategy: 'alpha' })

    assert.equal(res.status, 202)
    assert.deepEqual(policyCalls, ['alpha'])
    assert.equal(fixture.dispatchCalls.length, 1)
    assert.equal(fixture.addedOrders.length, 1)
})

test('POST /api/webhooks/tradingview maps corrupt stored symbol constraints to INVALID_STORED_STATE', async () => {
    const fixture = createSizingRouteFixture({
        getTradableSymbol: async () => {
            throw new InvalidStoredTradableSymbolError('invalid order_constraints.quantity_step')
        },
    })

    const res = await postWebhook(fixture.app, { ...makePayload('evt-sizing-corrupt-symbol-1'), strategy: 'alpha' })
    const body = await res.json()

    assert.equal(res.status, 400)
    assert.equal(body.error.code, 'INVALID_STORED_STATE')
    assert.equal(body.sizing_decision.reason, 'INVALID_STORED_STATE')
    assert.equal(fixture.events[0]?.status, 'rejected')
    assert.equal(fixture.events[0]?.rejection_reason, 'INVALID_STORED_STATE')
    assert.equal(fixture.dispatchCalls.length, 0)
    assert.equal(fixture.addedOrders.length, 0)
})

test('POST /api/webhooks/tradingview keeps operational symbol read failures as 500', async () => {
    const fixture = createSizingRouteFixture({
        getTradableSymbol: async () => {
            throw new Error('firestore unavailable')
        },
    })

    const res = await postWebhook(fixture.app, { ...makePayload('evt-sizing-symbol-read-failure-1'), strategy: 'alpha' })

    assert.equal(res.status, 500)
    assert.deepEqual(await res.json(), {
        error: {
            code: 'INTERNAL_ERROR',
            message: 'failed to fetch symbol',
        },
    })
    assert.equal(fixture.events.length, 0)
    assert.equal(fixture.dispatchCalls.length, 0)
})

test('POST /api/webhooks/tradingview rejects a malformed symbol snapshot before fallback', async () => {
    const fixture = createSizingRouteFixture({
        getTradableSymbol: async () => ({
            ...makeTradableSymbol(),
            id: 'bitflyer:OTHER_JPY',
        } as TradableSymbol),
        getStrategySymbolPolicy: async () => {
            throw new Error('policy lookup must not run for malformed symbol snapshot')
        },
    })

    const res = await postWebhook(fixture.app, { ...makePayload('evt-sizing-malformed-symbol-snapshot-1'), strategy: 'alpha' })
    const body = await res.json()

    assert.equal(res.status, 400)
    assert.equal(body.error.code, 'INVALID_STORED_STATE')
    assert.equal(fixture.events[0]?.status, 'rejected')
    assert.equal(fixture.dispatchCalls.length, 0)
})

test('POST /api/webhooks/tradingview rejects a WEBHOOK_CAPPED size that is not step-aligned', async () => {
    const { logger, calls } = createLoggerStub()
    const fixture = createSizingRouteFixture({ logger })
    const res = await postWebhook(fixture.app, {
        ...makePayload('evt-sizing-step-invalid-1'),
        strategy: 'alpha',
        size: 0.15,
    })
    const body = await res.json()

    assert.equal(res.status, 400)
    assert.equal(body.error.code, 'INVALID_SIZE_INCREMENT')
    assert.equal(body.sizing_decision.reason, 'INVALID_SIZE_INCREMENT')
    assert.equal(fixture.events[0]?.status, 'rejected')
    assert.equal(fixture.dispatchCalls.length, 0)
    assert.equal(fixture.logs.length, 0)
    assert.equal(stringifyLogCalls(calls).includes('test-secret'), false)
})

for (const scenario of [
    {
        name: 'below minimum order size',
        payload: { size: 0.05 },
        symbol: { order_constraints: { quantity_step: 0.01, min_order_size: 0.1 } },
        policy: {},
        position: {},
        reason: 'BELOW_MIN_ORDER_SIZE',
    },
    {
        name: 'no remaining headroom at max position',
        payload: { size: 0.1 },
        symbol: { order_constraints: { quantity_step: 0.1, min_order_size: 0.1 } },
        policy: { max_abs_position: 1 },
        position: { confirmed_position: 1 },
        reason: 'MAX_POSITION',
    },
    {
        name: 'no flip below the minimum order size',
        payload: { size: 0.5, side: 'SELL' },
        symbol: { order_constraints: { quantity_step: 0.1, min_order_size: 0.1 } },
        policy: {},
        position: { confirmed_position: 0.05 },
        reason: 'NO_FLIP',
    },
    {
        name: 'position is not ready',
        payload: { size: 0.1 },
        symbol: { order_constraints: { quantity_step: 0.1, min_order_size: 0.1 } },
        policy: {},
        position: { status: 'MANUAL_REVIEW' as const },
        reason: 'POSITION_NOT_READY',
    },
] as const) {
    test(`POST /api/webhooks/tradingview suppresses sizing decision: ${scenario.name}`, async () => {
        const fixture = createSizingRouteFixture({
            getTradableSymbol: async () => makeTradableSymbol(scenario.symbol),
            getStrategySymbolPolicy: async () => makeSizingPolicy(scenario.policy),
            getStrategySymbolPosition: async () => makeStrategySymbolPosition(scenario.position),
        })

        const res = await postWebhook(fixture.app, {
            ...makePayload(`evt-sizing-suppress-${scenario.name}`),
            strategy: 'alpha',
            ...scenario.payload,
        })
        const body = await res.json()

        assert.equal(res.status, 202)
        assert.equal(body.dispatch_status, 'suppressed')
        assert.equal(body.sizing_decision.kind, 'SUPPRESS')
        assert.equal(body.sizing_decision.reason, scenario.reason)
        assert.equal(fixture.dispatchCalls.length, 0)
        assert.equal(fixture.addedOrders.length, 0)
        assert.equal(fixture.logs.length, 0)
        assert.equal(fixture.events[0]?.status, 'suppressed')
        assert.equal(fixture.events[0]?.rejection_reason, scenario.reason)
    })
}

test('POST /api/webhooks/tradingview gives strategy_id precedence over the legacy strategy field', async () => {
    const policyCalls: string[] = []
    const fixture = createSizingRouteFixture({
        getStrategySymbolPolicy: async (strategyId) => {
            policyCalls.push(strategyId)
            return makeSizingPolicy()
        },
    })

    const res = await postWebhook(fixture.app, {
        ...makePayload('evt-sizing-strategy-id-priority-1'),
        strategy: 'display name',
        strategy_id: 'alpha',
        size: 0.1,
    })
    const body = await res.json()

    assert.equal(res.status, 202)
    assert.equal(body.dispatch_status, 'sizing_approved')
    assert.deepEqual(policyCalls, ['alpha', 'alpha'])
    assert.equal(fixture.events[0]?.effective_strategy_id, 'alpha')
})

test('POST /api/webhooks/tradingview normalizes legacy strategy whitespace for policy identity', async () => {
    const policyCalls: string[] = []
    const policy = makeSizingPolicy({
        id: 'alpha_strategy_v2:bitflyer:BTC_JPY',
        strategy_id: 'alpha_strategy_v2',
    })
    const position = makeStrategySymbolPosition({
        id: 'alpha_strategy_v2:bitflyer:BTC_JPY',
        strategy_id: 'alpha_strategy_v2',
    })
    const fixture = createSizingRouteFixture({
        getStrategySymbolPolicy: async (strategyId) => {
            policyCalls.push(strategyId)
            return policy
        },
        getStrategySymbolPosition: async () => position,
    })

    const res = await postWebhook(fixture.app, {
        ...makePayload('evt-sizing-strategy-whitespace-1'),
        strategy: ' alpha   strategy_v2 ',
        size: 0.1,
    })

    assert.equal(res.status, 202)
    assert.deepEqual(policyCalls, ['alpha_strategy_v2', 'alpha_strategy_v2'])
    assert.equal(fixture.events[0]?.effective_strategy_id, 'alpha_strategy_v2')
})

test('POST /api/webhooks/tradingview uses unknown when strategy fields are absent', async () => {
    const policyCalls: string[] = []
    const fixture = createSizingRouteFixture({
        getTradableSymbol: async () => null,
        getStrategySymbolPolicy: async (strategyId) => {
            policyCalls.push(strategyId)
            return null
        },
    })
    const { strategy: _strategy, ...payloadWithoutStrategy } = {
        ...makePayload('evt-sizing-strategy-unknown-1'),
        strategy: 'alpha',
    }

    const res = await postWebhook(fixture.app, payloadWithoutStrategy)

    assert.equal(res.status, 202)
    assert.deepEqual(policyCalls, ['unknown'])
    assert.equal(fixture.dispatchCalls.length, 1)
    assert.equal(fixture.events[0]?.status, 'accepted')
})

test('POST /api/webhooks/tradingview invalid legacy strategy uses fallback only when enabled', async () => {
    const enabled = createSizingRouteFixture({
        getStrategySymbolPolicy: async () => {
            throw new Error('policy lookup must not run for invalid legacy identity')
        },
    })
    const enabledResponse = await postWebhook(enabled.app, {
        ...makePayload('evt-sizing-invalid-legacy-on-1'),
        strategy: 'legacy/id',
    })

    assert.equal(enabledResponse.status, 202)
    assert.equal(enabled.dispatchCalls.length, 1)

    const disabled = createSizingRouteFixture({
        allowUnregisteredStrategyPolicyFallback: false,
        getStrategySymbolPolicy: async () => {
            throw new Error('policy lookup must not run for invalid legacy identity')
        },
    })
    const disabledResponse = await postWebhook(disabled.app, {
        ...makePayload('evt-sizing-invalid-legacy-off-1'),
        strategy: 'legacy/id',
    })
    const disabledBody = await disabledResponse.json()

    assert.equal(disabledResponse.status, 400)
    assert.equal(disabledBody.error.code, 'INVALID_STRATEGY_ID')
    assert.equal(disabled.events[0]?.status, 'rejected')
    assert.equal(disabled.dispatchCalls.length, 0)
})

test('POST /api/webhooks/tradingview rejects an invalid explicit strategy_id without fallback', async () => {
    const fixture = createSizingRouteFixture({
        getStrategySymbolPolicy: async () => {
            throw new Error('policy lookup must not run for invalid explicit identity')
        },
    })

    const res = await postWebhook(fixture.app, {
        ...makePayload('evt-sizing-invalid-explicit-strategy-id-1'),
        strategy: 'alpha',
        strategy_id: 'alpha/id',
    })
    const body = await res.json()

    assert.equal(res.status, 400)
    assert.equal(body.error.code, 'INVALID_STRATEGY_ID')
    assert.equal(fixture.events[0]?.status, 'rejected')
    assert.equal(fixture.dispatchCalls.length, 0)
})

const managedRoutePolicy = makeSizingPolicy({
    id: 'managed:bitflyer:BTC_JPY',
    strategy_id: 'managed',
    sizing_mode: 'MANAGED',
    base_order_size: 0.5,
    taper_strength: 0,
})
const managedRoutePosition = makeStrategySymbolPosition({
    id: 'managed:bitflyer:BTC_JPY',
    strategy_id: 'managed',
})

test('POST /api/webhooks/tradingview allows MANAGED payloads without size', async () => {
    const fixture = createSizingRouteFixture({
        getStrategySymbolPolicy: async () => managedRoutePolicy,
        getStrategySymbolPosition: async () => managedRoutePosition,
    })
    const { size: _size, ...payloadWithoutSize } = makePayload('evt-sizing-managed-no-size-1')

    const res = await postWebhook(fixture.app, { ...payloadWithoutSize, strategy: 'managed' })
    const body = await res.json()

    assert.equal(res.status, 202)
    assert.equal(body.dispatch_status, 'sizing_approved')
    assert.equal(body.sizing_decision.kind, 'DISPATCH')
    assert.equal(body.sizing_decision.effective_size, 0.5)
    assert.equal(body.sizing_decision.input_size_ignored, false)
    assert.equal(fixture.dispatchCalls.length, 1)
    assert.equal(fixture.dispatchCalls[0]?.size, 0.5)
    assert.equal(fixture.addedOrders.length, 1)
})

for (const invalidSize of [0, -1]) {
    test(`POST /api/webhooks/tradingview rejects MANAGED non-positive size ${invalidSize}`, async () => {
        const fixture = createSizingRouteFixture({
            getStrategySymbolPolicy: async () => managedRoutePolicy,
            getStrategySymbolPosition: async () => managedRoutePosition,
        })

        const res = await postWebhook(fixture.app, {
            ...makePayload(`evt-sizing-managed-invalid-size-${invalidSize}`),
            strategy: 'managed',
            size: invalidSize,
        })
        const body = await res.json()

        assert.equal(res.status, 400)
        assert.equal(body.error.code, 'INVALID_SIZE')
        assert.equal(body.sizing_decision.reason, 'INVALID_SIZE')
        assert.equal(fixture.events[0]?.status, 'rejected')
        assert.equal(fixture.dispatchCalls.length, 0)
        assert.equal(fixture.addedOrders.length, 0)
    })
}

for (const [field, value] of [
    ['stop_loss', '1'] as const,
    ['take_profit', '1'] as const,
    ['stop_loss_pct', 1] as const,
    ['take_profit_pct', 1] as const,
]) {
    test(`POST /api/webhooks/tradingview rejects MANAGED attached order field ${field}`, async () => {
        const fixture = createSizingRouteFixture({
            getStrategySymbolPolicy: async () => managedRoutePolicy,
            getStrategySymbolPosition: async () => managedRoutePosition,
        })

        const res = await postWebhook(fixture.app, {
            ...makePayload(`evt-sizing-managed-attached-${field}`),
            strategy: 'managed',
            [field]: value,
        })
        const body = await res.json()

        assert.equal(res.status, 400)
        assert.equal(body.error.code, 'MANAGED_ATTACHED_ORDERS_UNSUPPORTED')
        assert.equal(body.sizing_decision.reason, 'MANAGED_ATTACHED_ORDERS_UNSUPPORTED')
        assert.equal(fixture.events[0]?.status, 'rejected')
        assert.equal(fixture.dispatchCalls.length, 0)
        assert.equal(fixture.addedOrders.length, 0)
    })
}

test('POST /api/webhooks/tradingview policy-backed DISPATCH propagates effective size and tracking fields', async () => {
    const fixture = createSizingRouteFixture()

    const res = await postWebhook(fixture.app, {
        ...makePayload('evt-sizing-side-effect-boundary-1'),
        strategy: 'alpha',
        size: 0.1,
    })
    const body = await res.json()

    assert.equal(res.status, 202)
    assert.equal(body.dispatch_status, 'sizing_approved')
    assert.equal(fixture.dispatchCalls.length, 1)
    assert.equal(fixture.dispatchCalls[0]?.size, 0.1)
    assert.equal(fixture.addedOrders.length, 1)
    assert.equal((fixture.addedOrders[0] as { requested_size?: number }).requested_size, 0.1)
    assert.equal(fixture.logs.length, 1)
    assert.equal(fixture.logs[0]?.size, 0.1)
    assert.equal(fixture.logs[0]?.effective_size, 0.1)
    assert.equal(fixture.logs[0]?.input_size, 0.1)
    assert.equal(fixture.logs[0]?.sizing_mode, 'WEBHOOK_CAPPED')
    assert.equal(fixture.logs[0]?.policy_version, 3)
    assert.equal(fixture.logs[0]?.position_before, 0)
    assert.equal(fixture.logs[0]?.position_after, 0.1)
})

test('POST /api/webhooks/tradingview policy-backed dry-run releases reservation without orders_v2', async () => {
    const eventId = 'evt-policy-dry-run'
    const outcomes: string[] = []
    const fixture = createSizingRouteFixture({
        dispatchOrder: async () => ({
            ok: true as const,
            broker: 'bitflyer' as const,
            providerOrderId: 'DRY_RUN',
        }),
        reserveStrategySymbolOrder: async () => makeDispatchReservationResult(eventId, 0.4, {
            audit: {
                sizingMode: 'WEBHOOK_CAPPED',
                policyVersion: 3,
                positionBefore: 0.1,
                positionAfter: 0.5,
            },
        }),
        applyStrategySymbolDispatchOutcome: async (input) => {
            outcomes.push(input.outcome)
            return {
                kind: 'UPDATED' as const,
                reservation: makeDispatchReservationResult(eventId, 0.4).reservation,
                position: makeStrategySymbolPosition({ pending_delta: 0 }),
            }
        },
    })

    const res = await postWebhook(fixture.app, {
        ...makePayload(eventId),
        strategy: 'alpha',
        size: 1,
        dry_run: true,
    })
    const body = await res.json()

    assert.equal(res.status, 202)
    assert.equal(body.dispatch_status, 'sizing_approved')
    assert.equal(fixture.dispatchCalls.length, 1)
    assert.equal(fixture.dispatchCalls[0]?.dryRun, true)
    assert.equal(fixture.dispatchCalls[0]?.size, 0.4)
    assert.equal(fixture.addedOrders.length, 0)
    assert.equal(fixture.logs.length, 1)
    assert.equal(fixture.logs[0]?.dry_run, true)
    assert.equal(fixture.logs[0]?.provider_order_id, 'DRY_RUN')
    assert.equal(fixture.logs[0]?.input_size, 1)
    assert.equal(fixture.logs[0]?.effective_size, 0.4)
    assert.equal(fixture.logs[0]?.size, 0.4)
    assert.equal(fixture.logs[0]?.sizing_mode, 'WEBHOOK_CAPPED')
    assert.equal(fixture.logs[0]?.policy_version, 3)
    assert.equal(fixture.logs[0]?.position_before, 0.1)
    assert.equal(fixture.logs[0]?.position_after, 0.5)
    assert.equal(fixture.logs[0]?.certainty, 'CONFIRMED_FAILURE')
    assert.equal(fixture.logs[0]?.result, 'success')
    assert.equal(fixture.logs[0]?.request_payload.dryRun, true)
    assert.equal(fixture.logs[0]?.response_payload?.dry_run, true)
    assert.deepEqual(outcomes, ['CONFIRMED_FAILURE'])
})

test('POST /api/webhooks/tradingview policy-backed dry-run releases on unknown dispatcher result', async () => {
    const eventId = 'evt-policy-dry-run-unknown'
    const outcomes: string[] = []
    const fixture = createSizingRouteFixture({
        dispatchOrder: async () => ({
            ok: false as const,
            broker: 'bitflyer',
            code: 'BROKER_REQUEST_FAILED' as const,
            message: 'dry-run validation result unavailable',
            certainty: 'UNKNOWN' as const,
        }),
        reserveStrategySymbolOrder: async () => makeDispatchReservationResult(eventId, 0.2),
        applyStrategySymbolDispatchOutcome: async (input) => {
            outcomes.push(input.outcome)
            return {
                kind: 'UPDATED' as const,
                reservation: makeDispatchReservationResult(eventId, 0.2).reservation,
                position: makeStrategySymbolPosition({ pending_delta: 0 }),
            }
        },
    })

    const res = await postWebhook(fixture.app, {
        ...makePayload(eventId),
        strategy: 'alpha',
        dry_run: true,
    })

    assert.equal(res.status, 202)
    assert.equal(fixture.dispatchCalls[0]?.dryRun, true)
    assert.equal(fixture.addedOrders.length, 0)
    assert.equal(fixture.logs[0]?.dry_run, true)
    assert.equal(fixture.logs[0]?.provider_order_id, 'DRY_RUN')
    assert.equal(fixture.logs[0]?.certainty, 'CONFIRMED_FAILURE')
    assert.equal(fixture.logs[0]?.result, 'failure')
    assert.deepEqual(outcomes, ['CONFIRMED_FAILURE'])
})

test('POST /api/webhooks/tradingview policy-backed dry-run release failure keeps reservation safely and returns 202', async () => {
    const eventId = 'evt-policy-dry-run-release-failure'
    const fixture = createSizingRouteFixture({
        dispatchOrder: async () => ({
            ok: true as const,
            broker: 'bitflyer' as const,
            providerOrderId: 'DRY_RUN',
        }),
        reserveStrategySymbolOrder: async () => makeDispatchReservationResult(eventId, 0.3),
        applyStrategySymbolDispatchOutcome: async () => ({
            kind: 'REJECT' as const,
            reason: 'INVALID_STORED_STATE' as const,
        }),
    })

    const res = await postWebhook(fixture.app, {
        ...makePayload(eventId),
        strategy: 'alpha',
        dry_run: true,
    })

    assert.equal(res.status, 202)
    assert.equal(fixture.addedOrders.length, 0)
    assert.equal(fixture.logs[0]?.dry_run, true)
    assert.equal(fixture.logs[0]?.provider_order_id, 'DRY_RUN')
    const releaseFailure = fixture.loggerCalls.find((call) => call.event === 'strategy_symbol_reservation:outcome_apply_failed')
    assert.equal(releaseFailure?.event_id, eventId)
    assert.equal(releaseFailure?.reservation_id, `reservation-${eventId}`)
    assert.equal(releaseFailure?.effective_size, 0.3)
    assert.equal(releaseFailure?.dry_run, true)
})

test('POST /api/webhooks/tradingview policy-backed capped dispatch uses only atomic effective size', async () => {
    const outcomes: string[] = []
    const reservation = {
        id: 'reservation-effective-size',
        event_id: 'evt-effective-size',
        position_id: 'alpha:bitflyer:BTC_JPY',
        strategy_id: 'alpha',
        symbol_id: 'bitflyer:BTC_JPY',
        order_id: 'evt-effective-size',
        reserved_delta: 0.4,
        status: 'RESERVED' as const,
        policy_version: 3,
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
    }
    const fixture = createSizingRouteFixture({
        reserveStrategySymbolOrder: async () => ({
            kind: 'DISPATCH' as const,
            reason: 'CALCULATED' as const,
            effectiveSize: 0.4,
            decision: {
                kind: 'DISPATCH' as const,
                reason: 'CALCULATED' as const,
                effectiveSize: 0.4,
                details: { appliedConstraints: ['MAX_POSITION'] as const },
            },
            audit: {
                sizingMode: 'WEBHOOK_CAPPED' as const,
                policyVersion: 3,
                positionBefore: 0.1,
                positionAfter: 0.5,
            },
            reservation,
            position: makeStrategySymbolPosition({ pending_delta: 0.4 }),
        }),
        applyStrategySymbolDispatchOutcome: async (input) => {
            outcomes.push(input.outcome)
            return {
                kind: 'UPDATED' as const,
                reservation,
                position: makeStrategySymbolPosition({ pending_delta: 0.4 }),
            }
        },
    })

    const res = await postWebhook(fixture.app, {
        ...makePayload('evt-effective-size'),
        strategy: 'alpha',
        size: 1,
    })
    assert.equal(res.status, 202)
    assert.equal(fixture.dispatchCalls[0]?.size, 0.4)
    assert.equal((fixture.addedOrders[0] as { requested_size?: number }).requested_size, 0.4)
    assert.equal(fixture.logs[0]?.input_size, 1)
    assert.equal(fixture.logs[0]?.effective_size, 0.4)
    assert.equal(fixture.logs[0]?.size, 0.4)
    assert.equal(fixture.logs[0]?.certainty, 'CONFIRMED_SUCCESS')
    assert.deepEqual(outcomes, ['CONFIRMED_SUCCESS'])
})

test('POST /api/webhooks/tradingview explicit broker failure releases atomic reservation', async () => {
    const outcomes: string[] = []
    const reservation = {
        id: 'reservation-failure',
        event_id: 'evt-explicit-failure',
        position_id: 'alpha:bitflyer:BTC_JPY',
        strategy_id: 'alpha',
        symbol_id: 'bitflyer:BTC_JPY',
        order_id: 'evt-explicit-failure',
        reserved_delta: 0.2,
        status: 'RESERVED' as const,
        policy_version: 3,
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
    }
    const fixture = createSizingRouteFixture({
        dispatchOrder: async () => ({
            ok: false as const,
            broker: 'bitflyer',
            code: 'BROKER_REQUEST_FAILED' as const,
            message: 'rejected',
            certainty: 'CONFIRMED_FAILURE' as const,
        }),
        reserveStrategySymbolOrder: async () => ({
            kind: 'DISPATCH' as const,
            reason: 'CALCULATED' as const,
            effectiveSize: 0.2,
            decision: {
                kind: 'DISPATCH' as const,
                reason: 'CALCULATED' as const,
                effectiveSize: 0.2,
                details: { appliedConstraints: [] },
            },
            audit: {
                sizingMode: 'WEBHOOK_CAPPED' as const,
                policyVersion: 3,
                positionBefore: 0,
                positionAfter: 0.2,
            },
            reservation,
            position: makeStrategySymbolPosition({ pending_delta: 0.2 }),
        }),
        applyStrategySymbolDispatchOutcome: async (input) => {
            outcomes.push(input.outcome)
            return { kind: 'UPDATED' as const, reservation, position: makeStrategySymbolPosition() }
        },
    })

    const res = await postWebhook(fixture.app, {
        ...makePayload('evt-explicit-failure'),
        strategy: 'alpha',
    })
    assert.equal(res.status, 202)
    assert.equal(fixture.addedOrders.length, 0)
    assert.equal(fixture.logs[0]?.certainty, 'CONFIRMED_FAILURE')
    assert.deepEqual(outcomes, ['CONFIRMED_FAILURE'])
})

test('POST /api/webhooks/tradingview broker exception retains reservation as UNKNOWN', async () => {
    const outcomes: string[] = []
    const reservation = {
        id: 'reservation-unknown',
        event_id: 'evt-unknown',
        position_id: 'alpha:bitflyer:BTC_JPY',
        strategy_id: 'alpha',
        symbol_id: 'bitflyer:BTC_JPY',
        order_id: 'evt-unknown',
        reserved_delta: 0.2,
        status: 'RESERVED' as const,
        policy_version: 3,
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
    }
    const fixture = createSizingRouteFixture({
        dispatchOrder: async () => { throw new Error('timeout') },
        reserveStrategySymbolOrder: async () => ({
            kind: 'DISPATCH' as const,
            reason: 'CALCULATED' as const,
            effectiveSize: 0.2,
            decision: {
                kind: 'DISPATCH' as const,
                reason: 'CALCULATED' as const,
                effectiveSize: 0.2,
                details: { appliedConstraints: [] },
            },
            audit: {
                sizingMode: 'WEBHOOK_CAPPED' as const,
                policyVersion: 3,
                positionBefore: 0,
                positionAfter: 0.2,
            },
            reservation,
            position: makeStrategySymbolPosition({ pending_delta: 0.2 }),
        }),
        applyStrategySymbolDispatchOutcome: async (input) => {
            outcomes.push(input.outcome)
            return { kind: 'UPDATED' as const, reservation, position: makeStrategySymbolPosition() }
        },
    })

    const res = await postWebhook(fixture.app, {
        ...makePayload('evt-unknown'),
        strategy: 'alpha',
    })
    assert.equal(res.status, 202)
    assert.equal(fixture.addedOrders.length, 0)
    assert.equal(fixture.logs[0]?.certainty, 'UNKNOWN')
    assert.deepEqual(outcomes, ['UNKNOWN'])
})

test('POST /api/webhooks/tradingview orders_v2 failure keeps provider id and marks UNKNOWN', async () => {
    const outcomes: string[] = []
    const reservation = {
        id: 'reservation-order-write',
        event_id: 'evt-order-write',
        position_id: 'alpha:bitflyer:BTC_JPY',
        strategy_id: 'alpha',
        symbol_id: 'bitflyer:BTC_JPY',
        order_id: 'evt-order-write',
        reserved_delta: 0.2,
        status: 'RESERVED' as const,
        policy_version: 3,
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
    }
    const fixture = createSizingRouteFixture({
        addOrderV2: async () => { throw new Error('orders_v2 unavailable') },
        reserveStrategySymbolOrder: async () => ({
            kind: 'DISPATCH' as const,
            reason: 'CALCULATED' as const,
            effectiveSize: 0.2,
            decision: {
                kind: 'DISPATCH' as const,
                reason: 'CALCULATED' as const,
                effectiveSize: 0.2,
                details: { appliedConstraints: [] },
            },
            audit: {
                sizingMode: 'WEBHOOK_CAPPED' as const,
                policyVersion: 3,
                positionBefore: 0,
                positionAfter: 0.2,
            },
            reservation,
            position: makeStrategySymbolPosition({ pending_delta: 0.2 }),
        }),
        applyStrategySymbolDispatchOutcome: async (input) => {
            outcomes.push(input.outcome)
            return { kind: 'UPDATED' as const, reservation, position: makeStrategySymbolPosition() }
        },
    })

    const res = await postWebhook(fixture.app, {
        ...makePayload('evt-order-write'),
        strategy: 'alpha',
    })
    assert.equal(res.status, 202)
    assert.equal(fixture.logs[0]?.provider_order_id, 'JRF-test-1')
    assert.equal(fixture.logs[0]?.certainty, 'UNKNOWN')
    assert.equal(fixture.logs[0]?.error_code, 'ORDERS_V2_WRITE_FAILED')
    assert.deepEqual(outcomes, ['UNKNOWN'])
})

test('POST /api/webhooks/tradingview event persistence failure does not dispatch and releases reservation', async () => {
    const outcomes: string[] = []
    const eventId = 'evt-event-write-failure'
    const fixture = createSizingRouteFixture({
        createWebhookEvent: async () => { throw new Error('webhook event unavailable') },
        reserveStrategySymbolOrder: async () => makeDispatchReservationResult(eventId, 0.2),
        applyStrategySymbolDispatchOutcome: async (input) => {
            outcomes.push(input.outcome)
            return {
                kind: 'UPDATED' as const,
                reservation: makeDispatchReservationResult(eventId, 0.2).reservation,
                position: makeStrategySymbolPosition(),
            }
        },
    })

    const res = await postWebhook(fixture.app, {
        ...makePayload(eventId),
        strategy: 'alpha',
    })
    assert.equal(res.status, 500)
    assert.equal(fixture.dispatchCalls.length, 0)
    assert.equal(fixture.logs.length, 0)
    assert.deepEqual(outcomes, ['CONFIRMED_FAILURE'])
})

test('POST /api/webhooks/tradingview policy duplicate does not redispatch or add pending twice', async () => {
    const eventId = 'evt-policy-duplicate'
    const firstReservation = makeDispatchReservationResult(eventId, 0.2)
    let reserveCalls = 0
    const outcomes: string[] = []
    const fixture = createSizingRouteFixture({
        reserveStrategySymbolOrder: async () => {
            reserveCalls += 1
            if (reserveCalls > 1) {
                return {
                    kind: 'SUPPRESS' as const,
                    reason: 'DUPLICATE_EVENT' as const,
                    reservation: firstReservation.reservation,
                    position: firstReservation.position,
                }
            }
            return firstReservation
        },
        applyStrategySymbolDispatchOutcome: async (input) => {
            outcomes.push(input.outcome)
            return {
                kind: 'UPDATED' as const,
                reservation: firstReservation.reservation,
                position: firstReservation.position,
            }
        },
    })

    const payload = { ...makePayload(eventId), strategy: 'alpha' }
    const firstResponse = await postWebhook(fixture.app, payload)
    const secondResponse = await postWebhook(fixture.app, payload)

    assert.equal(firstResponse.status, 202)
    assert.equal(secondResponse.status, 409)
    assert.equal(fixture.dispatchCalls.length, 1)
    assert.equal(fixture.addedOrders.length, 1)
    assert.equal(fixture.events.length, 1)
    assert.deepEqual(outcomes, ['CONFIRMED_SUCCESS'])
})

test('POST /api/webhooks/tradingview malformed broker success is UNKNOWN without orders_v2 write', async () => {
    const outcomes: string[] = []
    const eventId = 'evt-malformed-success'
    const fixture = createSizingRouteFixture({
        dispatchOrder: async () => ({
            ok: true as const,
            broker: 'bitflyer' as const,
            providerOrderId: '   ',
        }),
        reserveStrategySymbolOrder: async () => makeDispatchReservationResult(eventId, 0.2),
        applyStrategySymbolDispatchOutcome: async (input) => {
            outcomes.push(input.outcome)
            return {
                kind: 'UPDATED' as const,
                reservation: makeDispatchReservationResult(eventId, 0.2).reservation,
                position: makeStrategySymbolPosition(),
            }
        },
    })

    const res = await postWebhook(fixture.app, {
        ...makePayload(eventId),
        strategy: 'alpha',
    })
    assert.equal(res.status, 202)
    assert.equal(fixture.addedOrders.length, 0)
    assert.equal(fixture.logs[0]?.certainty, 'UNKNOWN')
    assert.equal(fixture.logs[0]?.error_code, 'BROKER_REQUEST_FAILED')
    assert.deepEqual(outcomes, ['UNKNOWN'])
})

test('POST /api/webhooks/tradingview dispatch log failure keeps 202 and preserves lifecycle outcome', async () => {
    const outcomes: string[] = []
    const eventId = 'evt-log-write-failure'
    const fixture = createSizingRouteFixture({
        createOrderDispatchLog: async () => { throw new Error('dispatch log unavailable') },
        reserveStrategySymbolOrder: async () => makeDispatchReservationResult(eventId, 0.2),
        applyStrategySymbolDispatchOutcome: async (input) => {
            outcomes.push(input.outcome)
            return {
                kind: 'UPDATED' as const,
                reservation: makeDispatchReservationResult(eventId, 0.2).reservation,
                position: makeStrategySymbolPosition(),
            }
        },
    })

    const res = await postWebhook(fixture.app, {
        ...makePayload(eventId),
        strategy: 'alpha',
    })
    assert.equal(res.status, 202)
    assert.deepEqual(outcomes, ['CONFIRMED_SUCCESS'])
    assert.equal(fixture.loggerCalls.some((call) => call.event === 'order_dispatch_log:write_failed'), true)
})

test('POST /api/webhooks/tradingview lifecycle update failure keeps 202 and logs recovery context', async () => {
    const eventId = 'evt-outcome-update-failure'
    const outcomes: string[] = []
    let applyCalls = 0
    const fixture = createSizingRouteFixture({
        reserveStrategySymbolOrder: async () => makeDispatchReservationResult(eventId, 0.2),
        applyStrategySymbolDispatchOutcome: async (input) => {
            outcomes.push(input.outcome)
            applyCalls += 1
            return applyCalls === 1
                ? {
                    kind: 'REJECT' as const,
                    reason: 'INVALID_STORED_STATE' as const,
                }
                : {
                    kind: 'UPDATED' as const,
                    reservation: makeDispatchReservationResult(eventId, 0.2).reservation,
                    position: makeStrategySymbolPosition(),
                }
        },
    })

    const res = await postWebhook(fixture.app, {
        ...makePayload(eventId),
        strategy: 'alpha',
    })
    assert.equal(res.status, 202)
    assert.equal(fixture.logs[0]?.certainty, 'CONFIRMED_SUCCESS')
    assert.equal(fixture.loggerCalls.some((call) => call.event === 'strategy_symbol_reservation:outcome_apply_failed'), true)
    assert.deepEqual(outcomes, ['CONFIRMED_SUCCESS', 'UNKNOWN'])
})

for (const scenario of [
    {
        name: 'missing constraints',
        symbol: makeTradableSymbol(),
        position: makeStrategySymbolPosition(),
        policy: undefined,
        reason: 'SYMBOL_CONSTRAINTS_REQUIRED',
    },
    {
        name: 'malformed constraints',
        symbol: makeTradableSymbol({ order_constraints: { quantity_step: 0, min_order_size: 0.1 } }),
        position: makeStrategySymbolPosition(),
        policy: undefined,
        reason: 'INVALID_STORED_STATE',
    },
    {
        name: 'missing position',
        symbol: makeTradableSymbol({ order_constraints: { quantity_step: 0.1, min_order_size: 0.1 } }),
        position: null,
        policy: undefined,
        reason: 'POSITION_NOT_FOUND',
    },
    {
        name: 'malformed position',
        symbol: makeTradableSymbol({ order_constraints: { quantity_step: 0.1, min_order_size: 0.1 } }),
        position: { ...makeStrategySymbolPosition(), confirmed_position: Number.NaN },
        policy: undefined,
        reason: 'INVALID_STORED_STATE',
    },
    {
        name: 'malformed policy',
        symbol: makeTradableSymbol({ order_constraints: { quantity_step: 0.1, min_order_size: 0.1 } }),
        position: makeStrategySymbolPosition(),
        policy: { ...makeSizingPolicy(), version: 0 },
        reason: 'INVALID_STORED_STATE',
    },
] as const) {
    test(`POST /api/webhooks/tradingview rejects ${scenario.name}`, async () => {
        const fixture = createSizingRouteFixture({
            getTradableSymbol: async () => scenario.symbol,
            getStrategySymbolPolicy: async () => scenario.policy ?? makeSizingPolicy(),
            getStrategySymbolPosition: async () => scenario.position,
        })

        const res = await postWebhook(fixture.app, {
            ...makePayload(`evt-sizing-state-${scenario.name}`),
            strategy: 'alpha',
        })
        const body = await res.json()

        assert.equal(res.status, 400)
        assert.equal(body.error.code, scenario.reason)
        assert.equal(body.sizing_decision.reason, scenario.reason)
        assert.equal(fixture.events[0]?.status, 'rejected')
        assert.equal(fixture.events[0]?.rejection_reason, scenario.reason)
        assert.equal(fixture.dispatchCalls.length, 0)
        assert.equal(fixture.addedOrders.length, 0)
        assert.equal(fixture.logs.length, 0)
    })
}

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
        certainty: 'UNKNOWN',
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
        certainty: 'UNKNOWN',
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
