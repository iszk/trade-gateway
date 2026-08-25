import { isDeepStrictEqual } from 'node:util'
import type {
    DocumentReference,
    Firestore,
    Transaction,
} from 'firebase-admin/firestore'

import { getFirestoreClient } from '../firestore.js'
import type { OrderV2 } from '../types/order-v2.js'
import type {
    ExecutionSyncInfo,
    OrderExecutionSyncResult,
} from '../types/execution-sync.js'
import type { StrategySymbolPosition } from '../types/strategy-symbol-position.js'
import type { StrategySymbolReservation } from '../types/strategy-symbol-reservation.js'
import {
    addQuantities,
    isFiniteQuantity,
    subtractQuantities,
} from './quantity.js'
import {
    buildOrderExecutionSyncUpdates,
    deserializeOrderV2,
    ORDER_EXECUTION_FILL_EPSILON,
} from './orders-v2.js'
import {
    createStrategySymbolPositionId,
    deserializeStrategySymbolPosition,
    serializeStrategySymbolPosition,
} from './strategy-symbol-positions.js'
import {
    createStrategySymbolReservationId,
    deserializeStrategySymbolReservation,
    isAllowedStrategySymbolReservationTransition,
    serializeStrategySymbolReservation,
} from './strategy-symbol-reservations.js'
import { createSymbolId } from './tradable-symbols.js'
import { isCanonicalStrategyId, resolveEffectiveStrategyId } from './strategy-ids.js'

const ORDERS_COLLECTION = 'orders_v2'
const POSITIONS_COLLECTION = 'strategy_symbol_positions'
const RESERVATIONS_COLLECTION = 'strategy_symbol_reservations'

type Logger = {
    warn(obj: Record<string, unknown>, msg?: string): void
}

type StrategySymbolExecutionSyncReservationOutcome =
    | 'UPDATED'
    | 'UNCHANGED'
    | 'NOT_FOUND'
    | 'MANUAL_REVIEW'

export type ApplyStrategySymbolExecutionSyncOutcome = {
    orderUpdated: boolean
    reservation: StrategySymbolExecutionSyncReservationOutcome
    noOpReason?:
        | 'UNCHANGED'
        | 'STALE'
        | 'OVERFILL'
        | 'CONFLICT'
        | 'INVALID_STORED_STATE'
}

export type ApplyStrategySymbolExecutionSyncFn = (
    order: OrderV2,
    result: OrderExecutionSyncResult,
) => Promise<ApplyStrategySymbolExecutionSyncOutcome>

type SnapshotLike = {
    id: string
    exists: boolean
    data: () => unknown
}

type TransactionLike = Pick<Transaction, 'get' | 'set' | 'update'>

// Narrow runner seam used by emulator/unit tests to abort after staged writes.
// Production uses Firestore's native transaction runner.
type TransactionRunner = <T>(
    updateFunction: (transaction: Transaction) => Promise<T>,
) => Promise<T>

type ReservationIdentity = {
    strategyId: string
    symbolId: string
    eventId: string
    positionId: string
    reservationId: string
    reservationRef: DocumentReference
    positionRef: DocumentReference
}

