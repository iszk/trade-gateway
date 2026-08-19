import type { Firestore } from 'firebase-admin/firestore'

import { getFirestoreClient, setFirestoreDocument } from '../firestore.js'
import { createStrategySymbolPolicyId } from './strategy-symbol-policies.js'
import type {
    StrategySymbolPosition,
    StrategySymbolPositionStatus,
} from '../types/strategy-symbol-position.js'

const STRATEGY_SYMBOL_POSITIONS_COLLECTION = 'strategy_symbol_positions'

const POSITION_FIELDS = [
    'id',
    'strategy_id',
    'symbol_id',
    'confirmed_position',
    'pending_delta',
    'status',
    'policy_version',
    'updated_at',
    'reconciled_at',
] as const

const POSITION_STATUSES = new Set<StrategySymbolPositionStatus>([
    'READY',
    'MANUAL_REVIEW',
    'MISMATCH',
])

export class InvalidStrategySymbolPositionError extends Error {
    readonly code = 'INVALID_POSITION'

    constructor(message: string) {
        super(message)
        this.name = 'InvalidStrategySymbolPositionError'
    }
}

/** A position document exists but does not satisfy its persisted schema. */
export class InvalidStoredStrategySymbolPositionError extends Error {
    readonly code = 'INVALID_STORED_POSITION'

    constructor(message: string) {
        super(message)
        this.name = 'InvalidStoredStrategySymbolPositionError'
    }
}

export type GetStrategySymbolPositionFn = (
    strategyId: string,
    symbolId: string,
) => Promise<StrategySymbolPosition | null>

export type SetStrategySymbolPositionFn = (position: StrategySymbolPosition) => Promise<void>

type PositionFirestoreData = Record<string, unknown>

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isFiniteNumber = (value: unknown): value is number => (
    typeof value === 'number' && Number.isFinite(value)
)

const isPositiveSafeInteger = (value: unknown): value is number => (
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
)

const canonicalizeNumber = (value: number): number => value === 0 ? 0 : value

const hasExactlyPositionFields = (value: Record<string, unknown>): boolean => {
    const fields = new Set(POSITION_FIELDS)
    return Object.keys(value).length === POSITION_FIELDS.length && Object.keys(value).every((key) => fields.has(key as typeof POSITION_FIELDS[number]))
}

const cloneDate = (
    value: unknown,
    fieldName: string,
    ErrorType: typeof InvalidStrategySymbolPositionError | typeof InvalidStoredStrategySymbolPositionError,
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
    ErrorType: typeof InvalidStrategySymbolPositionError | typeof InvalidStoredStrategySymbolPositionError,
): string => {
    if (typeof strategyId !== 'string' || typeof symbolId !== 'string') {
        throw new ErrorType('position identity is invalid')
    }
    try {
        return createStrategySymbolPolicyId(strategyId, symbolId)
    } catch {
        throw new ErrorType('position identity is invalid')
    }
}

const normalizePosition = (
    value: unknown,
    ErrorType: typeof InvalidStrategySymbolPositionError | typeof InvalidStoredStrategySymbolPositionError,
    expectedDocumentId?: string,
): StrategySymbolPosition => {
    if (!isRecord(value)) {
        throw new ErrorType('position document is not an object')
    }
    if (!hasExactlyPositionFields(value)) {
        throw new ErrorType('position document has missing or unexpected fields')
    }

    const id = value.id
    const strategyId = value.strategy_id
    const symbolId = value.symbol_id
    const derivedId = createPositionIdOrThrow(strategyId, symbolId, ErrorType)
    if (typeof id !== 'string' || id !== derivedId || (expectedDocumentId !== undefined && id !== expectedDocumentId)) {
        throw new ErrorType('position document identity does not match its document path')
    }

    if (!isFiniteNumber(value.confirmed_position)) {
        throw new ErrorType('confirmed_position is invalid')
    }
    if (!isFiniteNumber(value.pending_delta)) {
        throw new ErrorType('pending_delta is invalid')
    }
    if (!POSITION_STATUSES.has(value.status as StrategySymbolPositionStatus)) {
        throw new ErrorType('position status is invalid')
    }
    if (!isPositiveSafeInteger(value.policy_version)) {
        throw new ErrorType('policy_version is invalid')
    }

    const updatedAt = cloneDate(value.updated_at, 'updated_at', ErrorType)
    const reconciledAt = value.reconciled_at === null
        ? null
        : cloneDate(value.reconciled_at, 'reconciled_at', ErrorType)
    if (reconciledAt !== null && reconciledAt.getTime() > updatedAt.getTime()) {
        throw new ErrorType('reconciled_at must not be after updated_at')
    }

    return {
        id: derivedId,
        strategy_id: strategyId as string,
        symbol_id: symbolId as string,
        confirmed_position: canonicalizeNumber(value.confirmed_position),
        pending_delta: canonicalizeNumber(value.pending_delta),
        status: value.status as StrategySymbolPositionStatus,
        policy_version: value.policy_version,
        updated_at: updatedAt,
        reconciled_at: reconciledAt,
    }
}

/** Create the position document ID shared with strategy-symbol policies. */
export const createStrategySymbolPositionId = (strategyId: string, symbolId: string): string => {
    try {
        return createStrategySymbolPolicyId(strategyId, symbolId)
    } catch {
        throw new InvalidStrategySymbolPositionError('position identity is invalid')
    }
}

/** Validate and serialize a domain position without sharing mutable Date instances. */
export const serializeStrategySymbolPosition = (position: StrategySymbolPosition): PositionFirestoreData => (
    normalizePosition(position, InvalidStrategySymbolPositionError)
)

/** Validate and normalize a Firestore position document into the domain model. */
export const deserializeStrategySymbolPosition = (
    value: unknown,
    expectedDocumentId?: string,
): StrategySymbolPosition => normalizePosition(value, InvalidStoredStrategySymbolPositionError, expectedDocumentId)

const getSnapshotId = (snapshot: unknown): string | undefined => (
    isRecord(snapshot) && typeof snapshot.id === 'string' ? snapshot.id : undefined
)

const getSnapshotData = (snapshot: unknown): unknown => (
    isRecord(snapshot) && typeof snapshot.data === 'function' ? snapshot.data() : undefined
)

export const createGetStrategySymbolPositionFn = (
    db: Firestore = getFirestoreClient(),
): GetStrategySymbolPositionFn => {
    return async (strategyId, symbolId) => {
        const positionId = createStrategySymbolPositionId(strategyId, symbolId)
        const snapshot = await db.collection(STRATEGY_SYMBOL_POSITIONS_COLLECTION).doc(positionId).get()
        if (!snapshot.exists) return null

        if (getSnapshotId(snapshot) !== positionId) {
            throw new InvalidStoredStrategySymbolPositionError('position document ID does not match its requested path')
        }
        return deserializeStrategySymbolPosition(getSnapshotData(snapshot), positionId)
    }
}

export const createSetStrategySymbolPositionFn = (
    db: Firestore = getFirestoreClient(),
): SetStrategySymbolPositionFn => {
    return async (position) => {
        const firestoreData = serializeStrategySymbolPosition(position)
        const docRef = db.collection(STRATEGY_SYMBOL_POSITIONS_COLLECTION).doc(position.id)
        await setFirestoreDocument(docRef, firestoreData, {
            collection: STRATEGY_SYMBOL_POSITIONS_COLLECTION,
            docId: position.id,
        })
    }
}
