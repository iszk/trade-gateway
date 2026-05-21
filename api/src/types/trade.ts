import type { BrokerName, OrderSide } from './order.js'

/**
 * entry と exit がペアリングされた決済済みトレード。
 */
export type Trade = {
    id: string
    strategy: string
    symbol: string
    interval: string
    broker: BrokerName
    entry_side: OrderSide
    entry_price: number
    exit_price: number
    size: number
    pnl: number
    /** 対応する OrderExecution の id */
    entry_id: string
    exit_id: string
    opened_at: Date
    closed_at: Date
}

export type AddTradeFn = (trade: Omit<Trade, 'id'>) => Promise<void>

export type TradesFilter = {
    from: Date
    to: Date
    strategy?: string
    interval?: string
    symbol?: string
    broker?: string
}

export type TradeWithId = Trade & { docId: string }

export type GetTradesFn = (filter: TradesFilter) => Promise<TradeWithId[]>

export type GroupKey = {
    strategy: string
    interval: string
    symbol: string
    broker: string
}

export type GroupStats = GroupKey & {
    total: number
    win_count: number
    loss_count: number
    win_rate: number
    total_pnl: number
    avg_pnl: number
    avg_win: number | null
    avg_loss: number | null
    profit_factor: number | null
    max_drawdown: number
    sharpe_ratio: number | null
}

export type TradeStatsResponse = {
    groups: GroupStats[]
    from: string
    to: string
}

export type TradesResponse = {
    records: TradeWithId[]
    total: number
    page: number
    limit: number
    total_pages: number
    from: string
    to: string
}

export type GetTradeStatsFn = (filter: TradesFilter) => Promise<TradeStatsResponse>
