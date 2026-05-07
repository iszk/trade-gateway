import type { Firestore } from 'firebase-admin/firestore'
import { getFirestoreClient } from '../firestore.js'

export type OpenTrade = {
    event_id: string
    broker: string
    ticker: string
    side: 'BUY' | 'SELL'
    size: number
    strategy: string
    interval: string
    /** webhook 受信時点では null、cron で確定後に number になる */
    execution_price: number | null
    created_at: Date
    /** 旧フロー（cron 昇格）由来の場合のみ設定される */
    order_dispatch_log_id?: string
    /** 新フロー（webhook 即時作成）由来の場合のみ設定される */
    provider_order_id?: string
}

export type TradeRecord = {
    strategy: string
    interval: string
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

export type CreateTradeRecordFn = (record: TradeRecord) => Promise<void>

export type AddOpenTradeFn = (trade: OpenTrade) => Promise<void>
export type GetOpenTradesFn = () => Promise<OpenTrade[]>
export type DeleteOpenTradeFn = (eventId: string) => Promise<void>

export type PairedTrade = {
    record: TradeRecord
    entryEventId: string
    exitEventId: string
}

const PAIRING_KEY = (log: Pick<OpenTrade, 'strategy' | 'interval' | 'ticker' | 'broker'>) =>
    `${log.strategy}|${log.interval}|${log.ticker}|${log.broker}`

export const pairLogs = (logs: OpenTrade[]): PairedTrade[] => {
    // execution_price が未確定（null）のものはペアリング対象外
    type ConfirmedOpenTrade = OpenTrade & { execution_price: number }
    const confirmedLogs = logs.filter((log): log is ConfirmedOpenTrade => log.execution_price !== null)

    // pairing key ごとに BUY/SELL を FIFO でマッチング
    const queues = new Map<string, ConfirmedOpenTrade[]>()

    for (const log of confirmedLogs) {
        const key = PAIRING_KEY(log)
        if (!queues.has(key)) queues.set(key, [])
        queues.get(key)!.push(log)
    }

    const paired: PairedTrade[] = []

    for (const queue of queues.values()) {
        // created_at 昇順でソート（FIFO）
        queue.sort((a, b) => a.created_at.getTime() - b.created_at.getTime())

        // 時系列順にスキャンしてペアを作る
        // 先に来た side がエントリー方向となる
        const openPositions: ConfirmedOpenTrade[] = []

        for (const log of queue) {
            const openIndex = openPositions.findIndex((open) => open.side !== log.side)
            if (openIndex !== -1) {
                // 反対方向のポジションが見つかった → クローズ
                const entry = openPositions[openIndex]!
                openPositions.splice(openIndex, 1)

                const isLong = entry.side === 'BUY'
                const pnl = isLong
                    ? (log.execution_price - entry.execution_price) * entry.size
                    : (entry.execution_price - log.execution_price) * entry.size

                paired.push({
                    record: {
                        strategy: entry.strategy,
                        interval: entry.interval,
                        ticker: entry.ticker,
                        broker: entry.broker,
                        entry_side: entry.side,
                        entry_price: entry.execution_price,
                        exit_price: log.execution_price,
                        size: entry.size,
                        pnl,
                        entry_event_id: entry.event_id,
                        exit_event_id: log.event_id,
                        opened_at: entry.created_at,
                        closed_at: log.created_at,
                    },
                    entryEventId: entry.event_id,
                    exitEventId: log.event_id,
                })
            } else {
                // 同じ方向か未決済ポジションなし → 新規エントリー
                openPositions.push(log)
            }
        }
    }

    return paired
}

export const createTradeRecordFn = (db: Firestore): CreateTradeRecordFn => {
    return async (record) => {
        const expireAt = new Date(record.closed_at.getTime() + 2 * 365 * 24 * 60 * 60 * 1000) // 約2年
        await db.collection('trade_records').add({
            ...record,
            expire_at: expireAt,
        })
    }
}

export const createDefaultCreateTradeRecordFn = (): CreateTradeRecordFn =>
    createTradeRecordFn(getFirestoreClient())

// ─────────────── open_trades CRUD ───────────────

export const addOpenTradeFn = (db: Firestore): AddOpenTradeFn => {
    return async (trade) => {
        // event_id をドキュメントIDとして使用（idempotent upsert）
        await db.collection('open_trades').doc(trade.event_id).set(trade)
    }
}

export const getOpenTradesFn = (db: Firestore): GetOpenTradesFn => {
    return async () => {
        const snapshot = await db.collection('open_trades').get()
        return snapshot.docs.map((doc) => {
            const data = doc.data()
            return {
                event_id: doc.id,
                broker: data.broker as string,
                ticker: data.ticker as string,
                side: data.side as 'BUY' | 'SELL',
                size: data.size as number,
                strategy: data.strategy as string,
                interval: data.interval as string,
                execution_price: (data.execution_price as number | null) ?? null,
                created_at: (data.created_at as { toDate(): Date }).toDate(),
                order_dispatch_log_id: data.order_dispatch_log_id as string | undefined,
                provider_order_id: data.provider_order_id as string | undefined,
            }
        })
    }
}

export const deleteOpenTradeFn = (db: Firestore): DeleteOpenTradeFn => {
    return async (eventId) => {
        await db.collection('open_trades').doc(eventId).delete()
    }
}

export const createDefaultAddOpenTradeFn = (): AddOpenTradeFn =>
    addOpenTradeFn(getFirestoreClient())

export const createDefaultGetOpenTradesFn = (): GetOpenTradesFn =>
    getOpenTradesFn(getFirestoreClient())

export const createDefaultDeleteOpenTradeFn = (): DeleteOpenTradeFn =>
    deleteOpenTradeFn(getFirestoreClient())

// ─────────────── 統計・一覧クエリ ───────────────

export type TradeRecordsFilter = {
    from: Date
    to: Date
    strategy?: string
    interval?: string
    ticker?: string
    broker?: string
}

export type TradeRecordWithId = TradeRecord & { docId: string }

export type GetTradeRecordsFn = (filter: TradeRecordsFilter) => Promise<TradeRecordWithId[]>

export type GroupKey = {
    strategy: string
    interval: string
    ticker: string
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

export type TradeRecordsResponse = {
    records: TradeRecordWithId[]
    total: number
    page: number
    limit: number
    total_pages: number
    from: string
    to: string
}

export const computeStats = (records: TradeRecord[]): Omit<GroupStats, keyof GroupKey> => {
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

    const wins = records.filter((r) => r.pnl > 0)
    const losses = records.filter((r) => r.pnl < 0)
    const win_count = wins.length
    const loss_count = losses.length
    const win_rate = win_count / total
    const total_pnl = records.reduce((sum, r) => sum + r.pnl, 0)
    const avg_pnl = total_pnl / total
    const avg_win = win_count > 0 ? wins.reduce((sum, r) => sum + r.pnl, 0) / win_count : null
    const avg_loss = loss_count > 0 ? losses.reduce((sum, r) => sum + r.pnl, 0) / loss_count : null

    const gross_profit = wins.reduce((sum, r) => sum + r.pnl, 0)
    const gross_loss = Math.abs(losses.reduce((sum, r) => sum + r.pnl, 0))
    const profit_factor = gross_loss > 0 ? gross_profit / gross_loss : null

    // Max drawdown: opened_at 昇順で累積PnLのピークから最大下落幅
    const sorted = [...records].sort((a, b) => a.opened_at.getTime() - b.opened_at.getTime())
    let peak = 0
    let cumulative = 0
    let max_drawdown = 0
    for (const r of sorted) {
        cumulative += r.pnl
        if (cumulative > peak) peak = cumulative
        const drawdown = peak - cumulative
        if (drawdown > max_drawdown) max_drawdown = drawdown
    }

    // Sharpe ratio: avg_pnl / std_pnl (リスクフリーレート=0、最低10件)
    let sharpe_ratio: number | null = null
    if (total >= 10) {
        const variance = records.reduce((sum, r) => sum + (r.pnl - avg_pnl) ** 2, 0) / total
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

export const getTradeRecordsFn = (db: Firestore): GetTradeRecordsFn => {
    return async (filter) => {
        const snapshot = await db
            .collection('trade_records')
            .where('opened_at', '>=', filter.from)
            .where('opened_at', '<', filter.to)
            .orderBy('opened_at', 'desc')
            .get()

        return snapshot.docs
            .map((doc) => {
                const data = doc.data()
                return {
                    docId: doc.id,
                    strategy: data.strategy as string,
                    interval: data.interval as string,
                    ticker: data.ticker as string,
                    broker: data.broker as string,
                    entry_side: data.entry_side as 'BUY' | 'SELL',
                    entry_price: data.entry_price as number,
                    exit_price: data.exit_price as number,
                    size: data.size as number,
                    pnl: data.pnl as number,
                    entry_event_id: data.entry_event_id as string,
                    exit_event_id: data.exit_event_id as string,
                    opened_at: (data.opened_at as { toDate(): Date }).toDate(),
                    closed_at: (data.closed_at as { toDate(): Date }).toDate(),
                }
            })
            .filter((r) => {
                if (filter.strategy && r.strategy !== filter.strategy) return false
                if (filter.interval && r.interval !== filter.interval) return false
                if (filter.ticker && r.ticker !== filter.ticker) return false
                if (filter.broker && r.broker !== filter.broker) return false
                return true
            })
    }
}

export const getTradeStatsFn = (db: Firestore) => {
    const fetchFn = getTradeRecordsFn(db)
    return async (filter: TradeRecordsFilter): Promise<TradeStatsResponse> => {
        const records = await fetchFn(filter)

        const groupMap = new Map<string, { key: GroupKey; records: TradeRecord[] }>()
        for (const r of records) {
            const key = `${r.strategy}|${r.interval}|${r.ticker}|${r.broker}`
            if (!groupMap.has(key)) {
                groupMap.set(key, {
                    key: { strategy: r.strategy, interval: r.interval, ticker: r.ticker, broker: r.broker },
                    records: [],
                })
            }
            groupMap.get(key)!.records.push(r)
        }

        const groups: GroupStats[] = [...groupMap.values()].map(({ key, records: recs }) => ({
            ...key,
            ...computeStats(recs),
        }))

        groups.sort((a, b) => b.total_pnl - a.total_pnl)

        return {
            groups,
            from: filter.from.toISOString(),
            to: filter.to.toISOString(),
        }
    }
}

export type GetTradeStatsFn = ReturnType<typeof getTradeStatsFn>

export const createDefaultGetTradeRecordsFn = (): GetTradeRecordsFn =>
    getTradeRecordsFn(getFirestoreClient())

export const createDefaultGetTradeStatsFn = (): GetTradeStatsFn =>
    getTradeStatsFn(getFirestoreClient())

// ─────────────── open_trades 約定価格更新（新フロー用） ───────────────

export type PendingExecutionOpenTrade = {
    event_id: string
    broker: string
    ticker: string
    provider_order_id: string
}

export type GetPendingExecutionOpenTradesFn = () => Promise<PendingExecutionOpenTrade[]>
export type UpdateOpenTradeExecutionPriceFn = (eventId: string, executionPrice: number) => Promise<void>

/** open_trades から provider_order_id あり & execution_price=null のものを取得する */
export const getPendingExecutionOpenTradesFn = (db: Firestore): GetPendingExecutionOpenTradesFn => {
    return async () => {
        const snapshot = await db.collection('open_trades').get()
        return snapshot.docs
            .filter((doc) => {
                const data = doc.data()
                return data.provider_order_id && data.execution_price === null
            })
            .map((doc) => ({
                event_id: doc.id,
                broker: doc.data().broker as string,
                ticker: doc.data().ticker as string,
                provider_order_id: doc.data().provider_order_id as string,
            }))
    }
}

export const updateOpenTradeExecutionPriceFn = (db: Firestore): UpdateOpenTradeExecutionPriceFn => {
    return async (eventId, executionPrice) => {
        await db.collection('open_trades').doc(eventId).update({ execution_price: executionPrice })
    }
}

export const createDefaultGetPendingExecutionOpenTradesFn = (): GetPendingExecutionOpenTradesFn =>
    getPendingExecutionOpenTradesFn(getFirestoreClient())

export const createDefaultUpdateOpenTradeExecutionPriceFn = (): UpdateOpenTradeExecutionPriceFn =>
    updateOpenTradeExecutionPriceFn(getFirestoreClient())
