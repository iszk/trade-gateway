import { isDeepStrictEqual } from 'node:util'
import type { Firestore } from 'firebase-admin/firestore'
import { getFirestoreClient, setFirestoreDocument, updateFirestoreDocument } from '../firestore.js'
import { omitUndefinedFields } from '../omit-undefined-fields.js'
import type { OrderV2, SaxoIfdocoRecoveryState } from '../types/order-v2.js'
import type { BrokerOrderMetadata } from '../types/broker-order-metadata.js'
import type { OrderExecutionSyncResult, ExecutionSyncInfo, ExecutionTerminalStatus } from '../types/execution-sync.js'

const COLLECTION_NAME = 'orders_v2'
export const ORDER_EXECUTION_FILL_EPSILON = 1e-8

type FirestoreDate = Date | { toDate(): Date }

const fromFirestoreDate = (value: FirestoreDate): Date =>
    value instanceof Date ? value : value.toDate()

const tryFromFirestoreDate = (value: unknown): Date | undefined => {
    try {
        const date = value instanceof Date
            ? value
            : typeof value === 'object' && value !== null && 'toDate' in value && typeof value.toDate === 'function'
                ? value.toDate()
                : undefined
        return date instanceof Date && !Number.isNaN(date.getTime()) ? date : undefined
    } catch {
        return undefined
    }
}

const isNonEmptyString = (value: unknown): value is string => (
    typeof value === 'string' && value.trim().length > 0
)

const isSaxoIfdocoRecoveryStatus = (
    value: unknown,
): value is SaxoIfdocoRecoveryState['status'] => (
    value === 'RETRY_PENDING' || value === 'MANUAL_REVIEW' || value === 'COMPLETED'
)

const isRecoveryAttemptCount = (value: unknown): value is number => (
    typeof value === 'number' && Number.isInteger(value) && value >= 0
)

const normalizeSaxoIfdocoRecovery = (
    recovery: unknown,
): OrderV2['saxo_ifdoco_recovery'] => {
    if (typeof recovery !== 'object' || recovery === null || Array.isArray(recovery)) return undefined
    const recoveryRecord = recovery as Record<string, unknown>
    const lastAttemptAt = tryFromFirestoreDate(recoveryRecord.last_attempt_at)
    const resultKind = recoveryRecord.result_kind
    if (
        !lastAttemptAt ||
        !isSaxoIfdocoRecoveryStatus(recoveryRecord.status) ||
        !isRecoveryAttemptCount(recoveryRecord.attempt_count) ||
        !isNonEmptyString(resultKind)
    ) {
        return undefined
    }
    const nextAttemptAt = recoveryRecord.next_attempt_at === undefined
        ? undefined
        : tryFromFirestoreDate(recoveryRecord.next_attempt_at)
    const reason = recoveryRecord.reason === undefined
        ? undefined
        : isNonEmptyString(recoveryRecord.reason)
            ? recoveryRecord.reason.trim()
            : undefined
    return {
        status: recoveryRecord.status,
        attempt_count: recoveryRecord.attempt_count,
        last_attempt_at: lastAttemptAt,
        next_attempt_at: nextAttemptAt,
        result_kind: resultKind.trim(),
        reason,
    }
}

export const deserializeOrderV2 = (data: OrderV2): OrderV2 => {
    const normalized = {
        ...data,
        created_at: fromFirestoreDate(data.created_at as FirestoreDate),
        updated_at: fromFirestoreDate(data.updated_at as FirestoreDate),
        executed_at: data.executed_at
            ? fromFirestoreDate(data.executed_at as FirestoreDate)
            : undefined,
        saxo_ifdoco_recovery: normalizeSaxoIfdocoRecovery(data.saxo_ifdoco_recovery),
    }

    return normalized as OrderV2
}

// Kept as a local alias to make the repository methods below read naturally.
const fromFirestoreOrderV2 = deserializeOrderV2

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

export type OrderExecutionSyncLogger = {
    warn(obj: Record<string, unknown>, msg?: string): void
}

const areSameExecutionNumber = (
    left: number | null | undefined,
    right: number | null | undefined,
): boolean => {
    if (left === null || left === undefined || right === null || right === undefined) return left === right
    return Math.abs(left - right) < ORDER_EXECUTION_FILL_EPSILON
}

