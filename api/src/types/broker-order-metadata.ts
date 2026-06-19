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

export type SaxoRelatedOrderRole = 'TAKE_PROFIT' | 'STOP_LOSS'

export type SaxoExpectedRelatedOrder = {
    role: SaxoRelatedOrderRole
    side: OrderSide
    order_type: 'Limit' | 'StopIfTraded'
    size: number
    price: number
}

export type SaxoResolvedRelatedOrder = {
    order_id: string | null
}

export type SaxoOrderMetadata = {
    kind: 'saxo_order_v1'
    order_id: string
    external_reference?: string
    entry: {
        expected: {
            side: OrderSide
            order_type: 'Market'
            size: number
        }
        resolved: {
            order_id: string
            external_reference?: string
        }
    }
    exits: Array<{
        expected: SaxoExpectedRelatedOrder
        resolved: SaxoResolvedRelatedOrder & {
            external_reference?: string
        }
    }>
}

export type BrokerOrderMetadata = BitflyerParentOrderMetadata | SaxoOrderMetadata
