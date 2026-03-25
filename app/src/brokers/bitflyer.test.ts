import assert from 'node:assert/strict'
import test from 'node:test'

import { BitflyerClient } from './bitflyer.js'

const makeOrder = () => ({
    eventId: 'evt-1',
    broker: 'bitflyer' as const,
    ticker: 'btc/jpy',
    side: 'BUY' as const,
    size: 0.01,
    requestId: 'req-1',
})

test('BitflyerClient returns not configured when credentials are missing', async () => {
    const client = new BitflyerClient({
        apiKey: undefined,
        apiSecret: undefined,
    })

    const result = await client.sendMarketOrder(makeOrder())

    assert.deepEqual(result, {
        ok: false,
        broker: 'bitflyer',
        code: 'BROKER_NOT_CONFIGURED',
        message: 'bitflyer api credentials are missing',
    })
})

test('BitflyerClient sends signed request and returns provider order id', async () => {
    let capturedUrl = ''
    let capturedHeaders: HeadersInit | undefined
    let capturedBody = ''

    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async (url, init) => {
            capturedUrl = String(url)
            capturedHeaders = init?.headers
            capturedBody = String(init?.body)

            return new Response(
                JSON.stringify({
                    child_order_acceptance_id: 'JRF-accepted-1',
                }),
                {
                    status: 200,
                    headers: {
                        'content-type': 'application/json',
                    },
                },
            )
        },
    })

    const result = await client.sendMarketOrder(makeOrder())

    assert.equal(capturedUrl, 'https://example.com/v1/me/sendchildorder')
    assert.equal(capturedBody, '{"product_code":"BTC_JPY","child_order_type":"MARKET","side":"BUY","size":0.01}')

    const headers = new Headers(capturedHeaders)
    assert.equal(headers.get('content-type'), 'application/json')
    assert.equal(headers.get('access-key'), 'test-key')
    assert.equal(headers.get('x-request-id'), 'req-1')
    assert.equal(typeof headers.get('access-timestamp'), 'string')
    assert.equal((headers.get('access-sign') ?? '').length > 0, true)

    assert.deepEqual(result, {
        ok: true,
        broker: 'bitflyer',
        providerOrderId: 'JRF-accepted-1',
    })
})

test('BitflyerClient returns failure when broker response is error', async () => {
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async () =>
            new Response(
                JSON.stringify({
                    error_message: 'invalid size',
                }),
                {
                    status: 400,
                    headers: {
                        'content-type': 'application/json',
                    },
                },
            ),
    })

    const result = await client.sendMarketOrder(makeOrder())

    assert.deepEqual(result, {
        ok: false,
        broker: 'bitflyer',
        code: 'BROKER_REQUEST_FAILED',
        message: 'invalid size',
    })
})
