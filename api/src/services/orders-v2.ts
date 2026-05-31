import type { Firestore } from 'firebase-admin/firestore'
import { getFirestoreClient } from '../firestore.js'
import type { OrderV2 } from '../types/order-v2.js'

const COLLECTION_NAME = 'orders_v2'

export const createAddOrderV2Fn = (db: Firestore = getFirestoreClient()) => {
    return async (order: OrderV2): Promise<void> => {
        const docRef = db.collection(COLLECTION_NAME).doc(order.id)
        await docRef.set(order)
    }
}

export const createUpdateOrderV2Fn = (db: Firestore = getFirestoreClient()) => {
    return async (id: string, updates: Partial<OrderV2>): Promise<void> => {
        const docRef = db.collection(COLLECTION_NAME).doc(id)
        await docRef.update({
            ...updates,
            updated_at: new Date(),
        })
    }
}

export const createGetOrderV2Fn = (db: Firestore = getFirestoreClient()) => {
    return async (id: string): Promise<OrderV2 | null> => {
        const doc = await db.collection(COLLECTION_NAME).doc(id).get()
        if (!doc.exists) {
            return null
        }
        const data = doc.data() as OrderV2
        return {
            ...data,
            // Firestore の Timestamp を Date に変換
            created_at: (data.created_at as any).toDate(),
            updated_at: (data.updated_at as any).toDate(),
        }
    }
}

export const createListOrdersV2ByStrategyFn = (db: Firestore = getFirestoreClient()) => {
    return async (strategy: string): Promise<OrderV2[]> => {
        const snapshot = await db
            .collection(COLLECTION_NAME)
            .where('strategy', '==', strategy)
            .orderBy('created_at', 'asc')
            .get()

        return snapshot.docs.map((doc) => {
            const data = doc.data() as OrderV2
            return {
                ...data,
                created_at: (data.created_at as any).toDate(),
                updated_at: (data.updated_at as any).toDate(),
            }
        })
    }
}

export const createGetPendingOrdersV2Fn = (db: Firestore = getFirestoreClient()) => {
    return async (): Promise<OrderV2[]> => {
        const snapshot = await db
            .collection(COLLECTION_NAME)
            .where('status', '==', 'PENDING')
            .get()

        return snapshot.docs.map((doc) => {
            const data = doc.data() as OrderV2
            return {
                ...data,
                created_at: (data.created_at as any).toDate(),
                updated_at: (data.updated_at as any).toDate(),
            }
        })
    }
}

export const createGetActiveIfdOrdersV2Fn = (db: Firestore = getFirestoreClient()) => {
    return async (): Promise<OrderV2[]> => {
        const snapshot = await db
            .collection(COLLECTION_NAME)
            .where('status', '==', 'EXECUTED')
            .where('order_type', '==', 'IFDOCO')
            .where('exit_sync_status', '==', 'MONITORING')
            .get()

        return snapshot.docs.map((doc) => {
            const data = doc.data() as OrderV2
            return {
                ...data,
                created_at: (data.created_at as any).toDate(),
                updated_at: (data.updated_at as any).toDate(),
            }
        })
    }
}

export const createListOrdersV2ByDateRangeFn = (db: Firestore = getFirestoreClient()) => {
    return async (from: Date, to: Date): Promise<OrderV2[]> => {
        const snapshot = await db
            .collection(COLLECTION_NAME)
            .where('created_at', '>=', from)
            .where('created_at', '<=', to)
            .orderBy('created_at', 'asc')
            .get()

        return snapshot.docs.map((doc) => {
            const data = doc.data() as OrderV2
            return {
                ...data,
                created_at: (data.created_at as any).toDate(),
                updated_at: (data.updated_at as any).toDate(),
            }
        })
    }
}

export const createGetOrdersV2Fn = (db: Firestore = getFirestoreClient()) => {
    return async (id: string): Promise<OrderV2 | null> => createGetOrderV2Fn(db)(id)
}

export type AddOrderV2Fn = (order: OrderV2) => Promise<void>
export type UpdateOrderV2Fn = (id: string, updates: Partial<OrderV2>) => Promise<void>
export type GetOrderV2Fn = (id: string) => Promise<OrderV2 | null>
export type ListOrdersV2ByStrategyFn = (strategy: string) => Promise<OrderV2[]>
export type GetPendingOrdersV2Fn = () => Promise<OrderV2[]>
export type GetActiveIfdOrdersV2Fn = () => Promise<OrderV2[]>
export type ListOrdersV2ByDateRangeFn = (from: Date, to: Date) => Promise<OrderV2[]>

export const createDefaultAddOrderV2Fn = (): AddOrderV2Fn => createAddOrderV2Fn(getFirestoreClient())
export const createDefaultUpdateOrderV2Fn = (): UpdateOrderV2Fn => createUpdateOrderV2Fn(getFirestoreClient())
export const createDefaultGetOrderV2Fn = (): GetOrderV2Fn => createGetOrderV2Fn(getFirestoreClient())
export const createDefaultListOrdersV2ByStrategyFn = (): ListOrdersV2ByStrategyFn => createListOrdersV2ByStrategyFn(getFirestoreClient())
export const createDefaultGetPendingOrdersV2Fn = (): GetPendingOrdersV2Fn => createGetPendingOrdersV2Fn(getFirestoreClient())
export const createDefaultGetActiveIfdOrdersV2Fn = (): GetActiveIfdOrdersV2Fn => createGetActiveIfdOrdersV2Fn(getFirestoreClient())
export const createDefaultListOrdersV2ByDateRangeFn = (): ListOrdersV2ByDateRangeFn => createListOrdersV2ByDateRangeFn(getFirestoreClient())
