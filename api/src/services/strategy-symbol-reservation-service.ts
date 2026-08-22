import type {
    DocumentReference,
    Firestore,
    Transaction,
} from 'firebase-admin/firestore'

import { getFirestoreClient } from '../firestore.js'
import type { OrderSide } from '../types/order.js'
import type { StrategySymbolPolicy } from '../types/strategy-symbol-policy.js'
import type { StrategySymbolPosition } from '../types/strategy-symbol-position.js'
import type {
    StrategySymbolReservation,
} from '../types/strategy-symbol-reservation.js'
import type { OrderConstraints } from '../types/tradable-symbol.js'
import {
    createStrategySymbolPolicyId,
    deserializeStrategySymbolPolicy,
} from './strategy-symbol-policies.js'
import {
    createStrategySymbolPositionId,
    deserializeStrategySymbolPosition,
    InvalidStoredStrategySymbolPositionError,
    serializeStrategySymbolPosition,
} from './strategy-symbol-positions.js'
import {
    createStrategySymbolReservationId,
    deserializeStrategySymbolReservation,
    InvalidStoredStrategySymbolReservationError,
    isAllowedStrategySymbolReservationTransition,
    serializeStrategySymbolReservation,
} from './strategy-symbol-reservations.js'
import {
    deserializeTradableSymbolOrderConstraints,
} from './tradable-symbols.js'
import {
    addQuantities,
    multiplyQuantity,
    subtractQuantities,
} from './quantity.js'
import {
    calculateOrderSize,
    type CalculateOrderSizeInput,
    type SizingDecision,
} from './order-size-calculator.js'

const POLICY_COLLECTION = 'strategy_symbol_policies'
const SYMBOL_COLLECTION = 'tradable_symbols'
const POSITION_COLLECTION = 'strategy_symbol_positions'
const RESERVATION_COLLECTION = 'strategy_symbol_reservations'

/** Input accepted by the atomic reservation operation. */
export type ReserveStrategySymbolOrderInput = {
    eventId: string
    orderId: string
    strategyId: string
    symbolId: string
    side: OrderSide
    inputSize?: number
}

type SizingDispatchDecision = Extract<SizingDecision, { kind: 'DISPATCH' }>
type SizingSuppressDecision = Extract<SizingDecision, { kind: 'SUPPRESS' }>
type SizingRejectDecision = Extract<SizingDecision, { kind: 'REJECT' }>

export type ReserveStrategySymbolOrderResult =
    | {
        kind: 'DISPATCH'
        reason: 'CALCULATED'
        effectiveSize: number
        decision: SizingDispatchDecision
        audit: {
            sizingMode: StrategySymbolPolicy['sizing_mode']
            policyVersion: number
            positionBefore: number
            positionAfter: number
        }
        reservation: StrategySymbolReservation
        position: StrategySymbolPosition
      }
    | {
        kind: 'SUPPRESS'
        reason: SizingSuppressDecision['reason'] | 'DUPLICATE_EVENT' | 'POSITION_NOT_READY'
        decision?: SizingSuppressDecision
        reservation?: StrategySymbolReservation
        position?: StrategySymbolPosition
      }
    | {
        kind: 'REJECT'
        reason: SizingRejectDecision['reason']
            | 'POLICY_NOT_FOUND'
            | 'SYMBOL_NOT_FOUND'
            | 'SYMBOL_CONSTRAINTS_REQUIRED'
            | 'POSITION_NOT_FOUND'
            | 'EVENT_CONFLICT'
            | 'INVALID_STORED_STATE'
        decision?: SizingRejectDecision
      }

export type CalculateOrderSizeFn = (input: CalculateOrderSizeInput) => SizingDecision
export type ReserveStrategySymbolOrderFn = (
    input: ReserveStrategySymbolOrderInput,
) => Promise<ReserveStrategySymbolOrderResult>

export type StrategySymbolDispatchOutcome =
    | 'CONFIRMED_SUCCESS'
    | 'CONFIRMED_FAILURE'
    | 'UNKNOWN'

export type ApplyStrategySymbolDispatchOutcomeInput = {
    strategyId: string
    symbolId: string
    eventId: string
    outcome: StrategySymbolDispatchOutcome
}

