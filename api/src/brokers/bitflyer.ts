import { createHmac } from 'node:crypto'

import type { OrderDispatchFailure, OrderDispatchResult, OrderRequest } from '../types/order.js'
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

const SEND_CHILD_ORDER_PATH = '/v1/me/sendchildorder'
const SEND_PARENT_ORDER_PATH = '/v1/me/sendparentorder'
const GET_POSITIONS_PATH = '/v1/me/getpositions'
const GET_BALANCE_PATH = '/v1/me/getbalance'
const GET_COLLATERAL_PATH = '/v1/me/getcollateral'
const DEFAULT_BITFLYER_BASE_URL = 'https://api.bitflyer.com'

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

const normalizeProductCode = (ticker: string) => ticker.replace(/\//g, '_').toUpperCase()

// webhook 側の ticker から bitflyer の product_code へのマッピング
// マップにない ticker は normalizeProductCode にフォールバック
const TICKER_PRODUCT_CODE_MAP: Record<string, string> = {
    'BITFLYER:FXBTCJPY': 'FX_BTC_JPY',
    'BITFLYER:BTCJPY': 'BTC_JPY',
}

const resolveProductCode = (ticker: string): string =>
    TICKER_PRODUCT_CODE_MAP[ticker.toUpperCase()] ?? normalizeProductCode(ticker)

export class BitflyerClient {
    private readonly apiKey?: string
    private readonly apiSecret?: string
    private readonly baseUrl: string
    private readonly fetchImpl: typeof fetch
    private readonly logger: Logger

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

                return {
                    ok: true,
                    broker: 'bitflyer',
                    providerOrderId,
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

    async getPositions(): Promise<Position[]> {
        // bitflyer では銘柄ごとに取得する必要があるが、とりあえず主要なものを取得するようにする
        // 本来は引数で ticker を指定するか、設定されている全ての ticker についてループする必要がある
        // ここでは MVP として FX_BTC_JPY 固定で取得してみる（TODO: 汎用化）
        try {
            const productCode = 'FX_BTC_JPY'
            const path = `${GET_POSITIONS_PATH}?product_code=${productCode}`
            const results = await this.callApi<BitflyerPositionResponse[]>('GET', path)

            return results.map((res) => ({
                broker: 'bitflyer',
                ticker: res.product_code,
                side: res.side as any, // 'BUY' | 'SELL'
                size: res.size,
                price: res.price,
                pnl: res.pnl,
            }))
        } catch (error) {
            this.logger.warn({ event: 'bitflyer:get_positions_failed', error }, 'Failed to get bitflyer positions')
            return []
        }
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
}