type QuantityApplication = {
    position: StrategySymbolPosition
    reservation: StrategySymbolReservation
    reservationUpdated: boolean
    positionUpdated: boolean
    manualReview: boolean
    stale: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isNonEmptyString = (value: unknown): value is string => (
    typeof value === 'string' && value.trim().length > 0
)

const areSameNumber = (left: number, right: number): boolean => (
    Math.abs(left - right) <= ORDER_EXECUTION_FILL_EPSILON
)

const isFiniteDate = (value: unknown): value is Date => (
    value instanceof Date && Number.isFinite(value.getTime())
)

const isValidExecutionInfo = (execution: ExecutionSyncInfo | null | undefined): boolean => {
    if (execution === null) return true
    if (!isRecord(execution)) return false
    if (
        !isFiniteQuantity(execution.size) ||
        execution.size < 0 ||
        !isFiniteQuantity(execution.price)
    ) return false
    if (execution.executed_at !== undefined && !isFiniteDate(execution.executed_at)) return false
    if (execution.commission !== undefined && !isFiniteQuantity(execution.commission)) return false
    return true
}

const isValidStoredOrderQuantity = (order: OrderV2): boolean => (
    isFiniteQuantity(order.requested_size) &&
    order.requested_size > 0 &&
    isFiniteQuantity(order.executed_size) &&
    order.executed_size >= 0
)

const isValidStoredOrderState = (order: OrderV2): boolean => (
    isValidStoredOrderQuantity(order) &&
    (order.effective_strategy_id === undefined || isCanonicalStrategyId(order.effective_strategy_id)) &&
    (order.broker === 'bitflyer' || order.broker === 'dummy' || order.broker === 'saxo') &&
    (order.side === 'BUY' || order.side === 'SELL') &&
    (order.order_type === 'MARKET' ||
        order.order_type === 'IFDOCO' ||
        order.order_type === 'LIMIT' ||
        order.order_type === 'STOP') &&
    (order.status === 'PENDING' ||
        order.status === 'EXECUTED' ||
        order.status === 'FAILED' ||
        order.status === 'CANCELED') &&
    isFiniteDate(order.created_at) &&
    isFiniteDate(order.updated_at) &&
    order.updated_at.getTime() >= order.created_at.getTime() &&
    (order.executed_price === null ||
        order.executed_price === undefined ||
        isFiniteQuantity(order.executed_price)) &&
    (order.executed_at === undefined || isFiniteDate(order.executed_at))
)

const isValidTerminalStatus = (value: unknown): boolean => (
    value === undefined || value === 'CANCELED' || value === 'FAILED'
)

const safeDateAfter = (requested: Date, current: Date): Date => {
    const requestedTime = requested.getTime()
    const currentTime = current.getTime()
    if (!Number.isFinite(requestedTime) || !Number.isFinite(currentTime)) return requested
    if (requestedTime > currentTime) return requested
    const next = currentTime + 1
    return Number.isFinite(next) ? new Date(next) : new Date(currentTime)
}

const snapshotId = (snapshot: SnapshotLike): string => snapshot.id
const snapshotData = (snapshot: SnapshotLike): unknown => snapshot.data()

const parseOrder = (snapshot: SnapshotLike, expectedDocumentId?: string): OrderV2 | null => {
    if (!snapshot.exists || !isRecord(snapshotData(snapshot))) return null
    try {
        const order = deserializeOrderV2(snapshotData(snapshot) as OrderV2)
        return expectedDocumentId !== undefined && order.id !== expectedDocumentId
            ? null
            : order
    } catch {
        return null
    }
}

const parsePosition = (
    snapshot: SnapshotLike,
    positionId: string,
): StrategySymbolPosition | null => {
    if (!snapshot.exists || snapshotId(snapshot) !== positionId) return null
    try {
        return deserializeStrategySymbolPosition(snapshotData(snapshot), positionId)
    } catch {
        return null
    }
}

const parseReservation = (
    snapshot: SnapshotLike,
    reservationId: string,
): StrategySymbolReservation | null => {
    if (!snapshot.exists || snapshotId(snapshot) !== reservationId) return null
    try {
        return deserializeStrategySymbolReservation(snapshotData(snapshot), reservationId)
    } catch {
        return null
    }
}

const tryReservationIdentity = (
    db: Firestore,
    order: OrderV2,
): ReservationIdentity | null => {
    if (!isNonEmptyString(order.id) || !isNonEmptyString(order.ticker)) {
        return null
    }
    const strategyResolution = resolveEffectiveStrategyId({
        effectiveStrategyId: order.effective_strategy_id,
        legacyStrategy: order.strategy,
    })
    const strategyId = strategyResolution.effectiveStrategyId
    if (strategyId === undefined) return null
    try {
        const symbolId = createSymbolId(order.broker, order.ticker)
        const positionId = createStrategySymbolPositionId(strategyId, symbolId)
        const reservationId = createStrategySymbolReservationId(strategyId, symbolId, order.id)
        return {
            strategyId,
            symbolId,
            eventId: order.id,
            positionId,
            reservationId,
            reservationRef: db.collection(RESERVATIONS_COLLECTION).doc(reservationId),
            positionRef: db.collection(POSITIONS_COLLECTION).doc(positionId),
        }
    } catch {
        return null
    }
}

const reservationSideMatches = (reservation: StrategySymbolReservation, order: OrderV2): boolean => (
    (order.side === 'BUY' && reservation.reserved_delta > 0) ||
    (order.side === 'SELL' && reservation.reserved_delta < 0)
)

const reservationIdentityMatches = (
    reservation: StrategySymbolReservation,
    order: OrderV2,
    identity: ReservationIdentity,
): boolean => (
    reservation.id === identity.reservationId &&
    reservation.event_id === order.id &&
    reservation.order_id === order.id &&
    reservation.strategy_id === identity.strategyId &&
    reservation.symbol_id === identity.symbolId &&
    reservation.position_id === identity.positionId &&
    reservationSideMatches(reservation, order) &&
    areSameNumber(Math.abs(reservation.reserved_delta), order.requested_size)
)

const isExecutionSnapshotConflict = (
    current: OrderV2,
    result: OrderExecutionSyncResult,
): boolean => {
    const info = result.execution
    if (info === null || !areSameNumber(current.executed_size, info.size)) return false
    if (current.executed_price !== null && !areSameNumber(current.executed_price, info.price)) return true
    if (
        current.executed_at !== undefined &&
        info.executed_at !== undefined &&
        current.executed_at.getTime() !== info.executed_at.getTime()
    ) return true
    if (
        current.execution_costs?.commission !== undefined &&
        info.commission !== undefined &&
        !areSameNumber(current.execution_costs.commission, info.commission)
    ) return true
    if (
        current.broker_order_metadata !== undefined &&
        current.broker_order_metadata !== null &&
        result.brokerOrderMetadata !== undefined &&
        !isDeepStrictEqual(current.broker_order_metadata, result.brokerOrderMetadata)
    ) return true
    return false
}

const isBrokerMetadataConflict = (result: OrderExecutionSyncResult, current: OrderV2): boolean => (
    result.brokerOrderMetadataPolicy === 'SET_IF_UNSET' &&
    result.brokerOrderMetadata !== undefined &&
    current.broker_order_metadata !== undefined &&
    current.broker_order_metadata !== null &&
    !isDeepStrictEqual(current.broker_order_metadata, result.brokerOrderMetadata)
)

const applyOrderWrite = (
    transaction: TransactionLike,
    orderRef: DocumentReference,
    current: OrderV2,
    updates: Partial<OrderV2> | null,
    now: Date,
): boolean => {
    if (updates === null || Object.keys(updates).length === 0) return false
    transaction.update(orderRef, {
        ...updates,
        updated_at: safeDateAfter(now, current.updated_at),
    } as Record<string, unknown>)
    return true
}

const setManualReview = (
    reservation: StrategySymbolReservation,
    position: StrategySymbolPosition,
    now: Date,
): { reservation: StrategySymbolReservation, position: StrategySymbolPosition, reservationUpdated: boolean, positionUpdated: boolean } => {
    const reservationCanTransition = reservation.status !== 'RELEASED' && reservation.status !== 'SETTLED' &&
        isAllowedStrategySymbolReservationTransition(reservation.status, 'MANUAL_REVIEW')
    const updatedReservation = reservationCanTransition
        ? {
            ...reservation,
            executed_delta: reservation.executed_delta ?? 0,
            status: 'MANUAL_REVIEW' as const,
            updated_at: safeDateAfter(now, reservation.updated_at),
        }
        : reservation
    const updatedPosition = position.status === 'MANUAL_REVIEW' || position.status === 'MISMATCH'
        ? position
        : {
            ...position,
            status: 'MANUAL_REVIEW' as const,
            updated_at: safeDateAfter(now, position.updated_at),
        }
    return {
        reservation: updatedReservation,
        position: updatedPosition,
        reservationUpdated: updatedReservation !== reservation,
        positionUpdated: updatedPosition !== position,
    }
}

const applyExecutionQuantity = (
    reservation: StrategySymbolReservation,
    position: StrategySymbolPosition,
    order: OrderV2,
    result: OrderExecutionSyncResult,
    mergedOrder: OrderV2,
    now: Date,
): QuantityApplication | null => {
    const storedExecutedDelta = reservation.executed_delta ?? 0
    if (!isFiniteQuantity(storedExecutedDelta)) return null
    if (
        storedExecutedDelta !== 0 &&
        (Math.sign(storedExecutedDelta) !== Math.sign(reservation.reserved_delta) ||
            Math.abs(storedExecutedDelta) > Math.abs(reservation.reserved_delta) + ORDER_EXECUTION_FILL_EPSILON)
    ) return null

    const signedDirection = order.side === 'BUY' ? 1 : -1
    const cumulativeSize = mergedOrder.executed_size
    if (!isFiniteQuantity(cumulativeSize) || cumulativeSize < 0) return null
    const cumulativeDelta = cumulativeSize * signedDirection
    if (!isFiniteQuantity(cumulativeDelta)) return null
    const reservedMagnitude = Math.abs(reservation.reserved_delta)
    if (cumulativeSize > reservedMagnitude + ORDER_EXECUTION_FILL_EPSILON) return null

    let appliedDelta = Math.abs(cumulativeDelta) < Math.abs(storedExecutedDelta)
        ? storedExecutedDelta
        : cumulativeDelta
    // orders_v2 considers a snapshot within epsilon of the requested size a
    // full fill.  Canonicalize that boundary to the reservation amount so a
    // tiny broker/IEEE-754 difference cannot leave pending dust or make the
    // reservation serializer reject an otherwise valid full fill.
    const isCanonicalFull = Math.abs(appliedDelta) >= reservedMagnitude - ORDER_EXECUTION_FILL_EPSILON
    if (isCanonicalFull) {
        appliedDelta = reservation.reserved_delta
    }
    const increment = !isCanonicalFull && Math.abs(appliedDelta - storedExecutedDelta) <= ORDER_EXECUTION_FILL_EPSILON
        ? 0
        : subtractQuantities(appliedDelta, storedExecutedDelta)
    if (increment === null || Math.sign(increment || storedExecutedDelta || reservation.reserved_delta) !== Math.sign(reservation.reserved_delta)) {
        return null
    }

    const terminal = result.terminalStatus !== undefined ||
        mergedOrder.status === 'CANCELED' ||
        mergedOrder.status === 'FAILED'
    const isFull = Math.abs(appliedDelta) >= reservedMagnitude - ORDER_EXECUTION_FILL_EPSILON
    const shouldSettle = terminal || isFull
    const remaining = subtractQuantities(reservation.reserved_delta, appliedDelta)
    if (remaining === null) return null

    let pendingDelta = position.pending_delta
    let confirmedPosition = position.confirmed_position
    if (increment !== 0) {
        const nextConfirmed = addQuantities(confirmedPosition, increment)
        const nextPending = subtractQuantities(pendingDelta, increment)
        if (nextConfirmed === null || nextPending === null) return null
        confirmedPosition = nextConfirmed
        pendingDelta = isCanonicalFull && Math.abs(nextPending) <= ORDER_EXECUTION_FILL_EPSILON
            ? 0
            : nextPending
    }
    if (terminal && remaining !== 0) {
        const nextPending = subtractQuantities(pendingDelta, remaining)
        if (nextPending === null) return null
        pendingDelta = nextPending
    }

    const nextStatus = shouldSettle
        ? 'SETTLED' as const
        : cumulativeSize > 0
            ? 'DISPATCHED' as const
            : reservation.status
    const reservationTransitionAllowed = nextStatus === reservation.status ||
        isAllowedStrategySymbolReservationTransition(reservation.status, nextStatus)
    if (!reservationTransitionAllowed) return null

    const reservationChanged = (
        reservation.executed_delta ?? 0
    ) !== appliedDelta || reservation.status !== nextStatus
    const positionChanged = confirmedPosition !== position.confirmed_position ||
        pendingDelta !== position.pending_delta
    const updatedReservation: StrategySymbolReservation = {
        ...reservation,
        executed_delta: appliedDelta,
        status: nextStatus,
        ...(reservationChanged ? { updated_at: safeDateAfter(now, reservation.updated_at) } : {}),
    }
    const updatedPosition: StrategySymbolPosition = {
        ...position,
        confirmed_position: confirmedPosition,
        pending_delta: pendingDelta,
        ...(positionChanged ? { updated_at: safeDateAfter(now, position.updated_at) } : {}),
    }
    return {
        position: updatedPosition,
        reservation: updatedReservation,
        reservationUpdated: reservationChanged,
        positionUpdated: positionChanged,
        manualReview: false,
        stale: result.execution !== null &&
            result.execution.size < cumulativeSize - ORDER_EXECUTION_FILL_EPSILON,
    }
}

const createApplyFn = (
    db: Firestore,
    logger?: Logger,
    runTransaction: TransactionRunner = (updateFunction) => db.runTransaction(updateFunction),
): ApplyStrategySymbolExecutionSyncFn => async (inputOrder, result) => {
    const orderRef = db.collection(ORDERS_COLLECTION).doc(inputOrder.id)
    const now = new Date()

    return runTransaction(async (transaction) => {
        // The caller's order is only the fetch/logging context.  Derive the
        // reservation path from the transaction's freshly read order so a
        // stale list snapshot cannot redirect execution to another identity.
        const orderSnapshot = await transaction.get(orderRef) as unknown as SnapshotLike
        const currentOrder = parseOrder(orderSnapshot, inputOrder.id)
        if (currentOrder === null) {
            return {
                orderUpdated: false,
                reservation: 'NOT_FOUND',
                noOpReason: 'INVALID_STORED_STATE',
            }
        }

        const identity = tryReservationIdentity(db, currentOrder)
        const reservationSnapshot = identity === null
            ? null
            : await transaction.get(identity.reservationRef) as unknown as SnapshotLike
        const positionSnapshot = identity === null
            ? null
            : await transaction.get(identity.positionRef) as unknown as SnapshotLike

        if (!isValidStoredOrderState(currentOrder) || !isValidTerminalStatus(result.terminalStatus)) {
            logger?.warn(
                {
                    event: 'cron:strategy_symbol_execution_invalid_stored_state',
                    orderId: inputOrder.id,
                    reason: 'INVALID_STORED_STATE',
                },
                'stored orders_v2 state or execution terminal status is invalid; execution not applied',
            )
            return {
                orderUpdated: false,
                reservation: identity === null ? 'NOT_FOUND' : 'MANUAL_REVIEW',
                noOpReason: 'INVALID_STORED_STATE' as const,
            }
        }

        const hasValidExecution = isValidExecutionInfo(result.execution)
        const requestedSize = currentOrder.requested_size
        const overfill = result.execution !== null && (
            !hasValidExecution ||
            result.execution.size > requestedSize + ORDER_EXECUTION_FILL_EPSILON
        )
        const metadataConflict = isBrokerMetadataConflict(result, currentOrder)
        const invalidMetadataRecoveryResult = result.brokerOrderMetadataPolicy === 'SET_IF_UNSET' &&
            result.brokerOrderMetadata === undefined
        const executionSnapshotConflict = hasValidExecution && isExecutionSnapshotConflict(currentOrder, result)
        const snapshotConflict = executionSnapshotConflict || metadataConflict || invalidMetadataRecoveryResult
        if (metadataConflict) {
            logger?.warn(
                {
                    event: 'cron:orders_v2_metadata_recovery_conflict',
                    orderId: currentOrder.id,
                    reason: 'CONFLICT',
                },
                'preserving concurrently written broker metadata and execution state',
            )
        } else if (invalidMetadataRecoveryResult) {
            logger?.warn(
                {
                    event: 'cron:orders_v2_metadata_recovery_invalid',
                    orderId: currentOrder.id,
                    reason: 'INVALID_RESULT',
                },
                'metadata recovery result omitted required broker metadata; execution not applied',
            )
        } else if (executionSnapshotConflict) {
            logger?.warn(
                {
                    event: 'cron:orders_v2_execution_snapshot_conflict',
                    orderId: currentOrder.id,
                    executionSize: result.execution?.size,
                    reason: 'CONFLICT',
                },
                'same-size execution snapshot conflicts with orders_v2; preserving quantity',
            )
        }
        if (overfill) {
            logger?.warn(
                {
                    event: 'cron:orders_v2_sync_invalid_size',
                    orderId: currentOrder.id,
                    requestedSize: currentOrder.requested_size,
                    executionSize: result.execution?.size,
                    reason: 'OVERFILL',
                },
                'execution size exceeded requested_size; manual review required for strategy-symbol state',
            )
        }

        let orderUpdates: Partial<OrderV2> | null = null
        if (!overfill && !snapshotConflict) {
            orderUpdates = buildOrderExecutionSyncUpdates(currentOrder, result, logger)
        }

        // No reservation means this is a legacy/fallback order.  Preserve the
        // established orders_v2-only lifecycle and never synthesize a virtual
        // position from an order that was not policy-backed.
        if (identity === null || reservationSnapshot === null || !reservationSnapshot.exists) {
            const orderUpdated = applyOrderWrite(transaction, orderRef, currentOrder, orderUpdates, now)
            return {
                orderUpdated,
                reservation: 'NOT_FOUND',
                ...(overfill ? { noOpReason: 'OVERFILL' as const } :
                    snapshotConflict ? { noOpReason: 'CONFLICT' as const } :
                        orderUpdated ? {} : { noOpReason: 'UNCHANGED' as const }),
            }
        }

        const reservation = parseReservation(reservationSnapshot, identity.reservationId)
        const position = positionSnapshot === null
            ? null
            : parsePosition(positionSnapshot, identity.positionId)
        if (reservation === null || position === null) {
            // Keep every document untouched.  This is a policy-backed order
            // (the reservation document path exists), so advancing orders_v2
            // alone could hide the pending order from the next cron run and
            // permanently lose the retry opportunity after repair.
            logger?.warn(
                {
                    event: 'cron:strategy_symbol_execution_invalid_stored_state',
                    orderId: currentOrder.id,
                    reservationId: identity.reservationId,
                    positionId: identity.positionId,
                    reason: 'INVALID_STORED_STATE',
                },
                'stored strategy-symbol reservation or position is invalid; execution not applied',
            )
            return {
                orderUpdated: false,
                reservation: 'MANUAL_REVIEW',
                noOpReason: 'INVALID_STORED_STATE' as const,
            }
        }

        if (!reservationIdentityMatches(reservation, currentOrder, identity)) {
            const manual = setManualReview(reservation, position, now)
            const orderUpdated = applyOrderWrite(transaction, orderRef, currentOrder, null, now)
            if (manual.positionUpdated) {
                transaction.set(identity.positionRef, serializeStrategySymbolPosition(manual.position))
            }
            if (manual.reservationUpdated) {
                transaction.set(identity.reservationRef, serializeStrategySymbolReservation(manual.reservation))
            }
            logger?.warn(
                {
                    event: 'cron:strategy_symbol_execution_identity_conflict',
                    orderId: currentOrder.id,
                    reservationId: reservation.id,
                    reason: 'IDENTITY_CONFLICT',
                },
                'execution snapshot identity conflicts with reservation; manual review required',
            )
            return {
                orderUpdated,
                reservation: 'MANUAL_REVIEW',
                noOpReason: 'CONFLICT' as const,
            }
        }

        if (overfill || snapshotConflict) {
            const manual = setManualReview(reservation, position, now)
            const orderUpdated = applyOrderWrite(transaction, orderRef, currentOrder, null, now)
            if (manual.positionUpdated) transaction.set(identity.positionRef, serializeStrategySymbolPosition(manual.position))
            if (manual.reservationUpdated) transaction.set(identity.reservationRef, serializeStrategySymbolReservation(manual.reservation))
            return {
                orderUpdated,
                reservation: 'MANUAL_REVIEW',
                noOpReason: overfill ? 'OVERFILL' as const : 'CONFLICT' as const,
            }
        }

        // A terminal reservation is immutable.  A later, larger execution is
        // evidence for manual review rather than a guessed repair.  Exact
        // duplicate snapshots remain idempotent.
        const incomingCumulative = result.execution?.size ?? currentOrder.executed_size
        const appliedCumulative = Math.abs(reservation.executed_delta ?? 0)
        if (
            (reservation.status === 'RELEASED' || reservation.status === 'SETTLED') &&
            incomingCumulative > appliedCumulative + ORDER_EXECUTION_FILL_EPSILON
        ) {
            logger?.warn(
                {
                    event: 'cron:strategy_symbol_execution_terminal_conflict',
                    orderId: currentOrder.id,
                    reservationId: identity.reservationId,
                    reason: 'CONFLICT',
                    appliedCumulative,
                    incomingCumulative,
                },
                'execution arrived after terminal reservation; manual review required',
            )
            const manual = setManualReview(reservation, position, now)
            const orderUpdated = applyOrderWrite(transaction, orderRef, currentOrder, orderUpdates, now)
            if (manual.positionUpdated) transaction.set(identity.positionRef, serializeStrategySymbolPosition(manual.position))
            // RELEASED/SETTLED cannot transition backwards.  Keep the
            // reservation immutable and use position MANUAL_REVIEW as the
            // operator-visible anchor.
            return {
                orderUpdated,
                reservation: 'MANUAL_REVIEW',
                noOpReason: 'CONFLICT' as const,
            }
        }

        // Replaying the terminal snapshot which already settled/released the
        // reservation is a normal cron no-op.  In particular, RELEASED is a
        // terminal state and must not be treated as an invalid reverse
        // transition merely because the same FAILED/CANCELED result arrived
        // again.
        if (
            (reservation.status === 'RELEASED' || reservation.status === 'SETTLED') &&
            incomingCumulative <= appliedCumulative + ORDER_EXECUTION_FILL_EPSILON
        ) {
            const orderUpdated = applyOrderWrite(transaction, orderRef, currentOrder, orderUpdates, now)
            return {
                orderUpdated,
                reservation: 'UNCHANGED' as const,
                ...(orderUpdated ? {} : { noOpReason: 'UNCHANGED' as const }),
            }
        }

        const mergedOrder = {
            ...currentOrder,
            ...(orderUpdates ?? {}),
        } as OrderV2
        const quantity = applyExecutionQuantity(
            reservation,
            position,
            currentOrder,
            result,
            mergedOrder,
            now,
        )
        if (quantity === null) {
            logger?.warn(
                {
                    event: 'cron:strategy_symbol_execution_invalid_quantity_state',
                    orderId: currentOrder.id,
                    reservationId: identity.reservationId,
                    reason: 'INVALID_STORED_STATE',
                },
                'execution quantity cannot be applied safely; manual review required',
            )
            const manual = setManualReview(reservation, position, now)
            const orderUpdated = applyOrderWrite(transaction, orderRef, currentOrder, null, now)
            if (manual.positionUpdated) transaction.set(identity.positionRef, serializeStrategySymbolPosition(manual.position))
            if (manual.reservationUpdated) transaction.set(identity.reservationRef, serializeStrategySymbolReservation(manual.reservation))
            return {
                orderUpdated,
                reservation: 'MANUAL_REVIEW',
                noOpReason: 'INVALID_STORED_STATE' as const,
            }
        }

        const orderUpdated = applyOrderWrite(transaction, orderRef, currentOrder, orderUpdates, now)
        if (quantity.positionUpdated || quantity.reservationUpdated) {
            transaction.set(identity.positionRef, serializeStrategySymbolPosition(quantity.position))
            transaction.set(identity.reservationRef, serializeStrategySymbolReservation(quantity.reservation))
        }
        const changed = orderUpdated || quantity.positionUpdated || quantity.reservationUpdated
        return {
            orderUpdated,
            reservation: quantity.manualReview
                ? 'MANUAL_REVIEW' as const
                : quantity.reservationUpdated || quantity.positionUpdated
                    ? 'UPDATED' as const
                    : 'UNCHANGED' as const,
            ...(changed ? {} : { noOpReason: quantity.stale ? 'STALE' as const : 'UNCHANGED' as const }),
        }
    })
}

/** Create an atomic orders_v2 + reservation + virtual-position applier. */
export const createApplyStrategySymbolExecutionSyncFn = (
    db: Firestore = getFirestoreClient(),
    loggerOrRunner?: Logger | TransactionRunner,
    runTransaction?: TransactionRunner,
): ApplyStrategySymbolExecutionSyncFn => {
    const logger = typeof loggerOrRunner === 'function' ? undefined : loggerOrRunner
    const runner = typeof loggerOrRunner === 'function'
        ? loggerOrRunner
        : runTransaction
    return createApplyFn(db, logger, runner)
}

export const createDefaultApplyStrategySymbolExecutionSyncFn = (
    logger?: Logger,
): ApplyStrategySymbolExecutionSyncFn => createApplyStrategySymbolExecutionSyncFn(getFirestoreClient(), logger)
