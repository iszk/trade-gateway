import type { Firestore } from 'firebase-admin/firestore'
import { getFirestoreClient, setFirestoreDocument } from '../firestore.js'
import type { OrderDispatchFailure, OrderDispatchResult, OrderRequest } from '../types/order.js'
import type { SaxoOrderMetadata } from '../types/broker-order-metadata.js'
import type { OrderV2 } from '../types/order-v2.js'
import type { Position } from '../types/position.js'
import type { Balance } from '../types/balance.js'
import type {
    PortfolioSnapshotV1,
    PortfolioSnapshotV1AssetClass,
    PortfolioSnapshotV1JsonValue,
    PortfolioSnapshotV1SourceMetadata,
} from '../types/portfolio-snapshot.js'
import { portfolioSnapshotV1SchemaVersion } from '../types/portfolio-snapshot.js'
import { defaultLogger, type Logger } from '../logger.js'
import {
    SaxoAuthStore,
    type SaxoAccountInfo,
    type SaxoAuthData,
} from './saxo-auth-store.js'

type SaxoClientOptions = {
    appKey?: string
    appSecret?: string
    baseUrl?: string
    authBaseUrl?: string
    redirectUri?: string
    fetchImpl?: typeof fetch
    db?: Firestore
    logger?: Logger
    rateLimitCooldownMs?: number
    tokenEncryptionKey?: string
    authStore?: SaxoAuthStore
    refreshWaitIntervalMs?: number
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
    AccountKey?: string
    Uic?: number
    AssetType?: string
    NetPositionBase: {
        Amount: number
        OpeningDirection: 'Buy' | 'Sell'
        AccountKey?: string
        Uic?: number
        AssetType?: string
    }
    NetPositionView: {
        AverageOpenPrice?: number
        ProfitLossOnTrade?: number
        ProfitLossOnTradeInBaseCurrency?: number
        MarketValue?: number
        MarketValueInBaseCurrency?: number
        PositionValue?: number
        Exposure?: number
        ExposureInBaseCurrency?: number
        CurrentPrice?: number
        Price?: number
        Currency?: string
        DisplayAndFormat?: {
            Symbol?: string
            Description?: string
            Currency?: string
        }
    }
}

type SaxoNetPositionsResponse = {
    Data: SaxoNetPosition[]
}

type SaxoBalanceResponse = {
    CashBalance?: number
    CashAvailableForTrading?: number
    TotalValue?: number
    NetEquity?: number
    Currency?: string
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
    ExternalReference?: string
    Amount?: number
    FillAmount?: number
    FilledAmount?: number
    ExecutionPrice?: number
    AveragePrice?: number
    ActivityTime?: string
    ExecutionTime?: string
    UtcTime?: string
}

type SaxoOrderActivitiesResponse = {
    Data: SaxoOrderActivity[]
    __next?: string
    __nextPoll?: string
}

type SaxoOrderActivitiesPollState = {
    last_poll_at?: string
    next_poll_url?: string
}