export type ApplyStrategySymbolDispatchOutcomeResult =
    | {
        kind: 'UPDATED'
        reservation: StrategySymbolReservation
        position: StrategySymbolPosition
      }
    | {
        kind: 'UNCHANGED'
        reservation: StrategySymbolReservation
        position: StrategySymbolPosition
      }
    | {
        kind: 'REJECT'
        reason: 'RESERVATION_NOT_FOUND' | 'INVALID_TRANSITION' | 'INVALID_STORED_STATE'
      }

export type ApplyStrategySymbolDispatchOutcomeFn = (
    input: ApplyStrategySymbolDispatchOutcomeInput,
) => Promise<ApplyStrategySymbolDispatchOutcomeResult>

export type StrategySymbolReservationService = {
    reserveStrategySymbolOrder: ReserveStrategySymbolOrderFn
    applyStrategySymbolDispatchOutcome: ApplyStrategySymbolDispatchOutcomeFn
}

/** Invalid request identity is rejected before opening a Firestore transaction. */
class InvalidStrategySymbolReservationServiceInputError extends Error {
    readonly code = 'INVALID_RESERVATION_SERVICE_INPUT'

    constructor(message: string) {
        super(message)
        this.name = 'InvalidStrategySymbolReservationServiceInputError'
    }
}

type SnapshotLike = {
    id: string
    exists: boolean
    data: () => unknown
}

type TransactionLike = Pick<Transaction, 'get' | 'set'>

// Kept as a narrow factory seam so emulator tests can abort after the service
// has staged both writes. Production callers use the default Firestore runner.
type TransactionRunner = <T>(
    updateFunction: (transaction: Transaction) => Promise<T>,
) => Promise<T>

const isNonEmptyString = (value: unknown): value is string => (
    typeof value === 'string' && value.trim().length > 0
)

const snapshotId = (snapshot: SnapshotLike): string => snapshot.id

const snapshotData = (snapshot: SnapshotLike): unknown => snapshot.data()

const assertReserveInput = (input: ReserveStrategySymbolOrderInput): void => {
    if (typeof input !== 'object' || input === null) {
        throw new InvalidStrategySymbolReservationServiceInputError('input is invalid')
    }
    if (!isNonEmptyString(input.eventId)) {
        throw new InvalidStrategySymbolReservationServiceInputError('eventId is invalid')
    }
    if (!isNonEmptyString(input.orderId)) {
        throw new InvalidStrategySymbolReservationServiceInputError('orderId is invalid')
    }
    if (!isNonEmptyString(input.strategyId)) {
        throw new InvalidStrategySymbolReservationServiceInputError('strategyId is invalid')
    }
    if (!isNonEmptyString(input.symbolId)) {
        throw new InvalidStrategySymbolReservationServiceInputError('symbolId is invalid')
    }
    if (input.side !== 'BUY' && input.side !== 'SELL') {
        throw new InvalidStrategySymbolReservationServiceInputError('side is invalid')
    }

    try {
        createStrategySymbolPositionId(input.strategyId, input.symbolId)
        createStrategySymbolReservationId(input.strategyId, input.symbolId, input.eventId)
    } catch {
        throw new InvalidStrategySymbolReservationServiceInputError('input identity is invalid')
    }
}

const assertOutcomeInput = (input: ApplyStrategySymbolDispatchOutcomeInput): void => {
    if (typeof input !== 'object' || input === null) {
        throw new InvalidStrategySymbolReservationServiceInputError('input is invalid')
    }
    if (!isNonEmptyString(input.eventId)) {
        throw new InvalidStrategySymbolReservationServiceInputError('eventId is invalid')
    }
    if (!isNonEmptyString(input.strategyId)) {
        throw new InvalidStrategySymbolReservationServiceInputError('strategyId is invalid')
    }
    if (!isNonEmptyString(input.symbolId)) {
        throw new InvalidStrategySymbolReservationServiceInputError('symbolId is invalid')
    }
    if (
        input.outcome !== 'CONFIRMED_SUCCESS'
        && input.outcome !== 'CONFIRMED_FAILURE'
        && input.outcome !== 'UNKNOWN'
    ) {
        throw new InvalidStrategySymbolReservationServiceInputError('outcome is invalid')
    }

    try {
        createStrategySymbolPositionId(input.strategyId, input.symbolId)
        createStrategySymbolReservationId(input.strategyId, input.symbolId, input.eventId)
    } catch {
        throw new InvalidStrategySymbolReservationServiceInputError('input identity is invalid')
    }
}

