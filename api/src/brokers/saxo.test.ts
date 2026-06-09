import assert from 'node:assert/strict'
import test from 'node:test'
import type { Firestore } from 'firebase-admin/firestore'

import { SaxoClient } from './saxo.js'

const mockFirestore = (data: Record<string, any> = {}) => {
    const store = { ...data }
    const db: any = {
        collection: (collectionPath: string) => ({
            doc: (docPath: string) => ({
                get: async () => ({
                    exists: store[`${collectionPath}/${docPath}`] !== undefined,
                    data: () => store[`${collectionPath}/${docPath}`],
                }),
                set: async (newData: any) => {
                    store[`${collectionPath}/${docPath}`] = newData
                },
                update: async (updates: any) => {
                    store[`${collectionPath}/${docPath}`] = {
                        ...store[`${collectionPath}/${docPath}`],
                        ...updates,
                    }
                },
            }),
        }),
        runTransaction: async (updateFunction: (transaction: any) => Promise<any>) => {
            const transaction = {
                get: async (ref: any) => ref.get(),
                update: (ref: any, updates: any) => {
                    ref.update(updates)
                    return transaction
                },
            }
            return updateFunction(transaction)
        },
    }
    return db as unknown as Firestore
}

test('SaxoClient.getLoginUrl returns correct URL', () => {
    const client = new SaxoClient({
        appKey: 'test-app-key',
        redirectUri: 'http://localhost/callback',
        authBaseUrl: 'https://auth.example.com',
    })

    const url = client.getLoginUrl('test-state')
    assert.equal(
        url,
        'https://auth.example.com/authorize?response_type=code&client_id=test-app-key&state=test-state&redirect_uri=http%3A%2F%2Flocalhost%2Fcallback',
    )
})

test('SaxoClient.exchangeCodeForToken exchanges code and saves to firestore', async () => {
    const db = mockFirestore()

    const client = new SaxoClient({
        appKey: 'test-key',
        appSecret: 'test-secret',
        redirectUri: 'http://localhost/callback',
        authBaseUrl: 'https://auth.example.com',
        baseUrl: 'https://api.example.com',
        db,
        fetchImpl: async (url) => {
            if (url.toString().endsWith('/token')) {
                return new Response(
                    JSON.stringify({
                        access_token: 'new-access-token',
                        refresh_token: 'new-refresh-token',
                        expires_in: 1200,
                        refresh_token_expires_in: 86400,
                    }),
                    { status: 200 },
                )
            }
            if (url.toString().endsWith('/port/v1/accounts/me')) {
                return new Response(
                    JSON.stringify({
                        Data: [
                            {
                                AccountKey: 'test-account-key',
                                ClientKey: 'test-client-key',
                                LegalAssetTypes: ['FxSpot'],
                                Currency: 'USD',
                                DisplayName: 'Test Account',
                            },
                        ],
                    }),
                    { status: 200 },
                )
            }
            return new Response('Not Found', { status: 404 })
        },
    })

    await client.exchangeCodeForToken('test-code')

    const auth = await client.getAuth()
    assert.equal(auth?.accessToken, 'new-access-token')
    assert.equal(auth?.refreshToken, 'new-refresh-token')
    assert.equal(auth?.accounts?.[0]?.accountKey, 'test-account-key')
    assert.equal(auth?.accounts?.[0]?.clientKey, 'test-client-key')
    assert.equal(auth?.accounts?.[0]?.currency, 'USD')
    assert.equal(auth?.accounts?.[0]?.displayName, 'Test Account')
})

