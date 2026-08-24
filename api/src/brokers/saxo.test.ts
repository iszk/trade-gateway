import assert from 'node:assert/strict'
import test from 'node:test'
import type { Firestore } from 'firebase-admin/firestore'

import type { SaxoAuthStore } from './saxo-auth-store.js'
import type { OrderV2 } from '../types/order-v2.js'
import { SaxoClient as ProductionSaxoClient } from './saxo.js'

const TEST_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')

class SaxoClient extends ProductionSaxoClient {
    constructor(options: ConstructorParameters<typeof ProductionSaxoClient>[0] = {}) {
        super({ tokenEncryptionKey: TEST_TOKEN_ENCRYPTION_KEY, ...options })
    }
}

const mockFirestore = (data: Record<string, any> = {}) => {
    const store = { ...data }
    const db: any = {
        collection: (collectionPath: string) => ({
            doc: (docPath: string) => ({
                get: async () => ({
                    exists: store[`${collectionPath}/${docPath}`] !== undefined,
                    data: () => store[`${collectionPath}/${docPath}`],
                }),
                set: async (newData: any, options?: { merge?: boolean }) => {
                    store[`${collectionPath}/${docPath}`] = options?.merge
                        ? { ...store[`${collectionPath}/${docPath}`], ...newData }
                        : newData
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
                set: (ref: any, newData: any) => {
                    ref.set(newData)
                    return transaction
                },
            }
            return updateFunction(transaction)
        },
        _getStoredData: () => structuredClone(store),
    }
    return db as unknown as Firestore & { _getStoredData: () => Record<string, unknown> }
}

const createCapturingLogger = () => {
    const infoLogs: Array<{ obj: Record<string, unknown>, msg?: string }> = []
    const warnLogs: Array<{ obj: Record<string, unknown>, msg?: string }> = []
    const errorLogs: Array<{ obj: Record<string, unknown>, msg?: string }> = []

    const logger = {
        info: (obj: Record<string, unknown>, msg?: string) => {
            infoLogs.push({ obj, msg })
        },
        warn: (obj: Record<string, unknown>, msg?: string) => {
            warnLogs.push({ obj, msg })
        },
        error: (obj: Record<string, unknown>, msg?: string) => {
            errorLogs.push({ obj, msg })
        },
        child: () => logger,
    }

    return { logger, infoLogs, warnLogs, errorLogs }
}

const stringifyCapturedLogs = (
    logs: Array<{ obj: Record<string, unknown>, msg?: string }>,
): string => JSON.stringify(logs, (_key, value) => value instanceof Error
    ? { name: value.name, message: value.message }
    : value)

const makePendingSaxoOrder = (orderId: string): OrderV2 => ({
    id: `evt-${orderId}`,
    strategy: 'test',
    broker: 'saxo',
    ticker: 'FxSpot:21',
    side: 'BUY',
    order_type: 'MARKET',
    requested_size: 1,
    executed_size: 0,
    executed_price: null,
    status: 'PENDING',
    provider_order_ids: [orderId],
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    broker_order_metadata: {
        kind: 'saxo_order_v1',
        order_id: orderId,
        entry: {
            expected: { side: 'BUY', order_type: 'Market', size: 1 },
            resolved: { order_id: orderId },
        },
        exits: [],
    },
})

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
        tokenEncryptionKey: TEST_TOKEN_ENCRYPTION_KEY,
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

    const saved = db._getStoredData()['saxo_auth_data/saxo_auth'] as Record<string, unknown>
    assert.ok(saved.encryptedTokens)
    assert.equal('accessToken' in saved, false)
    assert.equal('refreshToken' in saved, false)
    assert.equal(JSON.stringify(saved).includes('new-access-token'), false)
    assert.equal(JSON.stringify(saved).includes('new-refresh-token'), false)
})

test('SaxoClient.exchangeCodeForToken は token endpoint の raw response body を Error に含めない', async () => {
    const sensitiveValues = [
        'oauth-body-access-token',
        'oauth-body-refresh-token',
        Buffer.alloc(32, 29).toString('base64'),
    ]
    let bodyCancelled = false
    const responseBody = new ReadableStream({
        start: (controller) => {
            controller.enqueue(Buffer.from(JSON.stringify({
                access_token: sensitiveValues[0],
                refresh_token: sensitiveValues[1],
                diagnostic: sensitiveValues[2],
            })))
        },
        cancel: () => {
            bodyCancelled = true
        },
    })
    const client = new SaxoClient({
        appKey: 'test-key',
        appSecret: 'test-secret',
        redirectUri: 'http://localhost/callback',
        authBaseUrl: 'https://auth.example.com',
        fetchImpl: async () => new Response(responseBody, { status: 401 }),
    })

    await assert.rejects(
        client.exchangeCodeForToken('test-code'),
        (error: unknown) => {
            assert.ok(error instanceof Error)
            assert.equal(error.message, 'Failed to exchange Saxo code (HTTP 401)')
            for (const secret of sensitiveValues) {
                assert.equal(error.message.includes(secret), false)
            }
            return true
        },
    )
    assert.equal(bodyCancelled, true)
})

test('SaxoClient.refreshAccessToken は token endpoint の raw response body を Error に含めない', async () => {
    const sensitiveValues = [
        'refresh-body-access-token',
        'refresh-body-refresh-token',
        Buffer.alloc(32, 31).toString('base64'),
    ]
    let bodyCancelAttempted = false
    const responseBody = new ReadableStream({
        start: (controller) => {
            controller.enqueue(Buffer.from(JSON.stringify({
                access_token: sensitiveValues[0],
                refresh_token: sensitiveValues[1],
                diagnostic: sensitiveValues[2],
            })))
        },
        cancel: () => {
            bodyCancelAttempted = true
            throw new Error(`cancel failed: ${sensitiveValues.join(' ')}`)
        },
    })
    const client = new SaxoClient({
        appKey: 'test-key',
        appSecret: 'test-secret',
        authBaseUrl: 'https://auth.example.com',
        fetchImpl: async () => new Response(responseBody, { status: 503 }),
    })

    await assert.rejects(
        client.refreshAccessToken('request-refresh-token'),
        (error: unknown) => {
            assert.ok(error instanceof Error)
            assert.equal(error.message, 'Failed to refresh Saxo token (HTTP 503)')
            for (const secret of sensitiveValues) {
                assert.equal(error.message.includes(secret), false)
            }
            return true
        },
    )
    assert.equal(bodyCancelAttempted, true)
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
    const saved = db._getStoredData()['saxo_auth_data/saxo_auth'] as Record<string, unknown>
    assert.ok(saved.encryptedTokens)
    assert.equal('accessToken' in saved, false)
    assert.equal('refreshToken' in saved, false)
    assert.equal('refreshingUntil' in saved, false)
    assert.equal(JSON.stringify(saved).includes('refreshed-token'), false)
    assert.equal(JSON.stringify(saved).includes('new-refresh-token'), false)
})

test('SaxoClient.getValidAccessToken は active refresh lease の待機 timeout を維持する', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'expired-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() - 1_000,
            refreshTokenExpiresAt: Date.now() + 86_400_000,
            refreshingUntil: Date.now() + 30_000,
        },
    })
    const { logger, warnLogs } = createCapturingLogger()
    const client = new SaxoClient({
        db,
        logger,
        refreshWaitIntervalMs: 0,
    })

    assert.equal(await client.getValidAccessToken(), null)
    assert.equal(
        warnLogs.some(({ obj }) => obj.event === 'saxo:token_refresh_timeout'),
        true,
    )
})

test('SaxoClient.getValidAccessToken は refresh 失敗後に lease を解放して再取得できる', async () => {
    const failedResponseSecrets = [
        'failed-refresh-access-token',
        'failed-refresh-refresh-token',
        Buffer.alloc(32, 37).toString('base64'),
    ]
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'expired-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() - 1_000,
            refreshTokenExpiresAt: Date.now() + 86_400_000,
        },
    })
    let tokenRequestCount = 0
    const { logger, warnLogs } = createCapturingLogger()
    const client = new SaxoClient({
        appKey: 'test-key',
        appSecret: 'test-secret',
        authBaseUrl: 'https://auth.example.com',
        baseUrl: 'https://api.example.com',
        db,
        logger,
        fetchImpl: async (url) => {
            if (url.toString().endsWith('/token')) {
                tokenRequestCount++
                if (tokenRequestCount === 1) {
                    return new Response(JSON.stringify({
                        access_token: failedResponseSecrets[0],
                        refresh_token: failedResponseSecrets[1],
                        diagnostic: failedResponseSecrets[2],
                    }), { status: 500 })
                }
                return new Response(JSON.stringify({
                    access_token: 'recovered-access-token',
                    refresh_token: 'recovered-refresh-token',
                    expires_in: 1_200,
                    refresh_token_expires_in: 86_400,
                }), { status: 200 })
            }
            return new Response(JSON.stringify({
                Data: [{
                    AccountKey: 'test-account-key',
                    ClientKey: 'test-client-key',
                    LegalAssetTypes: ['FxSpot'],
                    Currency: 'USD',
                    DisplayName: 'Primary',
                }],
            }), { status: 200 })
        },
    })

    assert.equal(await client.getValidAccessToken(), null)
    const capturedFailureLog = stringifyCapturedLogs(warnLogs)
    assert.equal(capturedFailureLog.includes('Failed to refresh Saxo token (HTTP 500)'), true)
    for (const secret of failedResponseSecrets) {
        assert.equal(capturedFailureLog.includes(secret), false)
    }
    const released = db._getStoredData()['saxo_auth_data/saxo_auth'] as Record<string, unknown>
    assert.ok((released.refreshingUntil as number) < Date.now())

    assert.equal(await client.getValidAccessToken(), 'recovered-access-token')
    const saved = db._getStoredData()['saxo_auth_data/saxo_auth'] as Record<string, unknown>
    assert.ok(saved.encryptedTokens)
    assert.equal('refreshingUntil' in saved, false)
    assert.equal('accessToken' in saved, false)
    assert.equal('refreshToken' in saved, false)
})

test('SaxoClient.getValidAccessToken は lease 取得後に refresh token が期限切れなら lease を解放する', async () => {
    const initialAuth = {
        accessToken: 'expired-access-token',
        refreshToken: 'initial-refresh-token',
        accessTokenExpiresAt: Date.now() - 1_000,
        refreshTokenExpiresAt: Date.now() + 86_400_000,
    }
    let releaseCount = 0
    const authStore = {
        getAuth: async () => initialAuth,
        acquireRefreshLease: async () => ({
            status: 'acquired' as const,
            auth: {
                ...initialAuth,
                refreshToken: 'expired-refresh-token',
                refreshTokenExpiresAt: Date.now() - 1_000,
            },
        }),
        releaseRefreshLease: async () => {
            releaseCount++
        },
    } as unknown as SaxoAuthStore
    const client = new SaxoClient({
        authStore,
        fetchImpl: async () => {
            throw new Error('token endpoint must not be called')
        },
    })

    assert.equal(await client.getValidAccessToken(), null)
    assert.equal(releaseCount, 1)
})

