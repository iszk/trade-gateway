import type { Firestore } from 'firebase-admin/firestore'
import { getFirestoreClient, setFirestoreDocument } from '../firestore.js'
import type { OrderDispatchFailure, OrderDispatchResult, OrderRequest } from '../types/order.js'
import type { SaxoOrderMetadata } from '../types/broker-order-metadata.js'
import type {
    ExecutionReconciliationRange,
    ExecutionSyncOptions,
    ExecutionSyncTerminal,
    OrderExecutionSyncResult,
} from '../types/execution-sync.js'
import type { OrderV2 } from '../types/order-v2.js'
import {
    classifySaxoOrderMetadata,
} from './saxo-order-metadata.js'
import {
    parseSaxoOpenOrderEvidence,
    recoverSaxoIfdocoMetadataFromEvidence,
    type SaxoIfdocoMetadataRecoveryResult,
    type SaxoIfdocoTemporaryFailureReason,
    type SaxoOpenOrderEvidence,
} from './saxo-ifdoco-metadata-recovery.js'
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
import {
    fetchSaxoOrderActivitiesPages,
    isSaxoFillActivity,
    SAXO_ORDER_ACTIVITIES_MAX_PAGES,
    SAXO_ORDER_ACTIVITIES_PAGE_SIZE,
    summarizeSaxoActivities,
    normalizeSaxoOrderActivities,
    resolveSaxoOrderActivities,
    type SaxoOrderActivity,
    type SaxoOrderActivitiesPageResult,
    type SaxoOrderActivityResolution,
} from './saxo-order-activities.js'

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
    sleepImpl?: (ms: number) => Promise<void>
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

type SaxoOrderActivitiesPollState = {
    last_poll_at?: string
    next_poll_url?: string
}

type SaxoOrderActivitiesReconciliationState = {
    direct_lookup_after_order_id?: string
    last_direct_lookup_at?: string
    last_reconciliation_started_at?: string
    last_reconciliation_completed_at?: string
    last_reconciliation_window_from?: string
    last_reconciliation_window_to?: string
    last_reconciliation_outcome?: 'COMPLETE' | 'INCOMPLETE' | 'RATE_LIMITED' | 'FAILED'
}

type SaxoRangeFetchResult =
    | { complete: true, activities: SaxoOrderActivity[], pageCount: number }
    | { complete: false, reason: 'HTTP_ERROR' | 'PARSE_ERROR' | 'PAGE_LIMIT', pageCount: number, rateLimited: boolean }