const getDocumentRefs = (
    db: Firestore,
    strategyId: string,
    symbolId: string,
    eventId: string,
): {
    policyRef: DocumentReference
    symbolRef: DocumentReference
    positionRef: DocumentReference
    reservationRef: DocumentReference
} => {
    const policyId = createStrategySymbolPolicyId(strategyId, symbolId)
    const positionId = createStrategySymbolPositionId(strategyId, symbolId)
    const reservationId = createStrategySymbolReservationId(strategyId, symbolId, eventId)
    return {
        policyRef: db.collection(POLICY_COLLECTION).doc(policyId),
        symbolRef: db.collection(SYMBOL_COLLECTION).doc(symbolId),
        positionRef: db.collection(POSITION_COLLECTION).doc(positionId),
        reservationRef: db.collection(RESERVATION_COLLECTION).doc(reservationId),
    }
}

const isBuyDelta = (delta: number): boolean => delta > 0

const signedReservationDelta = (size: number, side: OrderSide): number | null => (
    multiplyQuantity(size, side === 'BUY' ? 1 : -1)
)

const invalidStoredState = (): ReserveStrategySymbolOrderResult => ({
    kind: 'REJECT',
    reason: 'INVALID_STORED_STATE',
})

const invalidOutcomeState = (): ApplyStrategySymbolDispatchOutcomeResult => ({
    kind: 'REJECT',
    reason: 'INVALID_STORED_STATE',
})

const safeDateAfter = (requested: Date, current: Date): Date => {
    const requestedTime = requested.getTime()
    const currentTime = current.getTime()
    if (!Number.isFinite(requestedTime) || !Number.isFinite(currentTime)) return requested
    // Reuse the transaction-external timestamp on the normal path.  Apart
    // from keeping dates monotonic, this makes retries observe the exact same
    // timestamp value rather than constructing a fresh Date per attempt.
    if (requestedTime > currentTime) return requested
    const next = currentTime + 1
    return Number.isFinite(next) ? new Date(next) : new Date(currentTime)
}

const sameReservationIdentity = (
    reservation: StrategySymbolReservation,
    input: ReserveStrategySymbolOrderInput,
): boolean => (
    reservation.strategy_id === input.strategyId
    && reservation.symbol_id === input.symbolId
    && reservation.event_id === input.eventId
    && reservation.order_id === input.orderId
    && isBuyDelta(reservation.reserved_delta) === (input.side === 'BUY')
)

const readAllReserveSnapshots = async (
    transaction: TransactionLike,
    refs: ReturnType<typeof getDocumentRefs>,
): Promise<{
    reservationSnapshot: SnapshotLike
    policySnapshot: SnapshotLike
    symbolSnapshot: SnapshotLike
    positionSnapshot: SnapshotLike
}> => {
    // Firestore requires every transaction read to happen before its first write.
    // Keep this order explicit so future changes cannot accidentally interleave a
    // write while one of the sizing inputs is still being read.
    const reservationSnapshot = await transaction.get(refs.reservationRef) as unknown as SnapshotLike
    const policySnapshot = await transaction.get(refs.policyRef) as unknown as SnapshotLike
    const symbolSnapshot = await transaction.get(refs.symbolRef) as unknown as SnapshotLike
    const positionSnapshot = await transaction.get(refs.positionRef) as unknown as SnapshotLike
    return { reservationSnapshot, policySnapshot, symbolSnapshot, positionSnapshot }
}

const readAllOutcomeSnapshots = async (
    transaction: TransactionLike,
    refs: ReturnType<typeof getDocumentRefs>,
): Promise<{
    reservationSnapshot: SnapshotLike
    positionSnapshot: SnapshotLike
}> => {
    const reservationSnapshot = await transaction.get(refs.reservationRef) as unknown as SnapshotLike
    const positionSnapshot = await transaction.get(refs.positionRef) as unknown as SnapshotLike
    return { reservationSnapshot, positionSnapshot }
}

const parseStoredPosition = (
    snapshot: SnapshotLike,
    positionId: string,
): StrategySymbolPosition => {
    if (snapshotId(snapshot) !== positionId) {
        throw new InvalidStoredStrategySymbolPositionError('position document ID does not match its requested path')
    }
    return deserializeStrategySymbolPosition(snapshotData(snapshot), positionId)
}