test('SaxoClient.getValidAccessToken refreshes if expired', async () => {
    const initialAuth = {
        accessToken: 'old-token',
        refreshToken: 'refresh-token',
        accessTokenExpiresAt: Date.now() - 1000, // Expired
        refreshTokenExpiresAt: Date.now() + 86400000,
    }
    const db = mockFirestore({ 'saxo_auth_data/saxo_auth': initialAuth })

    const client = new SaxoClient({
        appKey: 'test-key',
        appSecret: 'test-secret',
        authBaseUrl: 'https://auth.example.com',
        baseUrl: 'https://api.example.com',
        db,
        fetchImpl: async (url) => {
            if (url.toString().endsWith('/token')) {
                return new Response(
                    JSON.stringify({
                        access_token: 'refreshed-token',
                        refresh_token: 'new-refresh-token',
                        expires_in: 1200,
                        refresh_token_expires_in: 86400,
                    }),
                    { status: 200 },
                )
            }
            if (url.toString().endsWith('/port/v1/accounts/me')) {
                return new Response(
                    JSON.stringify({
                        Data: [
                            {
                                AccountKey: 'test-account-key',
                                ClientKey: 'test-client-key',
                                LegalAssetTypes: ['FxSpot'],
                                Currency: 'USD',
                                DisplayName: 'Test Account',
                            },
                        ],
                    }),
                    { status: 200 },
                )
            }
            return new Response('Not Found', { status: 404 })
        },
    })

    const token = await client.getValidAccessToken()
    assert.equal(token, 'refreshed-token')

    const auth = await client.getAuth()
    assert.equal(auth?.accessToken, 'refreshed-token')
    assert.equal(auth?.accounts?.[0]?.accountKey, 'test-account-key')
})

test('SaxoClient.getExecutionPrice returns null for DRY_RUN', async () => {
    const client = new SaxoClient({ db: mockFirestore() })
    const result = await client.getExecutionPrice('DRY_RUN', 'USDJPY')
    assert.equal(result, null)
})

test('SaxoClient.getExecutionPrice returns AveragePrice from audit activities', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [{ clientKey: 'test-client' }],
        },
    })

    let capturedUrl = ''

    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            capturedUrl = String(url)
            return new Response(
                JSON.stringify({
                    Data: [
                        { LogId: 'L1', OrderId: 'ORD-123', Status: 'Placed' },
                        { LogId: 'L2', OrderId: 'ORD-123', Status: 'FinalFill', AveragePrice: 18066.67, ActivityTime: '2026-01-01T00:05:00Z' },
                    ],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.getExecutionPrice('ORD-123', 'USDJPY')

    assert.ok(capturedUrl.includes('/cs/v1/audit/orderactivities/'))
    assert.ok(capturedUrl.includes('OrderId=ORD-123'))
    assert.ok(capturedUrl.includes('ClientKey=test-client'))
    assert.deepEqual(result, { price: 18066.67, size: 0, executed_at: new Date('2026-01-01T00:05:00Z') })
})

test('SaxoClient.getExecutionPrice leaves executed_at undefined when audit activity has no timestamp', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        },
    })

    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async () =>
            new Response(
                JSON.stringify({
                    Data: [
                        { LogId: 'L2', OrderId: 'ORD-123', Status: 'FinalFill', AveragePrice: 18066.67 },
                    ],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
    })

    const result = await client.getExecutionPrice('ORD-123', 'USDJPY')

    assert.deepEqual(result, { price: 18066.67, size: 0, executed_at: undefined })
})

test('SaxoClient.getExecutionPrice returns null when activities are empty', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        },
    })

    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async () =>
            new Response(
                JSON.stringify({ Data: [] }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
    })

    const result = await client.getExecutionPrice('ORD-123', 'USDJPY')
    assert.equal(result, null)
})