test('SaxoClient.getBalances fetches logged-in account balance and filters zero values', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        },
    })

    let capturedUrl = ''
    let capturedAuthorization = ''

    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async (url, init) => {
            capturedUrl = String(url)
            capturedAuthorization = new Headers(init?.headers).get('authorization') ?? ''
            return new Response(
                JSON.stringify({
                    Currency: 'USD',
                    CashBalance: 1000,
                    CashAvailableForTrading: 750,
                    TotalValue: 1250,
                    NetEquity: 0,
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.getBalances()

    assert.equal(capturedUrl, 'https://example.com/port/v1/balances/me')
    assert.equal(capturedAuthorization, 'Bearer valid-token')
    assert.deepEqual(result, [
        { asset: 'USD', amount: 1000 },
        { asset: 'USD_AVAILABLE_FOR_TRADING', amount: 750 },
        { asset: 'USD_TOTAL_VALUE', amount: 1250 },
    ])
})

test('SaxoClient.getBalances returns empty list when auth token is unavailable', async () => {
    const client = new SaxoClient({ db: mockFirestore() })
    const result = await client.getBalances()
    assert.deepEqual(result, [])
})

test('SaxoClient.getPositionsStrict rejects missing authentication instead of returning zero positions', async () => {
    const client = new SaxoClient({ db: mockFirestore() })
    await assert.rejects(client.getPositionsStrict(), /access token is unavailable/)
})

test('SaxoClient.getPositionsStrict returns a complete net-position snapshot', async () => {
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
        fetchImpl: async () => new Response(JSON.stringify({
            Data: [{
                NetPositionId: 'FxSpot:21__account-1',
                NetPositionBase: { Amount: 2, OpeningDirection: 'Sell' },
                NetPositionView: { AverageOpenPrice: 1.2, ProfitLossOnTrade: -3 },
            }],
        }), { status: 200 }),
    })

    assert.deepEqual(await client.getPositionsStrict(), [{
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'SELL',
        size: 2,
        price: 1.2,
        pnl: -3,
    }])
})

