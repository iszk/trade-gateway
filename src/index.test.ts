import test from 'node:test'
import assert from 'node:assert/strict'

import { createApp } from './index.js'

const makePayload = (eventId: string, webhookSecret = 'test-secret') => ({
    event_id: eventId,
    occurred_at: '2026-03-18T12:34:56Z',
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

    const res = await postWebhook(app, makePayload('evt-accepted-1'))
    const body = await res.json()

    assert.equal(res.status, 202)
    assert.deepEqual(body, {
        status: 'accepted',
        event_id: 'evt-accepted-1',
    })
})

test('POST /api/webhooks/tradingview returns 400 on validation error', async () => {
    const app = createApp({
        webhookSecret: 'test-secret',
        sourceIpAllowlist: new Set(['52.89.214.238']),
    })

    const invalidPayload = {
        ...makePayload('evt-invalid-1'),
        occurred_at: 'bad-date',
    }

    const res = await postWebhook(app, invalidPayload)
    const body = await res.json()

    assert.equal(res.status, 400)
    assert.equal(body.error.code, 'INVALID_REQUEST')
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
