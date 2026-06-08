import type { Firestore } from 'firebase-admin/firestore'
import { getFirestoreClient, setFirestoreDocument, updateFirestoreDocument } from '../firestore.js'
import type { OrderDispatchFailure, OrderDispatchResult, OrderRequest } from '../types/order.js'
import type { SaxoOrderMetadata } from '../types/broker-order-metadata.js'
import type { OrderV2 } from '../types/order-v2.js'
import type { Position } from '../types/position.js'
import { defaultLogger, type Logger } from '../logger.js'

type SaxoClientOptions = {
    appKey?: string
    appSecret?: string
    baseUrl?: string
    authBaseUrl?: string
    redirectUri?: string
    fetchImpl?: typeof fetch
    db?: Firestore
    logger?: Logger
}

type SaxoAccountInfo = {
    accountKey: string
    clientKey: string
    legalAssetTypes: string[]
    currency: string
    displayName: string
}

type SaxoAuthData = {
    accessToken: string
    refreshToken: string
    accessTokenExpiresAt: number // timestamp in ms
    refreshTokenExpiresAt: number // timestamp in ms
    accounts?: SaxoAccountInfo[]
}

type SaxoTokenResponse = {
    access_token: string
    refresh_token: string
    expires_in: number // seconds
    refresh_token_expires_in: number // seconds
    token_type: string
}

type SaxoAccountMeResponse = {
    Data: Array<{
        AccountKey: string
        ClientKey: string
        LegalAssetTypes: string[]
        Currency: string
        DisplayName: string
    }>
}

type SaxoNetPosition = {
    NetPositionId: string
    NetPositionBase: {
        Amount: number
        OpeningDirection: 'Buy' | 'Sell'
    }
    NetPositionView: {
        AverageOpenPrice?: number
        ProfitLossOnTrade?: number
    }
}

type SaxoNetPositionsResponse = {
    Data: SaxoNetPosition[]
}

type SaxoOrderResponse = {
    OrderId: string
    Orders?: Array<{ OrderId?: string }>
    RelatedOrders?: Array<{ OrderId?: string }>
}

type SaxoOrderActivity = {
    LogId: string
    OrderId: string
    Status: string
    AveragePrice?: number
    ActivityTime?: string
    ExecutionTime?: string
    UtcTime?: string
}

type SaxoOrderActivitiesResponse = {
    Data: SaxoOrderActivity[]
}

const parseSaxoActivityTime = (activity: SaxoOrderActivity): Date | undefined => {
    const rawTime = activity.ActivityTime ?? activity.ExecutionTime ?? activity.UtcTime
    if (!rawTime) return undefined

    const parsedMs = Date.parse(rawTime)
    if (Number.isNaN(parsedMs)) return undefined

    return new Date(parsedMs)
}

export type SaxoInstrument = {
    Identifier: number
    Symbol: string
    Description: string
    AssetType: string
    CurrencyCode: string
}

type SaxoInstrumentResponse = {
    Data: SaxoInstrument[]
}

const FIRESTORE_COLLECTION = 'saxo_auth_data'
const FIRESTORE_DOC = 'saxo_auth'

function parsePercentage(value: string): number | null {
    const match = value.trim().match(/^(\d+(?:\.\d+)?)%$/)
    if (!match || !match[1]) return null
    return parseFloat(match[1]) / 100
}

type SaxoRelatedOrder = {
    AccountKey: string
    AssetType: string
    Uic: number
    BuySell: 'Buy' | 'Sell'
    Amount: number
    ManualOrder: boolean
    OrderType: 'StopIfTraded' | 'Limit'
    OrderPrice: number
    OrderDuration: { DurationType: string }
}

type SaxoProductInfo = {
    AssetType: string
    Uic: number
}

type OrdersV2ExecutionSyncResult = {
    execution: { price: number, size: number, executed_at?: Date } | null
    brokerOrderMetadata?: SaxoOrderMetadata
}

const toOrderSide = (side: 'Buy' | 'Sell'): 'BUY' | 'SELL' => side === 'Buy' ? 'BUY' : 'SELL'

