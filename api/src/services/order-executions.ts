import type { Firestore } from 'firebase-admin/firestore'
import { getFirestoreClient } from '../firestore.js'
import type { OrderExecution, AddOrderExecutionFn, GetMarketOrderExecutionsFn, GetIfdocoEntriesFn, GetIfdocoExitsFn, DeleteOrderExecutionFn } from '../types/execution.js'

const COLLECTION = 'order_executions'

const docToExecution = (doc: FirebaseFirestore.QueryDocumentSnapshot): OrderExecution => {
    const d = doc.data()
    return {
        id: doc.id,
        strategy: d.strategy as string,
        symbol: d.symbol as string,
        interval: d.interval as string,
        broker: d.broker as OrderExecution['broker'],
        side: d.side as OrderExecution['side'],
        size: d.size as number,
        price: d.price as number,
        executed_at: (d.executed_at as { toDate(): Date }).toDate(),
        provider_order_id: d.provider_order_id as string | undefined,
        entry_id: d.entry_id as string | undefined,
    }
}

const omitUndefined = <T extends Record<string, unknown>>(obj: T): T =>
    Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T

export const addOrderExecutionFn = (db: Firestore): AddOrderExecutionFn => {
    return async (execution) => {
        await db.collection(COLLECTION).doc(execution.id).set(omitUndefined({ ...execution }))
    }
}

/** マーケット注文（provider_order_id なし かつ entry_id なし）を取得 */
export const getMarketOrderExecutionsFn = (db: Firestore): GetMarketOrderExecutionsFn => {
    return async () => {
        const snapshot = await db.collection(COLLECTION).get()
        return snapshot.docs
            .map(docToExecution)
            .filter((e) => !e.provider_order_id && !e.entry_id)
    }
}

/** IFDOCO エントリー（provider_order_id あり かつ entry_id なし）を取得 */
export const getIfdocoEntriesFn = (db: Firestore): GetIfdocoEntriesFn => {
    return async () => {
        const snapshot = await db.collection(COLLECTION).get()
        return snapshot.docs
            .map(docToExecution)
            .filter((e) => !!e.provider_order_id && !e.entry_id)
    }
}

/** IFDOCO エグジット（entry_id あり）を取得 */
export const getIfdocoExitsFn = (db: Firestore): GetIfdocoExitsFn => {
    return async () => {
        const snapshot = await db.collection(COLLECTION).get()
        return snapshot.docs
            .map(docToExecution)
            .filter((e) => !!e.entry_id)
    }
}

export const deleteOrderExecutionFn = (db: Firestore): DeleteOrderExecutionFn => {
    return async (id) => {
        await db.collection(COLLECTION).doc(id).delete()
    }
}

export const createDefaultAddOrderExecutionFn = (): AddOrderExecutionFn =>
    addOrderExecutionFn(getFirestoreClient())

export const createDefaultGetMarketOrderExecutionsFn = (): GetMarketOrderExecutionsFn =>
    getMarketOrderExecutionsFn(getFirestoreClient())

export const createDefaultGetIfdocoEntriesFn = (): GetIfdocoEntriesFn =>
    getIfdocoEntriesFn(getFirestoreClient())

export const createDefaultGetIfdocoExitsFn = (): GetIfdocoExitsFn =>
    getIfdocoExitsFn(getFirestoreClient())

export const createDefaultDeleteOrderExecutionFn = (): DeleteOrderExecutionFn =>
    deleteOrderExecutionFn(getFirestoreClient())
