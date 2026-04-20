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

test('BitflyerClient clamps order size to minimum 0.001', async () => {
    let capturedBody = ''

    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async (_url, init) => {
            capturedBody = String(init?.body)
            return new Response(
                JSON.stringify({ child_order_acceptance_id: 'JRF-accepted-1' }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    await client.sendMarketOrder({ ...makeOrder(), size: 0.0001 })

    const body = JSON.parse(capturedBody)
    assert.equal(body.size, 0.001)
})

test('BitflyerClient clamps order size to maximum 0.02', async () => {
    let capturedBody = ''

    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async (_url, init) => {
            capturedBody = String(init?.body)
            return new Response(
                JSON.stringify({ child_order_acceptance_id: 'JRF-accepted-1' }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    await client.sendMarketOrder({ ...makeOrder(), size: 1.0 })

    const body = JSON.parse(capturedBody)
    assert.equal(body.size, 0.02)
})

test('BitflyerClient.getBalances returns balances', async () => {
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async () =>
            new Response(
                JSON.stringify([
                    { currency_code: 'JPY', amount: 100, available: 100 },
                    { currency_code: 'BTC', amount: 0, available: 0 },
                ]),
                { status: 200 },
            ),
    })

    const result = await client.getBalances()
    assert.deepEqual(result, [
        { currency_code: 'JPY', amount: 100, available: 100 },
        { currency_code: 'BTC', amount: 0, available: 0 },
    ])
})

test('BitflyerClient.getCollateral returns collateral', async () => {
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async () =>
            new Response(
                JSON.stringify({ collateral: 50000, open_pnl: 100, keep_rate: 2.5 }),
                { status: 200 },
            ),
    })

    const result = await client.getCollateral()
    assert.deepEqual(result, { collateral: 50000, open_pnl: 100, keep_rate: 2.5 })
})

test('BitflyerClient uses IFD when stopLoss is provided with price', async () => {
    let capturedUrl = ''
    let capturedBody = ''

    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async (url, init) => {
            capturedUrl = String(url)
            capturedBody = String(init?.body)
            return new Response(
                JSON.stringify({ parent_order_acceptance_id: 'JRF-parent-1' }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.sendMarketOrder({
        ...makeOrder(),
        price: 1000000,
        stopLoss: '1%',
    })

    assert.equal(capturedUrl, 'https://example.com/v1/me/sendparentorder')
    const body = JSON.parse(capturedBody)
    assert.equal(body.order_method, 'IFD')
    assert.equal(body.parameters.length, 2)
    assert.equal(body.parameters[0].condition_type, 'MARKET')
    assert.equal(body.parameters[1].condition_type, 'STOP')
    assert.equal(body.parameters[1].trigger_price, 990000)

    assert.deepEqual(result, {
        ok: true,
        broker: 'bitflyer',
        providerOrderId: 'JRF-parent-1',
    })
})

test('BitflyerClient uses IFDOCO when stopLoss and takeProfit are provided with price', async () => {
    let capturedUrl = ''
    let capturedBody = ''

    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async (url, init) => {
            capturedUrl = String(url)
            capturedBody = String(init?.body)
            return new Response(
                JSON.stringify({ parent_order_acceptance_id: 'JRF-parent-2' }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.sendMarketOrder({
        ...makeOrder(),
        side: 'SELL',
        price: 1000000,
        stopLoss: '1%',
        takeProfit: '2%',
    })

    assert.equal(capturedUrl, 'https://example.com/v1/me/sendparentorder')
    const body = JSON.parse(capturedBody)
    assert.equal(body.order_method, 'IFDOCO')
    assert.equal(body.parameters.length, 3)
    assert.equal(body.parameters[0].condition_type, 'MARKET')
    assert.equal(body.parameters[1].condition_type, 'STOP')
    assert.equal(body.parameters[1].trigger_price, 1010000) // stop loss for SELL
    assert.equal(body.parameters[2].condition_type, 'LIMIT')
    assert.equal(body.parameters[2].price, 980000) // take profit for SELL

    assert.deepEqual(result, {
        ok: true,
        broker: 'bitflyer',
        providerOrderId: 'JRF-parent-2',
    })
})

test('BitflyerClient.getExecutionPrice returns null for DRY_RUN', async () => {
    const client = new BitflyerClient({ apiKey: 'test-key', apiSecret: 'test-secret' })
    const result = await client.getExecutionPrice('DRY_RUN')
    assert.equal(result, null)
})

test('BitflyerClient.getExecutionPrice returns weighted average price for child order', async () => {
    const capturedUrls: string[] = []

    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            capturedUrls.push(String(url))
            return new Response(
                JSON.stringify([
                    { child_order_acceptance_id: 'JRF-child-1', price: 10000000, size: 0.01 },
                    { child_order_acceptance_id: 'JRF-child-1', price: 10100000, size: 0.01 },
                ]),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.getExecutionPrice('JRF-child-1')

    assert.ok(capturedUrls[0]?.includes('getexecutions'))
    assert.ok(capturedUrls[0]?.includes('JRF-child-1'))
    assert.equal(result, 10050000) // (10000000 * 0.01 + 10100000 * 0.01) / 0.02
})

test('BitflyerClient.getExecutionPrice falls back to parent order lookup when no executions found', async () => {
    let callCount = 0

    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            callCount++
            const urlStr = String(url)

            if (callCount === 1) {
                // 1st: getexecutions?child_order_acceptance_id=JRF-parent-1 → empty
                assert.ok(urlStr.includes('getexecutions'))
                return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
            }
            if (callCount === 2) {
                // 2nd: getchildorders?parent_order_acceptance_id=JRF-parent-1
                assert.ok(urlStr.includes('getchildorders'))
                return new Response(
                    JSON.stringify([{ child_order_acceptance_id: 'JRF-child-entry', child_order_state: 'COMPLETED' }]),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            // 3rd: getexecutions?child_order_acceptance_id=JRF-child-entry
            assert.ok(urlStr.includes('getexecutions'))
            return new Response(
                JSON.stringify([{ child_order_acceptance_id: 'JRF-child-entry', price: 9500000, size: 0.01 }]),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.getExecutionPrice('JRF-parent-1')
    assert.equal(result, 9500000)
    assert.equal(callCount, 3)
})

test('BitflyerClient.getExecutionPrice returns null on API error', async () => {
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async () => new Response('server error', { status: 500 }),
    })

    const result = await client.getExecutionPrice('JRF-child-1')
    assert.equal(result, null)
})