test('SaxoClient.getPortfolioSnapshot maps CFD value to equity contribution and caches instruments per client', async () => {
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
                    legalAssetTypes: ['CfdOnIndex', 'Stock'],
                    currency: 'JPY',
                    displayName: 'Main Account',
                },
            ],
        },
    })

    let instrumentDetailFetchCount = 0
    const requestedUrls: string[] = []
    const clientFetchImpl = async (url: Parameters<typeof fetch>[0]): Promise<Response> => {
        const urlString = String(url)
        requestedUrls.push(urlString)
        if (urlString.endsWith('/port/v1/balances/me')) {
            return new Response(
                JSON.stringify({
                    Currency: 'JPY',
                    CashBalance: 100000,
                    CashAvailableForTrading: 90000,
                    TotalValue: 132000,
                    NetEquity: 132000,
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        }
        if (urlString.endsWith('/port/v1/netpositions/me')) {
            return new Response(
                JSON.stringify({
                    Data: [
                        {
                            NetPositionId: 'CfdOnIndex:111111__account-1',
                            NetPositionBase: {
                                AccountKey: 'account-1',
                                AssetType: 'CfdOnIndex',
                                Uic: 111111,
                                Amount: 2,
                                OpeningDirection: 'Buy',
                            },
                            NetPositionView: {
                                AverageOpenPrice: 5500,
                                ProfitLossOnTrade: 200,
                                Exposure: 11000,
                                Currency: 'USD',
                            },
                        },
                        {
                            NetPositionId: 'Stock:222222__account-1',
                            NetPositionBase: {
                                AccountKey: 'account-1',
                                AssetType: 'Stock',
                                Uic: 222222,
                                Amount: 3,
                                OpeningDirection: 'Buy',
                            },
                            NetPositionView: {
                                AverageOpenPrice: 500,
                                MarketValue: 1500,
                                ProfitLossOnTrade: 30,
                                Currency: 'USD',
                            },
                        },
                    ],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        }
        if (urlString.endsWith('/ref/v1/instruments/details/111111/CfdOnIndex')) {
            instrumentDetailFetchCount += 1
            return new Response(
                JSON.stringify({
                    Uic: 111111,
                    AssetType: 'CfdOnIndex',
                    DisplayAndFormat: {
                        Symbol: 'US500.I',
                        Description: 'US 500 CFD',
                        Currency: 'USD',
                    },
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        }
        if (urlString.endsWith('/ref/v1/instruments/details/222222/Stock')) {
            instrumentDetailFetchCount += 1
            return new Response(
                JSON.stringify({
                    Uic: 222222,
                    AssetType: 'Stock',
                    Symbol: 'VOO:xarc',
                    Description: 'Vanguard S&P 500 ETF',
                    CurrencyCode: 'USD',
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        }
        return new Response('Not Found', { status: 404 })
    }

    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: clientFetchImpl,
    })

    const snapshot = await client.getPortfolioSnapshot()
    await client.getPortfolioSnapshot()

    assert.equal(snapshot.schemaVersion, 'portfolio-snapshot.v1')
    assert.equal(snapshot.baseCurrency, 'JPY')
    assert.equal(snapshot.sourceMetadata?.reportedCurrency, 'JPY')
    assert.equal(snapshot.accounts[0]?.sourceAccountId, 'account-1')
    assert.deepEqual(snapshot.cashBalances[0], {
        sourceAccountId: 'client:client-1',
        currency: 'JPY',
        amount: '100000',
        valueJpy: '100000',
        fxRateToJpy: '1',
        sourceBalanceId: 'client:client-1:JPY:CashBalance',
        sourceMetadata: {
            sourceEndpoint: '/port/v1/balances/me',
            sourceField: 'CashBalance',
            sourceScope: 'client',
            currencyAssumption: 'client_aggregate_jpy',
            reportedCurrency: 'JPY',
        },
    })

    const cfd = snapshot.positions.find((position) => position.sourceInstrumentId === 'CfdOnIndex:111111')
    assert.equal(cfd?.assetClass, 'cfd')
    assert.equal(cfd?.symbol, 'US500.I')
    assert.equal(cfd?.valueJpy, '32000')
    assert.equal(cfd?.unrealizedPnlJpy, '32000')
    assert.equal(cfd?.sourceMetadata?.valuationBasis, 'equity_contribution')
    assert.equal(cfd?.sourceMetadata?.notionalValueJpy, '1760000')

    const stock = snapshot.positions.find((position) => position.sourceInstrumentId === 'Stock:222222')
    assert.equal(stock?.assetClass, 'stock')
    assert.equal(stock?.symbol, 'VOO:xarc')
    assert.equal(stock?.name, 'Vanguard S&P 500 ETF')
    assert.equal(stock?.valueJpy, '240000')

    assert.equal(instrumentDetailFetchCount, 2)
    assert.equal(requestedUrls.filter((url) => url.includes('/ref/v1/instruments/details/')).length, 2)

    const anotherClient = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: clientFetchImpl,
    })
    await anotherClient.getPortfolioSnapshot()
    assert.equal(instrumentDetailFetchCount, 4)
    assert.equal(requestedUrls.filter((url) => url.includes('/ref/v1/instruments/details/')).length, 4)
})

test('SaxoClient.getPortfolioSnapshot skips unsupported FX currencies without failing snapshot', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [
                {
                    accountKey: 'account-eur',
                    clientKey: 'client-eur',
                    legalAssetTypes: ['Stock'],
                    currency: 'EUR',
                    displayName: 'EUR Account',
                },
            ],
        },
    })

    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            const urlString = String(url)
            if (urlString.endsWith('/port/v1/balances/me')) {
                return new Response(
                    JSON.stringify({
                        Currency: 'EUR',
                        CashBalance: 100,
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            if (urlString.endsWith('/port/v1/netpositions/me')) {
                return new Response(
                    JSON.stringify({
                        Data: [
                            {
                                NetPositionId: 'Stock:333333__account-eur',
                                NetPositionBase: {
                                    AccountKey: 'account-eur',
                                    AssetType: 'Stock',
                                    Uic: 333333,
                                    Amount: 1,
                                    OpeningDirection: 'Buy',
                                },
                                NetPositionView: {
                                    MarketValue: 100,
                                    Currency: 'EUR',
                                },
                            },
                        ],
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            if (urlString.endsWith('/ref/v1/instruments/details/333333/Stock')) {
                return new Response(
                    JSON.stringify({
                        Uic: 333333,
                        AssetType: 'Stock',
                        Symbol: 'EURSTK:xeur',
                        Description: 'EUR Stock',
                        CurrencyCode: 'EUR',
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            return new Response('Not Found', { status: 404 })
        },
    })

    const snapshot = await client.getPortfolioSnapshot()

    assert.equal(snapshot.sourceMetadata?.reportedCurrency, 'EUR')
    assert.deepEqual(snapshot.cashBalances, [
        {
            sourceAccountId: 'client:client-eur',
            currency: 'JPY',
            amount: '100',
            valueJpy: '100',
            fxRateToJpy: '1',
            sourceBalanceId: 'client:client-eur:JPY:CashBalance',
            sourceMetadata: {
                sourceEndpoint: '/port/v1/balances/me',
                sourceField: 'CashBalance',
                sourceScope: 'client',
                currencyAssumption: 'client_aggregate_jpy',
                reportedCurrency: 'EUR',
            },
        },
    ])
    assert.deepEqual(snapshot.positions, [])
    assert.deepEqual(snapshot.sourceMetadata?.skippedPositions, [
        {
            sourcePositionId: 'Stock:333333__account-eur',
            sourceInstrumentId: 'Stock:333333',
            reason: 'unsupported_fx_rate',
            currency: 'EUR',
        },
    ])
})

test('SaxoClient.getPortfolioSnapshot keeps leveraged positions with metadata when only notional FX or PnL is missing', async () => {
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
                    currency: 'JPY',
                    displayName: 'Main Account',
                },
            ],
        },
    })

    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            const urlString = String(url)
            if (urlString.endsWith('/port/v1/balances/me')) {
                return new Response(
                    JSON.stringify({
                        Currency: 'JPY',
                        CashBalance: 100000,
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            if (urlString.endsWith('/port/v1/netpositions/me')) {
                return new Response(
                    JSON.stringify({
                        Data: [
                            {
                                NetPositionId: 'CfdOnIndex:444444__account-1',
                                NetPositionBase: {
                                    AccountKey: 'account-1',
                                    AssetType: 'CfdOnIndex',
                                    Uic: 444444,
                                    Amount: 1,
                                    OpeningDirection: 'Buy',
                                },
                                NetPositionView: {
                                    Exposure: 100,
                                    Currency: 'EUR',
                                },
                            },
                            {
                                NetPositionId: 'CfdOnIndex:555555__account-1',
                                NetPositionBase: {
                                    AccountKey: 'account-1',
                                    AssetType: 'CfdOnIndex',
                                    Uic: 555555,
                                    Amount: 1,
                                    OpeningDirection: 'Buy',
                                },
                                NetPositionView: {
                                    Exposure: 100,
                                    ProfitLossOnTrade: 10,
                                    Currency: 'EUR',
                                },
                            },
                        ],
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            if (urlString.endsWith('/ref/v1/instruments/details/444444/CfdOnIndex')) {
                return new Response(
                    JSON.stringify({
                        Uic: 444444,
                        AssetType: 'CfdOnIndex',
                        Symbol: 'EURCFD1',
                        CurrencyCode: 'EUR',
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            if (urlString.endsWith('/ref/v1/instruments/details/555555/CfdOnIndex')) {
                return new Response(
                    JSON.stringify({
                        Uic: 555555,
                        AssetType: 'CfdOnIndex',
                        Symbol: 'EURCFD2',
                        CurrencyCode: 'EUR',
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            return new Response('Not Found', { status: 404 })
        },
    })

    const snapshot = await client.getPortfolioSnapshot()

    assert.equal(snapshot.positions.length, 1)
    const missingPnlPosition = snapshot.positions[0]
    assert.equal(missingPnlPosition?.sourceInstrumentId, 'CfdOnIndex:444444')
    assert.equal(missingPnlPosition?.valueJpy, '0')
    assert.equal(missingPnlPosition?.unrealizedPnlJpy, undefined)
    assert.equal(missingPnlPosition?.sourceMetadata?.valuationBasis, 'equity_contribution')
    assert.equal(missingPnlPosition?.sourceMetadata?.valuationStatus, 'missing_unrealized_pnl')
    assert.equal(missingPnlPosition?.sourceMetadata?.notionalValueJpy, undefined)
    assert.equal(missingPnlPosition?.sourceMetadata?.notionalValueStatus, 'unsupported_fx_rate')
    assert.deepEqual(snapshot.sourceMetadata?.skippedPositions, [
        {
            sourcePositionId: 'CfdOnIndex:555555__account-1',
            sourceInstrumentId: 'CfdOnIndex:555555',
            reason: 'unsupported_fx_rate',
            currency: 'EUR',
        },
    ])
})

test('SaxoClient.getPortfolioSnapshot uses each position account currency for base-currency fields', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [
                {
                    accountKey: 'account-jpy',
                    clientKey: 'client-jpy',
                    legalAssetTypes: ['Stock', 'CfdOnIndex'],
                    currency: 'JPY',
                    displayName: 'JPY Account',
                },
                {
                    accountKey: 'account-usd',
                    clientKey: 'client-usd',
                    legalAssetTypes: ['Stock', 'CfdOnIndex'],
                    currency: 'USD',
                    displayName: 'USD Account',
                },
            ],
        },
    })

    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            const urlString = String(url)
            if (urlString.endsWith('/port/v1/balances/me')) {
                return new Response(
                    JSON.stringify({
                        Currency: 'JPY',
                        CashBalance: 100000,
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            if (urlString.endsWith('/port/v1/netpositions/me')) {
                return new Response(
                    JSON.stringify({
                        Data: [
                            {
                                NetPositionId: 'CfdOnIndex:666666__account-usd',
                                NetPositionBase: {
                                    AccountKey: 'account-usd',
                                    AssetType: 'CfdOnIndex',
                                    Uic: 666666,
                                    Amount: 1,
                                    OpeningDirection: 'Buy',
                                },
                                NetPositionView: {
                                    ExposureInBaseCurrency: 100,
                                    ProfitLossOnTradeInBaseCurrency: 10,
                                    Currency: 'USD',
                                },
                            },
                            {
                                NetPositionId: 'Stock:777777__account-usd',
                                NetPositionBase: {
                                    AccountKey: 'account-usd',
                                    AssetType: 'Stock',
                                    Uic: 777777,
                                    Amount: 1,
                                    OpeningDirection: 'Buy',
                                },
                                NetPositionView: {
                                    MarketValueInBaseCurrency: 200,
                                    Currency: 'USD',
                                },
                            },
                        ],
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            if (urlString.endsWith('/ref/v1/instruments/details/666666/CfdOnIndex')) {
                return new Response(
                    JSON.stringify({
                        Uic: 666666,
                        AssetType: 'CfdOnIndex',
                        Symbol: 'USDCFD',
                        CurrencyCode: 'USD',
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            if (urlString.endsWith('/ref/v1/instruments/details/777777/Stock')) {
                return new Response(
                    JSON.stringify({
                        Uic: 777777,
                        AssetType: 'Stock',
                        Symbol: 'USDSTK',
                        CurrencyCode: 'USD',
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            return new Response('Not Found', { status: 404 })
        },
    })

    const snapshot = await client.getPortfolioSnapshot()

    const cfd = snapshot.positions.find((position) => position.sourceInstrumentId === 'CfdOnIndex:666666')
    assert.equal(cfd?.sourceAccountId, 'account-usd')
    assert.equal(cfd?.valueJpy, '1600')
    assert.equal(cfd?.unrealizedPnlJpy, '1600')
    assert.equal(cfd?.sourceMetadata?.notionalValueJpy, '16000')

    const stock = snapshot.positions.find((position) => position.sourceInstrumentId === 'Stock:777777')
    assert.equal(stock?.sourceAccountId, 'account-usd')
    assert.equal(stock?.valueJpy, '32000')
    assert.equal(stock?.sourceMetadata?.valuationBasis, 'market_value_in_base_currency')
})

test('SaxoClient.getPortfolioSnapshot falls back when instrument details fetch or JSON parsing fails', async () => {
    const { logger, warnLogs } = createCapturingLogger()
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
                    legalAssetTypes: ['Stock'],
                    currency: 'JPY',
                    displayName: 'Main Account',
                },
            ],
        },
    })

    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        logger,
        fetchImpl: async (url) => {
            const urlString = String(url)
            if (urlString.endsWith('/port/v1/balances/me')) {
                return new Response(
                    JSON.stringify({
                        Currency: 'JPY',
                        CashBalance: 100000,
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            if (urlString.endsWith('/port/v1/netpositions/me')) {
                return new Response(
                    JSON.stringify({
                        Data: [
                            {
                                NetPositionId: 'Stock:888888__account-1',
                                NetPositionBase: {
                                    AccountKey: 'account-1',
                                    AssetType: 'Stock',
                                    Uic: 888888,
                                    Amount: 1,
                                    OpeningDirection: 'Buy',
                                },
                                NetPositionView: {
                                    MarketValue: 1000,
                                    Currency: 'JPY',
                                },
                            },
                            {
                                NetPositionId: 'Stock:999999__account-1',
                                NetPositionBase: {
                                    AccountKey: 'account-1',
                                    AssetType: 'Stock',
                                    Uic: 999999,
                                    Amount: 2,
                                    OpeningDirection: 'Buy',
                                },
                                NetPositionView: {
                                    MarketValue: 2000,
                                    Currency: 'JPY',
                                },
                            },
                        ],
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            if (urlString.endsWith('/ref/v1/instruments/details/888888/Stock')) {
                throw new Error('network unavailable')
            }
            if (urlString.endsWith('/ref/v1/instruments/details/999999/Stock')) {
                return new Response('not-json', { status: 200, headers: { 'content-type': 'application/json' } })
            }
            return new Response('Not Found', { status: 404 })
        },
    })

    const snapshot = await client.getPortfolioSnapshot()

    const fetchFailedPosition = snapshot.positions.find((position) => position.sourceInstrumentId === 'Stock:888888')
    assert.equal(fetchFailedPosition?.symbol, 'Stock:888888')
    assert.equal(fetchFailedPosition?.sourceMetadata?.instrumentLookupStatus, 'fallback')

    const parseFailedPosition = snapshot.positions.find((position) => position.sourceInstrumentId === 'Stock:999999')
    assert.equal(parseFailedPosition?.symbol, 'Stock:999999')
    assert.equal(parseFailedPosition?.sourceMetadata?.instrumentLookupStatus, 'fallback')

    assert.equal(
        warnLogs.some((log) => log.obj.event === 'saxo:instrument_details_failed' && log.obj.uic === 888888),
        true,
    )
    assert.equal(
        warnLogs.some((log) => log.obj.event === 'saxo:instrument_details_parse_failed' && log.obj.uic === 999999),
        true,
    )
})

test('SaxoClient.getPortfolioSnapshot limits concurrent instrument detail fetches', async () => {
    const positionCount = 8
    const positions = Array.from({ length: positionCount }, (_, index) => {
        const uic = 400000 + index
        return {
            NetPositionId: `Stock:${uic}__account-1`,
            NetPositionBase: {
                AccountKey: 'account-1',
                AssetType: 'Stock',
                Uic: uic,
                Amount: 1,
                OpeningDirection: 'Buy',
            },
            NetPositionView: {
                MarketValue: 1000 + index,
                Currency: 'JPY',
            },
        }
    })
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
                    legalAssetTypes: ['Stock'],
                    currency: 'JPY',
                    displayName: 'Main Account',
                },
            ],
        },
    })

    let activeInstrumentDetailFetches = 0
    let maxActiveInstrumentDetailFetches = 0
    let instrumentDetailFetchCount = 0
    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            const urlString = String(url)
            if (urlString.endsWith('/port/v1/balances/me')) {
                return new Response(
                    JSON.stringify({
                        Currency: 'JPY',
                        CashBalance: 100000,
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            if (urlString.endsWith('/port/v1/netpositions/me')) {
                return new Response(
                    JSON.stringify({ Data: positions }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            if (urlString.includes('/ref/v1/instruments/details/')) {
                instrumentDetailFetchCount += 1
                activeInstrumentDetailFetches += 1
                maxActiveInstrumentDetailFetches = Math.max(
                    maxActiveInstrumentDetailFetches,
                    activeInstrumentDetailFetches,
                )
                await new Promise((resolve) => setTimeout(resolve, 10))
                activeInstrumentDetailFetches -= 1
                const uic = Number(urlString.match(/\/details\/(\d+)\/Stock$/)?.[1])
                return new Response(
                    JSON.stringify({
                        Uic: uic,
                        AssetType: 'Stock',
                        Symbol: `STK${uic}`,
                        CurrencyCode: 'JPY',
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                )
            }
            return new Response('Not Found', { status: 404 })
        },
    })

    const snapshot = await client.getPortfolioSnapshot()

    assert.equal(snapshot.positions.length, positionCount)
    assert.equal(instrumentDetailFetchCount, positionCount)
    assert.ok(
        maxActiveInstrumentDetailFetches <= 5,
        `expected at most 5 concurrent instrument detail fetches, got ${maxActiveInstrumentDetailFetches}`,
    )
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
    assert.equal(requestBody.ExternalReference, 'tg:evt-saxo-meta-1')
    assert.equal(requestBody.Orders.length, 2)
    assert.equal(requestBody.Orders[0].ExternalReference, 'tg:evt-saxo-meta-1')
    assert.deepEqual(result.ok && result.brokerOrderMetadata, {
        kind: 'saxo_order_v1',
        order_id: 'ORD-entry-1',
        external_reference: 'tg:evt-saxo-meta-1',
        entry: {
            expected: { side: 'BUY', order_type: 'Market', size: 2 },
            resolved: { order_id: 'ORD-entry-1', external_reference: 'tg:evt-saxo-meta-1' },
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
                resolved: { order_id: 'ORD-sl-1', external_reference: 'tg:evt-saxo-meta-1' },
            },
            {
                expected: {
                    role: 'TAKE_PROFIT',
                    side: 'SELL',
                    order_type: 'Limit',
                    size: 2,
                    price: 103,
                },
                resolved: { order_id: 'ORD-tp-1', external_reference: 'tg:evt-saxo-meta-1' },
            },
        ],
    })
})

test('SaxoClient.sendMarketOrder returns Saxo entry metadata for standalone market orders', async () => {
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
                    legalAssetTypes: ['FxSpot'],
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
                JSON.stringify({ OrderId: 'ORD-market-1' }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.sendMarketOrder({
        eventId: 'evt-saxo-market-1',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'SELL',
        size: 1000,
        requestId: 'req-saxo-market-1',
    })

    assert.equal(result.ok, true)
    assert.equal(requestBody.Orders, undefined)
    assert.deepEqual(result.ok && result.brokerOrderMetadata, {
        kind: 'saxo_order_v1',
        order_id: 'ORD-market-1',
        external_reference: 'tg:evt-saxo-market-1',
        entry: {
            expected: { side: 'SELL', order_type: 'Market', size: 1000 },
            resolved: { order_id: 'ORD-market-1', external_reference: 'tg:evt-saxo-market-1' },
        },
        exits: [],
    })
})

test('SaxoClient.sendMarketOrder keeps related order ids nullable when response omits them', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [{
                accountKey: 'account-1',
                clientKey: 'client-1',
                legalAssetTypes: ['FxSpot'],
                currency: 'USD',
                displayName: 'Primary',
            }],
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

test('SaxoClient.sendMarketOrder classifies explicit rejection, HTTP 408, and transport uncertainty', async () => {
    const authData = {
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [{
                accountKey: 'account-1',
                clientKey: 'client-1',
                legalAssetTypes: ['FxSpot'],
                currency: 'USD',
                displayName: 'Primary',
            }],
        },
    }
    const makeOrder = () => ({
        eventId: 'evt-saxo-certainty',
        broker: 'saxo' as const,
        ticker: 'FxSpot:21',
        side: 'BUY' as const,
        size: 1,
        requestId: 'req-saxo-certainty',
    })

    const rejectionClient = new SaxoClient({
        db: mockFirestore(authData),
        baseUrl: 'https://example.com',
        fetchImpl: async () => new Response('invalid order', { status: 400 }),
    })
    const rejection = await rejectionClient.sendMarketOrder(makeOrder())
    assert.equal(rejection.ok, false)
    assert.equal(!rejection.ok && rejection.certainty, 'CONFIRMED_FAILURE')

    const serverErrorClient = new SaxoClient({
        db: mockFirestore(authData),
        baseUrl: 'https://example.com',
        fetchImpl: async () => new Response('temporary', { status: 503 }),
    })
    const serverError = await serverErrorClient.sendMarketOrder(makeOrder())
    assert.equal(serverError.ok, false)
    assert.equal(!serverError.ok && serverError.certainty, 'UNKNOWN')

    const requestTimeoutClient = new SaxoClient({
        db: mockFirestore(authData),
        baseUrl: 'https://example.com',
        fetchImpl: async () => new Response('request timeout', { status: 408 }),
    })
    const requestTimeout = await requestTimeoutClient.sendMarketOrder(makeOrder())
    assert.equal(requestTimeout.ok, false)
    assert.equal(!requestTimeout.ok && requestTimeout.certainty, 'UNKNOWN')

    const malformedResponseClient = new SaxoClient({
        db: mockFirestore(authData),
        baseUrl: 'https://example.com',
        fetchImpl: async () => new Response('{}', { status: 200 }),
    })
    const malformedResponse = await malformedResponseClient.sendMarketOrder(makeOrder())
    assert.equal(malformedResponse.ok, false)
    assert.equal(!malformedResponse.ok && malformedResponse.certainty, 'UNKNOWN')
})

test('SaxoClient.getExecutionPriceForOrderV2 uses batched audit activities and fill amount', async () => {
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
                        { LogId: 'L1', OrderId: 'ORD-entry-3', Status: 'Fill', ExecutionPrice: 101, FillAmount: 400, FilledAmount: 400, ActivityTime: '2026-01-01T00:05:00Z' },
                        { LogId: 'L2', OrderId: 'ORD-entry-3', Status: 'FinalFill', ExecutionPrice: 102, FillAmount: 600, FilledAmount: 1000, ActivityTime: '2026-01-01T00:06:00Z' },
                    ],
                    __nextPoll: '/cs/v1/audit/orderactivities/subscriptions/sub-1',
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
            exits: [{
                expected: {
                    role: 'TAKE_PROFIT',
                    side: 'SELL',
                    order_type: 'Limit',
                    size: 1000,
                    price: 110,
                },
                resolved: { order_id: 'ORD-entry-3-limit' },
            }],
        },
    })

    assert.deepEqual(result.execution, { price: 102, size: 1000, executed_at: new Date('2026-01-01T00:06:00Z') })
})

test('SaxoClient.getExecutionPricesForOrdersV2 は batch miss だけ direct lookup して約定を救済する', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [{ accountKey: 'account', clientKey: 'client-key', legalAssetTypes: ['FxSpot'], currency: 'USD', displayName: 'Primary' }],
        },
    })
    const requestedUrls: string[] = []
    const { logger, infoLogs } = createCapturingLogger()
    const client = new SaxoClient({
        db,
        logger: logger as any,
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            const parsedUrl = new URL(String(url))
            requestedUrls.push(parsedUrl.toString())
            if (parsedUrl.searchParams.has('OrderId')) {
                return Response.json({
                    Data: [{ LogId: 'direct-fill', OrderId: 'ORD-direct', Status: 'FinalFill', ExecutionPrice: 101, FillAmount: 1 }],
                })
            }
            return Response.json({ Data: [{ LogId: 'other', OrderId: 'ORD-other', Status: 'Working', SubStatus: 'Confirmed' }] })
        },
        sleepImpl: async () => { },
    })

    const result = await client.getExecutionPricesForOrdersV2(
        [makePendingSaxoOrder('ORD-direct')],
        { now: new Date('2026-07-17T00:00:00Z') },
    )

    assert.deepEqual(result.get('evt-ORD-direct')?.execution, { price: 101, size: 1, executed_at: undefined })
    assert.equal(requestedUrls.length, 2)
    const directUrl = new URL(requestedUrls[1] as string)
    assert.equal(directUrl.searchParams.get('ClientKey'), 'client-key')
    assert.equal(directUrl.searchParams.get('OrderId'), 'ORD-direct')
    assert.equal(directUrl.searchParams.get('EntryType'), 'All')
    assert.equal(directUrl.searchParams.get('$top'), '500')
    const summary = infoLogs.find((log) => log.obj.event === 'saxo:orderactivities_reconciliation_summary')
    assert.equal(summary?.obj.directCandidates, 1)
    assert.equal(summary?.obj.attempted, 1)
    assert.equal(summary?.obj.recovered, 1)
    const state = db._getStoredData()['cron_metadata/saxo_orderactivities_reconciliation_state'] as Record<string, unknown>
    assert.equal(state.direct_lookup_after_order_id, 'ORD-direct')
    assert.equal(state.last_direct_lookup_at, '2026-07-17T00:00:00.000Z')
})

test('SaxoClient.reconcileExecutionPricesForOrdersV2 は range を全ページ取得し LogId dedupe する', async () => {
    const initialPollState = {
        last_poll_at: '2026-07-16T23:00:00.000Z',
        next_poll_url: '/poll-existing',
    }
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [{ accountKey: 'account', clientKey: 'client-key', legalAssetTypes: ['FxSpot'], currency: 'USD', displayName: 'Primary' }],
        },
        'cron_metadata/saxo_orderactivities_poll_state': initialPollState,
        'cron_metadata/saxo_orderactivities_reconciliation_state': {
            direct_lookup_after_order_id: 'ORD-direct',
            last_direct_lookup_at: '2026-07-16T23:00:00.000Z',
        },
    })
    const requestedUrls: string[] = []
    const { logger, infoLogs } = createCapturingLogger()
    const order = {
        ...makePendingSaxoOrder('ORD-range'),
        created_at: new Date('2026-07-16T12:00:00Z'),
    }
    const client = new SaxoClient({
        db,
        logger: logger as any,
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            requestedUrls.push(String(url))
            if (requestedUrls.length === 1) {
                return Response.json({
                    Data: [
                        { LogId: '1', OrderId: 'ORD-range', Status: 'Fill', SubStatus: 'Confirmed', ExecutionPrice: 100, FillAmount: 0.4 },
                        { LogId: '2', OrderId: 'ORD-range', Status: 'Fill', SubStatus: 'Confirmed', ExecutionPrice: 110, FillAmount: 0.3 },
                    ],
                    __next: '/range-page-2',
                    __nextPoll: '/must-not-be-saved',
                })
            }
            return Response.json({
                Data: [
                    { LogId: '2', OrderId: 'ORD-range', Status: 'Fill', SubStatus: 'Confirmed', ExecutionPrice: 110, FillAmount: 0.3 },
                    { LogId: '3', OrderId: 'ORD-range', Status: 'FinalFill', SubStatus: 'Confirmed', ExecutionPrice: 120, FillAmount: 0.3 },
                ],
                __nextPoll: '/must-not-be-saved-2',
            })
        },
    })

    const result = await client.reconcileExecutionPricesForOrdersV2(
        [order],
        { from: new Date('2026-07-15T00:00:00Z'), to: new Date('2026-07-17T00:00:00Z') },
    )

    assert.equal(requestedUrls.length, 2)
    const rangeUrl = new URL(requestedUrls[0] as string)
    assert.equal(rangeUrl.searchParams.get('ClientKey'), 'client-key')
    assert.equal(rangeUrl.searchParams.get('FromDateTime'), '2026-07-15T00:00:00.000Z')
    assert.equal(rangeUrl.searchParams.get('ToDateTime'), '2026-07-17T00:00:00.000Z')
    assert.equal(rangeUrl.searchParams.get('EntryType'), 'All')
    assert.equal(rangeUrl.searchParams.get('$top'), '500')
    assert.deepEqual(result.get(order.id)?.execution, { price: 109, size: 1, executed_at: undefined })
    assert.deepEqual(db._getStoredData()['cron_metadata/saxo_orderactivities_poll_state'], initialPollState)
    const reconciliationState = db._getStoredData()['cron_metadata/saxo_orderactivities_reconciliation_state'] as Record<string, unknown>
    assert.equal(reconciliationState.direct_lookup_after_order_id, 'ORD-direct')
    assert.equal(reconciliationState.last_reconciliation_outcome, 'COMPLETE')
    assert.equal(reconciliationState.last_reconciliation_window_from, '2026-07-15T00:00:00.000Z')
    assert.equal(reconciliationState.last_reconciliation_window_to, '2026-07-17T00:00:00.000Z')
    assert.equal(typeof reconciliationState.last_reconciliation_completed_at, 'string')
    const summary = infoLogs.find((log) => log.obj.event === 'saxo:orderactivities_reconciliation_summary')
    assert.equal(summary?.obj.activity, 3)
    assert.equal(summary?.obj.matched, 1)
    assert.equal(summary?.obj.executed, 1)
    assert.equal(summary?.obj.pageCount, 2)
    assert.equal(summary?.obj.outcome, 'COMPLETE')
})

test('SaxoClient.reconcileExecutionPricesForOrdersV2 は INCOMPLETE window を再試行し partial を返さない', async () => {
    const initialPollState = {
        last_poll_at: '2026-07-16T23:00:00.000Z',
        next_poll_url: '/poll-existing',
    }
    const retryState = {
        direct_lookup_after_order_id: 'ORD-direct',
        last_reconciliation_outcome: 'INCOMPLETE',
        last_reconciliation_window_from: '2026-07-14T00:00:00.000Z',
        last_reconciliation_window_to: '2026-07-15T00:00:00.000Z',
    }
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [{ accountKey: 'account', clientKey: 'client-key', legalAssetTypes: ['FxSpot'], currency: 'USD', displayName: 'Primary' }],
        },
        'cron_metadata/saxo_orderactivities_poll_state': initialPollState,
        'cron_metadata/saxo_orderactivities_reconciliation_state': retryState,
    })
    const requestedUrls: string[] = []
    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            requestedUrls.push(String(url))
            return requestedUrls.length === 1
                ? Response.json({ Data: [{ LogId: 'partial', OrderId: 'ORD-retry', Status: 'Fill', ExecutionPrice: 100, FillAmount: 1 }], __next: '/retry-page-2' })
                : new Response('failed', { status: 503 })
        },
    })

    const result = await client.reconcileExecutionPricesForOrdersV2(
        [{ ...makePendingSaxoOrder('ORD-retry'), created_at: new Date('2026-07-14T12:00:00Z') }],
        { from: new Date('2026-07-15T00:00:00Z'), to: new Date('2026-07-17T00:00:00Z') },
    )

    assert.equal(result.size, 0)
    assert.equal(requestedUrls.length, 2)
    const retryUrl = new URL(requestedUrls[0] as string)
    assert.equal(retryUrl.searchParams.get('FromDateTime'), retryState.last_reconciliation_window_from)
    assert.equal(retryUrl.searchParams.get('ToDateTime'), retryState.last_reconciliation_window_to)
    assert.deepEqual(db._getStoredData()['cron_metadata/saxo_orderactivities_poll_state'], initialPollState)
    const savedState = db._getStoredData()['cron_metadata/saxo_orderactivities_reconciliation_state'] as Record<string, unknown>
    assert.equal(savedState.direct_lookup_after_order_id, 'ORD-direct')
    assert.equal(savedState.last_reconciliation_outcome, 'INCOMPLETE')
    assert.equal(savedState.last_reconciliation_window_from, retryState.last_reconciliation_window_from)
    assert.equal(savedState.last_reconciliation_window_to, retryState.last_reconciliation_window_to)
})

test('SaxoClient.reconcileExecutionPricesForOrdersV2 は ClientKey 欠落時にAPIを呼ばず incomplete にする', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [{ accountKey: 'account', clientKey: '', legalAssetTypes: ['FxSpot'], currency: 'USD', displayName: 'Primary' }],
        },
    })
    let requestCount = 0
    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async () => {
            requestCount += 1
            return Response.json({ Data: [] })
        },
    })

    const result = await client.reconcileExecutionPricesForOrdersV2(
        [{ ...makePendingSaxoOrder('ORD-no-client-key'), created_at: new Date('2026-07-16T12:00:00Z') }],
        { from: new Date('2026-07-15T00:00:00Z'), to: new Date('2026-07-17T00:00:00Z') },
    )

    assert.equal(requestCount, 0)
    assert.equal(result.size, 0)
    const state = db._getStoredData()['cron_metadata/saxo_orderactivities_reconciliation_state'] as Record<string, unknown>
    assert.equal(state.last_reconciliation_outcome, 'INCOMPLETE')
})

test('SaxoClient.reconcileExecutionPricesForOrdersV2 は window end から24時間超の stale order を除外する', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [{ accountKey: 'account', clientKey: 'client-key', legalAssetTypes: ['FxSpot'], currency: 'USD', displayName: 'Primary' }],
        },
    })
    let requestCount = 0
    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async () => {
            requestCount += 1
            return Response.json({ Data: [{ LogId: 'fresh', OrderId: 'ORD-fresh', Status: 'FinalFill', ExecutionPrice: 100, FillAmount: 1 }] })
        },
    })

    const fresh = { ...makePendingSaxoOrder('ORD-fresh'), created_at: new Date('2026-07-16T12:00:00Z') }
    const stale = { ...makePendingSaxoOrder('ORD-stale'), created_at: new Date('2026-07-15T23:59:59Z') }
    const result = await client.reconcileExecutionPricesForOrdersV2(
        [fresh, stale],
        { from: new Date('2026-07-15T00:00:00Z'), to: new Date('2026-07-17T00:00:00Z') },
    )

    assert.equal(requestCount, 1)
    assert.equal(result.has(fresh.id), true)
    assert.equal(result.has(stale.id), false)
})

