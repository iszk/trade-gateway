import type { Firestore } from 'firebase-admin/firestore'
import { getFirestoreClient } from '../firestore.js'
import type { Trade, AddTradeFn, TradesFilter, TradeWithId, GroupKey, GroupStats, TradeStatsResponse, GetTradesFn, GetTradeStatsFn } from '../types/trade.js'

const COLLECTION = 'trades'

export const addTradeFn = (db: Firestore): AddTradeFn => {
    return async (trade) => {
        const expireAt = new Date(trade.closed_at.getTime() + 2 * 365 * 24 * 60 * 60 * 1000)
        await db.collection(COLLECTION).add({ ...trade, expire_at: expireAt })
    }
}

export const getTradesFn = (db: Firestore): GetTradesFn => {
    return async (filter: TradesFilter): Promise<TradeWithId[]> => {
        const snapshot = await db
            .collection(COLLECTION)
            .where('opened_at', '>=', filter.from)
            .where('opened_at', '<', filter.to)
            .orderBy('opened_at', 'desc')
            .get()

        return snapshot.docs
            .map((doc) => {
                const d = doc.data()
                return {
                    docId: doc.id,
                    id: doc.id,
                    strategy: d.strategy as string,
                    symbol: d.symbol as string,
                    interval: d.interval as string,
                    broker: d.broker as Trade['broker'],
                    entry_side: d.entry_side as Trade['entry_side'],
                    entry_price: d.entry_price as number,
                    exit_price: d.exit_price as number,
                    size: d.size as number,
                    pnl: d.pnl as number,
                    entry_id: d.entry_id as string,
                    exit_id: d.exit_id as string,
                    opened_at: (d.opened_at as { toDate(): Date }).toDate(),
                    closed_at: (d.closed_at as { toDate(): Date }).toDate(),
                }
            })
            .filter((r) => {
                if (filter.strategy && r.strategy !== filter.strategy) return false
                if (filter.interval && r.interval !== filter.interval) return false
                if (filter.symbol && r.symbol !== filter.symbol) return false
                if (filter.broker && r.broker !== filter.broker) return false
                return true
            })
    }
}

export const getTradeStatsFn = (db: Firestore): GetTradeStatsFn => {
    const fetchFn = getTradesFn(db)
    return async (filter: TradesFilter): Promise<TradeStatsResponse> => {
        const trades = await fetchFn(filter)

        const groupMap = new Map<string, { key: GroupKey; trades: Trade[] }>()
        for (const t of trades) {
            const key = `${t.strategy}|${t.interval}|${t.symbol}|${t.broker}`
            if (!groupMap.has(key)) {
                groupMap.set(key, {
                    key: { strategy: t.strategy, interval: t.interval, symbol: t.symbol, broker: t.broker },
                    trades: [],
                })
            }
            groupMap.get(key)!.trades.push(t)
        }

        const groups: GroupStats[] = [...groupMap.values()].map(({ key, trades: ts }) => ({
            ...key,
            ...computeStats(ts),
        }))

        groups.sort((a, b) => b.total_pnl - a.total_pnl)

        return {
            groups,
            from: filter.from.toISOString(),
            to: filter.to.toISOString(),
        }
    }
}

export const createDefaultAddTradeFn = (): AddTradeFn =>
    addTradeFn(getFirestoreClient())

export const createDefaultGetTradesFn = (): GetTradesFn =>
    getTradesFn(getFirestoreClient())

export const createDefaultGetTradeStatsFn = (): GetTradeStatsFn =>
    getTradeStatsFn(getFirestoreClient())

// ─────────────── 統計計算（純粋関数） ───────────────

export const computeStats = (trades: Trade[]): Omit<GroupStats, keyof GroupKey> => {
    const total = trades.length
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

    const wins = trades.filter((t) => t.pnl > 0)
    const losses = trades.filter((t) => t.pnl < 0)
    const win_count = wins.length
    const loss_count = losses.length
    const win_rate = win_count / total
    const total_pnl = trades.reduce((sum, t) => sum + t.pnl, 0)
    const avg_pnl = total_pnl / total
    const avg_win = win_count > 0 ? wins.reduce((sum, t) => sum + t.pnl, 0) / win_count : null
    const avg_loss = loss_count > 0 ? losses.reduce((sum, t) => sum + t.pnl, 0) / loss_count : null

    const gross_profit = wins.reduce((sum, t) => sum + t.pnl, 0)
    const gross_loss = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0))
    const profit_factor = gross_loss > 0 ? gross_profit / gross_loss : null

    // Max drawdown: opened_at 昇順で累積PnLのピークから最大下落幅
    const sorted = [...trades].sort((a, b) => a.opened_at.getTime() - b.opened_at.getTime())
    let peak = 0
    let cumulative = 0
    let max_drawdown = 0
    for (const t of sorted) {
        cumulative += t.pnl
        if (cumulative > peak) peak = cumulative
        const drawdown = peak - cumulative
        if (drawdown > max_drawdown) max_drawdown = drawdown
    }

    // Sharpe ratio: avg_pnl / std_pnl（リスクフリーレート=0、最低10件）
    let sharpe_ratio: number | null = null
    if (total >= 10) {
        const variance = trades.reduce((sum, t) => sum + (t.pnl - avg_pnl) ** 2, 0) / total
        const std = Math.sqrt(variance)
        sharpe_ratio = std > 0 ? avg_pnl / std : null
    }

    return {
        total,
        win_count,
        loss_count,
        win_rate,
        total_pnl,
        avg_pnl,
        avg_win,
        avg_loss,
        profit_factor,
        max_drawdown,
        sharpe_ratio,
    }
}
