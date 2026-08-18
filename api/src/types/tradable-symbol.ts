import type { BrokerName } from './order.js'

export type TradeControlStatus = 'active' | 'paused'

export type OrderConstraints = {
    quantity_step: number
    min_order_size: number
    max_order_size?: number
}

export type TradableSymbol = {
    id: string
    broker: BrokerName
    ticker: string
    display_name?: string
    currency: string
    note?: string
    order_constraints?: OrderConstraints
    trade_control: {
        status: TradeControlStatus
        reason?: string
        updated_at: Date
        updated_by?: string
    }
    created_at: Date
    updated_at: Date
}
