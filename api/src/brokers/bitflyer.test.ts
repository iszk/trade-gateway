import assert from 'node:assert/strict'
import test from 'node:test'

import { BitflyerClient } from './bitflyer.js'
import type { OrderV2 } from '../types/order-v2.js'

const makeOrder = () => ({
    eventId: 'evt-1',
    broker: 'bitflyer' as const,
    ticker: 'BTC_JPY',
    side: 'BUY' as const,
    size: 0.01,
    requestId: 'req-1',
})

const createCapturingLogger = () => {
    const warnLogs: Array<{ obj: Record<string, unknown>, msg?: string }> = []

    const logger = {
        info: () => undefined,
        warn: (obj: Record<string, unknown>, msg?: string) => {
            warnLogs.push({ obj, msg })
        },
        error: () => undefined,
        child: () => logger,
    }

    return { logger, warnLogs }
}

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
        certainty: 'CONFIRMED_FAILURE',
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
        certainty: 'CONFIRMED_FAILURE',
    })
})

test('BitflyerClient classifies HTTP 408 as UNKNOWN', async () => {
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async () => new Response('request timeout', { status: 408 }),
    })

    const result = await client.sendMarketOrder(makeOrder())

    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.certainty, 'UNKNOWN')
})

test('BitflyerClient classifies 5xx and transport failures as UNKNOWN', async () => {
    const serverErrorClient = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async () => new Response('temporary', { status: 503 }),
    })
    const serverError = await serverErrorClient.sendMarketOrder(makeOrder())
    assert.equal(serverError.ok, false)
    assert.equal(!serverError.ok && serverError.certainty, 'UNKNOWN')

    const transportErrorClient = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async () => { throw new Error('socket timeout') },
    })
    const transportError = await transportErrorClient.sendMarketOrder(makeOrder())
    assert.equal(transportError.ok, false)
    assert.equal(!transportError.ok && transportError.certainty, 'UNKNOWN')
})

test('BitflyerClient classifies a missing acceptance id as UNKNOWN', async () => {
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async () => Response.json({}, { status: 200 }),
    })

    const result = await client.sendMarketOrder(makeOrder())
    assert.equal(result.ok, false)
    assert.equal(!result.ok && result.certainty, 'UNKNOWN')
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

test('BitflyerClient.getPositions fetches each requested product code', async () => {
    const capturedUrls: string[] = []
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            const requestUrl = String(url)
            capturedUrls.push(requestUrl)
            const productCode = new URL(requestUrl).searchParams.get('product_code')
            return new Response(
                JSON.stringify([
                    {
                        product_code: productCode,
                        side: 'BUY',
                        price: 10000000,
                        size: 0.01,
                        commission: 0,
                        swap_point_accumulated: 0,
                        require_collateral: 0,
                        open_date: '2026-01-01T00:00:00Z',
                        leverage: 2,
                        pnl: 100,
                        sfd: 0,
                    },
                ]),
                { status: 200 },
            )
        },
    })

    const result = await client.getPositions(['FX_BTC_JPY', 'BTC_JPY'])

    assert.equal(capturedUrls.length, 2)
    assert.ok(capturedUrls[0]?.includes('/v1/me/getpositions?product_code=FX_BTC_JPY'))
    assert.ok(capturedUrls[1]?.includes('/v1/me/getpositions?product_code=BTC_JPY'))
    assert.deepEqual(result.map((position) => position.ticker), ['FX_BTC_JPY', 'BTC_JPY'])
})

test('BitflyerClient.getPositionsStrict propagates a partial ticker failure', async () => {
    let requestCount = 0
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async () => {
            requestCount += 1
            if (requestCount === 2) return new Response('temporary failure', { status: 503 })
            return new Response(JSON.stringify([]), { status: 200 })
        },
    })

    await assert.rejects(
        client.getPositionsStrict(['FX_BTC_JPY', 'BTC_JPY']),
        /503/,
    )
    assert.equal(requestCount, 2)
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
        brokerOrderMetadata: {
            kind: 'bitflyer_parent_order_v1',
            parent_order_acceptance_id: 'JRF-parent-1',
            order_method: 'IFD',
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
                        trigger_price: 990000,
                    },
                    resolved: {
                        acceptance_id: null,
                    },
                },
            ],
        },
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
        brokerOrderMetadata: {
            kind: 'bitflyer_parent_order_v1',
            parent_order_acceptance_id: 'JRF-parent-2',
            order_method: 'IFDOCO',
            entry: {
                expected: {
                    role: 'ENTRY',
                    side: 'SELL',
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
                        side: 'BUY',
                        condition_type: 'STOP',
                        size: 0.01,
                        trigger_price: 1010000,
                    },
                    resolved: {
                        acceptance_id: null,
                    },
                },
                {
                    expected: {
                        role: 'TAKE_PROFIT',
                        side: 'BUY',
                        condition_type: 'LIMIT',
                        size: 0.01,
                        price: 980000,
                    },
                    resolved: {
                        acceptance_id: null,
                    },
                },
            ],
        },
    })
})