test('SaxoClient.getExecutionPricesForOrdersV2 は batch hit で direct call を発生させない', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [{ accountKey: 'account', clientKey: 'client-key', legalAssetTypes: ['FxSpot'], currency: 'USD', displayName: 'Primary' }],
        },
    })
    let directRequestCount = 0
    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            const parsedUrl = new URL(String(url))
            if (parsedUrl.searchParams.has('OrderId')) directRequestCount += 1
            return Response.json({
                Data: [{ LogId: 'batch-fill', OrderId: 'ORD-batch-hit', Status: 'FinalFill', ExecutionPrice: 99, FillAmount: 1, FilledAmount: 1 }],
            })
        },
    })

    const result = await client.getExecutionPricesForOrdersV2(
        [makePendingSaxoOrder('ORD-batch-hit')],
        { now: new Date('2026-07-17T00:00:00Z') },
    )

    assert.equal(directRequestCount, 0)
    assert.equal(result.get('evt-ORD-batch-hit')?.execution?.price, 99)
})

test('SaxoClient.getExecutionPricesForOrdersV2 は累積snapshot不明のpoll fillをdirect candidateへ回す', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [{ accountKey: 'account', clientKey: 'client-key', legalAssetTypes: ['FxSpot'], currency: 'USD', displayName: 'Primary' }],
        },
    })
    const requestedUrls: string[] = []
    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            const parsedUrl = new URL(String(url))
            requestedUrls.push(parsedUrl.toString())
            if (parsedUrl.searchParams.has('OrderId')) {
                return Response.json({
                    Data: [{ LogId: 'direct-recovery', OrderId: 'ORD-incomplete-poll', Status: 'FinalFill', ExecutionPrice: 101, FillAmount: 1 }],
                })
            }
            return Response.json({
                Data: [{ LogId: 'poll-incomplete', OrderId: 'ORD-incomplete-poll', Status: 'Fill', ExecutionPrice: 100, FillAmount: 0.4 }],
            })
        },
        sleepImpl: async () => { },
    })

    const result = await client.getExecutionPricesForOrdersV2(
        [makePendingSaxoOrder('ORD-incomplete-poll')],
        { now: new Date('2026-07-17T00:00:00Z') },
    )

    assert.equal(requestedUrls.length, 2)
    assert.equal(new URL(requestedUrls[1] as string).searchParams.get('OrderId'), 'ORD-incomplete-poll')
    assert.deepEqual(result.get('evt-ORD-incomplete-poll')?.execution, {
        price: 101,
        size: 1,
        executed_at: undefined,
    })
})

