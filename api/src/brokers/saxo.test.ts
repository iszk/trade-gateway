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