test('SaxoClient.sendMarketOrder returns Saxo metadata for related orders', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [
                {
                    accountKey: 'account-1',
                    clientKey: 'client-1',
                    legalAssetTypes: ['CfdOnIndex'],
                    currency: 'USD',
                    displayName: 'Test',
                },
            ],
        },
    })

    let requestBody: any
    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async (_url, init) => {
            requestBody = JSON.parse(String(init?.body))
            return new Response(
                JSON.stringify({
                    OrderId: 'ORD-entry-1',
                    Orders: [{ OrderId: 'ORD-sl-1' }, { OrderId: 'ORD-tp-1' }],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.sendMarketOrder({
        eventId: 'evt-saxo-meta-1',
        broker: 'saxo',
        ticker: 'CfdOnIndex:4912',
        side: 'BUY',
        size: 2,
        requestId: 'req-saxo-meta-1',
        price: 100,
        stopLoss: '2%',
        takeProfit: '3%',
    })

    assert.equal(result.ok, true)
    assert.equal(result.ok && result.providerOrderId, 'ORD-entry-1')
    assert.equal(requestBody.Orders.length, 2)
    assert.deepEqual(result.ok && result.brokerOrderMetadata, {
        kind: 'saxo_order_v1',
        order_id: 'ORD-entry-1',
        entry: {
            expected: { side: 'BUY', order_type: 'Market', size: 2 },
            resolved: { order_id: 'ORD-entry-1' },
        },
        exits: [
            {
                expected: {
                    role: 'STOP_LOSS',
                    side: 'SELL',
                    order_type: 'StopIfTraded',
                    size: 2,
                    price: 98,
                },
                resolved: { order_id: 'ORD-sl-1' },
            },
            {
                expected: {
                    role: 'TAKE_PROFIT',
                    side: 'SELL',
                    order_type: 'Limit',
                    size: 2,
                    price: 103,
                },
                resolved: { order_id: 'ORD-tp-1' },
            },
        ],
    })
})

test('SaxoClient.sendMarketOrder keeps related order ids nullable when response omits them', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [{ accountKey: 'account-1', clientKey: 'client-1', legalAssetTypes: ['FxSpot'] }],
        },
    })

    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async () =>
            new Response(
                JSON.stringify({ OrderId: 'ORD-entry-2' }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
    })

    const result = await client.sendMarketOrder({
        eventId: 'evt-saxo-meta-2',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'SELL',
        size: 1000,
        requestId: 'req-saxo-meta-2',
        price: 150,
        stopLoss: '1%',
    })

    assert.equal(result.ok, true)
    assert.equal(result.ok && result.brokerOrderMetadata?.kind, 'saxo_order_v1')
    if (result.ok && result.brokerOrderMetadata?.kind === 'saxo_order_v1') {
        assert.equal(result.brokerOrderMetadata.exits[0]?.resolved.order_id, null)
    }
})

test('SaxoClient.getExecutionPriceForOrderV2 uses order context and requested_size fallback', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        },
    })

    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async () =>
            new Response(
                JSON.stringify({
                    Data: [{ LogId: 'L1', OrderId: 'ORD-entry-3', Status: 'FinalFill', AveragePrice: 101.5 }],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
    })

    const result = await client.getExecutionPriceForOrderV2({
        id: 'evt-saxo-entry-v2',
        strategy: 'test',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 1000,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['ORD-entry-3'],
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
        broker_order_metadata: {
            kind: 'saxo_order_v1',
            order_id: 'ORD-entry-3',
            entry: {
                expected: { side: 'BUY', order_type: 'Market', size: 1000 },
                resolved: { order_id: 'ORD-entry-3' },
            },
            exits: [],
        },
    })

    assert.deepEqual(result.execution, { price: 101.5, size: 1000, executed_at: undefined })
})

