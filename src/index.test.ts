import test from 'node:test'
import assert from 'node:assert/strict'

import { createApp } from './index.js'

const captureConsole = <T>(method: 'info' | 'warn', run: () => T | Promise<T>) => {
    const original = console[method]
    const calls: unknown[][] = []

    console[method] = (...args: unknown[]) => {
        calls.push(args)
    }

    return Promise.resolve(run())
        .then((result) => ({ result, calls }))
        .finally(() => {
            console[method] = original
        })
}

const getLogEntry = (call: unknown[] | undefined) => {
    const candidate = call?.[0]
    return typeof candidate === 'string'
        ? (JSON.parse(candidate) as Record<string, unknown>)
        : undefined
}

const makePayload = (eventId: string, webhookSecret = 'test-secret') => ({
    event_id: eventId,
    occurred_at: 1773837296000,
    symbol: 'BTC_JPY',
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

test('GET /api/health returns 200', async () => {
    const app = createApp({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
    })

    const res = await app.request('/api/health')
    assert.equal(res.status, 200)
    assert.deepEqual(await res.json(), { status: 'ok' })
})

test('POST /api/webhooks/tradingview returns 202 on valid payload', async () => {
    const app = createApp({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
    })

    const payload = makePayload('evt-accepted-1')
    const { result: res, calls } = await captureConsole('info', () => postWebhook(app, payload))
    const body = await res.json()

    assert.equal(res.status, 202)
    assert.deepEqual(body, {
        status: 'accepted',
        event_id: 'evt-accepted-1',
    })

    const receivedLog = getLogEntry(calls[0])

    assert.equal(res.headers.get('x-request-id'), receivedLog?.request_id)
    assert.equal(receivedLog?.event, 'webhook:received')
    assert.deepEqual(receivedLog, {
        event: 'webhook:received',
        request_id: receivedLog?.request_id,
        sourceIp: '52.89.214.238',
        contentType: 'application/json',
        payload: {
            ...payload,
            webhook_secret: '[REDACTED]',
        },
        logged_at: receivedLog?.logged_at,
    })
})

test('POST /api/webhooks/tradingview returns 400 on validation error', async () => {
    const app = createApp({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
    })

    const invalidPayload = {
        ...makePayload('evt-invalid-1'),
        occurred_at: 'bad-date-ms',
    }

    const { result: res, calls } = await captureConsole('warn', () => postWebhook(app, invalidPayload))
    const body = await res.json()

    assert.equal(res.status, 400)
    assert.equal(body.error.code, 'INVALID_REQUEST')
    const rejectedLog = getLogEntry(calls[0])

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
    const app = createApp({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
    })

    const payload = makePayload('evt-unauth-1', 'wrong-secret')
    const { result: res, calls } = await captureConsole('warn', () => postWebhook(app, payload))
    const body = await res.json()
    const rejectedLog = getLogEntry(calls[0])

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
    const app = createApp({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
    })

    const payload = makePayload('evt-request-id-1')
    const { result: res, calls } = await captureConsole('info', () =>
        app.request('/api/webhooks/tradingview', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-forwarded-for': '52.89.214.238',
                'x-request-id': 'req-test-123',
            },
            body: JSON.stringify(payload),
        }),
    )

    const receivedLog = getLogEntry(calls[0])

    assert.equal(res.status, 202)
    assert.equal(res.headers.get('x-request-id'), 'req-test-123')
    assert.equal(receivedLog?.request_id, 'req-test-123')
})

test('POST /api/webhooks/tradingview returns 401 on invalid secret', async () => {
    const app = createApp({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
    })

    const res = await postWebhook(app, makePayload('evt-unauth-1', 'wrong-secret'))
    const body = await res.json()

    assert.equal(res.status, 401)
    assert.equal(body.error.code, 'INVALID_WEBHOOK_SECRET')
})

test('POST /api/webhooks/tradingview returns 403 on forbidden source ip', async () => {
    const app = createApp({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
    })

    const res = await postWebhook(app, makePayload('evt-forbidden-1'), '1.1.1.1')
    const body = await res.json()

    assert.equal(res.status, 403)
    assert.equal(body.error.code, 'FORBIDDEN_SOURCE_IP')
})

test('POST /api/webhooks/tradingview returns 409 on duplicate event_id', async () => {
    const app = createApp({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
    })

    const first = await postWebhook(app, makePayload('evt-dup-1'))
    const second = await postWebhook(app, makePayload('evt-dup-1'))
    const body = await second.json()

    assert.equal(first.status, 202)
    assert.equal(second.status, 409)
    assert.equal(body.error.code, 'DUPLICATED_EVENT')
})
