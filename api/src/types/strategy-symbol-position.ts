export type StrategySymbolPositionStatus = 'READY' | 'MANUAL_REVIEW' | 'MISMATCH'

export type StrategySymbolPosition = {
    id: string
    strategy_id: string
    symbol_id: string
    confirmed_position: number
    pending_delta: number
    status: StrategySymbolPositionStatus
    policy_version: number
    updated_at: Date
    reconciled_at: Date | null
}
