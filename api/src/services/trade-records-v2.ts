import type { OrderV2 } from '../types/order-v2.js'
import { createDefaultListOrdersV2ByDateRangeFn } from './orders-v2.js'
import type { ListOrdersV2ByDateRangeFn } from './orders-v2.js'

const EPSILON = 0.00000001

const isExecutableOrder = (order: OrderV2): order is OrderV2 & { status: 'EXECUTED'; executed_at: Date; executed_price: number } => (
    order.status === 'EXECUTED' && order.executed_at !== undefined && order.executed_price !== null
)

export type TradeRecord = {
    strategy: string
    ticker: string
    broker: string
    entry_side: 'BUY' | 'SELL'
    entry_price: number
    exit_price: number
    size: number
    pnl: number
    entry_event_id: string
    exit_event_id: string
    opened_at: Date
    closed_at: Date
}

export type TradeRecordWithId = TradeRecord & { docId: string }

export type TradeRecordsFilter = {
    from: Date
    to: Date
    strategy?: string
    ticker?: string
    broker?: string
}

export type GetTradeRecordsFn = (filter: TradeRecordsFilter) => Promise<TradeRecordWithId[]>

export type GroupStats = {
    strategy: string
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

export type TradeRecordsResponse = {
    records: TradeRecordWithId[]
    total: number
    page: number
    limit: number
    total_pages: number
    from: string
    to: string
}

type OpenLot = {
    event_id: string
    strategy: string
    ticker: string
    broker: string
    side: 'BUY' | 'SELL'
    remaining_size: number
    price: number
    opened_at: Date
}

export const buildTradeRecordsFromOrdersV2 = (orders: OrderV2[]): TradeRecordWithId[] => {
    const executedOrders = orders
        .filter(isExecutableOrder)
        .filter((order) => (order.executed_size || order.requested_size) > EPSILON)
        .sort((a, b) => a.executed_at.getTime() - b.executed_at.getTime() || a.id.localeCompare(b.id))

    const lotsByKey = new Map<string, OpenLot[]>()
    const records: TradeRecordWithId[] = []

    for (const order of executedOrders) {
        const key = `${order.strategy}|${order.ticker}|${order.broker}`
        const lots = lotsByKey.get(key) ?? []
        const orderTime = order.executed_at
        let remainingSize = order.executed_size || order.requested_size

        while (remainingSize > EPSILON) {
            const openIndex = lots.findIndex((lot) => lot.side !== order.side)
            if (openIndex === -1) {
                lots.push({
                    event_id: order.id,
                    strategy: order.strategy,
                    ticker: order.ticker,
                    broker: order.broker,
                    side: order.side,
                    remaining_size: remainingSize,
                    price: order.executed_price,
                    opened_at: orderTime,
                })
                remainingSize = 0
                break
            }

            const openLot = lots[openIndex]!
            const closeSize = Math.min(openLot.remaining_size, remainingSize)
            const pnl = openLot.side === 'BUY'
                ? (order.executed_price - openLot.price) * closeSize
                : (openLot.price - order.executed_price) * closeSize

            records.push({
                docId: `${openLot.event_id}:${order.id}:${records.length}`,
                strategy: order.strategy,
                ticker: order.ticker,
                broker: order.broker,
                entry_side: openLot.side,
                entry_price: openLot.price,
                exit_price: order.executed_price,
                size: closeSize,
                pnl,
                entry_event_id: openLot.event_id,
                exit_event_id: order.id,
                opened_at: openLot.opened_at,
                closed_at: orderTime,
            })

            openLot.remaining_size -= closeSize
            remainingSize -= closeSize

            if (openLot.remaining_size <= EPSILON) {
                lots.splice(openIndex, 1)
            }
        }

        lotsByKey.set(key, lots)
    }

    return records
}

export const computeTradeStats = (records: TradeRecord[]): Omit<GroupStats, 'strategy'> => {
    const total = records.length
    if (total === 0) {
        return {
            total: 0,
            win_count: 0,
            loss_count: 0,
            win_rate: 0,
            total_pnl: 0,
            avg_pnl: 0,
            avg_win: null,
            avg_loss: null,
            profit_factor: null,
            max_drawdown: 0,
            sharpe_ratio: null,
        }
    }

    const wins = records.filter((record) => record.pnl > 0)
    const losses = records.filter((record) => record.pnl < 0)
    const totalPnl = records.reduce((sum, record) => sum + record.pnl, 0)
    const grossProfit = wins.reduce((sum, record) => sum + record.pnl, 0)
    const grossLoss = Math.abs(losses.reduce((sum, record) => sum + record.pnl, 0))

    const avgPnl = totalPnl / total
    const avgWin = wins.length > 0 ? grossProfit / wins.length : null
    const avgLoss = losses.length > 0 ? grossLoss / losses.length : null
    const profitFactor = grossLoss > EPSILON ? grossProfit / grossLoss : grossProfit > EPSILON ? Infinity : null

    const ordered = [...records].sort((a, b) => a.closed_at.getTime() - b.closed_at.getTime())
    let cumulative = 0
    let peak = 0
    let maxDrawdown = 0
    for (const record of ordered) {
        cumulative += record.pnl
        if (cumulative > peak) peak = cumulative
        const drawdown = peak - cumulative
        if (drawdown > maxDrawdown) maxDrawdown = drawdown
    }

    let sharpeRatio: number | null = null
    if (records.length >= 2) {
        const variance = records.reduce((sum, record) => sum + (record.pnl - avgPnl) ** 2, 0) / records.length
        const stdDev = Math.sqrt(variance)
        sharpeRatio = stdDev > EPSILON ? avgPnl / stdDev : null
    }

    return {
        total,
        win_count: wins.length,
        loss_count: losses.length,
        win_rate: wins.length / total,
        total_pnl: totalPnl,
        avg_pnl: avgPnl,
        avg_win: avgWin,
        avg_loss: avgLoss,
        profit_factor: profitFactor,
        max_drawdown: maxDrawdown,
        sharpe_ratio: sharpeRatio,
    }
}

export const createGetTradeRecordsFn = (listOrdersV2ByDateRange: ListOrdersV2ByDateRangeFn): GetTradeRecordsFn => {
    return async (filter) => {
        const orders = await listOrdersV2ByDateRange(new Date(0), filter.to)
        return buildTradeRecordsFromOrdersV2(orders)
            .filter((record) => record.closed_at >= filter.from && record.closed_at < filter.to)
            .filter((record) => {
                if (filter.strategy && record.strategy !== filter.strategy) return false
                if (filter.ticker && record.ticker !== filter.ticker) return false
                if (filter.broker && record.broker !== filter.broker) return false
                return true
            })
            .sort((a, b) => b.closed_at.getTime() - a.closed_at.getTime() || a.docId.localeCompare(b.docId))
    }
}

export const createGetTradeStatsFn = (getTradeRecords: GetTradeRecordsFn) => {
    return async (filter: TradeRecordsFilter): Promise<TradeStatsResponse> => {
        const records = await getTradeRecords(filter)
        const grouped = new Map<string, TradeRecord[]>()

        for (const record of records) {
            const list = grouped.get(record.strategy) ?? []
            list.push(record)
            grouped.set(record.strategy, list)
        }

        const groups = Array.from(grouped.entries())
            .map(([strategy, strategyRecords]) => ({
                strategy,
                ...computeTradeStats(strategyRecords),
            }))
            .sort((a, b) => b.total_pnl - a.total_pnl)

        return {
            groups,
            from: filter.from.toISOString(),
            to: filter.to.toISOString(),
        }
    }
}

export type GetTradeStatsFn = ReturnType<typeof createGetTradeStatsFn>

export const createDefaultGetTradeRecordsFn = (): GetTradeRecordsFn => {
    const listOrdersV2ByDateRange = createDefaultListOrdersV2ByDateRangeFn()
    return createGetTradeRecordsFn(listOrdersV2ByDateRange)
}

export const createDefaultGetTradeStatsFn = (): GetTradeStatsFn => {
    const getTradeRecords = createDefaultGetTradeRecordsFn()
    return createGetTradeStatsFn(getTradeRecords)
}