const buildSaxoOrderMetadata = (
    order: OrderRequest,
    orderId: string,
    relatedOrders: SaxoRelatedOrder[],
    relatedOrderIds: Array<string | null> = [],
): SaxoOrderMetadata | undefined => {
    if (relatedOrders.length === 0) return undefined

    return {
        kind: 'saxo_order_v1',
        order_id: orderId,
        entry: {
            expected: {
                side: order.side,
                order_type: 'Market',
                size: order.size,
            },
            resolved: {
                order_id: orderId,
            },
        },
        exits: relatedOrders.map((relatedOrder, index) => ({
            expected: {
                role: relatedOrder.OrderType === 'Limit' ? 'TAKE_PROFIT' : 'STOP_LOSS',
                side: toOrderSide(relatedOrder.BuySell),
                order_type: relatedOrder.OrderType,
                size: relatedOrder.Amount,
                price: relatedOrder.OrderPrice,
            },
            resolved: {
                order_id: relatedOrderIds[index] ?? null,
            },
        })),
    }
}

const extractSaxoRelatedOrderIds = (payload: SaxoOrderResponse): Array<string | null> => {
    const related = payload.Orders ?? payload.RelatedOrders ?? []
    return related.map((item) => item.OrderId ?? null)
}

export class SaxoClient {
    private readonly appKey?: string
    private readonly appSecret?: string
    private readonly baseUrl: string
    private readonly authBaseUrl: string
    private readonly redirectUri?: string
    private readonly fetchImpl: typeof fetch
    private readonly db?: Firestore
    private readonly logger: Logger

    constructor(options: SaxoClientOptions = {}) {
        this.appKey = options.appKey
        this.appSecret = options.appSecret
        this.baseUrl = options.baseUrl ?? 'https://gateway.saxobank.com/sim/openapi'
        this.authBaseUrl = options.authBaseUrl ?? 'https://sim.logonvalidation.net'
        this.redirectUri = options.redirectUri
        this.fetchImpl = options.fetchImpl ?? fetch
        this.db = options.db
        this.logger = options.logger ?? defaultLogger
    }

    private getFirestore(): Firestore {
        return this.db ?? getFirestoreClient()
    }

    private buildFailure(
        code: OrderDispatchFailure['code'],
        message: string,
    ): OrderDispatchFailure {
        return {
            ok: false,
            broker: 'saxo',
            code,
            message,
        }
    }