test('SaxoClient.getExecutionPricesForOrdersV2 は direct の cancel を terminal statusへ変換する', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [{ accountKey: 'account', clientKey: 'client-key', legalAssetTypes: ['FxSpot'], currency: 'USD', displayName: 'Primary' }],
        },
    })
    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => new URL(String(url)).searchParams.has('OrderId')
            ? Response.json({ Data: [{ LogId: 'direct-cancel', OrderId: 'ORD-direct-cancel', Status: 'Cancelled', SubStatus: 'Confirmed' }] })
            : Response.json({ Data: [] }),
    })

    const result = await client.getExecutionPricesForOrdersV2(
        [makePendingSaxoOrder('ORD-direct-cancel')],
        { now: new Date('2026-07-17T00:00:00Z') },
    )

    assert.equal(result.get('evt-ORD-direct-cancel')?.terminalStatus, 'CANCELED')
    assert.equal(result.get('evt-ORD-direct-cancel')?.terminalReason, 'saxo_confirmed_cancel')
})

test('SaxoClient.getExecutionPricesForOrdersV2 は metadata欠落MARKETを metadata-only result として返す', async () => {
    let requestCount = 0
    const client = new SaxoClient({
        db: mockFirestore(),
        baseUrl: 'https://example.com',
        fetchImpl: async () => {
            requestCount += 1
            return Response.json({ Data: [] })
        },
    })

    const result = await client.getExecutionPricesForOrdersV2([{
        ...makePendingSaxoOrder('ORD-metadata-missing'),
        broker_order_metadata: undefined,
    }], { now: new Date('2026-07-17T00:00:00Z') })

    assert.equal(requestCount, 0)
    assert.equal(result.size, 1)
    assert.deepEqual(result.get('evt-ORD-metadata-missing')?.brokerOrderMetadata, {
        kind: 'saxo_order_v1',
        order_id: 'ORD-metadata-missing',
        entry: {
            expected: { side: 'BUY', order_type: 'Market', size: 1 },
            resolved: { order_id: 'ORD-metadata-missing' },
        },
        exits: [],
    })
    assert.equal(result.get('evt-ORD-metadata-missing')?.brokerOrderMetadataPolicy, 'SET_IF_UNSET')
})

test('SaxoClient.getExecutionPricesForOrdersV2 は metadata欠落MARKETを batch/direct pipeline へ投入する', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [{ accountKey: 'account', clientKey: 'client-key', legalAssetTypes: ['FxSpot'], currency: 'USD', displayName: 'Primary' }],
        },
    })
    const requestedUrls: string[] = []
    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            const parsedUrl = new URL(String(url))
            requestedUrls.push(parsedUrl.toString())
            return parsedUrl.searchParams.has('OrderId')
                ? Response.json({ Data: [{ LogId: 'legacy-direct', OrderId: 'ORD-legacy-recovery', Status: 'FinalFill', ExecutionPrice: 101, FillAmount: 1, FilledAmount: 1 }] })
                : Response.json({ Data: [] })
        },
    })

    const result = await client.getExecutionPricesForOrdersV2([{
        ...makePendingSaxoOrder('ORD-legacy-recovery'),
        broker_order_metadata: undefined,
    }], { now: new Date('2026-07-17T00:00:00Z') })

    assert.equal(requestedUrls.length, 2)
    assert.equal(new URL(requestedUrls[1] as string).searchParams.get('OrderId'), 'ORD-legacy-recovery')
    assert.deepEqual(result.get('evt-ORD-legacy-recovery')?.execution, {
        price: 101,
        size: 1,
        executed_at: undefined,
    })
    assert.equal(result.get('evt-ORD-legacy-recovery')?.brokerOrderMetadataPolicy, 'SET_IF_UNSET')
})

test('SaxoClient.getExecutionPricesForOrdersV2 は direct candidate を10件に制限し次回へ round-robin する', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [{ accountKey: 'account', clientKey: 'client-key', legalAssetTypes: ['FxSpot'], currency: 'USD', displayName: 'Primary' }],
        },
    })
    const directOrderIds: string[] = []
    const { logger, infoLogs } = createCapturingLogger()
    const client = new SaxoClient({
        db,
        logger: logger as any,
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            const parsedUrl = new URL(String(url))
            const orderId = parsedUrl.searchParams.get('OrderId')
            if (orderId) directOrderIds.push(orderId)
            return Response.json({ Data: [] })
        },
    })
    const orders = Array.from({ length: 12 }, (_, index) => makePendingSaxoOrder(`ORD-${String(index).padStart(2, '0')}`))

    await client.getExecutionPricesForOrdersV2(orders, { now: new Date('2026-07-17T00:00:00Z') })
    assert.equal(directOrderIds.length, 10)
    assert.deepEqual(directOrderIds.slice().sort(), orders.slice(0, 10).map((order) => order.provider_order_ids[0]).sort())

    directOrderIds.length = 0
    await client.getExecutionPricesForOrdersV2(orders, { now: new Date('2026-07-17T00:10:00Z') })
    assert.equal(directOrderIds.length, 10)
    assert.deepEqual(directOrderIds.slice(0, 2).sort(), ['ORD-10', 'ORD-11'])
    const summaries = infoLogs.filter((log) => log.obj.event === 'saxo:orderactivities_reconciliation_summary')
    const secondSummary = summaries[1]?.obj as { sampleOrderIds?: { deferred?: string[] } } | undefined
    assert.deepEqual(secondSummary?.sampleOrderIds?.deferred, ['ORD-08', 'ORD-09'])
})

test('SaxoClient.getExecutionPricesForOrdersV2 は request budget 到達候補を deferred にする', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [{ accountKey: 'account', clientKey: 'client-key', legalAssetTypes: ['FxSpot'], currency: 'USD', displayName: 'Primary' }],
        },
    })
    const { logger, infoLogs } = createCapturingLogger()
    const client = new SaxoClient({
        db,
        logger: logger as any,
        baseUrl: 'https://example.com',
        sleepImpl: async () => { },
        fetchImpl: async (url) => {
            const parsedUrl = new URL(String(url))
            if (!parsedUrl.searchParams.has('OrderId')) return Response.json({ Data: [] })
            if (parsedUrl.pathname.endsWith('/orderactivities/')) {
                const orderId = parsedUrl.searchParams.get('OrderId')
                return Response.json({
                    Data: [{ LogId: `${orderId}-page-1`, OrderId: orderId, Status: 'Working', SubStatus: 'Confirmed' }],
                    __next: `/direct-page-2?OrderId=${orderId}`,
                })
            }
            if (parsedUrl.pathname === '/direct-page-2') {
                const orderId = parsedUrl.searchParams.get('OrderId')
                return Response.json({
                    Data: [{ LogId: `${orderId}-page-2`, OrderId: orderId, Status: 'Working', SubStatus: 'Confirmed' }],
                    __next: `/direct-page-3?OrderId=${orderId}`,
                })
            }
            const orderId = parsedUrl.searchParams.get('OrderId')
            return Response.json({
                Data: [{ LogId: `${orderId}-page-3`, OrderId: orderId, Status: 'Working', SubStatus: 'Confirmed' }],
            })
        },
    })

    const orders = Array.from({ length: 10 }, (_, index) => makePendingSaxoOrder(`ORD-budget-${String(index).padStart(2, '0')}`))
    await client.getExecutionPricesForOrdersV2(orders, { now: new Date('2026-07-17T00:00:00Z') })

    const summary = infoLogs.find((log) => log.obj.event === 'saxo:orderactivities_reconciliation_summary')
    assert.equal(summary?.obj.directRequests, 20)
    assert.equal(summary?.obj.rateLimited, 0)
    assert.equal(summary?.obj.failed, 0)
    assert.equal((summary?.obj.attempted as number) + (summary?.obj.deferred as number), 10)
    assert.ok((summary?.obj.deferred as number) > 0)
    const sampleOrderIds = summary?.obj.sampleOrderIds as { deferred?: string[] }
    assert.ok((sampleOrderIds.deferred?.length ?? 0) > 0)
})

