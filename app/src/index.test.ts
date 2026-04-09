import test from 'node:test'
import assert from 'node:assert/strict'

import { createApp } from './index.js'
import type { DispatchOrderFn, BrokerName } from './types/order.js'
import type { BrokerBalance } from './types/balance.js'
import type { Position } from './types/position.js'
import { DuplicateEventError } from './services/webhook-events.js'
import type { CreateWebhookEventFn } from './services/webhook-events.js'

const createLoggerStub = () => {
    const calls: Record<string, unknown>[] = []
    const logger = {
        info: (obj: Record<string, unknown>) => calls.push(obj),
        warn: (obj: Record<string, unknown>) => calls.push(obj),
        child: (_bindings: Record<string, unknown>) => logger,
    }
    return { logger, calls }
}

const createBalanceFetcherStub = (balances: BrokerBalance[] = []) => ({
    fetchAllBalances: async () => balances,
})

const createPositionFetcherStub = (positions: Position[] = []) => ({
    fetchAllPositions: async (_broker?: BrokerName) => positions,
})

const createAppForTests = (options: Parameters<typeof createApp>[0] = {}) =>
    createApp({
        balanceFetcher: createBalanceFetcherStub(),
        positionFetcher: createPositionFetcherStub(),
        ...options,
    })

const makePayload = (eventId: string, webhookSecret = 'test-secret') => ({
    event_id: eventId,
    occurred_at: 1773837296000,
    ticker: 'BTC_JPY',
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

const createWebhookEventStub = (): { createWebhookEvent: CreateWebhookEventFn; seen: Set<string> } => {
    const seen = new Set<string>()
    const createWebhookEvent: CreateWebhookEventFn = async (data) => {
        if (seen.has(data.event_id)) {
            throw new DuplicateEventError(data.event_id)
        }
        seen.add(data.event_id)
    }
    return { createWebhookEvent, seen }
}

test('GET /api/health returns 200', async () => {
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
    })

    const res = await app.request('/api/health')
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { status: 'ok' })
})

test('GET /api/balances rejects requests without the shared key', async () => {
    const app = createAppForTests({
        apiSecret: 'test-secret',
    })

    const res = await app.request('/api/balances')
    const body = await res.json()

    assert.equal(res.status, 401)
    assert.equal(body.error.code, 'UNAUTHORIZED')
})

test('GET /api/balances returns balances when the shared key matches', async () => {
    const sampleBalances: BrokerBalance[] = [
        {
            broker: 'bitflyer',
            balances: [
                { asset: 'BTC', amount: 0.5 },
            ],
            updatedAt: 123,
        },
    ]

    const app = createAppForTests({
        apiSecret: 'test-secret',
        balanceFetcher: createBalanceFetcherStub(sampleBalances),
    })

    const res = await app.request('/api/balances', {
        headers: {
            Authorization: 'Bearer test-secret',
        },
    })
    const body = await res.json()

    assert.equal(res.status, 200)
    assert.deepEqual(body.balances, sampleBalances)
    assert.equal(typeof body.updated_at, 'number')
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
        broker: 'auto',
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

test('POST /api/webhooks/tradingview returns 400 on validation error', async () => {
    const { logger, calls } = createLoggerStub()
    const app = createAppForTests({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
        logger,
    })

    const invalidPayload = {
        ...makePayload('evt-invalid-1'),
        occurred_at: 'bad-date-ms',
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
    assert.deepEqual(rejectedLog?.error, {
        code: 'INVALID_REQUEST',
        message: 'occurred_at: Invalid input: expected number, received NaN',
    })
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