const cancelResponseBody = async (response: Response): Promise<void> => {
    try {
        await response.body?.cancel()
    } catch {
        // Body disposal is best-effort; keep the caller-facing error fixed and safe.
    }
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

type SaxoInstrumentDetails = {
    Uic?: number
    AssetType?: string
    Symbol?: string
    Description?: string
    CurrencyCode?: string
    ExchangeId?: string
    DisplayAndFormat?: {
        Symbol?: string
        Description?: string
        Currency?: string
    }
}

type SaxoInstrumentDetailsResponse =
    | (SaxoInstrumentDetails & { Data?: never })
    | {
        Data: SaxoInstrumentDetails[]
    }

const CRON_METADATA_COLLECTION = 'cron_metadata'
const SAXO_ORDER_ACTIVITIES_POLL_DOC = 'saxo_orderactivities_poll_state'
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000
const SAXO_AUDIT_INITIAL_LOOKBACK_MS = 48 * 60 * 60 * 1000
const SAXO_AUDIT_OVERLAP_MS = 30 * 60 * 1000
const SAXO_AUDIT_CURSOR_MAX_IDLE_MS = 30 * 60 * 1000
const SAXO_AUDIT_BATCH_CACHE_MS = 60 * 1000
const SAXO_AUDIT_MAX_PAGES_PER_POLL = 10
const SAXO_INSTRUMENT_DETAILS_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const SAXO_INSTRUMENT_DETAILS_FETCH_CONCURRENCY = 5
const FIXED_FX_RATES_TO_JPY: Record<string, number> = {
    JPY: 1,
    USD: 160,
    HKD: 20,
}

type CachedSaxoInstrumentDetails = {
    expiresAtMs: number
    details: SaxoInstrumentDetails
}

const toDecimalString = (value: number): string => {
    if (!Number.isFinite(value)) {
        throw new Error(`invalid decimal value: ${value}`)
    }
    const normalized = Object.is(value, -0) ? 0 : value
    if (Number.isInteger(normalized)) return String(normalized)
    return normalized
        .toFixed(12)
        .replace(/0+$/, '')
        .replace(/\.$/, '')
}

const getFixedFxRateToJpy = (currency: string): number | null =>
    FIXED_FX_RATES_TO_JPY[currency.toUpperCase()] ?? null

const toJpyDecimalString = (amount: number, currency: string): string | null => {
    const rate = getFixedFxRateToJpy(currency)
    return rate === null ? null : toDecimalString(amount * rate)
}

const normalizeCurrencyCode = (currency?: string): string | undefined => {
    const trimmed = currency?.trim().toUpperCase()
    return trimmed && /^[A-Z]{3}$/.test(trimmed) ? trimmed : undefined
}

const mapSaxoAssetClass = (assetType: string): PortfolioSnapshotV1AssetClass | null => {
    const normalized = assetType.toLowerCase()
    if (normalized.includes('cfd')) return 'cfd'
    if (normalized.includes('etf')) return 'etf'
    if (normalized.includes('fx')) return 'fx'
    if (normalized.includes('future')) return 'future'
    if (normalized.includes('option')) return 'option'
    if (normalized.includes('bond')) return 'bond'
    if (normalized.includes('fund')) return 'fund'
    if (normalized.includes('stock') || normalized.includes('equity')) return 'stock'
    return null
}

const isEquityContributionAssetClass = (assetClass: PortfolioSnapshotV1AssetClass): boolean =>
    assetClass === 'cfd' || assetClass === 'fx' || assetClass === 'future'

const extractInstrumentReference = (
    position: SaxoNetPosition,
): { assetType?: string; uic?: number } => {
    const assetType = position.NetPositionBase.AssetType ?? position.AssetType
    const uic = position.NetPositionBase.Uic ?? position.Uic
    if (assetType && typeof uic === 'number' && Number.isFinite(uic)) {
        return { assetType, uic }
    }

    const prefix = position.NetPositionId.split('__')[0] ?? position.NetPositionId
    const colonMatch = prefix.match(/^([^:]+):(\d+)$/)
    if (colonMatch?.[1] && colonMatch[2]) {
        return {
            assetType: colonMatch[1],
            uic: Number(colonMatch[2]),
        }
    }

    return { assetType, uic }
}

const extractInstrumentDetailsPayload = (
    payload: SaxoInstrumentDetailsResponse,
): SaxoInstrumentDetails | null => {
    if (payload.Data) {
        return payload.Data[0] ?? null
    }
    return payload
}

const getInstrumentDisplaySymbol = (
    details: SaxoInstrumentDetails | null,
    fallback: string,
): string => (
    details?.DisplayAndFormat?.Symbol ??
    details?.Symbol ??
    fallback
)

const getInstrumentDisplayName = (details: SaxoInstrumentDetails | null): string | undefined => (
    details?.DisplayAndFormat?.Description ??
    details?.Description
)

const getInstrumentCurrency = (details: SaxoInstrumentDetails | null): string | undefined =>
    normalizeCurrencyCode(details?.DisplayAndFormat?.Currency ?? details?.CurrencyCode)

const buildSaxoInstrumentKey = (assetType: string, uic: number): string => `${assetType}:${uic}`

const mapWithConcurrency = async <T, U>(
    items: T[],
    concurrency: number,
    mapper: (item: T, index: number) => Promise<U>,
): Promise<U[]> => {
    const results = new Array<U>(items.length)
    let nextIndex = 0
    const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length)

    await Promise.all(
        Array.from({ length: workerCount }, async () => {
            while (true) {
                const index = nextIndex
                nextIndex += 1
                if (index >= items.length) return
                results[index] = await mapper(items[index] as T, index)
            }
        }),
    )

    return results
}

const parseRetryAfterMs = (value: string | null): number | null => {
    if (!value) return null

    const seconds = Number(value)
    if (Number.isFinite(seconds) && seconds > 0) {
        return seconds * 1000
    }

    const retryAt = Date.parse(value)
    if (Number.isNaN(retryAt)) return null

    return Math.max(0, retryAt - Date.now())
}

const isSaxoFillActivity = (activity: SaxoOrderActivity): boolean => (
    (activity.Status === 'FinalFill' || activity.Status === 'Fill') &&
    (typeof activity.ExecutionPrice === 'number' || typeof activity.AveragePrice === 'number')
)

const getSaxoActivityPrice = (activity: SaxoOrderActivity): number | null => (
    typeof activity.ExecutionPrice === 'number'
        ? activity.ExecutionPrice
        : typeof activity.AveragePrice === 'number'
            ? activity.AveragePrice
            : null
)

const getSaxoActivityFillAmount = (activity: SaxoOrderActivity): number | null => {
    if (typeof activity.FillAmount !== 'number') return null
    const amount = Math.abs(activity.FillAmount)
    return amount > 0 ? amount : null
}

const getSaxoActivityCumulativeAmount = (activity: SaxoOrderActivity): number | null => {
    const rawAmount = typeof activity.FilledAmount === 'number'
        ? activity.FilledAmount
        : typeof activity.Amount === 'number'
            ? activity.Amount
            : undefined
    if (typeof rawAmount !== 'number') return null
    const amount = Math.abs(rawAmount)
    return amount > 0 ? amount : null
}

