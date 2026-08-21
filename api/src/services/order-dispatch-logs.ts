import type { Firestore } from 'firebase-admin/firestore'
import { addFirestoreDocument, getFirestoreClient } from '../firestore.js'

type OrderDispatchLogCertainty = 'CONFIRMED_SUCCESS' | 'CONFIRMED_FAILURE' | 'UNKNOWN'

type OrderDispatchLogInput = {
    event_id: string
    broker: string
    ticker: string
    side: 'BUY' | 'SELL'
    size: number
    input_size?: number
    effective_size?: number
    sizing_mode?: 'WEBHOOK_CAPPED' | 'MANAGED'
    policy_version?: number
    position_before?: number
    position_after?: number
    decision_reason?: string
    dry_run?: boolean
    certainty?: OrderDispatchLogCertainty
    strategy_id?: string
    symbol_id?: string
    order_id?: string
    reservation_id?: string
    provider_order_id?: string
    request_payload: Record<string, unknown>
    response_payload?: Record<string, unknown>
    result: 'success' | 'failure' | 'suppressed'
    error_code?: string
    error_message?: string
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
