import type { Firestore } from 'firebase-admin/firestore'
import { getFirestoreClient, setFirestoreDocument, updateFirestoreDocument } from '../firestore.js'
import type { OrderV2 } from '../types/order-v2.js'

const COLLECTION_NAME = 'orders_v2'
const FILL_EPSILON = 1e-8

type FirestoreDate = Date | { toDate(): Date }

const fromFirestoreDate = (value: FirestoreDate): Date =>
    value instanceof Date ? value : value.toDate()

const fromFirestoreOrderV2 = (data: OrderV2): OrderV2 => {
    const normalized = {
        ...data,
        created_at: fromFirestoreDate(data.created_at as FirestoreDate),
        updated_at: fromFirestoreDate(data.updated_at as FirestoreDate),
        executed_at: data.executed_at
            ? fromFirestoreDate(data.executed_at as FirestoreDate)
            : undefined,
    }

    return normalized as OrderV2
}

export type OrderFillStatus = 'UNFILLED' | 'PARTIALLY_FILLED' | 'FILLED'

export type OrderUpdate = {
    id: string
    strategy: string
    broker: OrderV2['broker']
    ticker: string
    side: OrderV2['side']
    order_type: OrderV2['order_type']
    requested_size: number
    executed_size: number
    executed_price: number | null
    fill_status: OrderFillStatus
    status: OrderV2['status']
    provider_order_ids: string[]
    execution_costs: {
        commission: number | null
    }
    exit_sync_status: NonNullable<OrderV2['exit_sync_status']> | null
    created_at: string
    updated_at: string
    executed_at: string | null
}

const getOrderFillStatus = (order: OrderV2): OrderFillStatus => {
    if (order.executed_size <= 0) return 'UNFILLED'
    if (order.executed_size >= order.requested_size - FILL_EPSILON) return 'FILLED'
    return 'PARTIALLY_FILLED'
}

export const toOrderUpdate = (order: OrderV2): OrderUpdate => ({
    id: order.id,
    strategy: order.strategy,
    broker: order.broker,
    ticker: order.ticker,
    side: order.side,
    order_type: order.order_type,
    requested_size: order.requested_size,
    executed_size: order.executed_size,
    executed_price: order.executed_price,
    fill_status: getOrderFillStatus(order),
    status: order.status,
    provider_order_ids: order.provider_order_ids,
    execution_costs: {
        commission: order.execution_costs?.commission ?? null,
    },
    exit_sync_status: order.exit_sync_status ?? null,
    created_at: order.created_at.toISOString(),
    updated_at: order.updated_at.toISOString(),
    executed_at: order.executed_at?.toISOString() ?? null,
})

export const createAddOrderV2Fn = (db: Firestore = getFirestoreClient()) => {
    return async (order: OrderV2): Promise<void> => {
        const docRef = db.collection(COLLECTION_NAME).doc(order.id)
        await setFirestoreDocument(docRef, order as unknown as Record<string, unknown>, {
            collection: COLLECTION_NAME,
            docId: order.id,
        })
    }
}

export const createUpdateOrderV2Fn = (db: Firestore = getFirestoreClient()) => {
    return async (id: string, updates: Partial<OrderV2>): Promise<void> => {
        const docRef = db.collection(COLLECTION_NAME).doc(id)
        await updateFirestoreDocument(
            docRef,
            {
                ...updates,
                updated_at: new Date(),
            } as unknown as Record<string, unknown>,
            {
                collection: COLLECTION_NAME,
                docId: id,
            },
        )
    }
}

const createGetOrderV2Fn = (db: Firestore = getFirestoreClient()) => {
    return async (id: string): Promise<OrderV2 | null> => {
        const doc = await db.collection(COLLECTION_NAME).doc(id).get()
        if (!doc.exists) {
            return null
        }
        return fromFirestoreOrderV2(doc.data() as OrderV2)
    }
}

