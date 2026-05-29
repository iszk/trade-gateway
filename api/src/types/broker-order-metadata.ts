import type { OrderSide } from './order.js'

export type BitflyerChildRole = 'ENTRY' | 'TAKE_PROFIT' | 'STOP_LOSS'

export type BitflyerExpectedChildOrder = {
    role: BitflyerChildRole
    side: OrderSide
    condition_type: 'MARKET' | 'LIMIT' | 'STOP'
    size: number
    price?: number
    trigger_price?: number
}

export type BitflyerResolvedChildOrder = {
    acceptance_id: string | null
}

export type BitflyerParentOrderMetadata = {
    kind: 'bitflyer_parent_order_v1'
    parent_order_acceptance_id: string
    order_method: 'IFD' | 'IFDOCO'
    entry: {
        expected: BitflyerExpectedChildOrder
        resolved: BitflyerResolvedChildOrder
    }
    exits: Array<{
        expected: BitflyerExpectedChildOrder
        resolved: BitflyerResolvedChildOrder
    }>
}

export type BrokerOrderMetadata = BitflyerParentOrderMetadata
