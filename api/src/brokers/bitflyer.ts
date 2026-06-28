import { createHmac } from 'node:crypto'

import type { OrderDispatchFailure, OrderDispatchResult, OrderRequest } from '../types/order.js'
import type { BitflyerParentOrderMetadata } from '../types/broker-order-metadata.js'
import type { OrderV2 } from '../types/order-v2.js'
import type { Position } from '../types/position.js'
import { defaultLogger, type Logger } from '../logger.js'

type BitflyerClientOptions = {
    apiKey?: string
    apiSecret?: string
    baseUrl?: string
    fetchImpl?: typeof fetch
    logger?: Logger
}

type BitflyerOrderResponse = {
    child_order_acceptance_id?: string
    parent_order_acceptance_id?: string
    message?: string
    error_message?: string
}

type BitflyerParentOrderDetail = {
    parent_order_id?: string
    parent_order_acceptance_id?: string
}

function parsePercentage(value: string): number | null {
    const match = value.trim().match(/^(\d+(?:\.\d+)?)%$/)
    if (!match || !match[1]) return null
    return parseFloat(match[1]) / 100
}

type BitflyerPositionResponse = {
    product_code: string
    side: string
    price: number
    size: number
    commission: number
    swap_point_accumulated: number
    require_collateral: number
    open_date: string
    leverage: number
    pnl: number
    sfd: number
}

type BitflyerBalanceResponse = {
    currency_code: string
    amount: number
    available: number
}

type BitflyerCollateralResponse = {
    collateral: number
    open_pnl: number
    keep_rate: number
}

type BitflyerExecutionEntry = {
    id?: number
    child_order_acceptance_id: string
    price: number
    size: number
    exec_date?: string
}

type BitflyerChildOrderEntry = {
    child_order_acceptance_id: string
    child_order_state: string
    child_order_type: string
    side?: 'BUY' | 'SELL'
    size?: number
    price?: number
    trigger_price?: number
}

const SEND_CHILD_ORDER_PATH = '/v1/me/sendchildorder'
const SEND_PARENT_ORDER_PATH = '/v1/me/sendparentorder'
const GET_POSITIONS_PATH = '/v1/me/getpositions'
const GET_BALANCE_PATH = '/v1/me/getbalance'
const GET_COLLATERAL_PATH = '/v1/me/getcollateral'
const GET_EXECUTIONS_PATH = '/v1/me/getexecutions'
const GET_CHILD_ORDERS_PATH = '/v1/me/getchildorders'
const GET_PARENT_ORDER_PATH = '/v1/me/getparentorder'
const DEFAULT_BITFLYER_BASE_URL = 'https://api.bitflyer.com'
const DEFAULT_POSITION_PRODUCT_CODES = ['FX_BTC_JPY']
const EXECUTIONS_BATCH_COUNT = 100
const EXECUTIONS_BATCH_MAX_PAGES = 5
const EXECUTIONS_BATCH_CACHE_MS = 30 * 1000

type BitflyerParentOrderParameter = {
    product_code: string
    condition_type: 'MARKET' | 'LIMIT' | 'STOP' | 'STOP_LIMIT' | 'TRAIL'
    side: 'BUY' | 'SELL'
    size: number
    price?: number
    trigger_price?: number
    offset?: number
}

type BitflyerParentOrderRequest = {
    order_method: 'SIMPLE' | 'IFD' | 'OCO' | 'IFDOCO'
    minute_to_expire?: number
    time_in_force?: 'GTC' | 'IOC' | 'FOK'
    parameters: BitflyerParentOrderParameter[]
}

const buildFailure = (
    code: OrderDispatchFailure['code'],
    message: string,
): OrderDispatchFailure => ({
    ok: false,
    broker: 'bitflyer',
    code,
    message,
})

const resolveProductCode = (ticker: string): string => ticker