const parseStoredReservation = (
    snapshot: SnapshotLike,
    reservationId: string,
): StrategySymbolReservation => {
    if (snapshotId(snapshot) !== reservationId) {
        throw new InvalidStoredStrategySymbolReservationError('reservation document ID does not match its requested path')
    }
    return deserializeStrategySymbolReservation(snapshotData(snapshot), reservationId)
}

const parseSizingDecision = (
    calculate: CalculateOrderSizeFn,
    input: CalculateOrderSizeInput,
): SizingDecision | null => {
    try {
        const decision = calculate(input)
        if (
            typeof decision !== 'object'
            || decision === null
            || (decision.kind !== 'DISPATCH' && decision.kind !== 'SUPPRESS' && decision.kind !== 'REJECT')
        ) {
            return null
        }
        return decision
    } catch {
        return null
    }
}

/**
 * The optional calculator seam is useful for contract tests and backwards
 * compatibility, but it must never be able to weaken the sizing invariant.
 * Re-run the canonical calculator against the same snapshot and accept an
 * injected DISPATCH only when it produces the exact same safe quantity.  This
 * reuses the business rules (step, min/max order, position cap, and no-flip)
 * instead of duplicating them at the persistence boundary.
 */
const satisfiesCanonicalDispatchPostcondition = (
    input: CalculateOrderSizeInput,
    decision: SizingDispatchDecision,
): boolean => {
    if (
        decision.reason !== 'CALCULATED'
        || typeof decision.effectiveSize !== 'number'
        || !Number.isFinite(decision.effectiveSize)
        || decision.effectiveSize <= 0
    ) return false

    const canonicalDecision = calculateOrderSize(input)
    return canonicalDecision.kind === 'DISPATCH'
        && canonicalDecision.effectiveSize === decision.effectiveSize
}

