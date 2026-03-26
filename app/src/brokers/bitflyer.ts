import { createHmac } from 'node:crypto'

import type { OrderDispatchFailure, OrderDispatchResult, OrderRequest } from '../types/order.js'

type BitflyerClientOptions = {
    apiKey?: string
    apiSecret?: string
    baseUrl?: string
    fetchImpl?: typeof fetch
}

type BitflyerOrderResponse = {
    child_order_acceptance_id?: string
    message?: string
    error_message?: string
}

const SEND_CHILD_ORDER_PATH = '/v1/me/sendchildorder'
const DEFAULT_BITFLYER_BASE_URL = 'https://api.bitflyer.com'

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

export class BitflyerClient {
    private readonly apiKey?: string
    private readonly apiSecret?: string
    private readonly baseUrl: string
    private readonly fetchImpl: typeof fetch

    constructor(options: BitflyerClientOptions = {}) {
        this.apiKey = options.apiKey
        this.apiSecret = options.apiSecret
        this.baseUrl = options.baseUrl ?? DEFAULT_BITFLYER_BASE_URL
        this.fetchImpl = options.fetchImpl ?? fetch
    }

    async sendMarketOrder(order: OrderRequest): Promise<OrderDispatchResult> {
        if (!this.apiKey || !this.apiSecret) {
            return buildFailure('BROKER_NOT_CONFIGURED', 'bitflyer api credentials are missing')
        }

        let size = order.size
        let productCode = normalizeProductCode(order.ticker)
        size = 0.01
        productCode = 'FX_BTC_JPY'

        const path = SEND_CHILD_ORDER_PATH
        const timestamp = Date.now().toString()
        const body = JSON.stringify({
            product_code: productCode,
            child_order_type: 'MARKET',
            side: order.side,
            size: size,
        })
        const sign = createHmac('sha256', this.apiSecret)
            .update(`${timestamp}POST${path}${body}`)
            .digest('hex')

        /*
        console.log('BitflyerClient sending request', {
            url: `${this.baseUrl}${path}`,
            body,
            headers: {
                'content-type': 'application/json',
                'access-key': this.apiKey,
                'access-timestamp': timestamp,
                'access-sign': sign,
                'x-request-id': order.requestId,
            },
        })
        */

        let response: Response
        try {
            response = await this.fetchImpl(`${this.baseUrl}${path}`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'access-key': this.apiKey,
                    'access-timestamp': timestamp,
                    'access-sign': sign,
                    'x-request-id': order.requestId,
                },
                body,
            })
        } catch (error) {
            return buildFailure(
                'BROKER_REQUEST_FAILED',
                error instanceof Error ? error.message : String(error),
            )
        }

        let payload: BitflyerOrderResponse | undefined
        try {
            payload = (await response.json()) as BitflyerOrderResponse
        } catch {
            payload = undefined
        }

        if (!response.ok) {
            return buildFailure(
                'BROKER_REQUEST_FAILED',
                payload?.error_message || payload?.message || `bitflyer response status ${response.status}`,
            )
        }

        const providerOrderId = payload?.child_order_acceptance_id
        if (!providerOrderId) {
            return buildFailure('BROKER_REQUEST_FAILED', 'missing child_order_acceptance_id')
        }

        return {
            ok: true,
            broker: 'bitflyer',
            providerOrderId,
        }
    }
}
