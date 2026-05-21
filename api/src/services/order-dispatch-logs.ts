import type { Firestore } from 'firebase-admin/firestore'
import { getFirestoreClient } from '../firestore.js'

/**
 * execution_status の意味:
 * - 'pending'      : 発注成功、order_executions への昇格を cron で待っている
 * - 'confirmed'    : cron が約定価格を確認し order_executions を作成済み
 * - 'not_tracked'  : strategy/interval なし等、order_executions を作成しないケース
 */
export type ExecutionStatus = 'pending' | 'confirmed' | 'not_tracked'

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
    /** 発注成功かつ strategy/interval ありの場合に設定 */
    execution_status?: ExecutionStatus
    /** execution_status='pending' の場合に設定（マッチングに必要な情報） */
    strategy?: string
    interval?: string
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
            created_at: createdAt,
            expire_at: expireAt,
        })
    }
}

export const createDefaultOrderDispatchLogFn = (): CreateOrderDispatchLogFn =>
    createOrderDispatchLogFn(getFirestoreClient())

// ─────────────── pending 発注の取得・更新 ───────────────

export type PendingDispatchLog = {
    docId: string
    event_id: string
    broker: string
    ticker: string
    side: 'BUY' | 'SELL'
    size: number
    strategy: string
    interval: string
    provider_order_id: string
}

export type GetPendingDispatchLogsFn = () => Promise<PendingDispatchLog[]>
export type ConfirmDispatchLogFn = (docId: string) => Promise<void>

/** execution_status='pending' の発注ログを取得する */
export const getPendingDispatchLogsFn = (db: Firestore): GetPendingDispatchLogsFn => {
    return async () => {
        const snapshot = await db
            .collection('order_dispatch_logs')
            .where('execution_status', '==', 'pending')
            .get()
        return snapshot.docs.map((doc) => {
            const d = doc.data()
            return {
                docId: doc.id,
                event_id: d.event_id as string,
                broker: d.broker as string,
                ticker: d.ticker as string,
                side: d.side as 'BUY' | 'SELL',
                size: d.size as number,
                strategy: d.strategy as string,
                interval: d.interval as string,
                provider_order_id: d.provider_order_id as string,
            }
        })
    }
}

/** execution_status を 'confirmed' に更新する */
export const confirmDispatchLogFn = (db: Firestore): ConfirmDispatchLogFn => {
    return async (docId) => {
        await db.collection('order_dispatch_logs').doc(docId).update({ execution_status: 'confirmed' })
    }
}

export const createDefaultGetPendingDispatchLogsFn = (): GetPendingDispatchLogsFn =>
    getPendingDispatchLogsFn(getFirestoreClient())

export const createDefaultConfirmDispatchLogFn = (): ConfirmDispatchLogFn =>
    confirmDispatchLogFn(getFirestoreClient())