const createReserveFn = (
    db: Firestore,
    calculate: CalculateOrderSizeFn,
): ReserveStrategySymbolOrderFn => {
    return async (input) => {
        assertReserveInput(input)
        const refs = getDocumentRefs(db, input.strategyId, input.symbolId, input.eventId)
        const reservationId = createStrategySymbolReservationId(input.strategyId, input.symbolId, input.eventId)
        const positionId = createStrategySymbolPositionId(input.strategyId, input.symbolId)
        // The callback may run more than once on a transaction conflict.  This
        // timestamp is intentionally created once, outside the callback.
        const requestedAt = new Date()

        return db.runTransaction(async (transaction) => {
            const snapshots = await readAllReserveSnapshots(transaction, refs)

            if (snapshots.reservationSnapshot.exists) {
                let existingReservation: StrategySymbolReservation
                try {
                    existingReservation = parseStoredReservation(
                        snapshots.reservationSnapshot,
                        reservationId,
                    )
                } catch {
                    return invalidStoredState()
                }

                if (!sameReservationIdentity(existingReservation, input)) {
                    return {
                        kind: 'REJECT',
                        reason: 'EVENT_CONFLICT',
                    } satisfies ReserveStrategySymbolOrderResult
                }

                // Do not re-run the calculator or re-dispatch an existing event.
                // A position is included when it is present and valid, but a
                // legacy/missing position does not justify creating a second
                // reservation for an already-deduplicated event.
                let existingPosition: StrategySymbolPosition | undefined
                if (snapshots.positionSnapshot.exists) {
                    try {
                        existingPosition = parseStoredPosition(snapshots.positionSnapshot, positionId)
                    } catch {
                        return invalidStoredState()
                    }
                }
                return {
                    kind: 'SUPPRESS',
                    reason: 'DUPLICATE_EVENT',
                    reservation: existingReservation,
                    ...(existingPosition === undefined ? {} : { position: existingPosition }),
                } satisfies ReserveStrategySymbolOrderResult
            }

            if (!snapshots.policySnapshot.exists) {
                return { kind: 'REJECT', reason: 'POLICY_NOT_FOUND' } satisfies ReserveStrategySymbolOrderResult
            }
            if (!snapshots.symbolSnapshot.exists) {
                return { kind: 'REJECT', reason: 'SYMBOL_NOT_FOUND' } satisfies ReserveStrategySymbolOrderResult
            }
            if (!snapshots.positionSnapshot.exists) {
                return { kind: 'REJECT', reason: 'POSITION_NOT_FOUND' } satisfies ReserveStrategySymbolOrderResult
            }

            let policy: StrategySymbolPolicy
            let constraints: OrderConstraints | undefined
            let position: StrategySymbolPosition
            try {
                const policyId = refs.policyRef.id
                if (snapshotId(snapshots.policySnapshot) !== policyId) {
                    return invalidStoredState()
                }
                policy = deserializeStrategySymbolPolicy(
                    snapshotData(snapshots.policySnapshot),
                    policyId,
                    input.strategyId,
                    input.symbolId,
                )
                constraints = deserializeTradableSymbolOrderConstraints(
                    snapshotData(snapshots.symbolSnapshot),
                    input.symbolId,
                )
                position = parseStoredPosition(snapshots.positionSnapshot, positionId)
            } catch {
                return invalidStoredState()
            }
            if (constraints === undefined) {
                return {
                    kind: 'REJECT',
                    reason: 'SYMBOL_CONSTRAINTS_REQUIRED',
                } satisfies ReserveStrategySymbolOrderResult
            }

            // Validate the virtual position arithmetic at the service
            // boundary as well as inside the default calculator.  This keeps
            // a custom calculator from turning an overflowing stored state
            // into a new reservation.
            if (addQuantities(position.confirmed_position, position.pending_delta) === null) {
                return invalidStoredState()
            }

            if (position.status !== 'READY') {
                return {
                    kind: 'SUPPRESS',
                    reason: 'POSITION_NOT_READY',
                    position,
                } satisfies ReserveStrategySymbolOrderResult
            }

            const calculationInput: CalculateOrderSizeInput = {
                policy,
                constraints,
                confirmedPosition: position.confirmed_position,
                pendingDelta: position.pending_delta,
                side: input.side,
                inputSize: input.inputSize,
            }
            const decision = parseSizingDecision(calculate, calculationInput)
            if (decision === null) return invalidStoredState()
            if (decision.kind === 'SUPPRESS') {
                return {
                    kind: 'SUPPRESS',
                    reason: decision.reason,
                    decision,
                } satisfies ReserveStrategySymbolOrderResult
            }
            if (decision.kind === 'REJECT') {
                return {
                    kind: 'REJECT',
                    reason: decision.reason,
                    decision,
                } satisfies ReserveStrategySymbolOrderResult
            }

            // A DISPATCH decision is an internal calculator contract.  Keep
            // the persistence boundary fail-closed even if a custom/injected
            // calculator returns a quantity that violates canonical sizing.
            if (!satisfiesCanonicalDispatchPostcondition(calculationInput, decision)) {
                return invalidStoredState()
            }
            const reservedDelta = signedReservationDelta(decision.effectiveSize, input.side)
            if (
                reservedDelta === null
                || reservedDelta === 0
                || (input.side === 'BUY' && reservedDelta < 0)
                || (input.side === 'SELL' && reservedDelta > 0)
            ) return invalidStoredState()
            const pendingDelta = addQuantities(position.pending_delta, reservedDelta)
            if (pendingDelta === null) return invalidStoredState()

            const positionBefore = addQuantities(
                position.confirmed_position,
                position.pending_delta,
            )
            const positionAfter = addQuantities(position.confirmed_position, pendingDelta)
            if (positionBefore === null || positionAfter === null) return invalidStoredState()

            const updatedPosition: StrategySymbolPosition = {
                ...position,
                pending_delta: pendingDelta,
                policy_version: policy.version,
                updated_at: safeDateAfter(requestedAt, position.updated_at),
            }
            const reservation: StrategySymbolReservation = {
                id: reservationId,
                event_id: input.eventId,
                position_id: positionId,
                strategy_id: input.strategyId,
                symbol_id: input.symbolId,
                order_id: input.orderId,
                reserved_delta: reservedDelta,
                executed_delta: 0,
                status: 'RESERVED',
                policy_version: policy.version,
                created_at: requestedAt,
                updated_at: requestedAt,
            }

            let positionData: Record<string, unknown>
            let reservationData: Record<string, unknown>
            try {
                positionData = serializeStrategySymbolPosition(updatedPosition)
                reservationData = serializeStrategySymbolReservation(reservation)
            } catch {
                return invalidStoredState()
            }

            // Both writes are staged only after every snapshot read, parser,
            // calculation, and serializer check has succeeded.
            transaction.set(refs.positionRef, positionData)
            transaction.set(refs.reservationRef, reservationData)
            return {
                kind: 'DISPATCH',
                reason: 'CALCULATED',
                effectiveSize: decision.effectiveSize,
                decision,
                audit: {
                    sizingMode: policy.sizing_mode,
                    policyVersion: policy.version,
                    positionBefore,
                    positionAfter,
                },
                reservation,
                position: updatedPosition,
            } satisfies ReserveStrategySymbolOrderResult
        })
    }
}