test('SaxoClient.getClosingExecutionForOrderV2 aggregates resolved exit executions', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        },
    })

    const requestedOrderIds: string[] = []
    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            const orderId = new URL(String(url)).searchParams.get('OrderId')
            requestedOrderIds.push(orderId ?? '')
            const averagePrice = orderId === 'ORD-sl-4' ? 98 : 104
            return new Response(
                JSON.stringify({
                    Data: [{ LogId: `L-${orderId}`, OrderId: orderId, Status: 'FinalFill', AveragePrice: averagePrice }],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.getClosingExecutionForOrderV2({
        id: 'evt-saxo-close-v2',
        strategy: 'test',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 2,
        executed_size: 2,
        executed_price: 100,
        status: 'EXECUTED',
        provider_order_ids: ['ORD-entry-4'],
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
        broker_order_metadata: {
            kind: 'saxo_order_v1',
            order_id: 'ORD-entry-4',
            entry: {
                expected: { side: 'BUY', order_type: 'Market', size: 2 },
                resolved: { order_id: 'ORD-entry-4' },
            },
            exits: [
                {
                    expected: { role: 'STOP_LOSS', side: 'SELL', order_type: 'StopIfTraded', size: 0.5, price: 98 },
                    resolved: { order_id: 'ORD-sl-4' },
                },
                {
                    expected: { role: 'TAKE_PROFIT', side: 'SELL', order_type: 'Limit', size: 1.5, price: 104 },
                    resolved: { order_id: 'ORD-tp-4' },
                },
            ],
        },
    })

    assert.deepEqual(requestedOrderIds, ['ORD-sl-4', 'ORD-tp-4'])
    assert.deepEqual(result.execution, { price: 102.5, size: 2, executed_at: undefined })
})

test('SaxoClient.getClosingExecutionForOrderV2 uses filled related order and ignores unfilled sibling', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        },
    })

    const requestedOrderIds: string[] = []
    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            const orderId = new URL(String(url)).searchParams.get('OrderId')
            requestedOrderIds.push(orderId ?? '')
            const data = orderId === 'ORD-sl-single'
                ? [{ LogId: 'L-sl-single', OrderId: orderId, Status: 'FinalFill', AveragePrice: 97.5 }]
                : []
            return new Response(
                JSON.stringify({ Data: data }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.getClosingExecutionForOrderV2({
        id: 'evt-saxo-close-single',
        strategy: 'test',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 1,
        executed_size: 1,
        executed_price: 100,
        status: 'EXECUTED',
        provider_order_ids: ['ORD-entry-single'],
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
        broker_order_metadata: {
            kind: 'saxo_order_v1',
            order_id: 'ORD-entry-single',
            entry: {
                expected: { side: 'BUY', order_type: 'Market', size: 1 },
                resolved: { order_id: 'ORD-entry-single' },
            },
            exits: [
                {
                    expected: { role: 'STOP_LOSS', side: 'SELL', order_type: 'StopIfTraded', size: 1, price: 97.5 },
                    resolved: { order_id: 'ORD-sl-single' },
                },
                {
                    expected: { role: 'TAKE_PROFIT', side: 'SELL', order_type: 'Limit', size: 1, price: 103 },
                    resolved: { order_id: 'ORD-tp-single' },
                },
            ],
        },
    })

    assert.deepEqual(requestedOrderIds, ['ORD-sl-single', 'ORD-tp-single'])
    assert.deepEqual(result.execution, { price: 97.5, size: 1, executed_at: undefined })
})

test('SaxoClient.getClosingExecutionForOrderV2 no-ops when related order ids are unresolved', async () => {
    const client = new SaxoClient({ db: mockFirestore() })

    const result = await client.getClosingExecutionForOrderV2({
        id: 'evt-saxo-close-unresolved',
        strategy: 'test',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 1,
        executed_size: 1,
        executed_price: 100,
        status: 'EXECUTED',
        provider_order_ids: ['ORD-entry-unresolved'],
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
        broker_order_metadata: {
            kind: 'saxo_order_v1',
            order_id: 'ORD-entry-unresolved',
            entry: {
                expected: { side: 'BUY', order_type: 'Market', size: 1 },
                resolved: { order_id: 'ORD-entry-unresolved' },
            },
            exits: [
                {
                    expected: { role: 'STOP_LOSS', side: 'SELL', order_type: 'StopIfTraded', size: 1, price: 98 },
                    resolved: { order_id: null },
                },
            ],
        },
    })

    assert.equal(result.execution, null)
    assert.equal(result.brokerOrderMetadata?.kind, 'saxo_order_v1')
})