test('BitflyerClient uses IFD with LIMIT when only takeProfit is provided with price', async () => {
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
                JSON.stringify({ parent_order_acceptance_id: 'JRF-parent-3' }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.sendMarketOrder({
        ...makeOrder(),
        price: 1000000,
        takeProfit: '2%',
    })

    assert.equal(capturedUrl, 'https://example.com/v1/me/sendparentorder')
    const body = JSON.parse(capturedBody)
    assert.equal(body.order_method, 'IFD')
    assert.equal(body.parameters.length, 2)
    assert.equal(body.parameters[0].condition_type, 'MARKET')
    assert.equal(body.parameters[1].condition_type, 'LIMIT')
    assert.equal(body.parameters[1].price, 1020000) // take profit for BUY: ceil(1000000 * 1.02)
    assert.equal(body.parameters[1].side, 'SELL')

    assert.deepEqual(result, {
        ok: true,
        broker: 'bitflyer',
        providerOrderId: 'JRF-parent-3',
        brokerOrderMetadata: {
            kind: 'bitflyer_parent_order_v1',
            parent_order_acceptance_id: 'JRF-parent-3',
            order_method: 'IFD',
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
                        role: 'TAKE_PROFIT',
                        side: 'SELL',
                        condition_type: 'LIMIT',
                        size: 0.01,
                        price: 1020000,
                    },
                    resolved: {
                        acceptance_id: null,
                    },
                },
            ],
        },
    })
})