const createOutcomeFn = (
    db: Firestore,
    runTransaction: TransactionRunner = (updateFunction) => db.runTransaction(updateFunction),
): ApplyStrategySymbolDispatchOutcomeFn => {
    return async (input) => {
        assertOutcomeInput(input)
        const refs = getDocumentRefs(db, input.strategyId, input.symbolId, input.eventId)
        const reservationId = createStrategySymbolReservationId(input.strategyId, input.symbolId, input.eventId)
        const positionId = createStrategySymbolPositionId(input.strategyId, input.symbolId)
        // Keep outcome timestamps stable if Firestore retries the callback.
        const requestedAt = new Date()

        return runTransaction(async (transaction) => {
            const snapshots = await readAllOutcomeSnapshots(transaction, refs)
            if (!snapshots.reservationSnapshot.exists) {
                return {
                    kind: 'REJECT',
                    reason: 'RESERVATION_NOT_FOUND',
                } satisfies ApplyStrategySymbolDispatchOutcomeResult
            }
            if (!snapshots.positionSnapshot.exists) return invalidOutcomeState()

            let reservation: StrategySymbolReservation
            let position: StrategySymbolPosition
            try {
                reservation = parseStoredReservation(snapshots.reservationSnapshot, reservationId)
                position = parseStoredPosition(snapshots.positionSnapshot, positionId)
            } catch {
                return invalidOutcomeState()
            }

            if (input.outcome === 'CONFIRMED_SUCCESS') {
                if (reservation.status === 'DISPATCHED') {
                    return { kind: 'UNCHANGED', reservation, position } satisfies ApplyStrategySymbolDispatchOutcomeResult
                }
                if (reservation.status !== 'RESERVED' && reservation.status !== 'MANUAL_REVIEW') {
                    return {
                        kind: 'REJECT',
                        reason: 'INVALID_TRANSITION',
                    } satisfies ApplyStrategySymbolDispatchOutcomeResult
                }
                if (!isAllowedStrategySymbolReservationTransition(reservation.status, 'DISPATCHED')) {
                    return { kind: 'REJECT', reason: 'INVALID_TRANSITION' } satisfies ApplyStrategySymbolDispatchOutcomeResult
                }
                const updatedReservation: StrategySymbolReservation = {
                    ...reservation,
                    executed_delta: reservation.executed_delta ?? 0,
                    status: 'DISPATCHED',
                    updated_at: safeDateAfter(requestedAt, reservation.updated_at),
                }
                let reservationData: Record<string, unknown>
                try {
                    reservationData = serializeStrategySymbolReservation(updatedReservation)
                } catch {
                    return invalidOutcomeState()
                }
                transaction.set(refs.reservationRef, reservationData)
                return {
                    kind: 'UPDATED',
                    reservation: updatedReservation,
                    position,
                } satisfies ApplyStrategySymbolDispatchOutcomeResult
            }

            if (input.outcome === 'CONFIRMED_FAILURE') {
                if (reservation.status === 'RELEASED') {
                    return { kind: 'UNCHANGED', reservation, position } satisfies ApplyStrategySymbolDispatchOutcomeResult
                }
                if (reservation.status !== 'RESERVED' && reservation.status !== 'MANUAL_REVIEW') {
                    return {
                        kind: 'REJECT',
                        reason: 'INVALID_TRANSITION',
                    } satisfies ApplyStrategySymbolDispatchOutcomeResult
                }
                if (!isAllowedStrategySymbolReservationTransition(reservation.status, 'RELEASED')) {
                    return { kind: 'REJECT', reason: 'INVALID_TRANSITION' } satisfies ApplyStrategySymbolDispatchOutcomeResult
                }
                const pendingDelta = subtractQuantities(position.pending_delta, reservation.reserved_delta)
                if (pendingDelta === null) return invalidOutcomeState()
                const updatedReservation: StrategySymbolReservation = {
                    ...reservation,
                    executed_delta: reservation.executed_delta ?? 0,
                    status: 'RELEASED',
                    updated_at: safeDateAfter(requestedAt, reservation.updated_at),
                }
                const updatedPosition: StrategySymbolPosition = {
                    ...position,
                    pending_delta: pendingDelta,
                    updated_at: safeDateAfter(requestedAt, position.updated_at),
                }
                let reservationData: Record<string, unknown>
                let positionData: Record<string, unknown>
                try {
                    reservationData = serializeStrategySymbolReservation(updatedReservation)
                    positionData = serializeStrategySymbolPosition(updatedPosition)
                } catch {
                    return invalidOutcomeState()
                }
                transaction.set(refs.positionRef, positionData)
                transaction.set(refs.reservationRef, reservationData)
                return {
                    kind: 'UPDATED',
                    reservation: updatedReservation,
                    position: updatedPosition,
                } satisfies ApplyStrategySymbolDispatchOutcomeResult
            }

            if (reservation.status === 'MANUAL_REVIEW') {
                return { kind: 'UNCHANGED', reservation, position } satisfies ApplyStrategySymbolDispatchOutcomeResult
            }
            if (reservation.status !== 'RESERVED' && reservation.status !== 'DISPATCHED') {
                return {
                    kind: 'REJECT',
                    reason: 'INVALID_TRANSITION',
                } satisfies ApplyStrategySymbolDispatchOutcomeResult
            }
            if (!isAllowedStrategySymbolReservationTransition(reservation.status, 'MANUAL_REVIEW')) {
                return { kind: 'REJECT', reason: 'INVALID_TRANSITION' } satisfies ApplyStrategySymbolDispatchOutcomeResult
            }
            const updatedReservation: StrategySymbolReservation = {
                ...reservation,
                executed_delta: reservation.executed_delta ?? 0,
                status: 'MANUAL_REVIEW',
                updated_at: safeDateAfter(requestedAt, reservation.updated_at),
            }
            const updatedPosition: StrategySymbolPosition = {
                ...position,
                status: 'MANUAL_REVIEW',
                updated_at: safeDateAfter(requestedAt, position.updated_at),
            }
            let reservationData: Record<string, unknown>
            let positionData: Record<string, unknown>
            try {
                reservationData = serializeStrategySymbolReservation(updatedReservation)
                positionData = serializeStrategySymbolPosition(updatedPosition)
            } catch {
                return invalidOutcomeState()
            }
            transaction.set(refs.positionRef, positionData)
            transaction.set(refs.reservationRef, reservationData)
            return {
                kind: 'UPDATED',
                reservation: updatedReservation,
                position: updatedPosition,
            } satisfies ApplyStrategySymbolDispatchOutcomeResult
        })
    }
}

