import type { Firestore } from 'firebase-admin/firestore'
import { getFirestoreClient } from '../firestore.js'
import { omitUndefinedFields } from '../omit-undefined-fields.js'

export type OrderDispatchLogInput = {
    event_id: string
    broker: string
    ticker: string
    side: 'BUY' | 'SELL'
    size: number
    provider_order_id?: string
    request_payload: Record<string, unknown>
    response_payload?: Record<string, unknown>
    result: 'success' | 'failure'
    error_code?: string
}

export type CreateOrderDispatchLogFn = (data: OrderDispatchLogInput) => Promise<void>

export const createOrderDispatchLogFn = (db: Firestore): CreateOrderDispatchLogFn => {
    return async (data) => {
        const createdAt = new Date()
        const expireAt = new Date(createdAt.getTime() + 180 * 24 * 60 * 60 * 1000)

        await db.collection('order_dispatch_logs').add({
            ...omitUndefinedFields(data),
            created_at: createdAt,
            expire_at: expireAt,
        })
    }
}

export const createDefaultOrderDispatchLogFn = (): CreateOrderDispatchLogFn =>
    createOrderDispatchLogFn(getFirestoreClient())
