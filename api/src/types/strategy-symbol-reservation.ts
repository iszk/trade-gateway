export type StrategySymbolReservationStatus =
    | 'RESERVED'
    | 'DISPATCHED'
    | 'RELEASED'
    | 'MANUAL_REVIEW'
    | 'SETTLED'

export type StrategySymbolReservation = {
    id: string
    event_id: string
    position_id: string
    strategy_id: string
    symbol_id: string
    order_id: string
    reserved_delta: number
    status: StrategySymbolReservationStatus
    policy_version: number
    created_at: Date
    updated_at: Date
}

export type StrategySymbolReservationTransition = {
    from: StrategySymbolReservationStatus
    to: StrategySymbolReservationStatus
}