const aggregateSaxoExecution = (
    activities: SaxoOrderActivity[],
): { price: number, size: number, executed_at?: Date } | null => {
    const fills = activities
        .filter(isSaxoFillActivity)
        .sort((a, b) => (parseSaxoActivityTime(a)?.getTime() ?? 0) - (parseSaxoActivityTime(b)?.getTime() ?? 0))
    if (fills.length === 0) return null

    let latestExecutedAt: Date | undefined
    for (const fill of fills) {
        const executedAt = parseSaxoActivityTime(fill)
        if (executedAt && (!latestExecutedAt || executedAt.getTime() > latestExecutedAt.getTime())) {
            latestExecutedAt = executedAt
        }
    }

    const perFillAmounts = fills.map((fill) => ({
        amount: getSaxoActivityFillAmount(fill),
        price: getSaxoActivityPrice(fill),
    }))
    if (perFillAmounts.some((item) => item.amount !== null)) {
        let totalSize = 0
        let totalValue = 0
        for (const item of perFillAmounts) {
            if (item.amount === null || item.price === null) continue
            totalSize += item.amount
            totalValue += item.price * item.amount
        }
        if (totalSize > 0) {
            return { price: totalValue / totalSize, size: totalSize, executed_at: latestExecutedAt }
        }
    }

    const latestFill = fills[fills.length - 1]
    if (!latestFill) return null
    const latestPrice = getSaxoActivityPrice(latestFill)
    if (latestPrice === null) return null

    const cumulativeSize = Math.max(
        ...fills
            .map(getSaxoActivityCumulativeAmount)
            .filter((amount): amount is number => amount !== null),
        0,
    )
    if (cumulativeSize <= 0) return null

    return { price: latestPrice, size: cumulativeSize, executed_at: latestExecutedAt }
}

const summarizeSaxoActivities = (activities: SaxoOrderActivity[]): Record<string, number> => {
    const summary: Record<string, number> = {}
    for (const activity of activities) {
        summary[activity.Status] = (summary[activity.Status] ?? 0) + 1
    }
    return summary
}

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
    ExternalReference?: string
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

const buildSaxoExternalReference = (eventId: string): string => {
    const normalized = eventId.trim().replace(/[^A-Za-z0-9_-]/g, '').slice(0, 47)
    return `tg:${normalized || 'order'}`
}