const weightedAvgExecs = (execs: BitflyerExecutionEntry[]): number | null => {
    if (execs.length === 0) return null
    const totalSize = totalSizeExecs(execs)
    const totalValue = execs.reduce((sum, e) => sum + e.price * e.size, 0)
    return totalValue / totalSize
}
const totalSizeExecs = (execs: BitflyerExecutionEntry[]): number => execs.reduce((sum, e) => sum + e.size, 0)

const areSameNumber = (left: number | undefined, right: number | undefined): boolean => {
    if (left === undefined || right === undefined) return left === right
    return Math.abs(left - right) < 0.00000001
}

const matchesExpectedChildOrder = (
    child: BitflyerChildOrderEntry,
    expected: BitflyerParentOrderMetadata['entry']['expected'],
): boolean => {
    if (child.side === undefined || child.size === undefined) return false

    const hasExpectedPrice = expected.price !== undefined
    const hasExpectedTriggerPrice = expected.trigger_price !== undefined

    if (
        child.side !== expected.side ||
        !areSameNumber(child.size, expected.size)
    ) {
        return false
    }

    const matchesExpectedShape = (
        (!hasExpectedPrice || areSameNumber(child.price, expected.price)) &&
        (!hasExpectedTriggerPrice || areSameNumber(child.trigger_price, expected.trigger_price)) &&
        (
            hasExpectedPrice ||
            hasExpectedTriggerPrice ||
            child.child_order_type === expected.condition_type
        )
    )

    if (matchesExpectedShape) {
        return true
    }

    return (
        expected.role === 'STOP_LOSS' &&
        expected.condition_type === 'STOP' &&
        child.child_order_type === 'MARKET' &&
        child.child_order_state === 'COMPLETED' &&
        child.trigger_price === undefined
    )
}

const buildParentOrderMetadata = (
    providerOrderId: string,
    orderMethod: 'IFD' | 'IFDOCO',
    entrySide: 'BUY' | 'SELL',
    entrySize: number,
    exits: BitflyerParentOrderMetadata['exits'],
): BitflyerParentOrderMetadata => ({
    kind: 'bitflyer_parent_order_v1',
    parent_order_acceptance_id: providerOrderId,
    order_method: orderMethod,
    entry: {
        expected: {
            role: 'ENTRY',
            side: entrySide,
            condition_type: 'MARKET',
            size: entrySize,
        },
        resolved: {
            acceptance_id: null,
        },
    },
    exits,
})

type OrdersV2ExecutionSyncResult = {
    execution: { price: number, size: number, executed_at?: Date } | null
    brokerOrderMetadata?: BitflyerParentOrderMetadata
}

type BitflyerExecutionsBatch = {
    fetchedAtMs: number
    executionsByAcceptanceId: Map<string, BitflyerExecutionEntry[]>
    incompleteReason?: 'page_limit' | 'missing_execution_ids'
}

const extractLatestExecutionAt = (execs: BitflyerExecutionEntry[]): Date | undefined => {
    let latestMs: number | null = null

    for (const exec of execs) {
        if (!exec.exec_date) continue
        const parsed = Date.parse(exec.exec_date)
        if (Number.isNaN(parsed)) continue
        if (latestMs === null || parsed > latestMs) {
            latestMs = parsed
        }
    }

    return latestMs === null ? undefined : new Date(latestMs)
}

export class BitflyerClient {
    private readonly apiKey?: string
    private readonly apiSecret?: string
    private readonly baseUrl: string
    private readonly fetchImpl: typeof fetch
    private readonly logger: Logger
    private readonly executionsBatchCache = new Map<string, BitflyerExecutionsBatch>()

    constructor(options: BitflyerClientOptions = {}) {
        this.apiKey = options.apiKey
        this.apiSecret = options.apiSecret
        this.baseUrl = options.baseUrl ?? DEFAULT_BITFLYER_BASE_URL
        this.fetchImpl = options.fetchImpl ?? fetch
        this.logger = options.logger ?? defaultLogger
    }

