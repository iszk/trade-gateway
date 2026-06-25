import type { Firestore } from 'firebase-admin/firestore'
import { addFirestoreDocument, getFirestoreClient } from '../firestore.js'

type OrderDispatchLogInput = {
    event_id: string
    broker: string
    ticker: string
    side: 'BUY' | 'SELL'
    size: number
    provider_order_id?: string
    request_payload: Record<string, unknown>
    response_payload?: Record<string, unknown>
    result: 'success' | 'failure' | 'suppressed'
    error_code?: string
}

export type CreateOrderDispatchLogFn = (data: OrderDispatchLogInput) => Promise<void>

export const createOrderDispatchLogFn = (db: Firestore): CreateOrderDispatchLogFn => {
    return async (data) => {
        const createdAt = new Date()
        const expireAt = new Date(createdAt.getTime() + 180 * 24 * 60 * 60 * 1000)

        await addFirestoreDocument(db.collection('order_dispatch_logs'), {
            ...data,
            created_at: createdAt,
            expire_at: expireAt,
        }, {
            collection: 'order_dispatch_logs',
        })
    }
}

export const createDefaultOrderDispatchLogFn = (): CreateOrderDispatchLogFn =>
    createOrderDispatchLogFn(getFirestoreClient())