const buildSaxoOrderMetadata = (
    order: OrderRequest,
    orderId: string,
    relatedOrders: SaxoRelatedOrder[],
    relatedOrderIds: Array<string | null> = [],
): SaxoOrderMetadata => {
    const externalReference = buildSaxoExternalReference(order.eventId)

    return {
        kind: 'saxo_order_v1',
        order_id: orderId,
        external_reference: externalReference,
        entry: {
            expected: {
                side: order.side,
                order_type: 'Market',
                size: order.size,
            },
            resolved: {
                order_id: orderId,
                external_reference: externalReference,
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
                external_reference: relatedOrder.ExternalReference,
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
    private readonly rateLimitCooldownMs: number
    private readonly tokenEncryptionKey?: string
    private readonly refreshWaitIntervalMs: number
    private authStore?: SaxoAuthStore
    private rateLimitedUntilMs = 0
    private auditActivitiesCache?: {
        fetchedAtMs: number
        activities: SaxoOrderActivity[]
    }
    private readonly instrumentDetailsCache = new Map<string, CachedSaxoInstrumentDetails>()

    constructor(options: SaxoClientOptions = {}) {
        this.appKey = options.appKey
        this.appSecret = options.appSecret
        this.baseUrl = options.baseUrl ?? 'https://gateway.saxobank.com/sim/openapi'
        this.authBaseUrl = options.authBaseUrl ?? 'https://sim.logonvalidation.net'
        this.redirectUri = options.redirectUri
        this.fetchImpl = options.fetchImpl ?? fetch
        this.db = options.db
        this.logger = options.logger ?? defaultLogger
        this.rateLimitCooldownMs = options.rateLimitCooldownMs ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS
        this.tokenEncryptionKey = options.tokenEncryptionKey
        this.authStore = options.authStore
        this.refreshWaitIntervalMs = options.refreshWaitIntervalMs ?? 1_000
    }

    private getFirestore(): Firestore {
        return this.db ?? getFirestoreClient()
    }

    private getAuthStore(): SaxoAuthStore {
        this.authStore ??= new SaxoAuthStore({
            db: this.getFirestore(),
            tokenEncryptionKey: this.tokenEncryptionKey,
            logger: this.logger,
        })
        return this.authStore
    }

    private buildSaxoApiUrl(pathOrUrl: string): string {
        if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
            return pathOrUrl
        }
        if (pathOrUrl.startsWith('/')) {
            return `${this.baseUrl}${pathOrUrl}`
        }
        return `${this.baseUrl}/${pathOrUrl}`
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

    private isRateLimited(): boolean {
        return this.rateLimitedUntilMs > Date.now()
    }

    private markRateLimited(response: Response): void {
        const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
        const cooldownMs = retryAfterMs ?? this.rateLimitCooldownMs
        this.rateLimitedUntilMs = Date.now() + cooldownMs
        this.logger.warn(
            {
                event: 'saxo:rate_limited',
                status: response.status,
                cooldownMs,
                rateLimitedUntil: new Date(this.rateLimitedUntilMs).toISOString(),
            },
            'Saxo API rate limited; suppressing audit calls temporarily',
        )
    }

    private async getOrderActivitiesPollState(): Promise<SaxoOrderActivitiesPollState> {
        const doc = await this.getFirestore()
            .collection(CRON_METADATA_COLLECTION)
            .doc(SAXO_ORDER_ACTIVITIES_POLL_DOC)
            .get()
        return doc.exists ? doc.data() as SaxoOrderActivitiesPollState : {}
    }

    private async saveOrderActivitiesPollState(state: SaxoOrderActivitiesPollState): Promise<void> {
        const docRef = this.getFirestore()
            .collection(CRON_METADATA_COLLECTION)
            .doc(SAXO_ORDER_ACTIVITIES_POLL_DOC)
        await setFirestoreDocument(
            docRef,
            state as Record<string, unknown>,
            {
                collection: CRON_METADATA_COLLECTION,
                docId: SAXO_ORDER_ACTIVITIES_POLL_DOC,
                logger: this.logger,
            },
            { merge: true },
        )
    }

    private buildOrderActivitiesInitialUrl(auth: SaxoAuthData, state: SaxoOrderActivitiesPollState, now: Date): string {
        const params = new URLSearchParams()
        const clientKey = auth.accounts?.[0]?.clientKey
        if (clientKey) {
            params.append('ClientKey', clientKey)
        }
        params.append('$top', '1000')

        const lastPollMs = state.last_poll_at ? Date.parse(state.last_poll_at) : NaN
        const hasRecentCursor = Number.isFinite(lastPollMs) &&
            now.getTime() - lastPollMs <= SAXO_AUDIT_CURSOR_MAX_IDLE_MS &&
            state.next_poll_url

        if (hasRecentCursor && state.next_poll_url) {
            return this.buildSaxoApiUrl(state.next_poll_url)
        }

        const fromMs = Number.isFinite(lastPollMs)
            ? Math.max(0, lastPollMs - SAXO_AUDIT_OVERLAP_MS)
            : now.getTime() - SAXO_AUDIT_INITIAL_LOOKBACK_MS

        params.append('FromDateTime', new Date(fromMs).toISOString())
        params.append('ToDateTime', now.toISOString())
        return `${this.baseUrl}/cs/v1/audit/orderactivities/?${params.toString()}`
    }

    private async fetchOrderActivitiesBatch(): Promise<SaxoOrderActivity[]> {
        if (this.auditActivitiesCache && Date.now() - this.auditActivitiesCache.fetchedAtMs <= SAXO_AUDIT_BATCH_CACHE_MS) {
            return this.auditActivitiesCache.activities
        }

        const cacheActivities = (activities: SaxoOrderActivity[]): SaxoOrderActivity[] => {
            this.auditActivitiesCache = {
                fetchedAtMs: Date.now(),
                activities,
            }
            return activities
        }

        if (this.isRateLimited()) {
            this.logger.warn(
                {
                    event: 'saxo:orderactivities_batch_skipped_rate_limited',
                    rateLimitedUntil: new Date(this.rateLimitedUntilMs).toISOString(),
                },
                'skipping Saxo audit batch request while rate limited',
            )
            return cacheActivities([])
        }

        const accessToken = await this.getValidAccessToken()
        if (!accessToken) return cacheActivities([])

        const auth = await this.getAuth()
        if (!auth) return cacheActivities([])

        const now = new Date()
        const state = await this.getOrderActivitiesPollState()
        let url: string | undefined = this.buildOrderActivitiesInitialUrl(auth, state, now)
        const activities: SaxoOrderActivity[] = []
        let nextPollUrl: string | undefined

        for (let page = 0; url && page < SAXO_AUDIT_MAX_PAGES_PER_POLL; page += 1) {
            const response = await this.fetchImpl(url, {
                headers: { Authorization: `Bearer ${accessToken}` },
            })

            if (!response.ok) {
                if (response.status === 429) {
                    this.markRateLimited(response)
                }
                this.logger.warn(
                    {
                        event: 'saxo:orderactivities_batch_failed',
                        status: response.status,
                        response: await response.text(),
                    },
                    'failed to fetch Saxo audit orderactivities batch',
                )
                return cacheActivities([])
            }

            const data = (await response.json()) as SaxoOrderActivitiesResponse
            activities.push(...(data.Data ?? []))
            nextPollUrl = data.__nextPoll ?? nextPollUrl
            url = data.__next ? this.buildSaxoApiUrl(data.__next) : undefined
        }

        if (url) {
            this.logger.warn(
                {
                    event: 'saxo:orderactivities_batch_page_limit_reached',
                    maxPages: SAXO_AUDIT_MAX_PAGES_PER_POLL,
                },
                'Saxo audit orderactivities page limit reached; poll state was not advanced',
            )
        } else {
            await this.saveOrderActivitiesPollState({
                last_poll_at: now.toISOString(),
                next_poll_url: nextPollUrl ?? '',
            })
        }

        return cacheActivities(activities)
    }

    private async getExecutionFromRecentActivities(orderId: string): Promise<{ price: number, size: number, executed_at?: Date } | null> {
        const activities = await this.fetchOrderActivitiesBatch()
        const matchingActivities = activities.filter((activity) => activity.OrderId === orderId)
        const execution = aggregateSaxoExecution(matchingActivities)

        if (matchingActivities.length === 0) {
            this.logger.info(
                {
                    event: 'saxo:execution_audit_no_match',
                    orderId,
                    fetchedActivityCount: activities.length,
                    matchedActivityCount: 0,
                },
                'no Saxo audit activities matched the requested order id',
            )
            return null
        }

        if (!execution) {
            this.logger.info(
                {
                    event: 'saxo:execution_audit_unresolved',
                    orderId,
                    fetchedActivityCount: activities.length,
                    matchedActivityCount: matchingActivities.length,
                    matchedStatuses: summarizeSaxoActivities(matchingActivities),
                    matchedActivities: matchingActivities.map((activity) => ({
                        logId: activity.LogId,
                        status: activity.Status,
                        executionPrice: activity.ExecutionPrice,
                        averagePrice: activity.AveragePrice,
                        fillAmount: activity.FillAmount,
                        filledAmount: activity.FilledAmount,
                        amount: activity.Amount,
                        activityTime: activity.ActivityTime ?? activity.ExecutionTime ?? activity.UtcTime,
                    })),
                },
                'matched Saxo audit activities could not be aggregated into an execution',
            )
        }

        return execution
    }

    async getAuth(): Promise<SaxoAuthData | null> {
        return this.getAuthStore().getAuth()
    }

    async saveAuth(data: SaxoAuthData): Promise<void> {
        await this.getAuthStore().saveAuth(data)
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
            await cancelResponseBody(response)
            throw new Error(`Failed to refresh Saxo token (HTTP ${response.status})`)
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
            await cancelResponseBody(response)
            throw new Error(`Failed to exchange Saxo code (HTTP ${response.status})`)
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

        const authStore = this.getAuthStore()
        const lease = await authStore.acquireRefreshLease()
        if (lease.status === 'missing') return null
        if (lease.status === 'already-fresh') return lease.auth.accessToken
        if (lease.status === 'already-refreshing') {
            // Wait for the other process to finish refreshing
            for (let i = 0; i < 15; i++) {
                await new Promise((resolve) => setTimeout(resolve, this.refreshWaitIntervalMs))
                auth = await this.getAuth()
                if (auth && auth.accessTokenExpiresAt >= Date.now() + 60 * 1000) {
                    return auth.accessToken
                }
            }
            this.logger.warn({ event: 'saxo:token_refresh_timeout' }, 'Timed out waiting for Saxo token refresh lock')
            return null
        }

        auth = lease.auth
        if (auth.refreshTokenExpiresAt < Date.now() + 60 * 1000) {
            await authStore.releaseRefreshLease()
            return null
        }

        try {
            const newAuth = await this.refreshAccessToken(auth.refreshToken)
            // refreshAccessToken calls saveAuth (using .set) which overwrites the whole document, effectively clearing the lock.
            return newAuth.accessToken
        } catch (error) {
            this.logger.warn({ event: 'saxo:token_refresh_failed', error }, 'Failed to auto-refresh Saxo token')
            // Release lock on failure
            await authStore.releaseRefreshLease()
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
        const externalReference = buildSaxoExternalReference(order.eventId)

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
                        ExternalReference: externalReference,
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
                        ExternalReference: externalReference,
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
            ExternalReference: externalReference,
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

    private async getPortfolioAccounts(accessToken: string): Promise<SaxoAccountInfo[]> {
        const auth = await this.getAuth()
        if (auth?.accounts && auth.accounts.length > 0) {
            return auth.accounts
        }

        const accounts = await this.fetchAccounts(accessToken)
        if (auth) {
            await this.saveAuth({ ...auth, accounts })
        }
        return accounts
    }

    private async fetchPortfolioBalance(accessToken: string): Promise<SaxoBalanceResponse> {
        const response = await this.fetchImpl(`${this.baseUrl}/port/v1/balances/me`, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        })

        if (!response.ok) {
            const body = await response.text()
            throw new Error(`Failed to fetch Saxo balances: ${response.status} ${body}`)
        }

        return (await response.json()) as SaxoBalanceResponse
    }

    private async fetchNetPositions(accessToken: string): Promise<SaxoNetPosition[]> {
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
        return data.Data
    }

    private purgeExpiredInstrumentDetailsCache(nowMs = Date.now()): void {
        for (const [cacheKey, cached] of this.instrumentDetailsCache) {
            if (cached.expiresAtMs <= nowMs) {
                this.instrumentDetailsCache.delete(cacheKey)
            }
        }
    }

    private async getInstrumentDetails(
        accessToken: string,
        assetType: string,
        uic: number,
    ): Promise<SaxoInstrumentDetails | null> {
        const cacheKey = buildSaxoInstrumentKey(assetType, uic)
        const nowMs = Date.now()
        const cached = this.instrumentDetailsCache.get(cacheKey)
        if (cached && cached.expiresAtMs > nowMs) {
            return cached.details
        }
        if (cached) {
            this.instrumentDetailsCache.delete(cacheKey)
        }

        const url = `${this.baseUrl}/ref/v1/instruments/details/${uic}/${encodeURIComponent(assetType)}`
        let response: Response
        try {
            response = await this.fetchImpl(url, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            })
        } catch (error) {
            this.logger.warn(
                {
                    event: 'saxo:instrument_details_failed',
                    error,
                    assetType,
                    uic,
                },
                'failed to fetch Saxo instrument details',
            )
            return null
        }

        if (!response.ok) {
            const body = await response.text()
            this.logger.warn(
                {
                    event: 'saxo:instrument_details_failed',
                    status: response.status,
                    response: body,
                    assetType,
                    uic,
                },
                'failed to fetch Saxo instrument details',
            )
            return null
        }

        let payload: SaxoInstrumentDetailsResponse
        try {
            payload = (await response.json()) as SaxoInstrumentDetailsResponse
        } catch (error) {
            this.logger.warn(
                {
                    event: 'saxo:instrument_details_parse_failed',
                    error,
                    assetType,
                    uic,
                },
                'failed to parse Saxo instrument details',
            )
            return null
        }
        const details = extractInstrumentDetailsPayload(payload)
        if (!details) {
            return null
        }

        this.instrumentDetailsCache.set(cacheKey, {
            details,
            expiresAtMs: Date.now() + SAXO_INSTRUMENT_DETAILS_CACHE_TTL_MS,
        })
        return details
    }

    private async fetchInstrumentDetailsByKey(
        accessToken: string,
        references: Array<{ assetType: string; uic: number }>,
    ): Promise<Map<string, SaxoInstrumentDetails | null>> {
        const uniqueReferences = new Map<string, { assetType: string; uic: number }>()
        for (const reference of references) {
            uniqueReferences.set(buildSaxoInstrumentKey(reference.assetType, reference.uic), reference)
        }

        this.purgeExpiredInstrumentDetailsCache()
        const entries = await mapWithConcurrency(
            [...uniqueReferences.entries()],
            SAXO_INSTRUMENT_DETAILS_FETCH_CONCURRENCY,
            async ([key, reference]) => [
                key,
                await this.getInstrumentDetails(accessToken, reference.assetType, reference.uic),
            ] as const,
        )
        return new Map(entries)
    }

    async getPortfolioSnapshot(): Promise<PortfolioSnapshotV1> {
        const accessToken = await this.getValidAccessToken()
        if (!accessToken) {
            throw new Error('Saxo auth is missing or expired')
        }

        const accounts = await this.getPortfolioAccounts(accessToken)
        const primaryAccount = accounts[0]
        if (!primaryAccount) {
            throw new Error('No Saxo accounts found')
        }

        const [balance, rawPositions] = await Promise.all([
            this.fetchPortfolioBalance(accessToken),
            this.fetchNetPositions(accessToken),
        ])
        const generatedAt = new Date().toISOString()
        const reportedBalanceCurrency = normalizeCurrencyCode(balance.Currency)
        const balanceCurrency = 'JPY'
        const primaryAccountCurrency = normalizeCurrencyCode(primaryAccount.currency) ?? balanceCurrency
        const clientAggregateSourceId = `client:${primaryAccount.clientKey}`
        const accountCurrencyByKey = new Map(
            accounts.map((account) => [
                account.accountKey,
                normalizeCurrencyCode(account.currency),
            ] as const),
        )
        const skippedPositions: PortfolioSnapshotV1JsonValue[] = []
        const positions: PortfolioSnapshotV1['positions'] = []
        const instrumentReferences: Array<{ assetType: string; uic: number }> = []
        for (const rawPosition of rawPositions) {
            const { assetType, uic } = extractInstrumentReference(rawPosition)
            if (assetType && typeof uic === 'number' && Number.isFinite(uic) && mapSaxoAssetClass(assetType) !== null) {
                instrumentReferences.push({ assetType, uic })
            }
        }
        const instrumentDetailsByKey = await this.fetchInstrumentDetailsByKey(accessToken, instrumentReferences)

        for (const rawPosition of rawPositions) {
            const { assetType, uic } = extractInstrumentReference(rawPosition)
            if (!assetType || typeof uic !== 'number' || !Number.isFinite(uic)) {
                skippedPositions.push({
                    sourcePositionId: rawPosition.NetPositionId,
                    reason: 'missing_instrument_reference',
                })
                continue
            }

            const assetClass = mapSaxoAssetClass(assetType)
            if (!assetClass) {
                skippedPositions.push({
                    sourcePositionId: rawPosition.NetPositionId,
                    reason: 'unsupported_asset_type',
                    assetType,
                    uic,
                })
                continue
            }

            const sourceInstrumentId = buildSaxoInstrumentKey(assetType, uic)
            const details = instrumentDetailsByKey.get(sourceInstrumentId) ?? null
            const sourceAccountId = rawPosition.NetPositionBase.AccountKey ?? rawPosition.AccountKey ?? primaryAccount.accountKey
            const positionAccountCurrency = accountCurrencyByKey.get(sourceAccountId) ?? primaryAccountCurrency
            const priceCurrency =
                getInstrumentCurrency(details) ??
                normalizeCurrencyCode(rawPosition.NetPositionView.Currency) ??
                positionAccountCurrency
            const amount = Math.abs(rawPosition.NetPositionBase.Amount)
            const price =
                rawPosition.NetPositionView.CurrentPrice ??
                rawPosition.NetPositionView.Price ??
                rawPosition.NetPositionView.AverageOpenPrice
            const accountCurrencyPnl = rawPosition.NetPositionView.ProfitLossOnTradeInBaseCurrency
            const tradeCurrencyPnl = rawPosition.NetPositionView.ProfitLossOnTrade
            const pnl = accountCurrencyPnl ?? tradeCurrencyPnl
            const pnlCurrency = accountCurrencyPnl !== undefined ? positionAccountCurrency : priceCurrency
            const unrealizedPnlJpy = pnl !== undefined ? toJpyDecimalString(pnl, pnlCurrency) : undefined
            const metadata: PortfolioSnapshotV1SourceMetadata = {
                netPositionId: rawPosition.NetPositionId,
                assetType,
                uic,
                instrumentLookupStatus: details ? 'hit' : 'fallback',
            }

            let valueJpy: string
            if (isEquityContributionAssetClass(assetClass)) {
                if (pnl !== undefined && unrealizedPnlJpy === null) {
                    skippedPositions.push({
                        sourcePositionId: rawPosition.NetPositionId,
                        sourceInstrumentId,
                        reason: 'unsupported_fx_rate',
                        currency: pnlCurrency,
                    })
                    continue
                }

                const exposureInBaseCurrency = rawPosition.NetPositionView.ExposureInBaseCurrency
                const exposure = rawPosition.NetPositionView.Exposure
                const notionalValueJpy =
                    exposureInBaseCurrency !== undefined
                        ? toJpyDecimalString(Math.abs(exposureInBaseCurrency), positionAccountCurrency)
                        : exposure !== undefined
                            ? toJpyDecimalString(Math.abs(exposure), priceCurrency)
                            : price !== undefined
                                ? toJpyDecimalString(price * amount, priceCurrency)
                                : undefined

                metadata.valuationBasis = 'equity_contribution'
                if (notionalValueJpy !== undefined && notionalValueJpy !== null) {
                    metadata.notionalValueJpy = notionalValueJpy
                }
                if (notionalValueJpy === null) {
                    metadata.notionalValueStatus = 'unsupported_fx_rate'
                }
                if (unrealizedPnlJpy === undefined) {
                    metadata.valuationStatus = 'missing_unrealized_pnl'
                }
                valueJpy = unrealizedPnlJpy ?? '0'
            } else {
                const marketValueInBaseCurrency = rawPosition.NetPositionView.MarketValueInBaseCurrency
                const marketValue = rawPosition.NetPositionView.MarketValue ?? rawPosition.NetPositionView.PositionValue
                if (marketValueInBaseCurrency !== undefined) {
                    const convertedValue = toJpyDecimalString(marketValueInBaseCurrency, positionAccountCurrency)
                    if (convertedValue === null) {
                        skippedPositions.push({
                            sourcePositionId: rawPosition.NetPositionId,
                            sourceInstrumentId,
                            reason: 'unsupported_fx_rate',
                            currency: positionAccountCurrency,
                        })
                        continue
                    }
                    valueJpy = convertedValue
                    metadata.valuationBasis = 'market_value_in_base_currency'
                } else if (marketValue !== undefined) {
                    const convertedValue = toJpyDecimalString(marketValue, priceCurrency)
                    if (convertedValue === null) {
                        skippedPositions.push({
                            sourcePositionId: rawPosition.NetPositionId,
                            sourceInstrumentId,
                            reason: 'unsupported_fx_rate',
                            currency: priceCurrency,
                        })
                        continue
                    }
                    valueJpy = convertedValue
                    metadata.valuationBasis = 'market_value'
                } else if (price !== undefined) {
                    const convertedValue = toJpyDecimalString(price * amount, priceCurrency)
                    if (convertedValue === null) {
                        skippedPositions.push({
                            sourcePositionId: rawPosition.NetPositionId,
                            sourceInstrumentId,
                            reason: 'unsupported_fx_rate',
                            currency: priceCurrency,
                        })
                        continue
                    }
                    valueJpy = convertedValue
                    metadata.valuationBasis = 'price_times_quantity'
                } else {
                    valueJpy = '0'
                    metadata.valuationStatus = 'missing_market_value'
                }
                if (pnl !== undefined && unrealizedPnlJpy === null) {
                    metadata.unrealizedPnlStatus = 'unsupported_fx_rate'
                }
            }

            positions.push({
                sourceAccountId,
                sourcePositionId: rawPosition.NetPositionId,
                sourceInstrumentId,
                assetClass,
                symbol: getInstrumentDisplaySymbol(details, sourceInstrumentId),
                ...(getInstrumentDisplayName(details) ? { name: getInstrumentDisplayName(details) } : {}),
                quantity: toDecimalString(amount),
                side: rawPosition.NetPositionBase.Amount === 0
                    ? 'flat'
                    : rawPosition.NetPositionBase.OpeningDirection === 'Buy'
                        ? 'long'
                        : 'short',
                ...(price !== undefined ? { price: toDecimalString(price) } : {}),
                priceCurrency,
                valueJpy,
                ...(typeof unrealizedPnlJpy === 'string' ? { unrealizedPnlJpy } : {}),
                sourceMetadata: metadata,
            })
        }

        const cashBalances: PortfolioSnapshotV1['cashBalances'] = []
        if (typeof balance.CashBalance === 'number') {
            const cashAmount = toDecimalString(balance.CashBalance)
            cashBalances.push({
                sourceAccountId: clientAggregateSourceId,
                currency: balanceCurrency,
                amount: cashAmount,
                valueJpy: cashAmount,
                fxRateToJpy: '1',
                sourceBalanceId: `${clientAggregateSourceId}:${balanceCurrency}:CashBalance`,
                sourceMetadata: {
                    sourceEndpoint: '/port/v1/balances/me',
                    sourceField: 'CashBalance',
                    sourceScope: 'client',
                    currencyAssumption: 'client_aggregate_jpy',
                    ...(reportedBalanceCurrency ? { reportedCurrency: reportedBalanceCurrency } : {}),
                },
            })
        }

        const balanceMetadata: PortfolioSnapshotV1SourceMetadata = {}
        for (const [key, value] of Object.entries({
            cashAvailableForTrading: balance.CashAvailableForTrading,
            totalValue: balance.TotalValue,
            netEquity: balance.NetEquity,
        })) {
            if (typeof value === 'number') {
                balanceMetadata[key] = value
            }
        }

        const sourceMetadata: PortfolioSnapshotV1SourceMetadata = {
            contractOwner: 'equinaut',
            fxRatesToJpy: FIXED_FX_RATES_TO_JPY,
            balanceCurrency,
            balanceCurrencyAssumption: 'client_aggregate_jpy',
            ...(reportedBalanceCurrency ? { reportedCurrency: reportedBalanceCurrency } : {}),
            ...(Object.keys(balanceMetadata).length > 0 ? { balance: balanceMetadata } : {}),
            ...(skippedPositions.length > 0 ? { skippedPositions } : {}),
        }

        return {
            schemaVersion: portfolioSnapshotV1SchemaVersion,
            source: {
                id: 'saxo-bank',
                provider: 'Saxo Bank',
                exporter: 'trade-gateway',
            },
            generatedAt,
            dataAsOf: generatedAt,
            baseCurrency: 'JPY',
            accounts: accounts.map((account) => ({
                sourceAccountId: account.accountKey,
                name: account.displayName,
                baseCurrency: normalizeCurrencyCode(account.currency),
                sourceMetadata: {
                    clientKey: account.clientKey,
                    legalAssetTypes: account.legalAssetTypes,
                },
            })),
            cashBalances,
            positions,
            sourceMetadata,
        }
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

    async getBalances(): Promise<Balance[]> {
        const accessToken = await this.getValidAccessToken()
        if (!accessToken) {
            return []
        }

        try {
            const response = await this.fetchImpl(`${this.baseUrl}/port/v1/balances/me`, {
                headers: {
                    Authorization: `Bearer ${accessToken}`,
                },
            })

            if (!response.ok) {
                const body = await response.text()
                throw new Error(`Failed to fetch Saxo balances: ${response.status} ${body}`)
            }

            const data = (await response.json()) as SaxoBalanceResponse
            const currency = data.Currency ?? 'ACCOUNT'
            const balances = [
                { asset: currency, amount: data.CashBalance },
                { asset: `${currency}_AVAILABLE_FOR_TRADING`, amount: data.CashAvailableForTrading },
                { asset: `${currency}_TOTAL_VALUE`, amount: data.TotalValue },
                { asset: `${currency}_NET_EQUITY`, amount: data.NetEquity },
            ]

            return balances
                .filter((balance): balance is Balance & { amount: number } =>
                    typeof balance.amount === 'number' && balance.amount !== 0)
                .map(({ asset, amount }) => ({ asset, amount }))
        } catch (error) {
            this.logger.warn({ event: 'saxo:get_balances_failed', error }, 'Failed to get Saxo balances')
            return []
        }
    }

    async getExecutionPriceForOrderV2(order: OrderV2): Promise<OrdersV2ExecutionSyncResult> {
        const providerOrderId = order.provider_order_ids[0]
        if (!providerOrderId || providerOrderId === 'DRY_RUN') {
            return { execution: null }
        }

        const metadata = order.broker_order_metadata
        if (metadata?.kind !== 'saxo_order_v1') {
            this.logger.warn(
                {
                    event: 'saxo:orders_v2_metadata_missing',
                    orderId: order.id,
                    ticker: order.ticker,
                    expectedKind: 'saxo_order_v1',
                    actualKind: metadata?.kind,
                },
                'orders_v2 execution sync skipped: broker_order_metadata is missing or invalid',
            )
            return { execution: null }
        }

        const entryOrderId = metadata.entry.resolved.order_id || metadata.order_id || providerOrderId
        const execution = await this.getExecutionFromRecentActivities(entryOrderId)
        return {
            execution,
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
            this.logger.warn(
                {
                    event: 'saxo:orders_v2_metadata_missing',
                    orderId: order.id,
                    ticker: order.ticker,
                    expectedKind: 'saxo_order_v1',
                    actualKind: metadata?.kind,
                },
                'orders_v2 closing sync skipped: broker_order_metadata is missing or invalid',
            )
            return { execution: null }
        }

        let totalSize = 0
        let totalValue = 0
        let latestExecutedAt: Date | undefined

        for (const exit of metadata.exits) {
            const exitOrderId = exit.resolved.order_id
            if (!exitOrderId) continue

            const execution = await this.getExecutionFromRecentActivities(exitOrderId)
            if (!execution) continue

            const size = execution.size
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