test('SaxoClient.getExecutionPricesForOrdersV2 は direct の5xxを1回retryし、途中failureのpartial activityを破棄する', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [{ accountKey: 'account', clientKey: 'client-key', legalAssetTypes: ['FxSpot'], currency: 'USD', displayName: 'Primary' }],
        },
    })
    let directRequests = 0
    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        sleepImpl: async () => { },
        fetchImpl: async (url) => {
            const parsedUrl = new URL(String(url))
            const isDirect = parsedUrl.searchParams.has('OrderId') || parsedUrl.pathname === '/direct-page-2'
            if (!isDirect) return Response.json({ Data: [] })
            directRequests += 1
            if (directRequests === 1) return new Response('temporary', { status: 503 })
            if (directRequests === 2) {
                return Response.json({
                    Data: [{ LogId: 'partial', OrderId: 'ORD-partial-direct', Status: 'Fill', ExecutionPrice: 100, FillAmount: 0.4 }],
                    __next: '/direct-page-2',
                })
            }
            return new Response('failed', { status: 503 })
        },
    })

    const result = await client.getExecutionPricesForOrdersV2(
        [makePendingSaxoOrder('ORD-partial-direct')],
        { now: new Date('2026-07-17T00:00:00Z') },
    )

    assert.equal(directRequests, 3)
    assert.equal(result.get('evt-ORD-partial-direct')?.execution, null)
})

test('SaxoClient.getExecutionPricesForOrdersV2 は direct 429を同一sessionでretryしない', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [{ accountKey: 'account', clientKey: 'client-key', legalAssetTypes: ['FxSpot'], currency: 'USD', displayName: 'Primary' }],
        },
    })
    let directRequests = 0
    const { logger, infoLogs } = createCapturingLogger()
    const client = new SaxoClient({
        db,
        logger: logger as any,
        baseUrl: 'https://example.com',
        rateLimitCooldownMs: 60_000,
        fetchImpl: async (url) => {
            const parsedUrl = new URL(String(url))
            if (parsedUrl.searchParams.has('OrderId')) directRequests += 1
            return parsedUrl.searchParams.has('OrderId')
                ? new Response('slow down', { status: 429, headers: { 'Retry-After': '60' } })
                : Response.json({ Data: [] })
        },
    })

    await client.getExecutionPricesForOrdersV2(
        [makePendingSaxoOrder('ORD-rate-limited')],
        { now: new Date('2026-07-17T00:00:00Z') },
    )

    assert.equal(directRequests, 1)
    const summary = infoLogs.find((log) => log.obj.event === 'saxo:orderactivities_reconciliation_summary')
    assert.equal(summary?.obj.rateLimited, 1)
})

test('SaxoClient.getExecutionPriceForOrderV2 maps confirmed audit terminal states to shared result', async () => {
    const cases = [
        { name: 'confirmed cancel', status: 'Cancelled', subStatus: 'Confirmed', expectedStatus: 'CANCELED', expectedReason: 'saxo_confirmed_cancel' },
        { name: 'confirmed expire', status: 'Expired', subStatus: 'Confirmed', expectedStatus: 'CANCELED', expectedReason: 'saxo_confirmed_expire' },
        { name: 'placement rejected', status: 'Placed', subStatus: 'Rejected', expectedStatus: 'FAILED', expectedReason: 'saxo_placement_rejected' },
        { name: 'cancel rejected', status: 'Cancelled', subStatus: 'Rejected', expectedStatus: undefined, expectedReason: undefined },
        { name: 'change rejected', status: 'Changed', subStatus: 'Rejected', expectedStatus: undefined, expectedReason: undefined },
        { name: 'done for day', status: 'DoneForDay', subStatus: 'Confirmed', expectedStatus: undefined, expectedReason: undefined },
    ] as const

    for (const testCase of cases) {
        const orderId = `ORD-${testCase.name.replaceAll(' ', '-')}`
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
            fetchImpl: async () => Response.json({
                Data: [{
                    LogId: `L-${testCase.name}`,
                    OrderId: orderId,
                    Status: testCase.status,
                    SubStatus: testCase.subStatus,
                }],
            }),
        })

        const result = await client.getExecutionPriceForOrderV2(makePendingSaxoOrder(orderId))

        assert.equal(result.terminalStatus, testCase.expectedStatus, testCase.name)
        assert.equal(result.terminalReason, testCase.expectedReason, testCase.name)
        assert.equal(result.execution, null, testCase.name)
    }
})

test('SaxoClient.getExecutionPriceForOrderV2 preserves partial execution snapshot with confirmed cancel', async () => {
    const orderId = 'ORD-partial-cancel'
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
        fetchImpl: async () => Response.json({
            Data: [
                { LogId: 'L-fill', OrderId: orderId, Status: 'Fill', SubStatus: 'Confirmed', ExecutionPrice: 101, FillAmount: 0.4, FilledAmount: 0.4, ActivityTime: '2026-01-01T00:01:00Z' },
                { LogId: 'L-cancel', OrderId: orderId, Status: 'Cancelled', SubStatus: 'Confirmed' },
            ],
        }),
    })

    const result = await client.getExecutionPriceForOrderV2(makePendingSaxoOrder(orderId))

    assert.ok(result.execution)
    assert.ok(Math.abs(result.execution.price - 101) < 0.00000001)
    assert.equal(result.execution.size, 0.4)
    assert.deepEqual(result.execution.executed_at, new Date('2026-01-01T00:01:00Z'))
    assert.equal(result.terminalStatus, 'CANCELED')
    assert.equal(result.terminalReason, 'saxo_confirmed_cancel')
})

test('SaxoClient.getExecutionPriceForOrderV2 returns null when batch has no entry fill activity', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        },
    })

    const requestedUrls: string[] = []
    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            requestedUrls.push(String(url))
            return new Response(
                JSON.stringify({ Data: [] }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const metadata = {
        kind: 'saxo_order_v1' as const,
        order_id: 'ORD-entry-no-fill',
        entry: {
            expected: { side: 'BUY' as const, order_type: 'Market' as const, size: 1000 },
            resolved: { order_id: 'ORD-entry-no-fill' },
        },
        exits: [{
            expected: {
                role: 'TAKE_PROFIT' as const,
                side: 'SELL' as const,
                order_type: 'Limit' as const,
                size: 1000,
                price: 110,
            },
            resolved: { order_id: 'ORD-entry-no-fill-limit' },
        }],
    }

    const result = await client.getExecutionPriceForOrderV2({
        id: 'evt-saxo-entry-no-fill',
        strategy: 'test',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 1000,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['ORD-entry-no-fill'],
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
        broker_order_metadata: metadata,
    })

    assert.equal(requestedUrls.length, 1)
    assert.equal(new URL(requestedUrls[0] ?? '').searchParams.get('OrderId'), null)
    assert.equal(result.execution, null)
    assert.deepEqual(result.brokerOrderMetadata, metadata)
})

test('SaxoClient.getExecutionPriceForOrderV2 returns null when fill size fields are unavailable', async () => {
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
                        { LogId: 'L-no-size', OrderId: 'ORD-entry-no-size', Status: 'FinalFill', ExecutionPrice: 101 },
                    ],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
    })

    const result = await client.getExecutionPriceForOrderV2({
        id: 'evt-saxo-entry-no-size',
        strategy: 'test',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 1000,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['ORD-entry-no-size'],
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
        broker_order_metadata: {
            kind: 'saxo_order_v1',
            order_id: 'ORD-entry-no-size',
            entry: {
                expected: { side: 'BUY', order_type: 'Market', size: 1000 },
                resolved: { order_id: 'ORD-entry-no-size' },
            },
            exits: [],
        },
    })

    assert.equal(result.execution, null)
})

test('SaxoClient.getExecutionPriceForOrderV2 logs when audit activities do not match the requested order id', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        },
    })

    const { logger, infoLogs } = createCapturingLogger()
    const client = new SaxoClient({
        db,
        logger: logger as any,
        baseUrl: 'https://example.com',
        fetchImpl: async () =>
            new Response(
                JSON.stringify({
                    Data: [
                        { LogId: 'L-no-match', OrderId: 'ORD-other', Status: 'FinalFill', AveragePrice: 101, FilledAmount: 1 },
                    ],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
    })

    const result = await client.getExecutionPriceForOrderV2({
        id: 'evt-saxo-no-match',
        strategy: 'test',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'BUY',
        order_type: 'MARKET',
        requested_size: 1,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['ORD-requested'],
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
        broker_order_metadata: {
            kind: 'saxo_order_v1',
            order_id: 'ORD-requested',
            entry: {
                expected: { side: 'BUY', order_type: 'Market', size: 1 },
                resolved: { order_id: 'ORD-requested' },
            },
            exits: [],
        },
    })

    assert.equal(result.execution, null)
    assert.ok(infoLogs.some((log) => log.obj.event === 'saxo:execution_audit_no_match'))
})

test('SaxoClient.getExecutionPriceForOrderV2 は metadata欠落MARKETを single recovery する', async () => {
    const db = mockFirestore()
    const { logger, warnLogs } = createCapturingLogger()
    const requestedUrls: string[] = []
    const client = new SaxoClient({
        db,
        logger: logger as any,
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            requestedUrls.push(String(url))
            return new Response(JSON.stringify({ Data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
        },
    })

    const result = await client.getExecutionPriceForOrderV2({
        id: 'evt-saxo-missing-metadata',
        strategy: 'test',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'BUY',
        order_type: 'MARKET',
        requested_size: 1,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['ORD-legacy'],
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
    })

    assert.equal(result.execution, null)
    assert.equal(requestedUrls.length, 0)
    assert.deepEqual(result.brokerOrderMetadata, {
        kind: 'saxo_order_v1',
        order_id: 'ORD-legacy',
        entry: {
            expected: { side: 'BUY', order_type: 'Market', size: 1 },
            resolved: { order_id: 'ORD-legacy' },
        },
        exits: [],
    })
    assert.equal(result.brokerOrderMetadataPolicy, 'SET_IF_UNSET')
    assert.equal(warnLogs.some((log) => log.obj.event === 'saxo:orders_v2_sync_unrecoverable'), false)
})

test('SaxoClient.getExecutionPricesForOrdersV2 は空のprovider idをsummary sampleに記録しない', async () => {
    const { logger, infoLogs } = createCapturingLogger()
    const client = new SaxoClient({ db: mockFirestore(), logger: logger as any, baseUrl: 'https://example.com' })
    const order = { ...makePendingSaxoOrder('   '), id: 'evt-blank-provider' }

    const result = await client.getExecutionPricesForOrdersV2([order], { now: new Date('2026-07-17T00:00:00Z') })

    assert.deepEqual(result.get(order.id), { execution: null })
    const summary = infoLogs.find((log) => log.obj.event === 'saxo:orderactivities_reconciliation_summary')
    assert.deepEqual(summary?.obj.unrecoverableOrderIds, {
        PROVIDER_ORDER_ID_MISSING: ['evt-blank-provider'],
    })
})

test('SaxoClient.getExecutionPricesForOrdersV2 は非文字列provider idでsummary sample処理をクラッシュさせない', async () => {
    const { logger, infoLogs } = createCapturingLogger()
    const client = new SaxoClient({ db: mockFirestore(), logger: logger as any, baseUrl: 'https://example.com' })
    const order = { ...makePendingSaxoOrder('ORD-malformed-provider'), id: 'evt-malformed-provider', provider_order_ids: [123 as any] }

    const result = await client.getExecutionPricesForOrdersV2([order], { now: new Date('2026-07-17T00:00:00Z') })

    assert.deepEqual(result.get(order.id), { execution: null })
    const summary = infoLogs.find((log) => log.obj.event === 'saxo:orderactivities_reconciliation_summary')
    assert.deepEqual(summary?.obj.unrecoverableOrderIds, {
        PROVIDER_ORDER_ID_MISSING: ['evt-malformed-provider'],
    })
})

test('SaxoClient.getClosingExecutionForOrderV2 aggregates resolved exit executions from one audit batch', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        },
    })

    let fetchCount = 0
    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async () => {
            fetchCount += 1
            return new Response(
                JSON.stringify({
                    Data: [
                        { LogId: 'L-sl-4', OrderId: 'ORD-sl-4', Status: 'FinalFill', ExecutionPrice: 98, FillAmount: 0.5, FilledAmount: 0.5 },
                        { LogId: 'L-tp-4', OrderId: 'ORD-tp-4', Status: 'FinalFill', ExecutionPrice: 104, FillAmount: 1.5, FilledAmount: 1.5 },
                    ],
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
        executed_at: new Date('2026-01-01T00:10:00Z'),
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

    assert.equal(fetchCount, 1)
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

    let fetchCount = 0
    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async () => {
            fetchCount += 1
            const data = [{ LogId: 'L-sl-single', OrderId: 'ORD-sl-single', Status: 'FinalFill', AveragePrice: 97.5, FilledAmount: 1 }]
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
        executed_at: new Date('2026-01-01T00:10:00Z'),
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

    assert.equal(fetchCount, 1)
    assert.deepEqual(result.execution, { price: 97.5, size: 1, executed_at: undefined })
})

test('SaxoClient.getClosingExecutionForOrderV2 returns null when exit fill size fields are unavailable', async () => {
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
                        { LogId: 'L-sl-no-size', OrderId: 'ORD-sl-no-size', Status: 'FinalFill', ExecutionPrice: 98 },
                    ],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            ),
    })

    const result = await client.getClosingExecutionForOrderV2({
        id: 'evt-saxo-close-no-size',
        strategy: 'test',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 1,
        executed_size: 1,
        executed_price: 100,
        status: 'EXECUTED',
        executed_at: new Date('2026-01-01T00:10:00Z'),
        provider_order_ids: ['ORD-entry-no-size'],
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
        broker_order_metadata: {
            kind: 'saxo_order_v1',
            order_id: 'ORD-entry-no-size',
            entry: {
                expected: { side: 'BUY', order_type: 'Market', size: 1 },
                resolved: { order_id: 'ORD-entry-no-size' },
            },
            exits: [
                {
                    expected: { role: 'STOP_LOSS', side: 'SELL', order_type: 'StopIfTraded', size: 1, price: 98 },
                    resolved: { order_id: 'ORD-sl-no-size' },
                },
            ],
        },
    })

    assert.equal(result.execution, null)
})

