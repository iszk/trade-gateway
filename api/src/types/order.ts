export type BrokerName = 'bitflyer' | 'dummy' | 'saxo'

import type { BrokerOrderMetadata } from './broker-order-metadata.js'

export type OrderSide = 'BUY' | 'SELL'

export type OrderRequest = {
    eventId: string
    broker: BrokerName
    ticker: string
    side: OrderSide
    size: number
    requestId: string
    dryRun?: boolean
    price?: number
    stopLoss?: string
    takeProfit?: string
}

type OrderDispatchSuccess = {
    ok: true
    broker: BrokerName
    providerOrderId: string
    brokerOrderMetadata?: BrokerOrderMetadata
}

type OrderDispatchFailureCode =
    | 'BROKER_NOT_SUPPORTED'
    | 'BROKER_NOT_CONFIGURED'
    | 'BROKER_REQUEST_FAILED'
    | 'SYMBOL_PAUSED'

export type OrderDispatchFailure = {
    ok: false
    broker: string
    code: OrderDispatchFailureCode
    message: string
}

export type OrderDispatchResult = OrderDispatchSuccess | OrderDispatchFailure

export type DispatchOrderFn = (order: OrderRequest) => Promise<OrderDispatchResult>
