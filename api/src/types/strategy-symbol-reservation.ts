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
    /**
     * 確定約定を仮想 position へ反映済みの累積数量。
     * reserved_delta と同じ符号で保持する。既存 document の読み取り時は
     * 欠落を 0 として扱い、次回の正常な更新で schema を upgrade する。
     */
    executed_delta?: number
    status: StrategySymbolReservationStatus
    policy_version: number
    created_at: Date
    updated_at: Date
}

export type StrategySymbolReservationTransition = {
    from: StrategySymbolReservationStatus
    to: StrategySymbolReservationStatus
}