test('SaxoClient.getExecutionPriceForOrderV2 saves the final cursor only after all pages complete', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [{
                accountKey: 'test-account',
                clientKey: 'test-client',
                legalAssetTypes: ['FxSpot'],
                currency: 'USD',
                displayName: 'Primary',
            }],
        },
    })

    const requestedUrls: string[] = []
    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            requestedUrls.push(String(url))
            if (requestedUrls.length === 1) {
                return Response.json({
                    Data: [{ LogId: '1', OrderId: 'ORD-paged', Status: 'Fill', ExecutionPrice: 100, FillAmount: 1, FilledAmount: 1 }],
                    __next: '/page-2',
                    __nextPoll: '/poll-1',
                })
            }
            return Response.json({
                Data: [{ LogId: '2', OrderId: 'ORD-paged', Status: 'FinalFill', ExecutionPrice: 110, FillAmount: 1, FilledAmount: 2 }],
                __nextPoll: '/poll-2',
            })
        },
    })

    const result = await client.getExecutionPriceForOrderV2(makePendingSaxoOrder('ORD-paged'))

    assert.equal(new URL(requestedUrls[0] as string).searchParams.get('$top'), '500')
    assert.equal(requestedUrls[1], 'https://example.com/page-2')
    assert.deepEqual(result.execution, { price: 110, size: 2, executed_at: undefined })
    const state = db._getStoredData()['cron_metadata/saxo_orderactivities_poll_state'] as Record<string, unknown>
    assert.equal(state.next_poll_url, '/poll-2')
    assert.equal(typeof state.last_poll_at, 'string')
})

test('SaxoClient.getExecutionPriceForOrderV2 discards partial fills and preserves cursor on intermediate failure', async () => {
    const initialState = {
        last_poll_at: new Date().toISOString(),
        next_poll_url: '/existing-poll',
    }
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        },
        'cron_metadata/saxo_orderactivities_poll_state': initialState,
    })

    let fetchCount = 0
    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async () => {
            fetchCount += 1
            if (fetchCount === 1) {
                return Response.json({
                    Data: [{ LogId: '1', OrderId: 'ORD-http-failure', Status: 'FinalFill', ExecutionPrice: 100, FillAmount: 1 }],
                    __next: '/page-2',
                    __nextPoll: '/new-poll',
                })
            }
            return new Response('failed', { status: 503 })
        },
    })

    const result = await client.getExecutionPriceForOrderV2(makePendingSaxoOrder('ORD-http-failure'))

    assert.equal(fetchCount, 2)
    assert.equal(result.execution, null)
    assert.deepEqual(db._getStoredData()['cron_metadata/saxo_orderactivities_poll_state'], initialState)
})

test('SaxoClient.getExecutionPriceForOrderV2 discards partial fills and preserves cursor at page cap', async () => {
    const initialState = {
        last_poll_at: new Date().toISOString(),
        next_poll_url: '/existing-poll',
    }
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        },
        'cron_metadata/saxo_orderactivities_poll_state': initialState,
    })

    let fetchCount = 0
    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async () => {
            fetchCount += 1
            return Response.json({
                Data: [{ LogId: String(fetchCount), OrderId: 'ORD-page-cap', Status: 'FinalFill', ExecutionPrice: 100, FillAmount: 1 }],
                __next: `/page-${fetchCount + 1}`,
                __nextPoll: '/new-poll',
            })
        },
    })

    const result = await client.getExecutionPriceForOrderV2(makePendingSaxoOrder('ORD-page-cap'))

    assert.equal(fetchCount, 20)
    assert.equal(result.execution, null)
    assert.deepEqual(db._getStoredData()['cron_metadata/saxo_orderactivities_poll_state'], initialState)
})

test('SaxoClient.getExecutionPriceForOrderV2 ignores stale next poll cursor after 30 minutes', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [{
                accountKey: 'test-account',
                clientKey: 'test-client',
                legalAssetTypes: ['FxSpot'],
                currency: 'USD',
                displayName: 'Primary',
            }],
        },
        'cron_metadata/saxo_orderactivities_poll_state': {
            last_poll_at: '2026-01-01T00:00:00Z',
            next_poll_url: '/cs/v1/audit/orderactivities/subscriptions/stale',
        },
    })

    let requestedUrl = ''
    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            requestedUrl = String(url)
            return new Response(
                JSON.stringify({
                    Data: [{ LogId: 'L-stale', OrderId: 'ORD-stale-cursor', Status: 'FinalFill', AveragePrice: 101, FilledAmount: 1 }],
                }),
                { status: 200, headers: { 'content-type': 'application/json' } },
            )
        },
    })

    const result = await client.getExecutionPriceForOrderV2({
        id: 'evt-stale-cursor',
        strategy: 'test',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'BUY',
        order_type: 'MARKET',
        requested_size: 1,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['ORD-stale-cursor'],
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
        broker_order_metadata: {
            kind: 'saxo_order_v1',
            order_id: 'ORD-stale-cursor',
            entry: {
                expected: { side: 'BUY', order_type: 'Market', size: 1 },
                resolved: { order_id: 'ORD-stale-cursor' },
            },
            exits: [],
        },
    })

    assert.ok(requestedUrl.startsWith('https://example.com/cs/v1/audit/orderactivities/'))
    assert.equal(new URL(requestedUrl).searchParams.get('ClientKey'), 'test-client')
    assert.equal(new URL(requestedUrl).searchParams.get('OrderId'), null)
    assert.notEqual(requestedUrl, 'https://example.com/cs/v1/audit/orderactivities/subscriptions/stale')
    assert.deepEqual(result.execution, { price: 101, size: 1, executed_at: undefined })
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
        executed_at: new Date('2026-01-01T00:10:00Z'),
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