    async getAuth(): Promise<SaxoAuthData | null> {
        const db = this.getFirestore()
        const doc = await db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC).get()
        if (!doc.exists) {
            return null
        }
        return doc.data() as SaxoAuthData
    }

    async saveAuth(data: SaxoAuthData): Promise<void> {
        const db = this.getFirestore()
        await setFirestoreDocument(
            db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC),
            data as unknown as Record<string, unknown>,
            {
                collection: FIRESTORE_COLLECTION,
                docId: FIRESTORE_DOC,
                logger: this.logger,
            },
        )
    }

    async refreshAccessToken(refreshToken: string): Promise<SaxoAuthData> {
        if (!this.appKey || !this.appSecret) {
            throw new Error('Saxo app credentials missing')
        }

        const basicAuth = Buffer.from(`${this.appKey}:${this.appSecret}`).toString('base64')
        const response = await this.fetchImpl(`${this.authBaseUrl}/token`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${basicAuth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
            }),
        })

        if (!response.ok) {
            const body = await response.text()
            throw new Error(`Failed to refresh Saxo token: ${response.status} ${body}`)
        }

        const payload = (await response.json()) as SaxoTokenResponse
        const accounts = await this.fetchAccounts(payload.access_token)

        const authData: SaxoAuthData = {
            accessToken: payload.access_token,
            refreshToken: payload.refresh_token,
            accessTokenExpiresAt: Date.now() + payload.expires_in * 1000,
            refreshTokenExpiresAt: Date.now() + payload.refresh_token_expires_in * 1000,
            accounts,
        }

        await this.saveAuth(authData)
        return authData
    }

    async exchangeCodeForToken(code: string): Promise<SaxoAuthData> {
        if (!this.appKey || !this.appSecret || !this.redirectUri) {
            throw new Error('Saxo app credentials or redirect URI missing')
        }

        const basicAuth = Buffer.from(`${this.appKey}:${this.appSecret}`).toString('base64')
        const response = await this.fetchImpl(`${this.authBaseUrl}/token`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${basicAuth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: this.redirectUri,
            }),
        })

        if (!response.ok) {
            const body = await response.text()
            throw new Error(`Failed to exchange Saxo code: ${response.status} ${body}`)
        }

        const payload = (await response.json()) as SaxoTokenResponse
        const accounts = await this.fetchAccounts(payload.access_token)

        const authData: SaxoAuthData = {
            accessToken: payload.access_token,
            refreshToken: payload.refresh_token,
            accessTokenExpiresAt: Date.now() + payload.expires_in * 1000,
            refreshTokenExpiresAt: Date.now() + payload.refresh_token_expires_in * 1000,
            accounts,
        }

        await this.saveAuth(authData)
        return authData
    }

    private async fetchAccounts(accessToken: string): Promise<SaxoAccountInfo[]> {
        const accountResp = await this.fetchImpl(`${this.baseUrl}/port/v1/accounts/me`, {
            headers: { Authorization: `Bearer ${accessToken}` },
        })
        if (!accountResp.ok) {
            throw new Error(`Failed to fetch Saxo account key: ${accountResp.status}`)
        }
        const accountData = (await accountResp.json()) as SaxoAccountMeResponse
        if (!accountData.Data || accountData.Data.length === 0) {
            throw new Error('No Saxo accounts found')
        }
        return accountData.Data.map((acc) => ({
            accountKey: acc.AccountKey,
            clientKey: acc.ClientKey,
            legalAssetTypes: acc.LegalAssetTypes,
            currency: acc.Currency,
            displayName: acc.DisplayName,
        }))
    }

    async getValidAccessToken(): Promise<string | null> {
        let auth = await this.getAuth()
        if (!auth) return null

        // Refresh if expiring in less than 1 minute
        if (auth.accessTokenExpiresAt >= Date.now() + 60 * 1000) {
            return auth.accessToken
        }

        if (auth.refreshTokenExpiresAt < Date.now() + 60 * 1000) {
            return null // Refresh token also expired
        }

        const db = this.getFirestore()
        const authRef = db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC)
        let shouldRefresh = false

        try {
            await db.runTransaction(async (transaction) => {
                const doc = await transaction.get(authRef)
                if (!doc.exists) return

                const data = doc.data() as SaxoAuthData & { refreshingUntil?: number }

                if (data.accessTokenExpiresAt >= Date.now() + 60 * 1000) {
                    return // Already refreshed
                }

                if (data.refreshingUntil && data.refreshingUntil > Date.now()) {
                    throw new Error('ALREADY_REFRESHING')
                }

                // Acquire lock for 30 seconds
                transaction.update(authRef, { refreshingUntil: Date.now() + 30 * 1000 })
                shouldRefresh = true
            })
        } catch (error) {
            if (error instanceof Error && error.message === 'ALREADY_REFRESHING') {
                // Wait for the other process to finish refreshing
                for (let i = 0; i < 15; i++) {
                    await new Promise((resolve) => setTimeout(resolve, 1000))
                    auth = await this.getAuth()
                    if (auth && auth.accessTokenExpiresAt >= Date.now() + 60 * 1000) {
                        return auth.accessToken
                    }
                }
                this.logger.warn({ event: 'saxo:token_refresh_timeout' }, 'Timed out waiting for Saxo token refresh lock')
                return null
            }
            throw error
        }

        if (!shouldRefresh) {
            // Already refreshed by another process while we were checking
            auth = await this.getAuth()
            return auth?.accessToken ?? null
        }

        try {
            // Get latest refresh token before calling API
            auth = await this.getAuth()
            if (!auth || auth.refreshTokenExpiresAt < Date.now() + 60 * 1000) {
                return null
            }
            const newAuth = await this.refreshAccessToken(auth.refreshToken)
            // refreshAccessToken calls saveAuth (using .set) which overwrites the whole document, effectively clearing the lock.
            return newAuth.accessToken
        } catch (error) {
            this.logger.warn({ event: 'saxo:token_refresh_failed', error }, 'Failed to auto-refresh Saxo token')
            // Release lock on failure
            await updateFirestoreDocument(authRef, { refreshingUntil: Date.now() - 1000 }, {
                collection: FIRESTORE_COLLECTION,
                docId: FIRESTORE_DOC,
                logger: this.logger,
            })
            return null
        }
    }

    async sendMarketOrder(order: OrderRequest): Promise<OrderDispatchResult> {
        const accessToken = await this.getValidAccessToken()
        if (!accessToken) {
            return this.buildFailure('BROKER_NOT_CONFIGURED', 'Saxo auth is missing or expired')
        }

        // ticker は "CfdOnIndex:4912" のような形式で渡される
        const productInfo: SaxoProductInfo = {
            AssetType: order.ticker.split(':')[0],
            Uic: parseInt(order.ticker.split(':')[1], 10),
        }

        const auth = await this.getAuth()
        if (!auth?.accounts || auth.accounts.length === 0) {
            return this.buildFailure('BROKER_NOT_CONFIGURED', 'No Saxo accounts available')
        }

        const account =
            auth.accounts.find((acc) => acc.legalAssetTypes.includes(productInfo.AssetType)) ??
            auth.accounts[0]
        // TODO: AssetType をサポートする account が複数あった場合の対応

        const closingSide = order.side === 'BUY' ? 'Sell' : 'Buy'

        const relatedOrders: SaxoRelatedOrder[] = []

        if ((order.stopLoss || order.takeProfit) && order.price === undefined) {
            this.logger.warn(
                { event: 'saxo:related_orders_skipped', ticker: order.ticker },
                'stop_loss/take_profit ignored: no reference price provided',
            )
        } else if (order.price !== undefined) {
            const refPrice = order.price

            if (order.stopLoss) {
                const pct = parsePercentage(order.stopLoss)
                if (pct === null) {
                    this.logger.warn({ event: 'saxo:invalid_stop_loss', value: order.stopLoss }, 'invalid stop_loss format')
                } else {
                    const stopPrice = Number((
                        order.side === 'BUY'
                            ? refPrice * (1 - pct)
                            : refPrice * (1 + pct)
                    ).toFixed(2))
                    relatedOrders.push({
                        AccountKey: account.accountKey,
                        AssetType: productInfo.AssetType,
                        Uic: productInfo.Uic,
                        BuySell: closingSide,
                        Amount: order.size,
                        ManualOrder: false,
                        OrderType: 'StopIfTraded',
                        OrderPrice: stopPrice,
                        OrderDuration: { DurationType: 'GoodTillCancel' },
                    })
                }
            }

            if (order.takeProfit) {
                const pct = parsePercentage(order.takeProfit)
                if (pct === null) {
                    this.logger.warn({ event: 'saxo:invalid_take_profit', value: order.takeProfit }, 'invalid take_profit format')
                } else {
                    const limitPrice = Number((
                        order.side === 'BUY'
                            ? refPrice * (1 + pct)
                            : refPrice * (1 - pct)
                    ).toFixed(2))
                    relatedOrders.push({
                        AccountKey: account.accountKey,
                        AssetType: productInfo.AssetType,
                        Uic: productInfo.Uic,
                        BuySell: closingSide,
                        Amount: order.size,
                        ManualOrder: false,
                        OrderType: 'Limit',
                        OrderPrice: limitPrice,
                        OrderDuration: { DurationType: 'GoodTillCancel' },
                    })
                }
            }
        }

        const orderBody = {
            AccountKey: account.accountKey,
            AssetType: productInfo.AssetType,
            Uic: productInfo.Uic,
            BuySell: order.side === 'BUY' ? 'Buy' : 'Sell',
            Amount: order.size,
            OrderType: 'Market',
            OrderDuration: { DurationType: 'DayOrder' },
            ManualOrder: false,
            ...(relatedOrders.length > 0 ? { Orders: relatedOrders } : {}),
        }

        const body = JSON.stringify(orderBody)

        if (order.dryRun) {
            this.logger.info({
                event: 'dry_run:broker_api_call',
                broker: 'saxo',
                method: 'POST',
                url: `${this.baseUrl}/trade/v2/orders`,
                body: JSON.parse(body),
            })
            return {
                ok: true,
                broker: 'saxo',
                providerOrderId: 'DRY_RUN',
                brokerOrderMetadata: buildSaxoOrderMetadata(order, 'DRY_RUN', relatedOrders),
            }
        }

        try {
            const response = await this.fetchImpl(`${this.baseUrl}/trade/v2/orders`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
                body,
            })

            if (!response.ok) {
                const errorBody = await response.text()
                this.logger.warn(
                    {
                        event: 'saxo:order_failed',
                        status: response.status,
                        response: errorBody,
                        request: { method: 'POST', url: `${this.baseUrl}/trade/v2/orders`, body: JSON.parse(body) },
                    },
                    'Saxo order request failed',
                )
                return this.buildFailure(
                    'BROKER_REQUEST_FAILED',
                    `Saxo order failed: ${response.status} ${errorBody}`,
                )
            }

            const payload = (await response.json()) as SaxoOrderResponse
            return {
                ok: true,
                broker: 'saxo',
                providerOrderId: payload.OrderId,
                brokerOrderMetadata: buildSaxoOrderMetadata(
                    order,
                    payload.OrderId,
                    relatedOrders,
                    extractSaxoRelatedOrderIds(payload),
                ),
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            return this.buildFailure('BROKER_REQUEST_FAILED', message)
        }
    }

    getLoginUrl(state: string): string {
        if (!this.appKey || !this.redirectUri) {
            throw new Error('Saxo app credentials or redirect URI missing')
        }
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: this.appKey,
            state: state,
            redirect_uri: this.redirectUri,
        })
        return `${this.authBaseUrl}/authorize?${params.toString()}`
    }

    async getPositions(): Promise<Position[]> {
        const accessToken = await this.getValidAccessToken()
        if (!accessToken) {
            return []
        }

        const response = await this.fetchImpl(`${this.baseUrl}/port/v1/netpositions/me`, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        })

        if (!response.ok) {
            const body = await response.text()
            throw new Error(`Failed to fetch Saxo positions: ${response.status} ${body}`)
        }

        const data = (await response.json()) as SaxoNetPositionsResponse
        return data.Data.map((item) => ({
            broker: 'saxo' as const,
            ticker: item.NetPositionId.split('__')[0] ?? item.NetPositionId,
            side: item.NetPositionBase.OpeningDirection === 'Buy' ? 'BUY' : 'SELL',
            size: item.NetPositionBase.Amount,
            price: item.NetPositionView.AverageOpenPrice,
            pnl: item.NetPositionView.ProfitLossOnTrade,
        }))
    }

    async getExecutionPrice(orderId: string, _ticker: string): Promise<{ price: number, size: number, executed_at?: Date } | null> {
        if (orderId === 'DRY_RUN') return null

        const accessToken = await this.getValidAccessToken()
        if (!accessToken) return null

        try {
            const auth = await this.getAuth()
            const clientKey = auth?.accounts?.[0]?.clientKey

            const params = new URLSearchParams()
            params.append('OrderId', orderId)
            if (clientKey) {
                params.append('ClientKey', clientKey)
            }

            // Saxo の audit エンドポイントで約定情報を取得
            const url = `${this.baseUrl}/cs/v1/audit/orderactivities/?${params.toString()}`
            const response = await this.fetchImpl(url, {
                headers: { Authorization: `Bearer ${accessToken}` },
            })

            if (!response.ok) {
                this.logger.warn(
                    {
                        event: 'saxo:get_execution_price_failed',
                        orderId,
                        response: await response.text(),
                        status: response.status
                    },
                    'failed to get execution price from Saxo audit',
                )
                return null
            }

            const data = (await response.json()) as SaxoOrderActivitiesResponse
            if (!data.Data || data.Data.length === 0) {
                this.logger.warn(
                    {
                        event: 'saxo:get_execution_price_no_activities', orderId,
                    },
                    'no activities found for order in Saxo audit',
                )
                return null
            }

            // Amount を取得するために別の場所を見る必要があるかもしれないが、
            // activities に入っている AveragePrice と、元々の注文数量を使えば暫定的に OK かもしれない。
            // 本来は Fill ごとの Amount を合算すべき。
            // SaxoOrderActivity に Amount はないようなので、とりあえず Fill があれば全量約定とみなすか、
            // もし Amount があればそれを使う。

            const fillActivity = data.Data.find((a) =>
                (a.Status === 'FinalFill' || a.Status === 'Fill') && a.AveragePrice !== undefined
            )

            if (fillActivity?.AveragePrice !== undefined) {
                // TODO: 正確な数量を取得する。現在は暫定的に、注文時に渡された数量が分かれば良いが、
                // ここでは分からないので、とりあえず 0 以外を返して fetcher の呼び出し元で requested_size を使わせるか、
                // あるいは BrokerAPI を改善して元々の数量を引数で取る。
                // ひとまず、price があれば size: 0 (不明だが約定はした) として返し、呼び出し元で requested_size にフォールバックさせる。
                // 
                // 修正：SaxoClient の他のメソッドで Amount を持っている可能性のあるレスポンスを調べる。
                // 実際には /trade/v1/orders/{OrderId} で詳細が見れるはず。
                return {
                    price: fillActivity.AveragePrice,
                    size: 0,
                    executed_at: parseSaxoActivityTime(fillActivity),
                }
            }

            return null
        } catch (error) {
            this.logger.warn(
                { event: 'saxo:get_execution_price_failed', orderId, error },
                'failed to get execution price',
            )
            return null
        }
    }

    async getExecutionPriceForOrderV2(order: OrderV2): Promise<OrdersV2ExecutionSyncResult> {
        const providerOrderId = order.provider_order_ids[0]
        if (!providerOrderId || providerOrderId === 'DRY_RUN') {
            return { execution: null }
        }

        const metadata = order.broker_order_metadata
        if (metadata?.kind !== 'saxo_order_v1') {
            return {
                execution: await this.getExecutionPrice(providerOrderId, order.ticker),
            }
        }

        const entryOrderId = metadata.entry.resolved.order_id || metadata.order_id || providerOrderId
        const execution = await this.getExecutionPrice(entryOrderId, order.ticker)
        return {
            execution: execution ? { ...execution, size: execution.size || order.requested_size } : null,
            brokerOrderMetadata: metadata,
        }
    }

    async getClosingExecutionForOrderV2(order: OrderV2): Promise<OrdersV2ExecutionSyncResult> {
        const providerOrderId = order.provider_order_ids[0]
        if (!providerOrderId || providerOrderId === 'DRY_RUN') {
            return { execution: null }
        }

        const metadata = order.broker_order_metadata
        if (metadata?.kind !== 'saxo_order_v1') {
            return { execution: null }
        }

        let totalSize = 0
        let totalValue = 0
        let latestExecutedAt: Date | undefined

        for (const exit of metadata.exits) {
            const exitOrderId = exit.resolved.order_id
            if (!exitOrderId) continue

            const execution = await this.getExecutionPrice(exitOrderId, order.ticker)
            if (!execution) continue

            const size = execution.size || Math.min(exit.expected.size, order.requested_size)
            totalSize += size
            totalValue += execution.price * size
            if (execution.executed_at && (!latestExecutedAt || execution.executed_at.getTime() > latestExecutedAt.getTime())) {
                latestExecutedAt = execution.executed_at
            }
        }

        return {
            execution: totalSize > 0 ? { price: totalValue / totalSize, size: totalSize, executed_at: latestExecutedAt } : null,
            brokerOrderMetadata: metadata,
        }
    }

    async getClosingExecution(_parentOrderId: string, _ticker: string): Promise<{ price: number, size: number, executed_at?: Date } | null> {
        return null
    }

    async searchInstruments(keyword: string): Promise<SaxoInstrument[]> {
        const accessToken = await this.getValidAccessToken()
        if (!accessToken) {
            throw new Error('Saxo auth is missing or expired')
        }

        const params = new URLSearchParams({
            Keywords: keyword,
            $top: '50',
            // Typically people trade CFD or FX, maybe Stocks. 
            // We can omit AssetTypes to search all, or restrict it. Let's omit for broader search.
        })

        const response = await this.fetchImpl(`${this.baseUrl}/ref/v1/instruments?${params.toString()}`, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        })

        if (!response.ok) {
            const body = await response.text()
            this.logger.warn(
                {
                    event: 'saxo:instrument_search_failed',
                    status: response.status,
                    response: body,
                    request: { method: 'GET', url: `${this.baseUrl}/ref/v1/instruments?${params.toString()}` },
                },
                'Saxo instrument search failed',
            )
            throw new Error(`Failed to search Saxo instruments: ${response.status} ${body}`)
        }

        const data = (await response.json()) as SaxoInstrumentResponse
        return data.Data
    }
}
