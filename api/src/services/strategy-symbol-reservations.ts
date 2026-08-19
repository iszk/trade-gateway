import { createHash } from 'node:crypto'
import type { Firestore } from 'firebase-admin/firestore'

import { getFirestoreClient, setFirestoreDocument } from '../firestore.js'
import type {
    StrategySymbolReservation,
    StrategySymbolReservationStatus,
} from '../types/strategy-symbol-reservation.js'
import { createStrategySymbolPositionId } from './strategy-symbol-positions.js'

const STRATEGY_SYMBOL_RESERVATIONS_COLLECTION = 'strategy_symbol_reservations'

const RESERVATION_FIELDS = [
    'id',
    'event_id',
    'position_id',
    'strategy_id',
    'symbol_id',
    'order_id',
    'reserved_delta',
    'status',
    'policy_version',
    'created_at',
    'updated_at',
] as const

const RESERVATION_STATUSES = new Set<StrategySymbolReservationStatus>([
    'RESERVED',
    'DISPATCHED',
    'RELEASED',
    'MANUAL_REVIEW',
    'SETTLED',
])

const ALLOWED_RESERVATION_TRANSITIONS: Record<
    StrategySymbolReservationStatus,
    readonly StrategySymbolReservationStatus[]
> = {
    RESERVED: ['RESERVED', 'DISPATCHED', 'RELEASED', 'MANUAL_REVIEW'],
    DISPATCHED: ['DISPATCHED', 'SETTLED', 'MANUAL_REVIEW'],
    RELEASED: ['RELEASED'],
    MANUAL_REVIEW: ['MANUAL_REVIEW', 'DISPATCHED', 'RELEASED', 'SETTLED'],
    SETTLED: ['SETTLED'],
}

export class InvalidStrategySymbolReservationError extends Error {
    readonly code = 'INVALID_RESERVATION'

    constructor(message: string) {
        super(message)
        this.name = 'InvalidStrategySymbolReservationError'
    }
}

/** A reservation document exists but does not satisfy its persisted schema. */
export class InvalidStoredStrategySymbolReservationError extends Error {
    readonly code = 'INVALID_STORED_RESERVATION'

    constructor(message: string) {
        super(message)
        this.name = 'InvalidStoredStrategySymbolReservationError'
    }
}

export type GetStrategySymbolReservationFn = (
    strategyId: string,
    symbolId: string,
    eventId: string,
) => Promise<StrategySymbolReservation | null>

export type SetStrategySymbolReservationFn = (reservation: StrategySymbolReservation) => Promise<void>

type ReservationFirestoreData = Record<string, unknown>

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isFiniteNumber = (value: unknown): value is number => (
    typeof value === 'number' && Number.isFinite(value)
)

const isPositiveSafeInteger = (value: unknown): value is number => (
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
)

const isNonEmptyString = (value: unknown): value is string => (
    typeof value === 'string' && value.trim().length > 0
)

const hasExactlyReservationFields = (value: Record<string, unknown>): boolean => {
    const fields = new Set(RESERVATION_FIELDS)
    return Object.keys(value).length === RESERVATION_FIELDS.length && Object.keys(value).every((key) => fields.has(key as typeof RESERVATION_FIELDS[number]))
}

const cloneDate = (
    value: unknown,
    fieldName: string,
    ErrorType: typeof InvalidStrategySymbolReservationError | typeof InvalidStoredStrategySymbolReservationError,
): Date => {
    try {
        if (value instanceof Date) {
            const time = value.getTime()
            if (Number.isFinite(time)) return new Date(time)
        } else if (isRecord(value) && typeof value.toDate === 'function') {
            const date = value.toDate()
            if (date instanceof Date && Number.isFinite(date.getTime())) {
                return new Date(date.getTime())
            }
        }
    } catch {
        // A malformed Timestamp-like object must not be accepted or normalized.
    }
    throw new ErrorType(`${fieldName} is invalid`)
}

const createPositionIdOrThrow = (
    strategyId: unknown,
    symbolId: unknown,
    ErrorType: typeof InvalidStrategySymbolReservationError | typeof InvalidStoredStrategySymbolReservationError,
): string => {
    if (typeof strategyId !== 'string' || typeof symbolId !== 'string') {
        throw new ErrorType('reservation identity is invalid')
    }
    try {
        return createStrategySymbolPositionId(strategyId, symbolId)
    } catch {
        throw new ErrorType('reservation identity is invalid')
    }
}

const encodeTuplePart = (value: string): string => `${Buffer.byteLength(value, 'utf8')}:${value}`

/**
 * Encode strategy, symbol, and event as a length-delimited UTF-8 tuple.
 * Lengths are byte lengths so Unicode event IDs remain unambiguous.
 */
const encodeStrategySymbolReservationTuple = (
    strategyId: string,
    symbolId: string,
    eventId: string,
): string => [strategyId, symbolId, eventId].map(encodeTuplePart).join('|')

/** Create a Firestore-safe, deterministic reservation document ID. */
export const createStrategySymbolReservationId = (
    strategyId: string,
    symbolId: string,
    eventId: string,
): string => {
    try {
        createStrategySymbolPositionId(strategyId, symbolId)
    } catch {
        throw new InvalidStrategySymbolReservationError('reservation identity is invalid')
    }
    if (!isNonEmptyString(eventId)) {
        throw new InvalidStrategySymbolReservationError('event_id is invalid')
    }
    const tuple = encodeStrategySymbolReservationTuple(strategyId, symbolId, eventId)
    return `r_${createHash('sha256').update(tuple, 'utf8').digest('hex')}`
}

