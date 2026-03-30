import type { Firestore } from 'firebase-admin/firestore'

export type OrderDispatchLogInput = {
    event_id: string
    broker: string
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
            ...data,
            created_at: createdAt,
            expire_at: expireAt,
        })
    }
}
