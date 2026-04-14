import type { BrokerName, OrderSide } from './order.js'

export type Position = {
    broker: BrokerName
    ticker: string
    side: OrderSide
    size: number
    price?: number
    pnl?: number
}

export type GetPositionsResult = {
    ok: true
    positions: Position[]
} | {
    ok: false
    broker: string
    code: string
    message: string
}
