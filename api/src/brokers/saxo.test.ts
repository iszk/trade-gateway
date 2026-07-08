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
    assert.equal(snapshot.accounts[0]?.sourceAccountId, 'account-1')
    assert.deepEqual(snapshot.cashBalances[0], {
        sourceAccountId: 'account-1',
        currency: 'JPY',
        amount: '100000',
        valueJpy: '100000',
        fxRateToJpy: '1',
        sourceBalanceId: 'account-1:JPY:CashBalance',
        sourceMetadata: {
            sourceField: 'CashBalance',
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

    assert.deepEqual(snapshot.cashBalances, [])
    assert.deepEqual(snapshot.positions, [])
    assert.deepEqual(snapshot.sourceMetadata?.skippedCashBalances, [
        {
            sourceAccountId: 'account-eur',
            currency: 'EUR',
            sourceField: 'CashBalance',
            reason: 'unsupported_fx_rate',
        },
    ])
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
                        { LogId: 'L1', OrderId: 'ORD-entry-3', Status: 'Fill', ExecutionPrice: 101, FillAmount: 400, ActivityTime: '2026-01-01T00:05:00Z' },
                        { LogId: 'L2', OrderId: 'ORD-entry-3', Status: 'FinalFill', ExecutionPrice: 102, FillAmount: 600, ActivityTime: '2026-01-01T00:06:00Z' },
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
            exits: [],
        },
    })

    assert.deepEqual(result.execution, { price: 101.6, size: 1000, executed_at: new Date('2026-01-01T00:06:00Z') })
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
        exits: [],
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

test('SaxoClient.getExecutionPriceForOrderV2 no-ops when metadata is missing', async () => {
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
    assert.ok(warnLogs.some((log) => log.obj.event === 'saxo:orders_v2_metadata_missing'))
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
                        { LogId: 'L-sl-4', OrderId: 'ORD-sl-4', Status: 'FinalFill', ExecutionPrice: 98, FillAmount: 0.5 },
                        { LogId: 'L-tp-4', OrderId: 'ORD-tp-4', Status: 'FinalFill', ExecutionPrice: 104, FillAmount: 1.5 },
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

test('SaxoClient.getExecutionPriceForOrderV2 ignores stale next poll cursor after 30 minutes', async () => {
    const db = mockFirestore({
        'saxo_auth_data/saxo_auth': {
            accessToken: 'valid-token',
            refreshToken: 'refresh-token',
            accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
            refreshTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
            accounts: [{ clientKey: 'test-client' }],
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