const createGetPendingOrdersV2Fn = (db: Firestore = getFirestoreClient()) => {
    return async (): Promise<OrderV2[]> => {
        const snapshot = await db
            .collection(COLLECTION_NAME)
            .where('status', '==', 'PENDING')
            .get()

        return snapshot.docs.map((doc) => fromFirestoreOrderV2(doc.data() as OrderV2))
    }
}

const createGetActiveIfdOrdersV2Fn = (db: Firestore = getFirestoreClient()) => {
    return async (): Promise<OrderV2[]> => {
        const snapshot = await db
            .collection(COLLECTION_NAME)
            .where('status', '==', 'EXECUTED')
            .where('order_type', '==', 'IFDOCO')
            .where('exit_sync_status', '==', 'MONITORING')
            .get()

        return snapshot.docs.map((doc) => fromFirestoreOrderV2(doc.data() as OrderV2))
    }
}

export const createListOrdersV2ByDateRangeFn = (db: Firestore = getFirestoreClient()) => {
    return async (from: Date, to: Date): Promise<OrderV2[]> => {
        const snapshot = await db
            .collection(COLLECTION_NAME)
            .where('executed_at', '>=', from)
            .where('executed_at', '<', to)
            .orderBy('executed_at', 'desc')
            .get()

        return snapshot.docs
            .map((doc) => fromFirestoreOrderV2(doc.data() as OrderV2))
            .filter((order) => order.executed_at !== undefined)
            .sort((a, b) => b.executed_at!.getTime() - a.executed_at!.getTime() || a.id.localeCompare(b.id))
    }
}

export const createListOrderUpdatesFn = (db: Firestore = getFirestoreClient()) => {
    return async (updatedFrom: Date, updatedTo: Date): Promise<OrderUpdate[]> => {
        const snapshot = await db
            .collection(COLLECTION_NAME)
            .where('updated_at', '>=', updatedFrom)
            .where('updated_at', '<', updatedTo)
            .orderBy('updated_at', 'asc')
            .get()

        return snapshot.docs
            .map((doc) => toOrderUpdate(fromFirestoreOrderV2(doc.data() as OrderV2)))
            .sort((a, b) => (
                a.updated_at.localeCompare(b.updated_at)
                || a.id.localeCompare(b.id)
            ))
    }
}

export type AddOrderV2Fn = (order: OrderV2) => Promise<void>
export type UpdateOrderV2Fn = (id: string, updates: Partial<OrderV2>) => Promise<void>
export type GetOrderV2Fn = (id: string) => Promise<OrderV2 | null>
export type GetPendingOrdersV2Fn = () => Promise<OrderV2[]>
export type GetActiveIfdOrdersV2Fn = () => Promise<OrderV2[]>
export type ListOrdersV2ByDateRangeFn = (from: Date, to: Date) => Promise<OrderV2[]>
export type ListOrderUpdatesFn = (updatedFrom: Date, updatedTo: Date) => Promise<OrderUpdate[]>

export const createDefaultAddOrderV2Fn = (): AddOrderV2Fn => createAddOrderV2Fn(getFirestoreClient())
export const createDefaultUpdateOrderV2Fn = (): UpdateOrderV2Fn => createUpdateOrderV2Fn(getFirestoreClient())
export const createDefaultGetOrderV2Fn = (): GetOrderV2Fn => createGetOrderV2Fn(getFirestoreClient())
export const createDefaultGetPendingOrdersV2Fn = (): GetPendingOrdersV2Fn => createGetPendingOrdersV2Fn(getFirestoreClient())
export const createDefaultGetActiveIfdOrdersV2Fn = (): GetActiveIfdOrdersV2Fn => createGetActiveIfdOrdersV2Fn(getFirestoreClient())
export const createDefaultListOrdersV2ByDateRangeFn = (): ListOrdersV2ByDateRangeFn => createListOrdersV2ByDateRangeFn(getFirestoreClient())
export const createDefaultListOrderUpdatesFn = (): ListOrderUpdatesFn => createListOrderUpdatesFn(getFirestoreClient())