const cancelResponseBody = async (response: Response): Promise<void> => {
    try {
        await response.body?.cancel()
    } catch {
        // Body disposal is best-effort; keep the caller-facing error fixed and safe.
    }
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
const SAXO_ORDER_ACTIVITIES_RECONCILIATION_DOC = 'saxo_orderactivities_reconciliation_state'
const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000
const SAXO_AUDIT_INITIAL_LOOKBACK_MS = 48 * 60 * 60 * 1000
const SAXO_AUDIT_OVERLAP_MS = 30 * 60 * 1000
const SAXO_AUDIT_CURSOR_MAX_IDLE_MS = 30 * 60 * 1000
const SAXO_AUDIT_BATCH_CACHE_MS = 60 * 1000
const SAXO_INSTRUMENT_DETAILS_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const SAXO_INSTRUMENT_DETAILS_FETCH_CONCURRENCY = 5
const SAXO_RECONCILIATION_MAX_DIRECT_CANDIDATES = 10
const SAXO_RECONCILIATION_MAX_DIRECT_REQUESTS = 20
const SAXO_RECONCILIATION_MAX_DIRECT_PAGES_PER_ORDER = 5
const SAXO_RECONCILIATION_REQUEST_CONCURRENCY = 2
const SAXO_RECONCILIATION_PAGE_SIZE = 500
const SAXO_RECONCILIATION_MAX_RETRIES = 1
const SAXO_RECONCILIATION_RETRY_BASE_MS = 100
const SAXO_RECONCILIATION_RETRY_JITTER_MS = 100
const SAXO_RECONCILIATION_RECENT_ORDER_MAX_AGE_MS = 24 * 60 * 60 * 1000
const EPSILON = 0.00000001
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

class AsyncConcurrencyLimiter {
    private active = 0
    private readonly queue: Array<{
        task: () => Promise<unknown>
        resolve: (value: unknown) => void
        reject: (error: unknown) => void
    }> = []

    constructor(private readonly limit: number) { }

    async run<T>(task: () => Promise<T>): Promise<T> {
        if (this.active >= this.limit) {
            return new Promise<T>((resolve, reject) => {
                this.queue.push({ task, resolve: resolve as (value: unknown) => void, reject })
            })
        }

        return this.execute(task)
    }

    private async execute<T>(task: () => Promise<T>): Promise<T> {
        this.active += 1
        try {
            return await task()
        } finally {
            this.active -= 1
            const next = this.queue.shift()
            if (next) {
                void this.execute(next.task).then(next.resolve, next.reject)
            }
        }
    }
}

const saxoAuditRequestLimiter = new AsyncConcurrencyLimiter(SAXO_RECONCILIATION_REQUEST_CONCURRENCY)

class SaxoDirectLookupError extends Error {
    constructor(readonly reason: 'budget' | 'rate_limited' | 'failed') {
        super(`Saxo direct audit lookup ${reason}`)
    }
}

class SaxoIfdocoRecoveryRequestError extends Error {
    constructor(readonly reason: SaxoIfdocoTemporaryFailureReason) {
        super(`Saxo IFDOCO recovery request ${reason}`)
    }
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

type OrdersV2ExecutionSyncResult = OrderExecutionSyncResult

const toSaxoTerminalStatus = (
    brokerState: SaxoOrderActivityResolution['brokerState'],
): ExecutionSyncTerminal => {
    if (brokerState === 'CANCELED') {
        return { terminalStatus: 'CANCELED', terminalReason: 'saxo_confirmed_cancel' }
    }
    if (brokerState === 'EXPIRED') {
        return { terminalStatus: 'CANCELED', terminalReason: 'saxo_confirmed_expire' }
    }
    if (brokerState === 'PLACEMENT_REJECTED') {
        return { terminalStatus: 'FAILED', terminalReason: 'saxo_placement_rejected' }
    }
    return {}
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
    private readonly sleepImpl: (ms: number) => Promise<void>
    private authStore?: SaxoAuthStore
    private rateLimitedUntilMs = 0
    private auditActivitiesCache?: {
        fetchedAtMs: number
        result: SaxoOrderActivitiesPageResult
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
        this.sleepImpl = options.sleepImpl ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
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

    private async getOrderActivitiesReconciliationState(): Promise<SaxoOrderActivitiesReconciliationState> {
        const doc = await this.getFirestore()
            .collection(CRON_METADATA_COLLECTION)
            .doc(SAXO_ORDER_ACTIVITIES_RECONCILIATION_DOC)
            .get()
        return doc.exists ? doc.data() as SaxoOrderActivitiesReconciliationState : {}
    }

    private async saveOrderActivitiesReconciliationState(
        state: SaxoOrderActivitiesReconciliationState,
    ): Promise<void> {
        const docRef = this.getFirestore()
            .collection(CRON_METADATA_COLLECTION)
            .doc(SAXO_ORDER_ACTIVITIES_RECONCILIATION_DOC)
        await setFirestoreDocument(
            docRef,
            state as Record<string, unknown>,
            {
                collection: CRON_METADATA_COLLECTION,
                docId: SAXO_ORDER_ACTIVITIES_RECONCILIATION_DOC,
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
        params.append('$top', String(SAXO_ORDER_ACTIVITIES_PAGE_SIZE))

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

    private async fetchOrderActivitiesBatch(now = new Date()): Promise<SaxoOrderActivitiesPageResult> {
        if (this.auditActivitiesCache && Date.now() - this.auditActivitiesCache.fetchedAtMs <= SAXO_AUDIT_BATCH_CACHE_MS) {
            return this.auditActivitiesCache.result
        }

        const cacheResult = (result: SaxoOrderActivitiesPageResult): SaxoOrderActivitiesPageResult => {
            this.auditActivitiesCache = {
                fetchedAtMs: Date.now(),
                result,
            }
            return result
        }

        if (this.isRateLimited()) {
            this.logger.warn(
                {
                    event: 'saxo:orderactivities_batch_skipped_rate_limited',
                    rateLimitedUntil: new Date(this.rateLimitedUntilMs).toISOString(),
                },
                'skipping Saxo audit batch request while rate limited',
            )
            return cacheResult({ complete: false, reason: 'HTTP_ERROR' })
        }

        const accessToken = await this.getValidAccessToken()
        if (!accessToken) return cacheResult({ complete: false, reason: 'HTTP_ERROR' })

        const auth = await this.getAuth()
        if (!auth) return cacheResult({ complete: false, reason: 'HTTP_ERROR' })

        const state = await this.getOrderActivitiesPollState()
        const result = await fetchSaxoOrderActivitiesPages({
            initialUrl: this.buildOrderActivitiesInitialUrl(auth, state, now),
            maxPages: SAXO_ORDER_ACTIVITIES_MAX_PAGES,
            resolveNextUrl: (url) => this.buildSaxoApiUrl(url),
            fetchPage: (url) => saxoAuditRequestLimiter.run(() => this.fetchImpl(url, {
                headers: { Authorization: `Bearer ${accessToken}` },
            })),
            onHttpError: async (response) => {
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
            },
        })

        if (!result.complete) {
            this.logger.warn(
                {
                    event: result.reason === 'PAGE_LIMIT'
                        ? 'saxo:orderactivities_batch_page_limit_reached'
                        : 'saxo:orderactivities_batch_incomplete',
                    reason: result.reason,
                    maxPages: SAXO_ORDER_ACTIVITIES_MAX_PAGES,
                },
                'Saxo audit orderactivities batch was incomplete; partial activities were discarded',
            )
        } else {
            await this.saveOrderActivitiesPollState({
                last_poll_at: now.toISOString(),
                next_poll_url: result.nextPollUrl ?? '',
            })
        }

        return cacheResult(result)
    }

    private buildOrderActivitiesDirectUrl(clientKey: string, orderId: string): string {
        const params = new URLSearchParams({
            ClientKey: clientKey,
            OrderId: orderId,
            EntryType: 'All',
            '$top': String(SAXO_RECONCILIATION_PAGE_SIZE),
        })
        return `${this.baseUrl}/cs/v1/audit/orderactivities/?${params.toString()}`
    }

    private async fetchOrderActivitiesDirect(
        orderId: string,
        accessToken: string,
        clientKey: string,
        requestBudget: { used: number },
    ): Promise<
        | { status: 'complete', resolution: SaxoOrderActivityResolution }
        | { status: 'failed' | 'rate_limited' | 'budget' }
    > {
        let failureReason: 'failed' | 'rate_limited' | 'budget' = 'failed'
        let retryCount = 0
        const fetchPage = async (url: string): Promise<Response> => {
            if (this.isRateLimited()) {
                failureReason = 'rate_limited'
                throw new SaxoDirectLookupError('rate_limited')
            }
            if (requestBudget.used >= SAXO_RECONCILIATION_MAX_DIRECT_REQUESTS) {
                failureReason = 'budget'
                throw new SaxoDirectLookupError('budget')
            }

            requestBudget.used += 1
            try {
                const response = await saxoAuditRequestLimiter.run(() => this.fetchImpl(url, {
                    headers: { Authorization: `Bearer ${accessToken}` },
                }))
                if (response.status >= 500 && response.status <= 599 && retryCount < SAXO_RECONCILIATION_MAX_RETRIES) {
                    retryCount += 1
                    await cancelResponseBody(response)
                    const backoffMs = SAXO_RECONCILIATION_RETRY_BASE_MS * (2 ** (retryCount - 1))
                    const jitterMs = Math.floor(Math.random() * SAXO_RECONCILIATION_RETRY_JITTER_MS)
                    await this.sleepImpl(backoffMs + jitterMs)
                    return fetchPage(url)
                }
                return response
            } catch (error) {
                if (error instanceof SaxoDirectLookupError) throw error
                if (retryCount < SAXO_RECONCILIATION_MAX_RETRIES) {
                    retryCount += 1
                    const backoffMs = SAXO_RECONCILIATION_RETRY_BASE_MS * (2 ** (retryCount - 1))
                    const jitterMs = Math.floor(Math.random() * SAXO_RECONCILIATION_RETRY_JITTER_MS)
                    await this.sleepImpl(backoffMs + jitterMs)
                    return fetchPage(url)
                }
                failureReason = 'failed'
                throw new SaxoDirectLookupError('failed')
            }
        }

        let result: SaxoOrderActivitiesPageResult
        try {
            result = await fetchSaxoOrderActivitiesPages({
                initialUrl: this.buildOrderActivitiesDirectUrl(clientKey, orderId),
                maxPages: SAXO_RECONCILIATION_MAX_DIRECT_PAGES_PER_ORDER,
                resolveNextUrl: (url) => this.buildSaxoApiUrl(url),
                fetchPage,
                onHttpError: async (response) => {
                    await cancelResponseBody(response)
                    if (response.status === 429) {
                        failureReason = 'rate_limited'
                        this.markRateLimited(response)
                    } else {
                        failureReason = 'failed'
                    }
                },
            })
        } catch (error) {
            if (error instanceof SaxoDirectLookupError) return { status: error.reason }
            return { status: failureReason }
        }

        if (!result.complete) return { status: failureReason }
        const matchingActivities = result.activities.filter((activity) => activity.OrderId === orderId)
        return {
            status: 'complete',
            resolution: resolveSaxoOrderActivities(matchingActivities, 'COMPLETE_HISTORY'),
        }
    }

    private async fetchIfdocoRecoveryResponse(
        url: string,
        accessToken: string,
        requestBudget: { used: number },
    ): Promise<Response> {
        let retryCount = 0
        while (true) {
            if (this.isRateLimited()) {
                throw new SaxoIfdocoRecoveryRequestError('RATE_LIMITED')
            }
            if (requestBudget.used >= SAXO_RECONCILIATION_MAX_DIRECT_REQUESTS) {
                throw new SaxoIfdocoRecoveryRequestError('REQUEST_BUDGET_EXHAUSTED')
            }

            requestBudget.used += 1
            let response: Response
            try {
                response = await saxoAuditRequestLimiter.run(() => this.fetchImpl(url, {
                    headers: { Authorization: `Bearer ${accessToken}` },
                }))
            } catch {
                if (retryCount < SAXO_RECONCILIATION_MAX_RETRIES) {
                    retryCount += 1
                    const backoffMs = SAXO_RECONCILIATION_RETRY_BASE_MS * (2 ** (retryCount - 1))
                    const jitterMs = Math.floor(Math.random() * SAXO_RECONCILIATION_RETRY_JITTER_MS)
                    await this.sleepImpl(backoffMs + jitterMs)
                    continue
                }
                throw new SaxoIfdocoRecoveryRequestError('NETWORK_ERROR')
            }

            if (response.status === 429) {
                this.markRateLimited(response)
                await cancelResponseBody(response)
                throw new SaxoIfdocoRecoveryRequestError('RATE_LIMITED')
            }
            if (response.status === 401 || response.status === 403) {
                await cancelResponseBody(response)
                throw new SaxoIfdocoRecoveryRequestError('AUTH_UNAVAILABLE')
            }
            if (
                response.status >= 500 &&
                response.status <= 599 &&
                retryCount < SAXO_RECONCILIATION_MAX_RETRIES
            ) {
                retryCount += 1
                await cancelResponseBody(response)
                const backoffMs = SAXO_RECONCILIATION_RETRY_BASE_MS * (2 ** (retryCount - 1))
                const jitterMs = Math.floor(Math.random() * SAXO_RECONCILIATION_RETRY_JITTER_MS)
                await this.sleepImpl(backoffMs + jitterMs)
                continue
            }
            return response
        }
    }

    private async fetchIfdocoRecoveryActivities(
        orderId: string,
        accessToken: string,
        clientKey: string,
        requestBudget: { used: number },
    ): Promise<
        | { kind: 'COMPLETE', activities: SaxoOrderActivity[] }
        | { kind: 'FAILED', reason: SaxoIfdocoTemporaryFailureReason }
    > {
        let requestFailure: SaxoIfdocoTemporaryFailureReason | undefined
        const result = await fetchSaxoOrderActivitiesPages({
            initialUrl: this.buildOrderActivitiesDirectUrl(clientKey, orderId),
            maxPages: SAXO_RECONCILIATION_MAX_DIRECT_PAGES_PER_ORDER,
            resolveNextUrl: (url) => this.buildSaxoApiUrl(url),
            fetchPage: async (url) => {
                try {
                    return await this.fetchIfdocoRecoveryResponse(url, accessToken, requestBudget)
                } catch (error) {
                    requestFailure = error instanceof SaxoIfdocoRecoveryRequestError
                        ? error.reason
                        : 'HTTP_ERROR'
                    throw error
                }
            },
            onHttpError: async (response) => {
                requestFailure = 'HTTP_ERROR'
                await cancelResponseBody(response)
            },
        })

        if (!result.complete) {
            return {
                kind: 'FAILED',
                reason: requestFailure ??
                    (result.reason === 'PARSE_ERROR'
                        ? 'PARSE_ERROR'
                        : result.reason === 'PAGE_LIMIT' ? 'PAGE_LIMIT' : 'HTTP_ERROR'),
            }
        }
        return {
            kind: 'COMPLETE',
            activities: result.activities.filter((activity) => activity.OrderId === orderId),
        }
    }

    private async fetchIfdocoOpenOrder(
        orderId: string,
        accessToken: string,
        clientKey: string,
        requestBudget: { used: number },
    ): Promise<
        | { kind: 'COMPLETE', openOrder: SaxoOpenOrderEvidence | null }
        | { kind: 'FAILED', reason: SaxoIfdocoTemporaryFailureReason }
    > {
        const url = `${this.baseUrl}/port/v1/orders/${encodeURIComponent(clientKey)}/${encodeURIComponent(orderId)}`
        let response: Response
        try {
            response = await this.fetchIfdocoRecoveryResponse(url, accessToken, requestBudget)
        } catch (error) {
            return {
                kind: 'FAILED',
                reason: error instanceof SaxoIfdocoRecoveryRequestError ? error.reason : 'HTTP_ERROR',
            }
        }

        if (response.status === 404) {
            await cancelResponseBody(response)
            return { kind: 'FAILED', reason: 'OPEN_ORDER_NOT_FOUND' }
        }
        if (!response.ok) {
            await cancelResponseBody(response)
            return { kind: 'FAILED', reason: 'HTTP_ERROR' }
        }

        let rawOpenOrder: unknown
        try {
            rawOpenOrder = await response.json()
        } catch {
            return { kind: 'FAILED', reason: 'PARSE_ERROR' }
        }
        const openOrder = parseSaxoOpenOrderEvidence(rawOpenOrder)
        return openOrder
            ? { kind: 'COMPLETE', openOrder }
            : { kind: 'FAILED', reason: 'PARSE_ERROR' }
    }

    async recoverIfdocoOrderMetadata(order: OrderV2): Promise<SaxoIfdocoMetadataRecoveryResult> {
        const classification = classifySaxoOrderMetadata(order)
        if (classification.kind !== 'RECOVERABLE_IFDOCO') {
            return {
                kind: 'MANUAL_REVIEW',
                retryable: false,
                reason: 'UNSUPPORTED_ORDER_SHAPE',
            }
        }
        if (this.isRateLimited()) {
            return { kind: 'TEMPORARY_FAILURE', retryable: true, reason: 'RATE_LIMITED' }
        }

        const accessToken = await this.getValidAccessToken()
        if (!accessToken) {
            return { kind: 'TEMPORARY_FAILURE', retryable: true, reason: 'AUTH_UNAVAILABLE' }
        }
        const auth = await this.getAuth()
        const clientKey = auth?.accounts?.[0]?.clientKey
        if (!clientKey) {
            return { kind: 'TEMPORARY_FAILURE', retryable: true, reason: 'AUTH_UNAVAILABLE' }
        }

        const requestBudget = { used: 0 }
        const entryHistory = await this.fetchIfdocoRecoveryActivities(
            classification.candidate.entryOrderId,
            accessToken,
            clientKey,
            requestBudget,
        )
        if (entryHistory.kind === 'FAILED') {
            return { kind: 'TEMPORARY_FAILURE', retryable: true, reason: entryHistory.reason }
        }

        const relatedOrderSets = new Map<string, string[]>()
        for (const activity of entryHistory.activities) {
            if (activity.RelatedOrders && activity.RelatedOrders.length > 0) {
                const normalized = activity.RelatedOrders.map((orderId) => orderId.trim()).sort()
                relatedOrderSets.set(normalized.join('\u0000'), normalized)
            }
        }
        const relatedOrderIds = relatedOrderSets.size === 1
            ? [...relatedOrderSets.values()][0] ?? []
            : []
        if (
            relatedOrderSets.size !== 1 ||
            relatedOrderIds.length !== 2 ||
            new Set(relatedOrderIds).size !== 2
        ) {
            return recoverSaxoIfdocoMetadataFromEvidence(classification.candidate, {
                entryActivities: entryHistory.activities,
                exitActivities: {},
                openOrders: [],
            })
        }

        const exitHistoryResults = await Promise.all(relatedOrderIds.map(async (orderId) => ({
            orderId,
            result: await this.fetchIfdocoRecoveryActivities(orderId, accessToken, clientKey, requestBudget),
        })))
        const failedExitHistory = exitHistoryResults.find(({ result }) => result.kind === 'FAILED')
        if (failedExitHistory?.result.kind === 'FAILED') {
            return { kind: 'TEMPORARY_FAILURE', retryable: true, reason: failedExitHistory.result.reason }
        }

        const exitActivities = Object.fromEntries(exitHistoryResults.map(({ orderId, result }) => [
            orderId,
            result.kind === 'COMPLETE' ? result.activities : undefined,
        ]))
        const allActivities = [
            { orderId: classification.candidate.entryOrderId, activities: entryHistory.activities },
            ...exitHistoryResults.map(({ orderId, result }) => ({
                orderId,
                activities: result.kind === 'COMPLETE' ? result.activities : [],
            })),
        ]
        const possiblyOpenOrderIds = allActivities
            .filter(({ activities }) => {
                const state = resolveSaxoOrderActivities(activities, 'COMPLETE_HISTORY').brokerState
                return state === 'NON_TERMINAL' || state === 'PARTIALLY_FILLED' || state === 'UNRESOLVED'
            })
            .map(({ orderId }) => orderId)

        const openOrderResults = await Promise.all(possiblyOpenOrderIds.map(async (orderId) => ({
            orderId,
            result: await this.fetchIfdocoOpenOrder(orderId, accessToken, clientKey, requestBudget),
        })))
        const failedOpenOrder = openOrderResults.find(({ result }) => result.kind === 'FAILED')
        if (failedOpenOrder?.result.kind === 'FAILED') {
            return { kind: 'TEMPORARY_FAILURE', retryable: true, reason: failedOpenOrder.result.reason }
        }

        return recoverSaxoIfdocoMetadataFromEvidence(classification.candidate, {
            entryActivities: entryHistory.activities,
            exitActivities,
            openOrders: openOrderResults.flatMap(({ result }) => (
                result.kind === 'COMPLETE' && result.openOrder ? [result.openOrder] : []
            )),
        })
    }

    async getExecutionPricesForOrdersV2(
        orders: OrderV2[],
        options: ExecutionSyncOptions,
    ): Promise<Map<string, OrderExecutionSyncResult>> {
        const results = new Map<string, OrderExecutionSyncResult>()
        const unrecoverableReasons: Record<string, number> = {}
        const unrecoverableOrderIds: Record<string, string[]> = {}
        const addUnrecoverable = (reason: string, orderId: string): void => {
            unrecoverableReasons[reason] = (unrecoverableReasons[reason] ?? 0) + 1
            const samples = unrecoverableOrderIds[reason] ?? []
            if (samples.length < 5) samples.push(orderId)
            unrecoverableOrderIds[reason] = samples
        }
        type SaxoOrderCandidate = {
            order: OrderV2
            metadata: SaxoOrderMetadata
            entryOrderId: string
            metadataRecovered: boolean
        }
        const validOrders = orders.flatMap((order): SaxoOrderCandidate[] => {
            const classification = classifySaxoOrderMetadata(order)
            if (classification.kind === 'UNRECOVERABLE') {
                results.set(order.id, { execution: null })
                const rawProviderOrderId: unknown = order.provider_order_ids[0]
                const providerOrderId = typeof rawProviderOrderId === 'string' ? rawProviderOrderId.trim() : ''
                addUnrecoverable(classification.reason, providerOrderId || order.id)
                return []
            }
            if (classification.kind === 'RECOVERABLE_IFDOCO') {
                results.set(order.id, { execution: null })
                addUnrecoverable('IFDOCO_RECOVERY_NOT_INTEGRATED', classification.candidate.entryOrderId)
                return []
            }

            const metadata = classification.metadata
            results.set(
                order.id,
                classification.kind === 'RECOVERABLE_MARKET'
                    ? { execution: null, brokerOrderMetadata: metadata, brokerOrderMetadataPolicy: 'SET_IF_UNSET' }
                    : { execution: null, brokerOrderMetadata: metadata },
            )
            return [{
                order,
                metadata,
                entryOrderId: metadata.entry.resolved.order_id,
                metadataRecovered: classification.kind === 'RECOVERABLE_MARKET',
            }]
        })

        const terminalCounts: Record<string, number> = {}
        const sampleOrderIds = {
            noMatch: [] as string[],
            failed: [] as string[],
            rateLimited: [] as string[],
            deferred: [] as string[],
        }
        const addSample = (target: string[], orderId: string): void => {
            if (target.length < 5) target.push(orderId)
        }
        let batchMatched = 0
        let recovered = 0
        let directCandidates = 0
        let attempted = 0
        let deferred = 0
        let failed = 0
        let rateLimited = 0
        let noMatch = 0
        let directRequests = 0
        let batchComplete = false
        const validMetadata = validOrders.filter((candidate) => !candidate.metadataRecovered).length
        const recoverableMarket = validOrders.filter((candidate) => candidate.metadataRecovered).length

        const toSyncResult = (
            candidate: SaxoOrderCandidate,
            resolution: SaxoOrderActivityResolution,
        ): OrderExecutionSyncResult => {
            const result = {
                execution: resolution.execution,
                ...toSaxoTerminalStatus(resolution.brokerState),
                brokerOrderMetadata: candidate.metadata,
            }
            return candidate.metadataRecovered
                ? { ...result, brokerOrderMetadataPolicy: 'SET_IF_UNSET' }
                : result
        }

        const recordResolution = (resolution: SaxoOrderActivityResolution): void => {
            const terminal = toSaxoTerminalStatus(resolution.brokerState)
            if (terminal.terminalStatus) {
                terminalCounts[terminal.terminalStatus] = (terminalCounts[terminal.terminalStatus] ?? 0) + 1
            }
            if (resolution.execution !== null || terminal.terminalStatus !== undefined) recovered += 1
        }

        if (validOrders.length > 0) {
            let batch: SaxoOrderActivitiesPageResult
            try {
                batch = await this.fetchOrderActivitiesBatch(options.now)
            } catch (error) {
                this.logger.warn({ event: 'saxo:orderactivities_reconciliation_batch_failed', error }, 'Saxo reconciliation batch failed')
                batch = { complete: false, reason: 'HTTP_ERROR' }
            }

            if (batch.complete) {
                batchComplete = true
                const activitiesByOrderId = new Map<string, SaxoOrderActivity[]>()
                for (const activity of batch.activities) {
                    const activities = activitiesByOrderId.get(activity.OrderId) ?? []
                    activities.push(activity)
                    activitiesByOrderId.set(activity.OrderId, activities)
                }
                const directCandidateOrders = validOrders.filter((candidate) => {
                    const matchingActivities = activitiesByOrderId.get(candidate.entryOrderId) ?? []
                    if (matchingActivities.length === 0) return true
                    const resolution = resolveSaxoOrderActivities(matchingActivities, 'INCREMENTAL_SNAPSHOT')
                    if (matchingActivities.some(isSaxoFillActivity) && resolution.execution === null) return true
                    batchMatched += 1
                    recordResolution(resolution)
                    results.set(candidate.order.id, toSyncResult(candidate, resolution))
                    return false
                })
                directCandidates = directCandidateOrders.length

                let state: SaxoOrderActivitiesReconciliationState = {}
                try {
                    state = await this.getOrderActivitiesReconciliationState()
                } catch (error) {
                    this.logger.warn({ event: 'saxo:orderactivities_reconciliation_state_read_failed', error }, 'failed to read Saxo reconciliation state')
                }

                const sortedCandidates = directCandidateOrders
                    .slice()
                    .sort((left, right) => left.entryOrderId.localeCompare(right.entryOrderId))
                const cursor = state.direct_lookup_after_order_id
                let startIndex = 0
                if (cursor && sortedCandidates.length > 0) {
                    const cursorIndex = sortedCandidates.findIndex((candidate) => candidate.entryOrderId === cursor)
                    startIndex = cursorIndex >= 0
                        ? (cursorIndex + 1) % sortedCandidates.length
                        : sortedCandidates.findIndex((candidate) => candidate.entryOrderId > cursor)
                    if (startIndex < 0) startIndex = 0
                }
                const roundRobinCandidates = sortedCandidates.length === 0
                    ? []
                    : [...sortedCandidates.slice(startIndex), ...sortedCandidates.slice(0, startIndex)]
                const selectedCandidates = roundRobinCandidates.slice(0, SAXO_RECONCILIATION_MAX_DIRECT_CANDIDATES)
                const requestBudget = { used: 0 }
                let directAccessToken: string | null = null
                let clientKey: string | undefined
                if (selectedCandidates.length > 0) {
                    try {
                        directAccessToken = await this.getValidAccessToken()
                        const directAuth = await this.getAuth()
                        clientKey = directAuth?.accounts?.[0]?.clientKey
                    } catch (error) {
                        this.logger.warn({ event: 'saxo:orderactivities_reconciliation_auth_failed', error }, 'failed to prepare Saxo direct recovery auth')
                    }
                }
                const attemptedIndexes = new Set<number>()

                if (directAccessToken && clientKey) {
                    const outcomes = await mapWithConcurrency(
                        selectedCandidates,
                        SAXO_RECONCILIATION_REQUEST_CONCURRENCY,
                        async (candidate, index) => {
                            if (this.isRateLimited()) {
                                return { candidate, index, attempted: false, status: 'rate_limited' as const }
                            }
                            const outcome = await this.fetchOrderActivitiesDirect(
                                candidate.entryOrderId,
                                directAccessToken,
                                clientKey,
                                requestBudget,
                            )
                            if (outcome.status === 'budget') {
                                return { candidate, index, attempted: false, ...outcome }
                            }
                            attemptedIndexes.add(index)
                            return { candidate, index, attempted: true, ...outcome }
                        },
                    )

                    attempted = attemptedIndexes.size
                    directRequests = requestBudget.used
                    for (const outcome of outcomes) {
                        if (!outcome.attempted) {
                            deferred += 1
                            if (outcome.status === 'rate_limited') {
                                rateLimited += 1
                                addSample(sampleOrderIds.rateLimited, outcome.candidate.entryOrderId)
                            } else {
                                addSample(sampleOrderIds.deferred, outcome.candidate.entryOrderId)
                            }
                            continue
                        }
                        if (outcome.status === 'complete') {
                            const { resolution } = outcome
                            recordResolution(resolution)
                            results.set(outcome.candidate.order.id, toSyncResult(outcome.candidate, resolution))
                            const hasMatch = resolution.execution !== null || resolution.brokerState !== 'UNRESOLVED'
                            if (!hasMatch) {
                                // The direct history completed but did not contain a usable activity.
                                noMatch += 1
                                addSample(sampleOrderIds.noMatch, outcome.candidate.entryOrderId)
                            }
                            continue
                        }
                        if (outcome.status === 'rate_limited') {
                            rateLimited += 1
                            addSample(sampleOrderIds.rateLimited, outcome.candidate.entryOrderId)
                        } else if (outcome.status === 'budget') {
                            deferred += 1
                            addSample(sampleOrderIds.deferred, outcome.candidate.entryOrderId)
                        } else {
                            failed += 1
                            addSample(sampleOrderIds.failed, outcome.candidate.entryOrderId)
                        }
                    }
                } else {
                    deferred = selectedCandidates.length
                    for (const candidate of selectedCandidates) addSample(sampleOrderIds.deferred, candidate.entryOrderId)
                }

                deferred += sortedCandidates.length - selectedCandidates.length
                for (const candidate of roundRobinCandidates.slice(selectedCandidates.length)) {
                    addSample(sampleOrderIds.deferred, candidate.entryOrderId)
                }

                if (attemptedIndexes.size > 0) {
                    const lastAttemptedIndex = Math.max(...attemptedIndexes)
                    const lastAttempted = selectedCandidates[lastAttemptedIndex]
                    if (lastAttempted) {
                        try {
                            await this.saveOrderActivitiesReconciliationState({
                                direct_lookup_after_order_id: lastAttempted.entryOrderId,
                                last_direct_lookup_at: options.now.toISOString(),
                            })
                        } catch (error) {
                            this.logger.warn({ event: 'saxo:orderactivities_reconciliation_state_write_failed', error }, 'failed to save Saxo reconciliation state')
                        }
                    }
                }
            }
        }

        this.logger.info(
            {
                event: 'saxo:orderactivities_reconciliation_summary',
                pending: orders.length,
                validMetadata,
                recoverableMarket,
                generatedMetadata: recoverableMarket,
                unrecoverable: orders.length - validOrders.length,
                unrecoverableReasons,
                unrecoverableOrderIds,
                batchComplete,
                batchMatched,
                directCandidates,
                attempted,
                deferred,
                directRequests,
                recovered,
                noMatch,
                failed,
                rateLimited,
                terminalCounts,
                sampleOrderIds,
            },
            'Saxo orderactivities reconciliation session completed',
        )
        return results
    }

    private buildOrderActivitiesRangeUrl(auth: SaxoAuthData, range: ExecutionReconciliationRange): string {
        const params = new URLSearchParams()
        const clientKey = auth.accounts?.[0]?.clientKey
        if (clientKey) params.append('ClientKey', clientKey)
        params.append('FromDateTime', range.from.toISOString())
        params.append('ToDateTime', range.to.toISOString())
        params.append('EntryType', 'All')
        params.append('$top', String(SAXO_RECONCILIATION_PAGE_SIZE))
        return `${this.baseUrl}/cs/v1/audit/orderactivities/?${params.toString()}`
    }

    private async fetchOrderActivitiesRange(
        range: ExecutionReconciliationRange,
    ): Promise<SaxoRangeFetchResult> {
        if (this.isRateLimited()) {
            return { complete: false, reason: 'HTTP_ERROR', pageCount: 0, rateLimited: true }
        }

        const accessToken = await this.getValidAccessToken()
        if (!accessToken) return { complete: false, reason: 'HTTP_ERROR', pageCount: 0, rateLimited: false }

        const auth = await this.getAuth()
        if (!auth) return { complete: false, reason: 'HTTP_ERROR', pageCount: 0, rateLimited: false }
        if (!auth.accounts?.[0]?.clientKey) {
            return { complete: false, reason: 'HTTP_ERROR', pageCount: 0, rateLimited: false }
        }

        let pageCount = 0
        let rateLimited = false
        const result = await fetchSaxoOrderActivitiesPages({
            initialUrl: this.buildOrderActivitiesRangeUrl(auth, range),
            maxPages: SAXO_ORDER_ACTIVITIES_MAX_PAGES,
            resolveNextUrl: (url) => this.buildSaxoApiUrl(url),
            fetchPage: (url) => {
                pageCount += 1
                return saxoAuditRequestLimiter.run(() => this.fetchImpl(url, {
                    headers: { Authorization: `Bearer ${accessToken}` },
                }))
            },
            onHttpError: async (response) => {
                if (response.status === 429) {
                    rateLimited = true
                    this.markRateLimited(response)
                }
                this.logger.warn(
                    {
                        event: 'saxo:orderactivities_reconciliation_range_failed',
                        status: response.status,
                        response: await response.text(),
                    },
                    'failed to fetch Saxo audit orderactivities reconciliation range',
                )
            },
        })

        if (result.complete) {
            return { complete: true, activities: result.activities, pageCount }
        }
        return { complete: false, reason: result.reason, pageCount, rateLimited }
    }

    private getRetryReconciliationRange(
        state: SaxoOrderActivitiesReconciliationState,
        requestedRange: ExecutionReconciliationRange,
    ): ExecutionReconciliationRange {
        const shouldRetry = state.last_reconciliation_outcome === 'INCOMPLETE' ||
            state.last_reconciliation_outcome === 'RATE_LIMITED'
        if (!shouldRetry) return requestedRange

        const fromMs = state.last_reconciliation_window_from
            ? Date.parse(state.last_reconciliation_window_from)
            : NaN
        const toMs = state.last_reconciliation_window_to
            ? Date.parse(state.last_reconciliation_window_to)
            : NaN
        if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || fromMs >= toMs) return requestedRange

        return { from: new Date(fromMs), to: new Date(toMs) }
    }

    async reconcileExecutionPricesForOrdersV2(
        orders: OrderV2[],
        requestedRange: ExecutionReconciliationRange,
    ): Promise<Map<string, OrderExecutionSyncResult>> {
        let state: SaxoOrderActivitiesReconciliationState = {}
        try {
            state = await this.getOrderActivitiesReconciliationState()
        } catch (error) {
            this.logger.warn(
                { event: 'saxo:orderactivities_reconciliation_state_read_failed', error },
                'failed to read Saxo reconciliation state',
            )
        }

        const range = this.getRetryReconciliationRange(state, requestedRange)
        const startedAt = new Date().toISOString()
        const saveState = async (updates: SaxoOrderActivitiesReconciliationState): Promise<void> => {
            try {
                await this.saveOrderActivitiesReconciliationState(updates)
            } catch (error) {
                this.logger.warn(
                    { event: 'saxo:orderactivities_reconciliation_state_write_failed', error },
                    'failed to save Saxo reconciliation state',
                )
            }
        }

        await saveState({
            last_reconciliation_started_at: startedAt,
            last_reconciliation_window_from: range.from.toISOString(),
            last_reconciliation_window_to: range.to.toISOString(),
        })

        const eligibleOrders = orders.filter((order) => (
            order.created_at.getTime() >= range.to.getTime() - SAXO_RECONCILIATION_RECENT_ORDER_MAX_AGE_MS &&
            order.created_at.getTime() <= range.to.getTime()
        ))
        const results = new Map<string, OrderExecutionSyncResult>()
        let pageCount = 0
        let activityCount = 0
        let matched = 0
        let executed = 0
        let partial = 0
        let canceled = 0
        let failed = 0
        let noMatch = 0
        let outcome: SaxoOrderActivitiesReconciliationState['last_reconciliation_outcome'] = 'COMPLETE'

        try {
            let rangeResult: SaxoRangeFetchResult = {
                complete: true,
                activities: [],
                pageCount: 0,
            }
            if (eligibleOrders.length > 0) {
                rangeResult = await this.fetchOrderActivitiesRange(range)
            }
            pageCount = rangeResult.pageCount

            if (!rangeResult.complete) {
                outcome = rangeResult.rateLimited ? 'RATE_LIMITED' : 'INCOMPLETE'
                await saveState({
                    last_reconciliation_window_from: range.from.toISOString(),
                    last_reconciliation_window_to: range.to.toISOString(),
                    last_reconciliation_outcome: outcome,
                })
                this.logger.info(
                    {
                        event: 'saxo:orderactivities_reconciliation_summary',
                        windowFrom: range.from.toISOString(),
                        windowTo: range.to.toISOString(),
                        pending: orders.length,
                        eligible: eligibleOrders.length,
                        activity: 0,
                        matched: 0,
                        executed: 0,
                        partial: 0,
                        canceled: 0,
                        failed: 0,
                        noMatch: 0,
                        pageCount,
                        outcome,
                    },
                    'Saxo orderactivities range reconciliation incomplete',
                )
                return results
            }

            const uniqueActivities = normalizeSaxoOrderActivities(rangeResult.activities)
            activityCount = uniqueActivities.length
            const activitiesByOrderId = new Map<string, SaxoOrderActivity[]>()
            for (const activity of uniqueActivities) {
                const activities = activitiesByOrderId.get(activity.OrderId) ?? []
                activities.push(activity)
                activitiesByOrderId.set(activity.OrderId, activities)
            }

            for (const order of eligibleOrders) {
                const metadata = order.broker_order_metadata
                if (metadata?.kind !== 'saxo_order_v1') continue
                const entryOrderId = metadata.entry.resolved.order_id
                if (!entryOrderId) continue

                const matchingActivities = activitiesByOrderId.get(entryOrderId) ?? []
                if (matchingActivities.length > 0) matched += 1
                const resolution = resolveSaxoOrderActivities(matchingActivities, 'COMPLETE_HISTORY')
                const terminal = toSaxoTerminalStatus(resolution.brokerState)
                results.set(order.id, {
                    execution: resolution.execution,
                    ...terminal,
                    brokerOrderMetadata: metadata,
                })

                if (resolution.execution !== null) {
                    if (resolution.execution.size >= order.requested_size - EPSILON) executed += 1
                    else partial += 1
                } else if (terminal.terminalStatus === undefined) {
                    noMatch += 1
                }
                if (terminal.terminalStatus === 'CANCELED') canceled += 1
                if (terminal.terminalStatus === 'FAILED') failed += 1
            }

            await saveState({
                last_reconciliation_window_from: range.from.toISOString(),
                last_reconciliation_window_to: range.to.toISOString(),
                last_reconciliation_outcome: 'COMPLETE',
                last_reconciliation_completed_at: new Date().toISOString(),
            })
        } catch (error) {
            outcome = 'FAILED'
            await saveState({
                last_reconciliation_window_from: range.from.toISOString(),
                last_reconciliation_window_to: range.to.toISOString(),
                last_reconciliation_outcome: outcome,
            })
            this.logger.warn(
                { event: 'saxo:orderactivities_reconciliation_failed', error },
                'failed to reconcile Saxo audit orderactivities range',
            )
            return new Map()
        }

        this.logger.info(
            {
                event: 'saxo:orderactivities_reconciliation_summary',
                windowFrom: range.from.toISOString(),
                windowTo: range.to.toISOString(),
                pending: orders.length,
                eligible: eligibleOrders.length,
                activity: activityCount,
                matched,
                executed,
                partial,
                canceled,
                failed,
                noMatch,
                pageCount,
                outcome,
            },
            'Saxo orderactivities range reconciliation completed',
        )
        return results
    }

    private async getExecutionFromRecentActivities(orderId: string): Promise<SaxoOrderActivityResolution> {
        const result = await this.fetchOrderActivitiesBatch()
        if (!result.complete) return { execution: null, brokerState: 'UNRESOLVED' }
        const activities = result.activities
        const matchingActivities = activities.filter((activity) => activity.OrderId === orderId)
        const resolution = resolveSaxoOrderActivities(matchingActivities, 'INCREMENTAL_SNAPSHOT')
        const execution = resolution.execution

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
            return resolution
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

        return resolution
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
        const classification = classifySaxoOrderMetadata(order)
        if (classification.kind === 'UNRECOVERABLE') {
            this.logger.warn(
                {
                    event: 'saxo:orders_v2_sync_unrecoverable',
                    orderId: order.id,
                    reason: classification.reason,
                },
                'orders_v2 execution sync skipped: Saxo metadata is unrecoverable',
            )
            return { execution: null }
        }
        if (classification.kind === 'RECOVERABLE_IFDOCO') {
            this.logger.warn(
                {
                    event: 'saxo:orders_v2_sync_ifdoco_recovery_required',
                    orderId: order.id,
                    entryOrderId: classification.candidate.entryOrderId,
                },
                'orders_v2 execution sync skipped: Saxo IFDOCO metadata recovery is not integrated',
            )
            return { execution: null }
        }

        const metadata = classification.metadata
        const entryOrderId = metadata.entry.resolved.order_id
        let resolution: SaxoOrderActivityResolution
        try {
            resolution = await this.getExecutionFromRecentActivities(entryOrderId)
        } catch (error) {
            this.logger.warn(
                { event: 'saxo:orders_v2_sync_activity_failed', orderId: order.id, error },
                'Saxo activity lookup failed; preserving metadata-only recovery result',
            )
            return classification.kind === 'RECOVERABLE_MARKET'
                ? { execution: null, brokerOrderMetadata: metadata, brokerOrderMetadataPolicy: 'SET_IF_UNSET' }
                : { execution: null, brokerOrderMetadata: metadata }
        }
        const result = {
            execution: resolution.execution,
            ...toSaxoTerminalStatus(resolution.brokerState),
            brokerOrderMetadata: metadata,
        }
        return classification.kind === 'RECOVERABLE_MARKET'
            ? { ...result, brokerOrderMetadataPolicy: 'SET_IF_UNSET' }
            : result
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

            const execution = (await this.getExecutionFromRecentActivities(exitOrderId)).execution
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