const normalizeReservation = (
    value: unknown,
    ErrorType: typeof InvalidStrategySymbolReservationError | typeof InvalidStoredStrategySymbolReservationError,
    expectedDocumentId?: string,
): StrategySymbolReservation => {
    if (!isRecord(value)) {
        throw new ErrorType('reservation document is not an object')
    }
    if (!hasExactlyReservationFields(value)) {
        throw new ErrorType('reservation document has missing or unexpected fields')
    }

    const eventId = value.event_id
    const strategyId = value.strategy_id
    const symbolId = value.symbol_id
    if (!isNonEmptyString(eventId)) {
        throw new ErrorType('event_id is invalid')
    }
    const positionId = createPositionIdOrThrow(strategyId, symbolId, ErrorType)
    const reservationId = (() => {
        try {
            return createStrategySymbolReservationId(strategyId as string, symbolId as string, eventId)
        } catch {
            throw new ErrorType('reservation identity is invalid')
        }
    })()
    if (
        typeof value.id !== 'string' ||
        value.id !== reservationId ||
        (expectedDocumentId !== undefined && value.id !== expectedDocumentId)
    ) {
        throw new ErrorType('reservation document ID does not match its identity')
    }
    if (typeof value.position_id !== 'string' || value.position_id !== positionId) {
        throw new ErrorType('reservation position_id does not match its strategy and symbol')
    }
    if (!isNonEmptyString(value.order_id)) {
        throw new ErrorType('order_id is invalid')
    }
    if (!isFiniteNumber(value.reserved_delta) || value.reserved_delta === 0) {
        throw new ErrorType('reserved_delta must be a finite non-zero number')
    }
    if (!RESERVATION_STATUSES.has(value.status as StrategySymbolReservationStatus)) {
        throw new ErrorType('reservation status is invalid')
    }
    if (!isPositiveSafeInteger(value.policy_version)) {
        throw new ErrorType('policy_version is invalid')
    }

    const createdAt = cloneDate(value.created_at, 'created_at', ErrorType)
    const updatedAt = cloneDate(value.updated_at, 'updated_at', ErrorType)
    if (updatedAt.getTime() < createdAt.getTime()) {
        throw new ErrorType('updated_at must not be before created_at')
    }

    return {
        id: reservationId,
        event_id: eventId,
        position_id: positionId,
        strategy_id: strategyId as string,
        symbol_id: symbolId as string,
        order_id: value.order_id,
        reserved_delta: value.reserved_delta === 0 ? 0 : value.reserved_delta,
        status: value.status as StrategySymbolReservationStatus,
        policy_version: value.policy_version,
        created_at: createdAt,
        updated_at: updatedAt,
    }
}

/** Validate and serialize a domain reservation without sharing mutable Date instances. */
export const serializeStrategySymbolReservation = (
    reservation: StrategySymbolReservation,
): ReservationFirestoreData => normalizeReservation(reservation, InvalidStrategySymbolReservationError)

/** Validate and normalize a Firestore reservation document into the domain model. */
export const deserializeStrategySymbolReservation = (
    value: unknown,
    expectedDocumentId?: string,
): StrategySymbolReservation => normalizeReservation(
    value,
    InvalidStoredStrategySymbolReservationError,
    expectedDocumentId,
)

/** Return whether a reservation state transition is permitted by the lifecycle contract. */
export const isAllowedStrategySymbolReservationTransition = (
    from: StrategySymbolReservationStatus,
    to: StrategySymbolReservationStatus,
): boolean => {
    if (!RESERVATION_STATUSES.has(from) || !RESERVATION_STATUSES.has(to)) return false
    return ALLOWED_RESERVATION_TRANSITIONS[from].includes(to)
}

const getSnapshotId = (snapshot: unknown): string | undefined => (
    isRecord(snapshot) && typeof snapshot.id === 'string' ? snapshot.id : undefined
)

const getSnapshotData = (snapshot: unknown): unknown => (
    isRecord(snapshot) && typeof snapshot.data === 'function' ? snapshot.data() : undefined
)

export const createGetStrategySymbolReservationFn = (
    db: Firestore = getFirestoreClient(),
): GetStrategySymbolReservationFn => {
    return async (strategyId, symbolId, eventId) => {
        const reservationId = createStrategySymbolReservationId(strategyId, symbolId, eventId)
        const snapshot = await db.collection(STRATEGY_SYMBOL_RESERVATIONS_COLLECTION).doc(reservationId).get()
        if (!snapshot.exists) return null

        if (getSnapshotId(snapshot) !== reservationId) {
            throw new InvalidStoredStrategySymbolReservationError('reservation document ID does not match its requested path')
        }
        return deserializeStrategySymbolReservation(getSnapshotData(snapshot), reservationId)
    }
}

export const createSetStrategySymbolReservationFn = (
    db: Firestore = getFirestoreClient(),
): SetStrategySymbolReservationFn => {
    return async (reservation) => {
        const firestoreData = serializeStrategySymbolReservation(reservation)
        const docRef = db.collection(STRATEGY_SYMBOL_RESERVATIONS_COLLECTION).doc(reservation.id)
        await setFirestoreDocument(docRef, firestoreData, {
            collection: STRATEGY_SYMBOL_RESERVATIONS_COLLECTION,
            docId: reservation.id,
        })
    }
}