test('SaxoClient.getClosingExecutionForOrderV2 no-ops when metadata is missing', async () => {
    const { logger, warnLogs } = createCapturingLogger()
    const requestedUrls: string[] = []
    const client = new SaxoClient({
        db: mockFirestore(),
        logger: logger as any,
        fetchImpl: async (url) => {
            requestedUrls.push(String(url))
            return new Response(JSON.stringify({ Data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
        },
    })

    const result = await client.getClosingExecutionForOrderV2({
        id: 'evt-saxo-close-missing-metadata',
        strategy: 'test',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'BUY',
        order_type: 'IFDOCO',
        requested_size: 1,
        executed_size: 1,
        executed_price: 100,
        status: 'EXECUTED',
        executed_at: new Date('2026-01-01T00:10:00Z'),
        provider_order_ids: ['ORD-entry-legacy'],
        created_at: new Date('2026-01-01T00:00:00Z'),
        updated_at: new Date('2026-01-01T00:00:00Z'),
    })

    assert.equal(result.execution, null)
    assert.equal(requestedUrls.length, 0)
    assert.ok(warnLogs.some((log) => log.obj.event === 'saxo:orders_v2_metadata_missing'))
})

const makeRecoverableIfdocoOrder = (): OrderV2 => ({
    id: 'evt-ifdoco-recovery',
    strategy: 'test',
    broker: 'saxo',
    ticker: 'FxSpot:21',
    side: 'BUY',
    order_type: 'IFDOCO',
    requested_size: 1,
    executed_size: 0,
    executed_price: null,
    status: 'PENDING',
    provider_order_ids: ['ENTRY'],
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
})

const makeRecoveryAuthDb = () => mockFirestore({
    'saxo_auth_data/saxo_auth': {
        accessToken: 'valid-token',
        refreshToken: 'refresh-token',
        accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
        refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
        accounts: [{
            accountKey: 'account',
            clientKey: 'client-key',
            legalAssetTypes: ['FxSpot'],
            currency: 'USD',
            displayName: 'Primary',
        }],
    },
})

const recoveryActivity = (orderId: 'ENTRY' | 'STOP' | 'LIMIT') => ({
    LogId: `log-${orderId}`,
    OrderId: orderId,
    Status: 'Placed',
    SubStatus: 'Confirmed',
    BuySell: orderId === 'ENTRY' ? 'Buy' : 'Sell',
    Amount: 1,
    AssetType: 'FxSpot',
    Uic: 21,
    OrderType: orderId === 'ENTRY'
        ? 'Market'
        : orderId === 'STOP' ? 'StopIfTraded' : 'Limit',
    ...(orderId === 'ENTRY' ? {} : { Price: orderId === 'STOP' ? 98 : 103 }),
    ExternalReference: 'tg:event-1',
    RelatedOrders: orderId === 'ENTRY'
        ? ['STOP', 'LIMIT']
        : ['ENTRY', orderId === 'STOP' ? 'LIMIT' : 'STOP'],
})

const recoveryOpenOrder = (orderId: 'ENTRY' | 'STOP' | 'LIMIT') => ({
    OrderId: orderId,
    BuySell: orderId === 'ENTRY' ? 'Buy' : 'Sell',
    Amount: 1,
    AssetType: 'FxSpot',
    Uic: 21,
    OpenOrderType: orderId === 'ENTRY'
        ? 'Market'
        : orderId === 'STOP' ? 'StopIfTraded' : 'Limit',
    ...(orderId === 'ENTRY' ? {} : { Price: orderId === 'STOP' ? 98 : 103 }),
    ExternalReference: 'tg:event-1',
    RelatedOpenOrders: orderId === 'ENTRY'
        ? [
            { OrderId: 'STOP', Amount: 1, OpenOrderType: 'StopIfTraded', OrderPrice: 98 },
            { OrderId: 'LIMIT', Amount: 1, OpenOrderType: 'Limit', OrderPrice: 103 },
        ]
        : [{
            OrderId: orderId === 'STOP' ? 'LIMIT' : 'STOP',
            Amount: 1,
            OpenOrderType: orderId === 'STOP' ? 'Limit' : 'StopIfTraded',
            OrderPrice: orderId === 'STOP' ? 103 : 98,
        }],
})

test('SaxoClient.getExecutionPriceForOrderV2 は IFDOCO recovery未統合を entry ID付きで警告する', async () => {
    const { logger, warnLogs } = createCapturingLogger()
    const client = new SaxoClient({
        db: mockFirestore(),
        logger: logger as any,
    })

    const result = await client.getExecutionPriceForOrderV2(makeRecoverableIfdocoOrder())

    assert.deepEqual(result, { execution: null })
    assert.ok(warnLogs.some((log) => (
        log.obj.event === 'saxo:orders_v2_sync_ifdoco_recovery_required' &&
        log.obj.orderId === 'evt-ifdoco-recovery' &&
        log.obj.entryOrderId === 'ENTRY'
    )))
})

test('SaxoClient.recoverIfdocoOrderMetadata は全 history と open evidence が揃う場合だけ完全 metadata を返す', async () => {
    const requestedUrls: string[] = []
    const db = makeRecoveryAuthDb()
    const client = new SaxoClient({
        db,
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            const parsedUrl = new URL(String(url))
            requestedUrls.push(parsedUrl.toString())
            if (parsedUrl.pathname.includes('/cs/v1/audit/orderactivities')) {
                const orderId = parsedUrl.searchParams.get('OrderId') as 'ENTRY' | 'STOP' | 'LIMIT'
                return Response.json({ Data: [recoveryActivity(orderId)] })
            }
            const orderId = parsedUrl.pathname.split('/').at(-1) as 'ENTRY' | 'STOP' | 'LIMIT'
            return Response.json({ Data: [recoveryOpenOrder(orderId)] })
        },
    })

    const result = await client.recoverIfdocoOrderMetadata(makeRecoverableIfdocoOrder())

    assert.equal(result.kind, 'SUCCESS')
    if (result.kind === 'SUCCESS') {
        assert.equal(result.metadata.entry.resolved.order_id, 'ENTRY')
        assert.deepEqual(result.metadata.exits.map((exit) => exit.resolved.order_id), ['STOP', 'LIMIT'])
        assert.equal(result.metadata.exits.every((exit) => exit.resolved.order_id !== null), true)
    }
    assert.equal(requestedUrls.filter((url) => url.includes('/cs/v1/audit/orderactivities')).length, 3)
    assert.equal(requestedUrls.filter((url) => url.includes('/port/v1/orders/')).length, 3)
    assert.equal(
        Object.keys(db._getStoredData()).some((path) => path.startsWith('orders_v2/')),
        false,
    )
})

test('SaxoClient.recoverIfdocoOrderMetadata は open候補の404を retryable failureにする', async () => {
    const client = new SaxoClient({
        db: makeRecoveryAuthDb(),
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            const parsedUrl = new URL(String(url))
            if (parsedUrl.pathname.includes('/cs/v1/audit/orderactivities')) {
                const orderId = parsedUrl.searchParams.get('OrderId') as 'ENTRY' | 'STOP' | 'LIMIT'
                return Response.json({ Data: [recoveryActivity(orderId)] })
            }
            return new Response('Not Found', { status: 404 })
        },
    })

    const result = await client.recoverIfdocoOrderMetadata(makeRecoverableIfdocoOrder())

    assert.deepEqual(result, {
        kind: 'TEMPORARY_FAILURE',
        retryable: true,
        reason: 'OPEN_ORDER_NOT_FOUND',
    })
    assert.equal('metadata' in result, false)
})

for (const [name, buildPayload, reason] of [
    [
        '空Data',
        () => ({ Data: [] }),
        'OPEN_ORDER_NOT_FOUND',
    ],
    [
        '複数候補',
        (orderId: 'ENTRY' | 'STOP' | 'LIMIT') => ({
            Data: [recoveryOpenOrder(orderId), recoveryOpenOrder(orderId)],
        }),
        'PARSE_ERROR',
    ],
    [
        '対象OrderId不一致',
        (orderId: 'ENTRY' | 'STOP' | 'LIMIT') => ({
            Data: [{ ...recoveryOpenOrder(orderId), OrderId: `OTHER-${orderId}` }],
        }),
        'PARSE_ERROR',
    ],
    [
        '不正payload',
        () => ({ Data: 'not-an-array' }),
        'PARSE_ERROR',
    ],
] as const) {
    test(`SaxoClient.recoverIfdocoOrderMetadata は open候補の${name}を fail-closedにする`, async () => {
        const client = new SaxoClient({
            db: makeRecoveryAuthDb(),
            baseUrl: 'https://example.com',
            fetchImpl: async (url) => {
                const parsedUrl = new URL(String(url))
                if (parsedUrl.pathname.includes('/cs/v1/audit/orderactivities')) {
                    const orderId = parsedUrl.searchParams.get('OrderId') as 'ENTRY' | 'STOP' | 'LIMIT'
                    return Response.json({ Data: [recoveryActivity(orderId)] })
                }
                const orderId = parsedUrl.pathname.split('/').at(-1) as 'ENTRY' | 'STOP' | 'LIMIT'
                return Response.json(buildPayload(orderId))
            },
        })

        const result = await client.recoverIfdocoOrderMetadata(makeRecoverableIfdocoOrder())

        assert.deepEqual(result, {
            kind: 'TEMPORARY_FAILURE',
            retryable: true,
            reason,
        })
        assert.equal('metadata' in result, false)
    })
}

test('SaxoClient.recoverIfdocoOrderMetadata は paging 途中失敗で partial evidence を返さない', async () => {
    let requestCount = 0
    const client = new SaxoClient({
        db: makeRecoveryAuthDb(),
        baseUrl: 'https://example.com',
        fetchImpl: async () => {
            requestCount += 1
            return requestCount === 1
                ? Response.json({
                    Data: [recoveryActivity('ENTRY')],
                    __next: 'https://example.com/cs/v1/audit/orderactivities?page=2',
                })
                : new Response('failed', { status: 503 })
        },
        sleepImpl: async () => { },
    })

    const result = await client.recoverIfdocoOrderMetadata(makeRecoverableIfdocoOrder())

    assert.deepEqual(result, {
        kind: 'TEMPORARY_FAILURE',
        retryable: true,
        reason: 'HTTP_ERROR',
    })
    assert.equal(requestCount, 3)
    assert.equal('metadata' in result, false)
})

test('SaxoClient.recoverIfdocoOrderMetadata は429で cooldownを共有し再試行しない', async () => {
    let requestCount = 0
    const client = new SaxoClient({
        db: makeRecoveryAuthDb(),
        baseUrl: 'https://example.com',
        rateLimitCooldownMs: 60_000,
        fetchImpl: async () => {
            requestCount += 1
            return new Response('rate limited', {
                status: 429,
                headers: { 'Retry-After': '60' },
            })
        },
    })

    const first = await client.recoverIfdocoOrderMetadata(makeRecoverableIfdocoOrder())
    const second = await client.recoverIfdocoOrderMetadata(makeRecoverableIfdocoOrder())

    assert.deepEqual(first, {
        kind: 'TEMPORARY_FAILURE',
        retryable: true,
        reason: 'RATE_LIMITED',
    })
    assert.deepEqual(second, first)
    assert.equal(requestCount, 1)
})

test('SaxoClient.recoverIfdocoOrderMetadata は page limit で partial evidence を破棄する', async () => {
    let requestCount = 0
    const client = new SaxoClient({
        db: makeRecoveryAuthDb(),
        baseUrl: 'https://example.com',
        fetchImpl: async () => {
            requestCount += 1
            return Response.json({
                Data: [recoveryActivity('ENTRY')],
                __next: `https://example.com/cs/v1/audit/orderactivities?page=${requestCount + 1}`,
            })
        },
    })

    const result = await client.recoverIfdocoOrderMetadata(makeRecoverableIfdocoOrder())

    assert.deepEqual(result, {
        kind: 'TEMPORARY_FAILURE',
        retryable: true,
        reason: 'PAGE_LIMIT',
    })
    assert.equal(requestCount, 5)
    assert.equal('metadata' in result, false)
})

test('SaxoClient.recoverIfdocoOrderMetadata は request budget 20 到達で partial evidence を破棄する', async () => {
    let requestCount = 0
    const auditAttempts = new Map<string, number>()
    const client = new SaxoClient({
        db: makeRecoveryAuthDb(),
        baseUrl: 'https://example.com',
        sleepImpl: async () => { },
        fetchImpl: async (url) => {
            requestCount += 1
            const parsedUrl = new URL(String(url))
            if (parsedUrl.pathname.includes('/cs/v1/audit/orderactivities')) {
                const orderId = parsedUrl.searchParams.get('OrderId') as 'ENTRY' | 'STOP' | 'LIMIT'
                const attempt = (auditAttempts.get(orderId) ?? 0) + 1
                auditAttempts.set(orderId, attempt)
                if (attempt === 1) return new Response('retry', { status: 503 })
                const page = attempt - 1
                return Response.json({
                    Data: [recoveryActivity(orderId)],
                    ...(page < 5
                        ? {
                            __next: `https://example.com/cs/v1/audit/orderactivities?ClientKey=client-key&OrderId=${orderId}&page=${page + 1}`,
                        }
                        : {}),
                })
            }
            const orderId = parsedUrl.pathname.split('/').at(-1) as 'ENTRY' | 'STOP' | 'LIMIT'
            return Response.json({ Data: [recoveryOpenOrder(orderId)] })
        },
    })

    const result = await client.recoverIfdocoOrderMetadata(makeRecoverableIfdocoOrder())

    assert.deepEqual(result, {
        kind: 'TEMPORARY_FAILURE',
        retryable: true,
        reason: 'REQUEST_BUDGET_EXHAUSTED',
    })
    assert.equal(requestCount, 20)
    assert.equal('metadata' in result, false)
})

test('SaxoClient.recoverIfdocoOrderMetadata は child/open request で共有 concurrency 2を超えない', async () => {
    let activeRequests = 0
    let maxActiveRequests = 0
    const client = new SaxoClient({
        db: makeRecoveryAuthDb(),
        baseUrl: 'https://example.com',
        fetchImpl: async (url) => {
            activeRequests += 1
            maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
            await new Promise((resolve) => setTimeout(resolve, 5))
            activeRequests -= 1

            const parsedUrl = new URL(String(url))
            if (parsedUrl.pathname.includes('/cs/v1/audit/orderactivities')) {
                const orderId = parsedUrl.searchParams.get('OrderId') as 'ENTRY' | 'STOP' | 'LIMIT'
                return Response.json({ Data: [recoveryActivity(orderId)] })
            }
            const orderId = parsedUrl.pathname.split('/').at(-1) as 'ENTRY' | 'STOP' | 'LIMIT'
            return Response.json({ Data: [recoveryOpenOrder(orderId)] })
        },
    })

    const result = await client.recoverIfdocoOrderMetadata(makeRecoverableIfdocoOrder())

    assert.equal(result.kind, 'SUCCESS')
    assert.equal(maxActiveRequests, 2)
})

test('SaxoClient.recoverIfdocoOrderMetadata は認証情報欠落を retryable failure にする', async () => {
    let requestCount = 0
    const client = new SaxoClient({
        db: mockFirestore(),
        fetchImpl: async () => {
            requestCount += 1
            return Response.json({})
        },
    })

    assert.deepEqual(await client.recoverIfdocoOrderMetadata(makeRecoverableIfdocoOrder()), {
        kind: 'TEMPORARY_FAILURE',
        retryable: true,
        reason: 'AUTH_UNAVAILABLE',
    })
    assert.equal(requestCount, 0)
})
