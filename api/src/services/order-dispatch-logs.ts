import type { Firestore } from 'firebase-admin/firestore'
import { getFirestoreClient } from '../firestore.js'

export type OrderDispatchLogInput = {
    event_id: string
    broker: string
    ticker: string
    side: 'BUY' | 'SELL'
    size: number
    strategy?: string
    interval?: string
    price?: number
    provider_order_id?: string
    execution_price?: number
    request_payload: Record<string, unknown>
    response_payload?: Record<string, unknown>
    result: 'success' | 'failure'
    error_code?: string
}

export type CreateOrderDispatchLogFn = (data: OrderDispatchLogInput) => Promise<void>

const omitUndefinedFields = <T extends Record<string, unknown>>(value: T): T => {
    return Object.fromEntries(
        Object.entries(value).filter(([, entryValue]) => entryValue !== undefined),
    ) as T
}

export const createOrderDispatchLogFn = (db: Firestore): CreateOrderDispatchLogFn => {
    return async (data) => {
        const createdAt = new Date()
        const expireAt = new Date(createdAt.getTime() + 180 * 24 * 60 * 60 * 1000)

        await db.collection('order_dispatch_logs').add({
            ...omitUndefinedFields(data),
            open_trades_written: false,
            created_at: createdAt,
            expire_at: expireAt,
        })
    }
}

export const createDefaultOrderDispatchLogFn = (): CreateOrderDispatchLogFn =>
    createOrderDispatchLogFn(getFirestoreClient())

export type PendingExecutionLog = {
    docId: string
    broker: string
    ticker: string
    provider_order_id: string
    event_id: string
}

export type GetPendingExecutionLogsFn = () => Promise<PendingExecutionLog[]>
export type UpdateExecutionPriceFn = (docId: string, executionPrice: number) => Promise<void>

export const getPendingExecutionLogsFn = (db: Firestore): GetPendingExecutionLogsFn => {
    return async () => {
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
        const snapshot = await db
            .collection('order_dispatch_logs')
            .where('result', '==', 'success')
            .where('created_at', '>=', since)
            .get()

        return snapshot.docs
            .filter((doc) => {
                const data = doc.data()
                return data.provider_order_id && data.execution_price === undefined
            })
            .map((doc) => ({
                docId: doc.id,
                broker: doc.data().broker as string,
                ticker: doc.data().ticker as string,
                event_id: doc.data().event_id as string,
                provider_order_id: doc.data().provider_order_id as string,
            }))
    }
}

export const updateExecutionPriceFn = (db: Firestore): UpdateExecutionPriceFn => {
    return async (docId, executionPrice) => {
        await db.collection('order_dispatch_logs').doc(docId).update({ execution_price: executionPrice })
    }
}

export const createDefaultGetPendingExecutionLogsFn = (): GetPendingExecutionLogsFn =>
    getPendingExecutionLogsFn(getFirestoreClient())

export const createDefaultUpdateExecutionPriceFn = (): UpdateExecutionPriceFn =>
    updateExecutionPriceFn(getFirestoreClient())

// ─────────────── open_trades 連携 ───────────────

export type ConfirmedUnpromotedLog = {
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

export type GetConfirmedUnpromotedLogsFn = () => Promise<ConfirmedUnpromotedLog[]>
export type MarkOpenTradesWrittenFn = (docId: string) => Promise<void>

export const getConfirmedUnpromotedLogsFn = (db: Firestore): GetConfirmedUnpromotedLogsFn => {
    return async () => {
        const snapshot = await db
            .collection('order_dispatch_logs')
            .where('result', '==', 'success')
            .where('open_trades_written', '==', false)
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

export const markOpenTradesWrittenFn = (db: Firestore): MarkOpenTradesWrittenFn => {
    return async (docId) => {
        await db.collection('order_dispatch_logs').doc(docId).update({ open_trades_written: true })
    }
}

export const createDefaultGetConfirmedUnpromotedLogsFn = (): GetConfirmedUnpromotedLogsFn =>
    getConfirmedUnpromotedLogsFn(getFirestoreClient())

export const createDefaultMarkOpenTradesWrittenFn = (): MarkOpenTradesWrittenFn =>
    markOpenTradesWrittenFn(getFirestoreClient())