    private async callApi<T>(
        method: 'GET' | 'POST',
        path: string,
        body?: string,
        requestId?: string,
    ): Promise<T> {
        if (!this.apiKey || !this.apiSecret) {
            throw new Error('bitflyer api credentials are missing')
        }

        const timestamp = Date.now().toString()
        const signBody = body ?? ''
        const sign = createHmac('sha256', this.apiSecret)
            .update(`${timestamp}${method}${path}${signBody}`)
            .digest('hex')

        const headers: Record<string, string> = {
            'content-type': 'application/json',
            'access-key': this.apiKey,
            'access-timestamp': timestamp,
            'access-sign': sign,
        }

        if (requestId) {
            headers['x-request-id'] = requestId
        }

        const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
            method,
            headers,
            body,
        })

        if (!response.ok) {
            let payload: any
            try {
                payload = await response.json()
            } catch {
                payload = undefined
            }
            throw new Error(payload?.error_message || payload?.message || `bitflyer response status ${response.status}`)
        }

        return (await response.json()) as T
    }

    async sendMarketOrder(order: OrderRequest): Promise<OrderDispatchResult> {
        try {
            const maxSize = 0.02
            const minSize = 0.001 // bitflyer の最小注文サイズ（例: FX_BTC_JPY の場合は 0.001）
            const size = Math.max(minSize, Math.min(maxSize, order.size))
            const productCode = resolveProductCode(order.ticker)

            const closingSide = order.side === 'BUY' ? 'SELL' : 'BUY'
            const stopLossPct = order.stopLoss ? parsePercentage(order.stopLoss) : null
            const takeProfitPct = order.takeProfit ? parsePercentage(order.takeProfit) : null

            if ((order.stopLoss || order.takeProfit) && order.price === undefined) {
                this.logger.warn(
                    { event: 'bitflyer:related_orders_skipped', ticker: order.ticker },
                    'stop_loss/take_profit ignored: no reference price provided',
                )
            } else if ((stopLossPct !== null || takeProfitPct !== null) && order.price !== undefined) {
                const parameters: BitflyerParentOrderParameter[] = [
                    {
                        product_code: productCode,
                        condition_type: 'MARKET',
                        side: order.side,
                        size: size,
                    },
                ]

                let orderMethod: BitflyerParentOrderRequest['order_method'] = 'IFD'

                if (stopLossPct !== null && takeProfitPct !== null) {
                    orderMethod = 'IFDOCO'
                    const stopPrice = order.side === 'BUY'
                        ? Math.floor(order.price * (1 - stopLossPct))
                        : Math.ceil(order.price * (1 + stopLossPct))
                    const limitPrice = order.side === 'BUY'
                        ? Math.ceil(order.price * (1 + takeProfitPct))
                        : Math.floor(order.price * (1 - takeProfitPct))

                    parameters.push({
                        product_code: productCode,
                        condition_type: 'STOP',
                        side: closingSide,
                        size: size,
                        trigger_price: stopPrice,
                    })
                    parameters.push({
                        product_code: productCode,
                        condition_type: 'LIMIT',
                        side: closingSide,
                        size: size,
                        price: limitPrice,
                    })
                } else if (stopLossPct !== null) {
                    orderMethod = 'IFD'
                    const stopPrice = order.side === 'BUY'
                        ? Math.floor(order.price * (1 - stopLossPct))
                        : Math.ceil(order.price * (1 + stopLossPct))
                    parameters.push({
                        product_code: productCode,
                        condition_type: 'STOP',
                        side: closingSide,
                        size: size,
                        trigger_price: stopPrice,
                    })
                } else if (takeProfitPct !== null) {
                    orderMethod = 'IFD'
                    const limitPrice = order.side === 'BUY'
                        ? Math.ceil(order.price * (1 + takeProfitPct))
                        : Math.floor(order.price * (1 - takeProfitPct))
                    parameters.push({
                        product_code: productCode,
                        condition_type: 'LIMIT',
                        side: closingSide,
                        size: size,
                        price: limitPrice,
                    })
                }

                const bodyObj: BitflyerParentOrderRequest = {
                    order_method: orderMethod,
                    minute_to_expire: 43200,
                    time_in_force: 'GTC',
                    parameters,
                }
                const body = JSON.stringify(bodyObj)

                if (order.dryRun) {
                    this.logger.info({
                        event: 'dry_run:broker_api_call',
                        broker: 'bitflyer',
                        method: 'POST',
                        path: SEND_PARENT_ORDER_PATH,
                        body: JSON.parse(body),
                    })
                    return { ok: true, broker: 'bitflyer', providerOrderId: 'DRY_RUN' }
                }

                const payload = await this.callApi<BitflyerOrderResponse>(
                    'POST',
                    SEND_PARENT_ORDER_PATH,
                    body,
                    order.requestId,
                )

                const providerOrderId = payload?.parent_order_acceptance_id
                if (!providerOrderId) {
                    return buildFailure('BROKER_REQUEST_FAILED', 'missing parent_order_acceptance_id')
                }

                const metadataExits: BitflyerParentOrderMetadata['exits'] = parameters.slice(1).map((parameter) => ({
                    expected: {
                        role: parameter.condition_type === 'STOP' ? 'STOP_LOSS' : 'TAKE_PROFIT',
                        side: parameter.side,
                        condition_type: parameter.condition_type as 'LIMIT' | 'STOP',
                        size: parameter.size,
                        ...(parameter.price !== undefined ? { price: parameter.price } : {}),
                        ...(parameter.trigger_price !== undefined ? { trigger_price: parameter.trigger_price } : {}),
                    },
                    resolved: {
                        acceptance_id: null,
                    },
                }))

                const brokerOrderMetadata = buildParentOrderMetadata(
                    providerOrderId,
                    orderMethod,
                    order.side,
                    size,
                    metadataExits,
                )

                return {
                    ok: true,
                    broker: 'bitflyer',
                    providerOrderId,
                    brokerOrderMetadata,
                }
            }

            const body = JSON.stringify({
                product_code: productCode,
                child_order_type: 'MARKET',
                side: order.side,
                size: size,
            })

            if (order.dryRun) {
                this.logger.info({
                    event: 'dry_run:broker_api_call',
                    broker: 'bitflyer',
                    method: 'POST',
                    path: SEND_CHILD_ORDER_PATH,
                    body: JSON.parse(body),
                })
                return { ok: true, broker: 'bitflyer', providerOrderId: 'DRY_RUN' }
            }

            const payload = await this.callApi<BitflyerOrderResponse>(
                'POST',
                SEND_CHILD_ORDER_PATH,
                body,
                order.requestId,
            )

            const providerOrderId = payload?.child_order_acceptance_id
            if (!providerOrderId) {
                return buildFailure('BROKER_REQUEST_FAILED', 'missing child_order_acceptance_id')
            }

            return {
                ok: true,
                broker: 'bitflyer',
                providerOrderId,
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (message.includes('api credentials are missing')) {
                return buildFailure('BROKER_NOT_CONFIGURED', message)
            }
            return buildFailure('BROKER_REQUEST_FAILED', message)
        }
    }

    async getPositions(productCodes: string[] = DEFAULT_POSITION_PRODUCT_CODES): Promise<Position[]> {
        const uniqueProductCodes = [...new Set(productCodes.map((code) => code.trim()).filter((code) => code.length > 0))]
        const targets = uniqueProductCodes.length > 0 ? uniqueProductCodes : DEFAULT_POSITION_PRODUCT_CODES
        const positions: Position[] = []

        for (const productCode of targets) {
            try {
                const path = `${GET_POSITIONS_PATH}?product_code=${encodeURIComponent(productCode)}`
                const results = await this.callApi<BitflyerPositionResponse[]>('GET', path)

                positions.push(...results.map((res) => ({
                    broker: 'bitflyer' as const,
                    ticker: res.product_code,
                    side: res.side as Position['side'],
                    size: res.size,
                    price: res.price,
                    pnl: res.pnl,
                })))
            } catch (error) {
                this.logger.warn(
                    { event: 'bitflyer:get_positions_failed', productCode, error },
                    'Failed to get bitflyer positions',
                )
            }
        }

        return positions
    }

    async getBalances(): Promise<BitflyerBalanceResponse[]> {
        try {
            return await this.callApi<BitflyerBalanceResponse[]>('GET', GET_BALANCE_PATH)
        } catch (error) {
            this.logger.warn({ event: 'bitflyer:get_balances_failed', error }, 'Failed to get bitflyer balances')
            return []
        }
    }

    async getCollateral(): Promise<BitflyerCollateralResponse | null> {
        try {
            return await this.callApi<BitflyerCollateralResponse>('GET', GET_COLLATERAL_PATH)
        } catch (error) {
            this.logger.warn({ event: 'bitflyer:get_collateral_failed', error }, 'Failed to get bitflyer collateral')
            return null
        }
    }

    private async resolveParentOrderId(orderId: string): Promise<string | null> {
        if (orderId.startsWith('JCO')) {
            return orderId
        }

        const queryParam = orderId.startsWith('JRF')
            ? `parent_order_acceptance_id=${encodeURIComponent(orderId)}`
            : `parent_order_id=${encodeURIComponent(orderId)}`

        const parentOrder = await this.callApi<BitflyerParentOrderDetail>(
            'GET',
            `${GET_PARENT_ORDER_PATH}?${queryParam}`,
        )

        return parentOrder.parent_order_id ?? null
    }

    private async fetchChildOrders(parentOrderId: string, ticker: string): Promise<BitflyerChildOrderEntry[] | null> {
        const productCode = resolveProductCode(ticker)
        const resolvedParentOrderId = await this.resolveParentOrderId(parentOrderId)
        if (!resolvedParentOrderId) return null

        return await this.callApi<BitflyerChildOrderEntry[]>(
            'GET',
            `${GET_CHILD_ORDERS_PATH}?product_code=${encodeURIComponent(productCode)}&parent_order_id=${encodeURIComponent(resolvedParentOrderId)}`,
        )
    }

    private resolveMetadataFromChildOrders(
        metadata: BitflyerParentOrderMetadata,
        childOrders: BitflyerChildOrderEntry[],
    ): BitflyerParentOrderMetadata {
        const usedAcceptanceIds = new Set<string>()
        if (metadata.entry.resolved.acceptance_id) {
            usedAcceptanceIds.add(metadata.entry.resolved.acceptance_id)
        }
        for (const exit of metadata.exits) {
            if (exit.resolved.acceptance_id) {
                usedAcceptanceIds.add(exit.resolved.acceptance_id)
            }
        }

        const resolveAcceptanceId = (expected: BitflyerParentOrderMetadata['entry']['expected'], current: string | null) => {
            if (current) return current

            const matches = childOrders.filter((child) =>
                !usedAcceptanceIds.has(child.child_order_acceptance_id) && matchesExpectedChildOrder(child, expected),
            )

            if (matches.length !== 1) return null

            const [match] = matches
            if (!match) return null
            usedAcceptanceIds.add(match.child_order_acceptance_id)
            return match.child_order_acceptance_id
        }

        return {
            ...metadata,
            entry: {
                ...metadata.entry,
                resolved: {
                    acceptance_id: resolveAcceptanceId(
                        metadata.entry.expected,
                        metadata.entry.resolved.acceptance_id,
                    ),
                },
            },
            exits: metadata.exits.map((exit) => ({
                ...exit,
                resolved: {
                    acceptance_id: resolveAcceptanceId(exit.expected, exit.resolved.acceptance_id),
                },
            })),
        }
    }

    private async fetchExecutionsByProductCode(productCode: string): Promise<BitflyerExecutionsBatch> {
        const cached = this.executionsBatchCache.get(productCode)
        if (cached && Date.now() - cached.fetchedAtMs <= EXECUTIONS_BATCH_CACHE_MS) {
            return cached
        }

        const executions: BitflyerExecutionEntry[] = []
        let before: number | undefined
        let incompleteReason: BitflyerExecutionsBatch['incompleteReason']

        for (let page = 0; page < EXECUTIONS_BATCH_MAX_PAGES; page += 1) {
            const params = new URLSearchParams({
                product_code: productCode,
                count: String(EXECUTIONS_BATCH_COUNT),
            })
            if (before !== undefined) {
                params.set('before', String(before))
            }

            const pageExecutions = await this.callApi<BitflyerExecutionEntry[]>(
                'GET',
                `${GET_EXECUTIONS_PATH}?${params.toString()}`,
            )

            executions.push(...pageExecutions)

            if (pageExecutions.length < EXECUTIONS_BATCH_COUNT) {
                break
            }

            const pageIds = pageExecutions
                .map((execution) => execution.id)
                .filter((id): id is number => typeof id === 'number')

            if (pageIds.length !== pageExecutions.length) {
                incompleteReason = 'missing_execution_ids'
                break
            }

            before = Math.min(...pageIds)
            if (page === EXECUTIONS_BATCH_MAX_PAGES - 1) {
                incompleteReason = 'page_limit'
            }
        }

        const executionsByAcceptanceId = new Map<string, BitflyerExecutionEntry[]>()
        for (const execution of executions) {
            const acceptanceId = execution.child_order_acceptance_id
            const list = executionsByAcceptanceId.get(acceptanceId) ?? []
            list.push(execution)
            executionsByAcceptanceId.set(acceptanceId, list)
        }

        const batch = {
            fetchedAtMs: Date.now(),
            executionsByAcceptanceId,
            incompleteReason,
        }
        this.executionsBatchCache.set(productCode, batch)

        if (incompleteReason === 'page_limit') {
            this.logger.warn(
                {
                    event: 'bitflyer:executions_batch_page_limit_reached',
                    productCode,
                    maxPages: EXECUTIONS_BATCH_MAX_PAGES,
                    fetchedCount: executions.length,
                },
                'bitFlyer executions batch page limit reached',
            )
        } else if (incompleteReason === 'missing_execution_ids') {
            this.logger.warn(
                {
                    event: 'bitflyer:executions_batch_pagination_incomplete',
                    productCode,
                    fetchedCount: executions.length,
                },
                'bitFlyer executions batch pagination stopped because execution ids were missing',
            )
        }

        return batch
    }

    private async fetchExecutionInfoByChildAcceptanceIdDirect(
        childAcceptanceId: string,
        ticker: string,
    ): Promise<{ price: number, size: number, executed_at?: Date } | null> {
        const productCode = resolveProductCode(ticker)
        const childExecs = await this.callApi<BitflyerExecutionEntry[]>(
            'GET',
            `${GET_EXECUTIONS_PATH}?product_code=${encodeURIComponent(productCode)}&child_order_acceptance_id=${encodeURIComponent(childAcceptanceId)}`,
        )
        if (childExecs.length === 0) return null

        const price = weightedAvgExecs(childExecs)
        const size = totalSizeExecs(childExecs)
        return price === null ? null : { price, size, executed_at: extractLatestExecutionAt(childExecs) }
    }

    private async fetchExecutionInfoByChildAcceptanceId(
        childAcceptanceId: string,
        ticker: string,
    ): Promise<{ price: number, size: number, executed_at?: Date } | null> {
        const productCode = resolveProductCode(ticker)
        const batch = await this.fetchExecutionsByProductCode(productCode)
        const childExecs = batch.executionsByAcceptanceId.get(childAcceptanceId) ?? []

        if (childExecs.length === 0 && batch.incompleteReason) {
            this.logger.warn(
                {
                    event: 'bitflyer:executions_batch_miss_after_incomplete_batch',
                    productCode,
                    childAcceptanceId,
                    reason: batch.incompleteReason,
                },
                'bitFlyer executions batch did not include requested acceptance id after incomplete pagination; falling back to direct lookup',
            )
            return this.fetchExecutionInfoByChildAcceptanceIdDirect(childAcceptanceId, ticker)
        }

        if (childExecs.length === 0) return null

        const price = weightedAvgExecs(childExecs)
        const size = totalSizeExecs(childExecs)
        return price === null ? null : { price, size, executed_at: extractLatestExecutionAt(childExecs) }
    }

    async getExecutionPriceForOrderV2(order: OrderV2): Promise<OrdersV2ExecutionSyncResult> {
        const providerOrderId = order.provider_order_ids[0]
        if (!providerOrderId || providerOrderId === 'DRY_RUN') {
            return { execution: null }
        }

        const metadata = order.broker_order_metadata
        if (metadata?.kind !== 'bitflyer_parent_order_v1') {
            this.logger.warn(
                {
                    event: 'bitflyer:orders_v2_metadata_missing',
                    orderId: order.id,
                    ticker: order.ticker,
                    expectedKind: 'bitflyer_parent_order_v1',
                    actualKind: metadata?.kind,
                },
                'orders_v2 execution sync skipped: broker_order_metadata is missing or invalid',
            )
            return { execution: null }
        }

        try {
            let resolvedMetadata = metadata
            if (!resolvedMetadata.entry.resolved.acceptance_id) {
                const childOrders = await this.fetchChildOrders(providerOrderId, order.ticker)
                if (childOrders) {
                    resolvedMetadata = this.resolveMetadataFromChildOrders(resolvedMetadata, childOrders)
                }
            }

            const acceptanceId = resolvedMetadata.entry.resolved.acceptance_id
            const execution = acceptanceId
                ? await this.fetchExecutionInfoByChildAcceptanceId(acceptanceId, order.ticker)
                : null

            return {
                execution,
                brokerOrderMetadata: resolvedMetadata,
            }
        } catch (error) {
            this.logger.warn(
                { event: 'bitflyer:get_execution_price_v2_failed', orderId: order.id, ticker: order.ticker, error },
                'failed to get execution price for orders_v2 order',
            )
            return { execution: null, brokerOrderMetadata: metadata }
        }
    }

    async getClosingExecutionForOrderV2(order: OrderV2): Promise<OrdersV2ExecutionSyncResult> {
        const providerOrderId = order.provider_order_ids[0]
        if (!providerOrderId || providerOrderId === 'DRY_RUN') {
            return { execution: null }
        }

        const metadata = order.broker_order_metadata
        if (metadata?.kind !== 'bitflyer_parent_order_v1') {
            this.logger.warn(
                {
                    event: 'bitflyer:orders_v2_metadata_missing',
                    orderId: order.id,
                    ticker: order.ticker,
                    expectedKind: 'bitflyer_parent_order_v1',
                    actualKind: metadata?.kind,
                },
                'orders_v2 closing sync skipped: broker_order_metadata is missing or invalid',
            )
            return { execution: null }
        }

        try {
            let resolvedMetadata = metadata
            if (resolvedMetadata.exits.some((exit) => !exit.resolved.acceptance_id)) {
                const childOrders = await this.fetchChildOrders(providerOrderId, order.ticker)
                if (childOrders) {
                    resolvedMetadata = this.resolveMetadataFromChildOrders(resolvedMetadata, childOrders)
                }
            }

            let totalSize = 0
            let totalValue = 0
            let latestExecutedAt: Date | undefined

            for (const exit of resolvedMetadata.exits) {
                const acceptanceId = exit.resolved.acceptance_id
                if (!acceptanceId) continue

                const execution = await this.fetchExecutionInfoByChildAcceptanceId(acceptanceId, order.ticker)
                if (!execution) continue

                totalSize += execution.size
                totalValue += execution.price * execution.size
                if (execution.executed_at && (!latestExecutedAt || execution.executed_at.getTime() > latestExecutedAt.getTime())) {
                    latestExecutedAt = execution.executed_at
                }
            }

            return {
                execution: totalSize > 0 ? { price: totalValue / totalSize, size: totalSize, executed_at: latestExecutedAt } : null,
                brokerOrderMetadata: resolvedMetadata,
            }
        } catch (error) {
            this.logger.warn(
                { event: 'bitflyer:get_closing_execution_v2_failed', orderId: order.id, ticker: order.ticker, error },
                'failed to get closing execution for orders_v2 order',
            )
            return { execution: null, brokerOrderMetadata: metadata }
        }
    }

}
