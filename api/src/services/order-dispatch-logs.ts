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
            paired: false,
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