const areSameExecutionDate = (left: Date | undefined, right: Date): boolean => (
    left !== undefined && left.getTime() === right.getTime()
)

const mergeDefinedOrderValues = (current: unknown, incoming: unknown): unknown => {
    if (current === undefined || current === null) return incoming
    if (incoming === undefined || incoming === null) return current
    if (Array.isArray(current) && Array.isArray(incoming)) {
        const length = Math.max(current.length, incoming.length)
        return Array.from({ length }, (_, index) => mergeDefinedOrderValues(current[index], incoming[index]))
    }
    if (
        typeof current === 'object' && current !== null &&
        typeof incoming === 'object' && incoming !== null &&
        !Array.isArray(current) && !Array.isArray(incoming)
    ) {
        const currentRecord = current as Record<string, unknown>
        const incomingRecord = incoming as Record<string, unknown>
        const keys = new Set([...Object.keys(currentRecord), ...Object.keys(incomingRecord)])
        return Object.fromEntries([...keys].map((key) => [
            key,
            mergeDefinedOrderValues(currentRecord[key], incomingRecord[key]),
        ]))
    }
    return current
}

const mergeBrokerOrderMetadata = (
    current: BrokerOrderMetadata | undefined,
    incoming: BrokerOrderMetadata | undefined,
): BrokerOrderMetadata | undefined => (
    incoming === undefined
        ? current
        : mergeDefinedOrderValues(current, incoming) as BrokerOrderMetadata
)

const isBrokerOrderMetadataUnset = (
    value: BrokerOrderMetadata | null | undefined,
): value is null | undefined => value === undefined || value === null

const resolveOrderExecutedAt = (
    order: Pick<OrderV2, 'created_at' | 'executed_at'>,
    execution: ExecutionSyncInfo,
): Date => execution.executed_at ?? order.executed_at ?? order.created_at

const resolveOrderStatus = (
    currentStatus: OrderV2['status'],
    execution: ExecutionSyncInfo | null,
    terminalStatus: ExecutionTerminalStatus | undefined,
    requestedSize: number,
): OrderV2['status'] => {
    const isCompleted = execution !== null && execution.size >= requestedSize - ORDER_EXECUTION_FILL_EPSILON
    if (isCompleted) return 'EXECUTED'
    if (currentStatus !== 'PENDING') return currentStatus
    if (terminalStatus === 'CANCELED') return 'CANCELED'
    if (terminalStatus === 'FAILED' && execution === null) return 'FAILED'
    return 'PENDING'
}

/**
 * Apply the existing monotonic orders_v2 execution lifecycle to a freshly
 * read order.  The execution reconciliation transaction uses this same seam
 * so an order-only legacy sync and a policy-backed position sync cannot drift.
 */
export const buildOrderExecutionSyncUpdates = (
    current: OrderV2,
    result: OrderExecutionSyncResult,
    logger?: OrderExecutionSyncLogger,
): Partial<OrderV2> | null => {
    if (result.brokerOrderMetadataPolicy === 'SET_IF_UNSET') {
        const incomingMetadata = result.brokerOrderMetadata
        if (incomingMetadata === undefined) return null
        if (
            !isBrokerOrderMetadataUnset(current.broker_order_metadata) &&
            !isDeepStrictEqual(current.broker_order_metadata, incomingMetadata)
        ) {
            logger?.warn(
                {
                    event: 'cron:orders_v2_metadata_recovery_conflict',
                    orderId: current.id,
                },
                'preserving concurrently written broker metadata and execution state',
            )
            return null
        }
    }

    const info = result.execution
    const updates: Partial<OrderV2> = {}
    const nextStatus = resolveOrderStatus(current.status, info, result.terminalStatus, current.requested_size)
    if (current.status !== nextStatus) updates.status = nextStatus

    const mergedMetadata = mergeBrokerOrderMetadata(current.broker_order_metadata, result.brokerOrderMetadata)
    if (!isDeepStrictEqual(current.broker_order_metadata, mergedMetadata)) {
        updates.broker_order_metadata = mergedMetadata
    }

    if (info !== null) {
        const currentExecutedSize = current.executed_size ?? 0
        const isLargerSnapshot = info.size > currentExecutedSize + ORDER_EXECUTION_FILL_EPSILON
        const isSameSnapshotSize = areSameExecutionNumber(currentExecutedSize, info.size)
        const executedAt = resolveOrderExecutedAt(current, info)

        if (isLargerSnapshot) {
            updates.executed_size = info.size
            updates.executed_price = info.price
            updates.executed_at = executedAt
            if (info.commission !== undefined) {
                updates.execution_costs = { commission: info.commission }
            }
        } else if (isSameSnapshotSize) {
            if (current.executed_price == null) updates.executed_price = info.price
            if (current.executed_at === undefined) updates.executed_at = executedAt
            if (current.execution_costs?.commission === undefined && info.commission !== undefined) {
                updates.execution_costs = { commission: info.commission }
            }
        }

        if (
            nextStatus === 'EXECUTED' &&
            current.status !== 'EXECUTED' &&
            current.order_type === 'IFDOCO' &&
            current.exit_sync_status === undefined
        ) {
            updates.exit_sync_status = 'MONITORING'
        }
    }

    return Object.keys(updates).length === 0 ? null : updates
}