test('BitflyerClient.getExecutionPriceForOrderV2 resolves entry acceptance id from metadata and returns updated metadata', async () => {
    const order: OrderV2 = {
        id: 'v2-entry-meta',
        strategy: 'MA',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 0.01,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['JRF-parent-entry-meta'],
        broker_order_metadata: {
            kind: 'bitflyer_parent_order_v1',
            parent_order_acceptance_id: 'JRF-parent-entry-meta',
            order_method: 'IFDOCO',
            entry: {
                expected: { role: 'ENTRY', side: 'BUY', condition_type: 'MARKET', size: 0.01 },
                resolved: { acceptance_id: null },
            },
            exits: [
                {
                    expected: { role: 'STOP_LOSS', side: 'SELL', condition_type: 'STOP', size: 0.01, trigger_price: 9500000 },
                    resolved: { acceptance_id: null },
                },
            ],
        },
        created_at: new Date(),
        updated_at: new Date(),
    }

    let callCount = 0
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            callCount++
            const urlStr = String(url)

            if (callCount === 1) {
                assert.ok(urlStr.includes('getparentorder'))
                return new Response(
                    JSON.stringify({ parent_order_id: 'JCO-parent-entry-meta', parent_order_acceptance_id: 'JRF-parent-entry-meta' }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            if (callCount === 2) {
                assert.ok(urlStr.includes('getchildorders'))
                return new Response(
                    JSON.stringify([
                        { child_order_acceptance_id: 'JRF-child-entry-meta', child_order_state: 'COMPLETED', child_order_type: 'MARKET', side: 'BUY', size: 0.01 },
                        { child_order_acceptance_id: 'JRF-child-stop-meta', child_order_state: 'ACTIVE', child_order_type: 'STOP', side: 'SELL', size: 0.01, trigger_price: 9500000 },
                    ]),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }

            assert.ok(urlStr.includes('getexecutions'))
            assert.equal(new URL(urlStr).searchParams.get('child_order_acceptance_id'), null)
            assert.equal(new URL(urlStr).searchParams.get('product_code'), 'BTC_JPY')
            return new Response(
                JSON.stringify([
                    { id: 101, child_order_acceptance_id: 'JRF-child-entry-meta', price: 9700000, size: 0.01, exec_date: '2026-01-01T00:05:00.000Z' },
                    { id: 100, child_order_acceptance_id: 'JRF-other-entry-meta', price: 9900000, size: 0.01, exec_date: '2026-01-01T00:06:00.000Z' },
                ]),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.getExecutionPriceForOrderV2(order)

    assert.deepEqual(result.execution, { price: 9700000, size: 0.01, executed_at: new Date('2026-01-01T00:05:00.000Z') })
    assert.deepEqual(result.brokerOrderMetadata?.entry.resolved, { acceptance_id: 'JRF-child-entry-meta' })
    assert.deepEqual(result.brokerOrderMetadata?.exits[0]?.resolved, { acceptance_id: 'JRF-child-stop-meta' })
})

test('BitflyerClient.getExecutionPriceForOrderV2 returns null when resolved entry has no executions', async () => {
    const order: OrderV2 = {
        id: 'v2-entry-no-execution',
        strategy: 'MA',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 0.01,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['JRF-parent-entry-no-execution'],
        broker_order_metadata: {
            kind: 'bitflyer_parent_order_v1',
            parent_order_acceptance_id: 'JRF-parent-entry-no-execution',
            order_method: 'IFDOCO',
            entry: {
                expected: { role: 'ENTRY', side: 'BUY', condition_type: 'MARKET', size: 0.01 },
                resolved: { acceptance_id: 'JRF-child-entry-no-execution' },
            },
            exits: [],
        },
        created_at: new Date(),
        updated_at: new Date(),
    }

    const requestedUrls: string[] = []
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            requestedUrls.push(String(url))
            return new Response(
                JSON.stringify([]),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.getExecutionPriceForOrderV2(order)

    assert.equal(result.execution, null)
    assert.deepEqual(result.brokerOrderMetadata, order.broker_order_metadata)
    assert.equal(requestedUrls.length, 2)
    assert.equal(new URL(requestedUrls[0] ?? '').searchParams.get('child_order_acceptance_id'), null)
    assert.equal(new URL(requestedUrls[0] ?? '').searchParams.get('product_code'), 'BTC_JPY')
    assert.equal(new URL(requestedUrls[1] ?? '').searchParams.get('child_order_acceptance_id'), 'JRF-child-entry-no-execution')
})

test('BitflyerClient.getExecutionPriceForOrderV2 reuses product execution batch cache', async () => {
    const makePendingOrder = (id: string, acceptanceId: string): OrderV2 => ({
        id,
        strategy: 'MA',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 0.01,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: [`JRF-parent-${id}`],
        broker_order_metadata: {
            kind: 'bitflyer_parent_order_v1',
            parent_order_acceptance_id: `JRF-parent-${id}`,
            order_method: 'IFDOCO',
            entry: {
                expected: { role: 'ENTRY', side: 'BUY', condition_type: 'MARKET', size: 0.01 },
                resolved: { acceptance_id: acceptanceId },
            },
            exits: [],
        },
        created_at: new Date(),
        updated_at: new Date(),
    })

    const requestedUrls: string[] = []
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            requestedUrls.push(String(url))
            return new Response(
                JSON.stringify([
                    { id: 502, child_order_acceptance_id: 'JRF-child-cache-1', price: 9700000, size: 0.01, exec_date: '2026-01-01T00:05:00.000Z' },
                    { id: 501, child_order_acceptance_id: 'JRF-child-cache-2', price: 9800000, size: 0.01, exec_date: '2026-01-01T00:06:00.000Z' },
                ]),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result1 = await client.getExecutionPriceForOrderV2(makePendingOrder('cache-1', 'JRF-child-cache-1'))
    const result2 = await client.getExecutionPriceForOrderV2(makePendingOrder('cache-2', 'JRF-child-cache-2'))

    assert.equal(requestedUrls.length, 1)
    assert.equal(new URL(requestedUrls[0] ?? '').searchParams.get('child_order_acceptance_id'), null)
    assert.equal(result1.execution?.price, 9700000)
    assert.equal(result2.execution?.price, 9800000)
})

test('BitflyerClient.getExecutionPriceForOrderV2 skips batch lookup for stale orders', async () => {
    const order: OrderV2 = {
        id: 'v2-entry-stale',
        strategy: 'MA',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 0.01,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['JRF-parent-stale'],
        broker_order_metadata: {
            kind: 'bitflyer_parent_order_v1',
            parent_order_acceptance_id: 'JRF-parent-stale',
            order_method: 'IFDOCO',
            entry: {
                expected: { role: 'ENTRY', side: 'BUY', condition_type: 'MARKET', size: 0.01 },
                resolved: { acceptance_id: 'JRF-child-stale' },
            },
            exits: [],
        },
        created_at: new Date(Date.now() - 25 * 60 * 60 * 1000),
        updated_at: new Date(),
    }

    const requestedUrls: string[] = []
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            const urlStr = String(url)
            requestedUrls.push(urlStr)
            const params = new URL(urlStr).searchParams
            assert.equal(params.get('child_order_acceptance_id'), 'JRF-child-stale')
            return new Response(
                JSON.stringify([
                    { id: 1, child_order_acceptance_id: 'JRF-child-stale', price: 9700000, size: 0.01, exec_date: '2026-01-01T00:05:00.000Z' },
                ]),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.getExecutionPriceForOrderV2(order)

    assert.deepEqual(result.execution, { price: 9700000, size: 0.01, executed_at: new Date('2026-01-01T00:05:00.000Z') })
    assert.equal(requestedUrls.length, 1)
})

test('BitflyerClient.getExecutionPriceForOrderV2 pages direct lookup beyond 100 executions', async () => {
    const order: OrderV2 = {
        id: 'v2-entry-direct-pagination',
        strategy: 'MA',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 0.01,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['JRF-parent-direct-pagination'],
        broker_order_metadata: {
            kind: 'bitflyer_parent_order_v1',
            parent_order_acceptance_id: 'JRF-parent-direct-pagination',
            order_method: 'IFDOCO',
            entry: {
                expected: { role: 'ENTRY', side: 'BUY', condition_type: 'MARKET', size: 0.01 },
                resolved: { acceptance_id: 'JRF-child-direct-pagination' },
            },
            exits: [],
        },
        created_at: new Date(),
        updated_at: new Date(),
    }

    const requestedUrls: string[] = []
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            const urlStr = String(url)
            requestedUrls.push(urlStr)
            const params = new URL(urlStr).searchParams
            const childAcceptanceId = params.get('child_order_acceptance_id')

            if (childAcceptanceId === null) {
                return new Response(
                    JSON.stringify([
                        { id: 200, child_order_acceptance_id: 'JRF-other-direct-pagination', price: 9600000, size: 0.01, exec_date: '2026-01-01T00:00:00.000Z' },
                    ]),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }

            if (params.get('before') === null) {
                return new Response(
                    JSON.stringify(Array.from({ length: 100 }, (_, index) => ({
                        id: 100 - index,
                        child_order_acceptance_id: 'JRF-child-direct-pagination',
                        price: 9700000,
                        size: index === 0 ? 0.004 : 0,
                        exec_date: '2026-01-01T00:05:00.000Z',
                    }))),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }

            assert.equal(params.get('before'), '1')
            return new Response(
                JSON.stringify([
                    { id: 0, child_order_acceptance_id: 'JRF-child-direct-pagination', price: 9800000, size: 0.006, exec_date: '2026-01-01T00:06:00.000Z' },
                ]),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.getExecutionPriceForOrderV2(order)

    assert.equal(result.execution?.size, 0.01)
    assert.equal(requestedUrls.length, 3)
    assert.equal(new URL(requestedUrls[0] ?? '').searchParams.get('child_order_acceptance_id'), null)
    assert.equal(new URL(requestedUrls[1] ?? '').searchParams.get('child_order_acceptance_id'), 'JRF-child-direct-pagination')
    assert.equal(new URL(requestedUrls[2] ?? '').searchParams.get('before'), '1')
})

test('BitflyerClient.getExecutionPriceForOrderV2 does not return partial data when direct pagination is incomplete', async () => {
    const order: OrderV2 = {
        id: 'v2-entry-direct-incomplete',
        strategy: 'MA',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 0.01,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['JRF-parent-direct-incomplete'],
        broker_order_metadata: {
            kind: 'bitflyer_parent_order_v1',
            parent_order_acceptance_id: 'JRF-parent-direct-incomplete',
            order_method: 'IFDOCO',
            entry: {
                expected: { role: 'ENTRY', side: 'BUY', condition_type: 'MARKET', size: 0.01 },
                resolved: { acceptance_id: 'JRF-child-direct-incomplete' },
            },
            exits: [],
        },
        created_at: new Date(),
        updated_at: new Date(),
    }

    const { logger, warnLogs } = createCapturingLogger()
    const requestedUrls: string[] = []
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        logger: logger as any,
        fetchImpl: async (url) => {
            const urlStr = String(url)
            requestedUrls.push(urlStr)
            const params = new URL(urlStr).searchParams
            if (params.get('child_order_acceptance_id') === null) {
                return new Response(
                    JSON.stringify([{ id: 1000, child_order_acceptance_id: 'JRF-other-direct-incomplete', price: 9600000, size: 0.01 }]),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }

            return new Response(
                JSON.stringify(Array.from({ length: 100 }, (_, index) => ({
                    child_order_acceptance_id: 'JRF-child-direct-incomplete',
                    price: 9700000,
                    size: index === 0 ? 0.004 : 0,
                }))),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.getExecutionPriceForOrderV2(order)

    assert.equal(result.execution, null)
    assert.equal(requestedUrls.length, 2)
    assert.equal(warnLogs[0]?.obj.event, 'bitflyer:executions_direct_lookup_incomplete')
    assert.equal(warnLogs[0]?.obj.reason, 'missing_execution_ids')
})

test('BitflyerClient.getExecutionPriceForOrderV2 does not return partial data when direct pagination cursor does not advance', async () => {
    const order: OrderV2 = {
        id: 'v2-entry-direct-cursor-stuck',
        strategy: 'MA',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 0.01,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['JRF-parent-direct-cursor-stuck'],
        broker_order_metadata: {
            kind: 'bitflyer_parent_order_v1',
            parent_order_acceptance_id: 'JRF-parent-direct-cursor-stuck',
            order_method: 'IFDOCO',
            entry: {
                expected: { role: 'ENTRY', side: 'BUY', condition_type: 'MARKET', size: 0.01 },
                resolved: { acceptance_id: 'JRF-child-direct-cursor-stuck' },
            },
            exits: [],
        },
        created_at: new Date(),
        updated_at: new Date(),
    }

    const { logger, warnLogs } = createCapturingLogger()
    const requestedUrls: string[] = []
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        logger: logger as any,
        fetchImpl: async (url) => {
            const urlStr = String(url)
            requestedUrls.push(urlStr)
            const params = new URL(urlStr).searchParams
            if (params.get('child_order_acceptance_id') === null) {
                return new Response(
                    JSON.stringify([{ id: 1000, child_order_acceptance_id: 'JRF-other-direct-cursor-stuck', price: 9600000, size: 0.01 }]),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }

            return new Response(
                JSON.stringify(Array.from({ length: 100 }, (_, index) => ({
                    id: 100 - index,
                    child_order_acceptance_id: 'JRF-child-direct-cursor-stuck',
                    price: 9700000,
                    size: index === 0 ? 0.004 : 0,
                }))),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.getExecutionPriceForOrderV2(order)

    assert.equal(result.execution, null)
    assert.equal(requestedUrls.length, 3)
    assert.equal(new URL(requestedUrls[2] ?? '').searchParams.get('before'), '1')
    assert.equal(warnLogs[0]?.obj.event, 'bitflyer:executions_direct_lookup_incomplete')
    assert.equal(warnLogs[0]?.obj.reason, 'cursor_not_advanced')
})

test('BitflyerClient.getExecutionPriceForOrderV2 falls back to direct lookup when one-page batch is insufficient', async () => {
    const order: OrderV2 = {
        id: 'v2-entry-page-limit',
        strategy: 'MA',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 0.01,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['JRF-parent-page-limit'],
        broker_order_metadata: {
            kind: 'bitflyer_parent_order_v1',
            parent_order_acceptance_id: 'JRF-parent-page-limit',
            order_method: 'IFDOCO',
            entry: {
                expected: { role: 'ENTRY', side: 'BUY', condition_type: 'MARKET', size: 0.01 },
                resolved: { acceptance_id: 'JRF-child-page-limit-target' },
            },
            exits: [],
        },
        created_at: new Date(),
        updated_at: new Date(),
    }

    const requestedUrls: string[] = []
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            const urlStr = String(url)
            requestedUrls.push(urlStr)
            const params = new URL(urlStr).searchParams

            if (params.get('child_order_acceptance_id') === 'JRF-child-page-limit-target') {
                return new Response(
                    JSON.stringify([
                        { id: 1, child_order_acceptance_id: 'JRF-child-page-limit-target', price: 9700000, size: 0.01, exec_date: '2026-01-01T00:05:00.000Z' },
                    ]),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }

            return new Response(
                JSON.stringify(Array.from({ length: 100 }, (_, index) => ({
                    id: 600 - index,
                    child_order_acceptance_id: `JRF-child-other-${index}`,
                    price: 9600000,
                    size: 0.001,
                    exec_date: '2026-01-01T00:00:00.000Z',
                }))),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.getExecutionPriceForOrderV2(order)

    assert.deepEqual(result.execution, { price: 9700000, size: 0.01, executed_at: new Date('2026-01-01T00:05:00.000Z') })
    assert.equal(requestedUrls.length, 2)
    assert.equal(new URL(requestedUrls[0] ?? '').searchParams.get('child_order_acceptance_id'), null)
    assert.equal(new URL(requestedUrls[1] ?? '').searchParams.get('child_order_acceptance_id'), 'JRF-child-page-limit-target')
})

test('BitflyerClient.getExecutionPriceForOrderV2 falls back to direct lookup when batch target quantity is incomplete', async () => {
    const order: OrderV2 = {
        id: 'v2-entry-missing-execution-ids',
        strategy: 'MA',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 0.01,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['JRF-parent-missing-execution-ids'],
        broker_order_metadata: {
            kind: 'bitflyer_parent_order_v1',
            parent_order_acceptance_id: 'JRF-parent-missing-execution-ids',
            order_method: 'IFDOCO',
            entry: {
                expected: { role: 'ENTRY', side: 'BUY', condition_type: 'MARKET', size: 0.01 },
                resolved: { acceptance_id: 'JRF-child-missing-execution-ids-target' },
            },
            exits: [],
        },
        created_at: new Date(),
        updated_at: new Date(),
    }

    const requestedUrls: string[] = []
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            const urlStr = String(url)
            requestedUrls.push(urlStr)
            const params = new URL(urlStr).searchParams

            if (params.get('child_order_acceptance_id') === 'JRF-child-missing-execution-ids-target') {
                return new Response(
                    JSON.stringify([
                        { id: 1, child_order_acceptance_id: 'JRF-child-missing-execution-ids-target', price: 9700000, size: 0.01, exec_date: '2026-01-01T00:05:00.000Z' },
                    ]),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }

            return new Response(
                JSON.stringify(Array.from({ length: 100 }, (_, index) => ({
                    id: 500 - index,
                    child_order_acceptance_id: index === 0 ? 'JRF-child-missing-execution-ids-target' : `JRF-child-other-missing-id-${index}`,
                    price: 9600000,
                    size: index === 0 ? 0.004 : 0.001,
                    exec_date: '2026-01-01T00:00:00.000Z',
                }))),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.getExecutionPriceForOrderV2(order)

    assert.deepEqual(result.execution, { price: 9700000, size: 0.01, executed_at: new Date('2026-01-01T00:05:00.000Z') })
    assert.equal(requestedUrls.length, 2)
    assert.equal(new URL(requestedUrls[0] ?? '').searchParams.get('child_order_acceptance_id'), null)
    assert.equal(new URL(requestedUrls[1] ?? '').searchParams.get('child_order_acceptance_id'), 'JRF-child-missing-execution-ids-target')
})

test('BitflyerClient.getExecutionPriceForOrderV2 resolves metadata-less MARKET order from provider order id', async () => {
    const requestedUrls: string[] = []
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            requestedUrls.push(String(url))
            return new Response(
                JSON.stringify([
                    { id: 201, child_order_acceptance_id: 'JRF-child-legacy', price: 9700000, size: 0.01, exec_date: '2026-01-01T00:05:00.000Z' },
                    { id: 200, child_order_acceptance_id: 'JRF-child-other', price: 9800000, size: 0.01, exec_date: '2026-01-01T00:06:00.000Z' },
                ]),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.getExecutionPriceForOrderV2({
        id: 'v2-entry-missing-metadata',
        strategy: 'MA',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        order_type: 'MARKET',
        requested_size: 0.01,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['JRF-child-legacy'],
        created_at: new Date(),
        updated_at: new Date(),
    })

    assert.deepEqual(result.execution, { price: 9700000, size: 0.01, executed_at: new Date('2026-01-01T00:05:00.000Z') })
    assert.equal(result.brokerOrderMetadata, undefined)
    assert.equal(requestedUrls.length, 1)
    assert.equal(new URL(requestedUrls[0] ?? '').searchParams.get('child_order_acceptance_id'), null)
    assert.equal(new URL(requestedUrls[0] ?? '').searchParams.get('product_code'), 'BTC_JPY')
})

test('BitflyerClient.getExecutionPriceForOrderV2 rounds split execution size totals', async () => {
    const executions = Array.from({ length: 10 }, (_, index) => ({
        id: 300 - index,
        child_order_acceptance_id: 'JRF-child-split-entry',
        price: 9700000 + index,
        size: 0.1,
        exec_date: '2026-01-01T00:05:00.000Z',
    }))
    const expectedPrice = executions.reduce((sum, execution) => sum + execution.price * execution.size, 0)
        / executions.reduce((sum, execution) => sum + execution.size, 0)

    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async () =>
            new Response(
                JSON.stringify(executions),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
    })

    const result = await client.getExecutionPriceForOrderV2({
        id: 'v2-entry-split-size',
        strategy: 'MA',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        order_type: 'MARKET',
        requested_size: 1,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['JRF-child-split-entry'],
        created_at: new Date(),
        updated_at: new Date(),
    })

    assert.deepEqual(result.execution, { price: expectedPrice, size: 1, executed_at: new Date('2026-01-01T00:05:00.000Z') })
})

test('BitflyerClient.getExecutionPriceForOrderV2 preserves known zero commission', async () => {
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async () => new Response(JSON.stringify([
            {
                id: 350,
                child_order_acceptance_id: 'JRF-child-commission-zero',
                price: 9700000,
                size: 0.01,
                commission: 0,
                exec_date: '2026-01-01T00:05:00.000Z',
            },
        ]), { status: 200, headers: { 'content-type': 'application/json' } }),
    })

    const result = await client.getExecutionPriceForOrderV2({
        id: 'v2-entry-commission-zero',
        strategy: 'MA',
        broker: 'bitflyer',
        ticker: 'FX_BTC_JPY',
        side: 'BUY',
        order_type: 'MARKET',
        requested_size: 0.01,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['JRF-child-commission-zero'],
        created_at: new Date(),
        updated_at: new Date(),
    })

    assert.equal(result.execution?.commission, 0)
})

test('BitflyerClient.getExecutionPriceForOrderV2 sums signed commission across fills', async () => {
    const executions = [
        {
            id: 361,
            child_order_acceptance_id: 'JRF-child-commission-sum',
            price: 9700000,
            size: 0.004,
            commission: -0.0002,
            exec_date: '2026-01-01T00:05:00.000Z',
        },
        {
            id: 360,
            child_order_acceptance_id: 'JRF-child-commission-sum',
            price: 9710000,
            size: 0.006,
            commission: 0.0001,
            exec_date: '2026-01-01T00:06:00.000Z',
        },
    ]
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async () => new Response(JSON.stringify(executions), { status: 200, headers: { 'content-type': 'application/json' } }),
    })

    const result = await client.getExecutionPriceForOrderV2({
        id: 'v2-entry-commission-sum',
        strategy: 'MA',
        broker: 'bitflyer',
        ticker: 'FX_BTC_JPY',
        side: 'BUY',
        order_type: 'MARKET',
        requested_size: 0.01,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['JRF-child-commission-sum'],
        created_at: new Date(),
        updated_at: new Date(),
    })

    assert.equal(result.execution?.commission, -0.0001)
    assert.equal(result.execution?.size, 0.01)
})

test('BitflyerClient.getExecutionPriceForOrderV2 leaves commission unknown when a fill commission is missing', async () => {
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async () => new Response(JSON.stringify([
            {
                id: 370,
                child_order_acceptance_id: 'JRF-child-commission-unknown',
                price: 9700000,
                size: 0.004,
                commission: 0.0001,
                exec_date: '2026-01-01T00:05:00.000Z',
            },
            {
                id: 369,
                child_order_acceptance_id: 'JRF-child-commission-unknown',
                price: 9710000,
                size: 0.006,
                exec_date: '2026-01-01T00:06:00.000Z',
            },
        ]), { status: 200, headers: { 'content-type': 'application/json' } }),
    })

    const result = await client.getExecutionPriceForOrderV2({
        id: 'v2-entry-commission-unknown',
        strategy: 'MA',
        broker: 'bitflyer',
        ticker: 'FX_BTC_JPY',
        side: 'BUY',
        order_type: 'MARKET',
        requested_size: 0.01,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['JRF-child-commission-unknown'],
        created_at: new Date(),
        updated_at: new Date(),
    })

    assert.ok(result.execution)
    assert.equal('commission' in result.execution, false)
})

test('BitflyerClient.getExecutionPriceForOrderV2 no-ops when IFDOCO metadata is missing', async () => {
    const { logger, warnLogs } = createCapturingLogger()
    const requestedUrls: string[] = []
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        logger: logger as any,
        fetchImpl: async (url) => {
            requestedUrls.push(String(url))
            return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
        },
    })

    const result = await client.getExecutionPriceForOrderV2({
        id: 'v2-ifdoco-missing-metadata',
        strategy: 'MA',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 0.01,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['JRF-parent-missing-metadata'],
        created_at: new Date(),
        updated_at: new Date(),
    })

    assert.equal(result.execution, null)
    assert.equal(requestedUrls.length, 0)
    assert.ok(warnLogs.some((log) => log.obj.event === 'bitflyer:orders_v2_metadata_missing'))
})

test('BitflyerClient.getClosingExecutionForOrderV2 resolves close acceptance ids from metadata even when completed child is MARKET', async () => {
    const order: OrderV2 = {
        id: 'v2-close-meta',
        strategy: 'MA',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 0.01,
        executed_size: 0.01,
        executed_price: 9700000,
        status: 'EXECUTED',
        executed_at: new Date('2026-01-01T00:10:00Z'),
        provider_order_ids: ['JRF-parent-close-meta'],
        broker_order_metadata: {
            kind: 'bitflyer_parent_order_v1',
            parent_order_acceptance_id: 'JRF-parent-close-meta',
            order_method: 'IFDOCO',
            entry: {
                expected: { role: 'ENTRY', side: 'BUY', condition_type: 'MARKET', size: 0.01 },
                resolved: { acceptance_id: 'JRF-child-entry-meta' },
            },
            exits: [
                {
                    expected: { role: 'STOP_LOSS', side: 'SELL', condition_type: 'STOP', size: 0.01, trigger_price: 9500000 },
                    resolved: { acceptance_id: null },
                },
                {
                    expected: { role: 'TAKE_PROFIT', side: 'SELL', condition_type: 'LIMIT', size: 0.01, price: 9800000 },
                    resolved: { acceptance_id: null },
                },
            ],
        },
        created_at: new Date(),
        updated_at: new Date(),
    }

    let callCount = 0
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            callCount++
            const urlStr = String(url)

            if (callCount === 1) {
                assert.ok(urlStr.includes('getparentorder'))
                return new Response(
                    JSON.stringify({ parent_order_id: 'JCO-parent-close-meta', parent_order_acceptance_id: 'JRF-parent-close-meta' }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            if (callCount === 2) {
                assert.ok(urlStr.includes('getchildorders'))
                return new Response(
                    JSON.stringify([
                        { child_order_acceptance_id: 'JRF-child-stop-meta', child_order_state: 'COMPLETED', child_order_type: 'MARKET', side: 'SELL', size: 0.01, trigger_price: 9500000 },
                        { child_order_acceptance_id: 'JRF-child-limit-meta', child_order_state: 'ACTIVE', child_order_type: 'LIMIT', side: 'SELL', size: 0.01, price: 9800000 },
                        { child_order_acceptance_id: 'JRF-child-entry-meta', child_order_state: 'COMPLETED', child_order_type: 'MARKET', side: 'BUY', size: 0.01 },
                    ]),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }

            assert.ok(urlStr.includes('getexecutions'))
            const childAcceptanceId = new URL(urlStr).searchParams.get('child_order_acceptance_id')
            if (childAcceptanceId !== null) {
                assert.equal(childAcceptanceId, 'JRF-child-limit-meta')
                return new Response(
                    JSON.stringify([]),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            return new Response(
                JSON.stringify([
                    { id: 202, child_order_acceptance_id: 'JRF-child-stop-meta', price: 9500000, size: 0.01, exec_date: '2026-01-01T01:10:00.000Z' },
                ]),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.getClosingExecutionForOrderV2(order)

    assert.deepEqual(result.execution, { price: 9500000, size: 0.01, executed_at: new Date('2026-01-01T01:10:00.000Z') })
    assert.deepEqual(result.brokerOrderMetadata?.exits[0]?.resolved, { acceptance_id: 'JRF-child-stop-meta' })
    assert.deepEqual(result.brokerOrderMetadata?.exits[1]?.resolved, { acceptance_id: 'JRF-child-limit-meta' })
})

test('BitflyerClient.getClosingExecutionForOrderV2 resolves stop loss MARKET child without trigger_price', async () => {
    const order: OrderV2 = {
        id: 'v2-close-sl-market-no-trigger',
        strategy: 'MA',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 0.01,
        executed_size: 0.01,
        executed_price: 9700000,
        status: 'EXECUTED',
        executed_at: new Date('2026-01-01T00:10:00Z'),
        provider_order_ids: ['JRF-parent-close-sl-market'],
        broker_order_metadata: {
            kind: 'bitflyer_parent_order_v1',
            parent_order_acceptance_id: 'JRF-parent-close-sl-market',
            order_method: 'IFDOCO',
            entry: {
                expected: { role: 'ENTRY', side: 'BUY', condition_type: 'MARKET', size: 0.01 },
                resolved: { acceptance_id: 'JRF-child-entry-sl-market' },
            },
            exits: [
                {
                    expected: { role: 'STOP_LOSS', side: 'SELL', condition_type: 'STOP', size: 0.01, trigger_price: 9500000 },
                    resolved: { acceptance_id: null },
                },
                {
                    expected: { role: 'TAKE_PROFIT', side: 'SELL', condition_type: 'LIMIT', size: 0.01, price: 9800000 },
                    resolved: { acceptance_id: null },
                },
            ],
        },
        created_at: new Date(),
        updated_at: new Date(),
    }

    let callCount = 0
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            callCount++
            const urlStr = String(url)

            if (callCount === 1) {
                assert.ok(urlStr.includes('getparentorder'))
                return new Response(
                    JSON.stringify({ parent_order_id: 'JCO-parent-close-sl-market', parent_order_acceptance_id: 'JRF-parent-close-sl-market' }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            if (callCount === 2) {
                assert.ok(urlStr.includes('getchildorders'))
                return new Response(
                    JSON.stringify([
                        { child_order_acceptance_id: 'JRF-child-stop-sl-market', child_order_state: 'COMPLETED', child_order_type: 'MARKET', side: 'SELL', size: 0.01 },
                        { child_order_acceptance_id: 'JRF-child-limit-sl-market', child_order_state: 'ACTIVE', child_order_type: 'LIMIT', side: 'SELL', size: 0.01, price: 9800000 },
                        { child_order_acceptance_id: 'JRF-child-entry-sl-market', child_order_state: 'COMPLETED', child_order_type: 'MARKET', side: 'BUY', size: 0.01 },
                    ]),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }

            assert.ok(urlStr.includes('getexecutions'))
            const childAcceptanceId = new URL(urlStr).searchParams.get('child_order_acceptance_id')
            if (childAcceptanceId !== null) {
                assert.equal(childAcceptanceId, 'JRF-child-limit-sl-market')
                return new Response(
                    JSON.stringify([]),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            return new Response(
                JSON.stringify([
                    { id: 302, child_order_acceptance_id: 'JRF-child-stop-sl-market', price: 9500000, size: 0.01, exec_date: '2026-01-01T01:10:00.000Z' },
                ]),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.getClosingExecutionForOrderV2(order)

    assert.deepEqual(result.execution, { price: 9500000, size: 0.01, executed_at: new Date('2026-01-01T01:10:00.000Z') })
    assert.deepEqual(result.brokerOrderMetadata?.exits[0]?.resolved, { acceptance_id: 'JRF-child-stop-sl-market' })
    assert.deepEqual(result.brokerOrderMetadata?.exits[1]?.resolved, { acceptance_id: 'JRF-child-limit-sl-market' })
})

test('BitflyerClient.getClosingExecutionForOrderV2 returns partial close and no-ops unfilled exits', async () => {
    const order: OrderV2 = {
        id: 'v2-close-partial-noop',
        strategy: 'MA',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 0.01,
        executed_size: 0.01,
        executed_price: 9700000,
        status: 'EXECUTED',
        executed_at: new Date('2026-01-01T00:10:00Z'),
        provider_order_ids: ['JRF-parent-close-partial-noop'],
        broker_order_metadata: {
            kind: 'bitflyer_parent_order_v1',
            parent_order_acceptance_id: 'JRF-parent-close-partial-noop',
            order_method: 'IFDOCO',
            entry: {
                expected: { role: 'ENTRY', side: 'BUY', condition_type: 'MARKET', size: 0.01 },
                resolved: { acceptance_id: 'JRF-child-entry-partial-noop' },
            },
            exits: [
                {
                    expected: { role: 'STOP_LOSS', side: 'SELL', condition_type: 'STOP', size: 0.01, trigger_price: 9500000 },
                    resolved: { acceptance_id: 'JRF-child-stop-partial-noop' },
                },
                {
                    expected: { role: 'TAKE_PROFIT', side: 'SELL', condition_type: 'LIMIT', size: 0.01, price: 9800000 },
                    resolved: { acceptance_id: 'JRF-child-limit-partial-noop' },
                },
            ],
        },
        created_at: new Date(),
        updated_at: new Date(),
    }

    const requestedUrls: string[] = []
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            const urlStr = String(url)
            requestedUrls.push(urlStr)
            assert.ok(urlStr.includes('getexecutions'))
            const childAcceptanceId = new URL(urlStr).searchParams.get('child_order_acceptance_id')
            if (childAcceptanceId !== null) {
                if (childAcceptanceId === 'JRF-child-stop-partial-noop') {
                    return new Response(
                        JSON.stringify([
                            { id: 401, child_order_acceptance_id: 'JRF-child-stop-partial-noop', price: 9500000, size: 0.004, exec_date: '2026-01-01T01:00:00.000Z' },
                        ]),
                        { status: 200, headers: { 'content-type': 'application/json' } },
                    )
                }
                assert.equal(childAcceptanceId, 'JRF-child-limit-partial-noop')
                return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
            }
            return new Response(
                JSON.stringify([
                    { id: 401, child_order_acceptance_id: 'JRF-child-stop-partial-noop', price: 9500000, size: 0.004, exec_date: '2026-01-01T01:00:00.000Z' },
                ]),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.getClosingExecutionForOrderV2(order)

    assert.deepEqual(result.execution, { price: 9500000, size: 0.004, executed_at: new Date('2026-01-01T01:00:00.000Z') })
    assert.deepEqual(result.brokerOrderMetadata, order.broker_order_metadata)
    assert.equal(requestedUrls.length, 3)
})

test('BitflyerClient.getClosingExecutionForOrderV2 rounds split execution size totals', async () => {
    const executions = Array.from({ length: 10 }, (_, index) => ({
        id: 500 - index,
        child_order_acceptance_id: 'JRF-child-stop-split-size',
        price: 9500000 + index,
        size: 0.1,
        commission: 0,
        exec_date: '2026-01-01T01:00:00.000Z',
    }))
    const expectedPrice = executions.reduce((sum, execution) => sum + execution.price * execution.size, 0)
        / executions.reduce((sum, execution) => sum + execution.size, 0)

    const order: OrderV2 = {
        id: 'v2-close-split-size',
        strategy: 'MA',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 1,
        executed_size: 1,
        executed_price: 9700000,
        status: 'EXECUTED',
        executed_at: new Date('2026-01-01T00:10:00Z'),
        provider_order_ids: ['JRF-parent-close-split-size'],
        broker_order_metadata: {
            kind: 'bitflyer_parent_order_v1',
            parent_order_acceptance_id: 'JRF-parent-close-split-size',
            order_method: 'IFDOCO',
            entry: {
                expected: { role: 'ENTRY', side: 'BUY', condition_type: 'MARKET', size: 1 },
                resolved: { acceptance_id: 'JRF-child-entry-split-size' },
            },
            exits: [
                {
                    expected: { role: 'STOP_LOSS', side: 'SELL', condition_type: 'STOP', size: 1, trigger_price: 9500000 },
                    resolved: { acceptance_id: 'JRF-child-stop-split-size' },
                },
            ],
        },
        created_at: new Date(),
        updated_at: new Date(),
    }

    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        fetchImpl: async () =>
            new Response(
                JSON.stringify(executions),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
    })

    const result = await client.getClosingExecutionForOrderV2(order)

    assert.deepEqual(result.execution, {
        price: expectedPrice,
        size: 1,
        executed_at: new Date('2026-01-01T01:00:00.000Z'),
        commission: 0,
    })
})

test('BitflyerClient.getClosingExecutionForOrderV2 no-ops when metadata is missing', async () => {
    const { logger, warnLogs } = createCapturingLogger()
    const requestedUrls: string[] = []
    const client = new BitflyerClient({
        apiKey: 'test-key',
        apiSecret: 'test-secret',
        baseUrl: 'https://example.com',
        logger: logger as any,
        fetchImpl: async (url) => {
            requestedUrls.push(String(url))
            return new Response(JSON.stringify([]), { status: 200, headers: { 'content-type': 'application/json' } })
        },
    })

    const result = await client.getClosingExecutionForOrderV2({
        id: 'v2-close-missing-metadata',
        strategy: 'MA',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 0.01,
        executed_size: 0.01,
        executed_price: 9700000,
        status: 'EXECUTED',
        executed_at: new Date('2026-01-01T00:10:00Z'),
        provider_order_ids: ['JRF-parent-legacy'],
        created_at: new Date(),
        updated_at: new Date(),
    })

    assert.equal(result.execution, null)
    assert.equal(requestedUrls.length, 0)
    assert.ok(warnLogs.some((log) => log.obj.event === 'bitflyer:orders_v2_metadata_missing'))
})