/** Create both atomic operations against the supplied Firestore instance. */
export const createStrategySymbolReservationService = (
    db: Firestore = getFirestoreClient(),
    calculate: CalculateOrderSizeFn = calculateOrderSize,
): StrategySymbolReservationService => ({
    reserveStrategySymbolOrder: createReserveFn(db, calculate),
    applyStrategySymbolDispatchOutcome: createOutcomeFn(db),
})

export const createReserveStrategySymbolOrderFn = (
    db: Firestore = getFirestoreClient(),
    calculate: CalculateOrderSizeFn = calculateOrderSize,
): ReserveStrategySymbolOrderFn => createReserveFn(db, calculate)

export const createApplyStrategySymbolDispatchOutcomeFn = (
    db: Firestore = getFirestoreClient(),
    runTransaction: TransactionRunner = (updateFunction) => db.runTransaction(updateFunction),
): ApplyStrategySymbolDispatchOutcomeFn => createOutcomeFn(db, runTransaction)

export const createDefaultReserveStrategySymbolOrderFn = (): ReserveStrategySymbolOrderFn => (
    createReserveStrategySymbolOrderFn(getFirestoreClient())
)

export const createDefaultApplyStrategySymbolDispatchOutcomeFn = (): ApplyStrategySymbolDispatchOutcomeFn => (
    createApplyStrategySymbolDispatchOutcomeFn(getFirestoreClient())
)