const getOrderFillStatus = (order: OrderV2): OrderFillStatus => {
    if (order.executed_size <= 0) return 'UNFILLED'
    if (order.executed_size >= order.requested_size - ORDER_EXECUTION_FILL_EPSILON) return 'FILLED'
    return 'PARTIALLY_FILLED'
}

const toOrderUpdate = (order: OrderV2): OrderUpdate => ({
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

export const createUpdateOrderV2AtomicallyFn = (db: Firestore = getFirestoreClient()): UpdateOrderV2AtomicallyFn => {
    return async (id, mutate): Promise<boolean> => {
        const docRef = db.collection(COLLECTION_NAME).doc(id)
        return db.runTransaction(async (transaction) => {
            const doc = await transaction.get(docRef)
            if (!doc.exists) return false

            const current = fromFirestoreOrderV2(doc.data() as OrderV2)
            const updates = mutate(current)
            if (!updates) return false

            const firestoreUpdates = omitUndefinedFields(updates as Record<string, unknown>)
            if (Object.keys(firestoreUpdates).length === 0) return false

            transaction.update(docRef, {
                ...firestoreUpdates,
                updated_at: new Date(),
            })
            return true
        })
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
export type UpdateOrderV2AtomicallyFn = (
    id: string,
    mutate: (current: OrderV2) => Partial<OrderV2> | null,
) => Promise<boolean>
export type GetOrderV2Fn = (id: string) => Promise<OrderV2 | null>
export type GetPendingOrdersV2Fn = () => Promise<OrderV2[]>
export type GetActiveIfdOrdersV2Fn = () => Promise<OrderV2[]>
export type ListOrdersV2ByDateRangeFn = (from: Date, to: Date) => Promise<OrderV2[]>
export type ListOrderUpdatesFn = (updatedFrom: Date, updatedTo: Date) => Promise<OrderUpdate[]>

export const createDefaultAddOrderV2Fn = (): AddOrderV2Fn => createAddOrderV2Fn(getFirestoreClient())
export const createDefaultUpdateOrderV2Fn = (): UpdateOrderV2Fn => createUpdateOrderV2Fn(getFirestoreClient())
export const createDefaultUpdateOrderV2AtomicallyFn = (): UpdateOrderV2AtomicallyFn => createUpdateOrderV2AtomicallyFn(getFirestoreClient())
export const createDefaultGetOrderV2Fn = (): GetOrderV2Fn => createGetOrderV2Fn(getFirestoreClient())
export const createDefaultGetPendingOrdersV2Fn = (): GetPendingOrdersV2Fn => createGetPendingOrdersV2Fn(getFirestoreClient())
export const createDefaultGetActiveIfdOrdersV2Fn = (): GetActiveIfdOrdersV2Fn => createGetActiveIfdOrdersV2Fn(getFirestoreClient())
export const createDefaultListOrdersV2ByDateRangeFn = (): ListOrdersV2ByDateRangeFn => createListOrdersV2ByDateRangeFn(getFirestoreClient())
export const createDefaultListOrderUpdatesFn = (): ListOrderUpdatesFn => createListOrderUpdatesFn(getFirestoreClient())
