import type { Firestore } from 'firebase-admin/firestore'
import { getFirestoreClient } from '../firestore.js'

export type UnpairedLog = {
    docId: string
    event_id: string
    broker: string
    ticker: string
    side: 'BUY' | 'SELL'
    size: number
    strategy: string
    interval: string
    execution_price: number
    created_at: Date
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

export type GetUnpairedLogsFn = () => Promise<UnpairedLog[]>
export type CreateTradeRecordFn = (record: TradeRecord) => Promise<void>
export type MarkLogPairedFn = (docId: string) => Promise<void>

export type PairedTrade = {
    record: TradeRecord
    entryDocId: string
    exitDocId: string
}

const PAIRING_KEY = (log: Pick<UnpairedLog, 'strategy' | 'interval' | 'ticker' | 'broker'>) =>
    `${log.strategy}|${log.interval}|${log.ticker}|${log.broker}`

export const pairLogs = (logs: UnpairedLog[]): PairedTrade[] => {
    // pairing key ごとに BUY/SELL を FIFO でマッチング
    const queues = new Map<string, UnpairedLog[]>()

    for (const log of logs) {
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
        const openPositions: UnpairedLog[] = []

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
                    entryDocId: entry.docId,
                    exitDocId: log.docId,
                })
            } else {
                // 同じ方向か未決済ポジションなし → 新規エントリー
                openPositions.push(log)
            }
        }
    }

    return paired
}

export const getUnpairedLogsFn = (db: Firestore): GetUnpairedLogsFn => {
    return async () => {
        const snapshot = await db
            .collection('order_dispatch_logs')
            .where('result', '==', 'success')
            .where('paired', '==', false)
            .get()

        return snapshot.docs
            .filter((doc) => {
                const data = doc.data()
                return (
                    data.execution_price !== undefined &&
                    data.strategy !== undefined &&
                    data.interval !== undefined
                )
            })
            .map((doc) => {
                const data = doc.data()
                return {
                    docId: doc.id,
                    event_id: data.event_id as string,
                    broker: data.broker as string,
                    ticker: data.ticker as string,
                    side: data.side as 'BUY' | 'SELL',
                    size: data.size as number,
                    strategy: data.strategy as string,
                    interval: data.interval as string,
                    execution_price: data.execution_price as number,
                    created_at: (data.created_at as { toDate(): Date }).toDate(),
                }
            })
    }
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

export const markLogPairedFn = (db: Firestore): MarkLogPairedFn => {
    return async (docId) => {
        await db.collection('order_dispatch_logs').doc(docId).update({ paired: true })
    }
}

export const createDefaultGetUnpairedLogsFn = (): GetUnpairedLogsFn =>
    getUnpairedLogsFn(getFirestoreClient())

export const createDefaultCreateTradeRecordFn = (): CreateTradeRecordFn =>
    createTradeRecordFn(getFirestoreClient())

export const createDefaultMarkLogPairedFn = (): MarkLogPairedFn =>
    markLogPairedFn(getFirestoreClient())
