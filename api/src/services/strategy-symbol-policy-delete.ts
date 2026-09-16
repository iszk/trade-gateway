import { randomUUID } from 'node:crypto'
import type { Firestore, Transaction } from 'firebase-admin/firestore'

import { getFirestoreClient } from '../firestore.js'
import { defaultLogger, type Logger } from '../logger.js'
import type { StrategySymbolPosition } from '../types/strategy-symbol-position.js'
import {
    createStrategySymbolPolicyId,
    isValidStrategyId,
} from './strategy-symbol-policies.js'
import {
    createStrategySymbolPositionId,
    deserializeStrategySymbolPosition,
} from './strategy-symbol-positions.js'
import { parseSymbolId } from './tradable-symbols.js'

const SYMBOLS_COLLECTION = 'tradable_symbols'
const POLICIES_COLLECTION = 'strategy_symbol_policies'
const POSITIONS_COLLECTION = 'strategy_symbol_positions'

type RawRecord = Record<string, unknown>

type SnapshotLike = {
    id: string
    exists: boolean
    data: () => unknown
}

export type DeleteStrategySymbolPolicyInput = {
    strategyId: string
    symbolId: string
    confirmTarget: string
    requestId?: string
}

export type DeletedPositionSummary = Pick<
    StrategySymbolPosition,
    'confirmed_position' | 'pending_delta' | 'status' | 'policy_version'
>

export type DeleteStrategySymbolPolicyResult = {
    strategy_id: string
    symbol_id: string
    policy_deleted: boolean
    position_deleted: boolean
    symbol_status: 'paused'
    position?: DeletedPositionSummary
}

export type DeleteStrategySymbolPolicyFn = (
    input: DeleteStrategySymbolPolicyInput,
) => Promise<DeleteStrategySymbolPolicyResult>

export type StrategySymbolPolicyDeleteServiceOptions = {
    db?: Firestore
    now?: () => Date
    logger?: Logger
}

export class InvalidStrategySymbolPolicyDeleteInputError extends Error {
    readonly code = 'INVALID_REQUEST'

    constructor(message: string) {
        super(message)
        this.name = 'InvalidStrategySymbolPolicyDeleteInputError'
    }
}

export class StrategySymbolPolicyDeleteTargetConfirmationError extends Error {
    readonly code = 'TARGET_CONFIRMATION_REQUIRED'

    constructor(message: string) {
        super(message)
        this.name = 'StrategySymbolPolicyDeleteTargetConfirmationError'
    }
}

export class StrategySymbolPolicyDeleteSymbolNotFoundError extends Error {
    readonly code = 'SYMBOL_NOT_FOUND'

    constructor(symbolId: string) {
        super(`symbol is not found: ${symbolId}`)
        this.name = 'StrategySymbolPolicyDeleteSymbolNotFoundError'
    }
}

export class StrategySymbolPolicyDeleteNotFoundError extends Error {
    readonly code = 'POLICY_NOT_FOUND'

    constructor(strategyId: string, symbolId: string) {
        super(`strategy-symbol policy and position are not found: ${strategyId}:${symbolId}`)
        this.name = 'StrategySymbolPolicyDeleteNotFoundError'
    }
}

export class InvalidStoredStrategySymbolPolicyDeleteSymbolError extends Error {
    readonly code = 'INVALID_STORED_SYMBOL'

    constructor(message: string) {
        super(message)
        this.name = 'InvalidStoredStrategySymbolPolicyDeleteSymbolError'
    }
}

type TransactionLike = Pick<Transaction, 'get' | 'update' | 'delete'>

const isRecord = (value: unknown): value is RawRecord => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
)

const validDate = (value: unknown): value is Date => (
    value instanceof Date && Number.isFinite(value.getTime())
)

const toDate = (value: unknown): Date | undefined => {
    if (validDate(value)) return new Date(value.getTime())
    if (isRecord(value) && typeof value.toDate === 'function') {
        try {
            const date = value.toDate()
            return validDate(date) ? new Date(date.getTime()) : undefined
        } catch {
            return undefined
        }
    }
    return undefined
}

const assertInput = (input: DeleteStrategySymbolPolicyInput): void => {
    if (!isRecord(input)) throw new InvalidStrategySymbolPolicyDeleteInputError('input is invalid')
    if (!isValidStrategyId(input.strategyId)) {
        throw new InvalidStrategySymbolPolicyDeleteInputError('strategy_id is invalid')
    }
    if (typeof input.symbolId !== 'string' || parseSymbolId(input.symbolId) === null) {
        throw new InvalidStrategySymbolPolicyDeleteInputError('symbol_id is invalid')
    }
    if (typeof input.confirmTarget !== 'string' || input.confirmTarget.length === 0) {
        throw new StrategySymbolPolicyDeleteTargetConfirmationError('target confirmation is required')
    }
    const expectedTarget = `${input.strategyId}:${input.symbolId}`
    if (input.confirmTarget !== expectedTarget) {
        throw new StrategySymbolPolicyDeleteTargetConfirmationError('target confirmation does not match the target')
    }
}

const readSymbolForDelete = (
    snapshot: SnapshotLike,
    symbolId: string,
): RawRecord => {
    if (!snapshot.exists) throw new StrategySymbolPolicyDeleteSymbolNotFoundError(symbolId)
    const data = snapshot.data()
    if (!isRecord(data) || snapshot.id !== symbolId || data.id !== symbolId) {
        throw new InvalidStoredStrategySymbolPolicyDeleteSymbolError('symbol document identity is invalid')
    }
    if (!isRecord(data.trade_control) ||
        (data.trade_control.status !== 'active' && data.trade_control.status !== 'paused')) {
        throw new InvalidStoredStrategySymbolPolicyDeleteSymbolError('symbol trade control is invalid')
    }
    return data
}

const positionSummary = (
    snapshot: SnapshotLike,
    positionId: string,
): DeletedPositionSummary | undefined => {
    if (!snapshot.exists) return undefined
    try {
        const position = deserializeStrategySymbolPosition(snapshot.data(), positionId)
        return {
            confirmed_position: position.confirmed_position,
            pending_delta: position.pending_delta,
            status: position.status,
            policy_version: position.policy_version,
        }
    } catch {
        // Force deletion is intentionally path based. A malformed position is
        // deleted, but no quantity/status is guessed for the response.
        return undefined
    }
}

const createService = (
    options: StrategySymbolPolicyDeleteServiceOptions,
): DeleteStrategySymbolPolicyFn => {
    const db = options.db ?? getFirestoreClient()
    const now = options.now ?? (() => new Date())
    const logger = options.logger ?? defaultLogger

    return async (input) => {
        const requestId = input?.requestId || randomUUID()
        let policyExists = false
        let positionExists = false
        let symbolStatus: 'active' | 'paused' | 'unknown' = 'unknown'

        const logFailure = (error: unknown): void => {
            logger.warn({
                event: 'strategy_symbol_policy:force_delete_failed',
                request_id: requestId,
                strategy_id: input?.strategyId,
                symbol_id: input?.symbolId,
                policy_exists: policyExists,
                position_exists: positionExists,
                symbol_status: symbolStatus,
                reason: error instanceof Error ? error.name : 'UNKNOWN_ERROR',
            }, 'failed to force-delete strategy-symbol policy')
        }

        try {
            assertInput(input)
        } catch (error) {
            logFailure(error)
            throw error
        }

        const policyId = createStrategySymbolPolicyId(input.strategyId, input.symbolId)
        const positionId = createStrategySymbolPositionId(input.strategyId, input.symbolId)
        const symbolRef = db.collection(SYMBOLS_COLLECTION).doc(input.symbolId)
        const policyRef = db.collection(POLICIES_COLLECTION).doc(policyId)
        const positionRef = db.collection(POSITIONS_COLLECTION).doc(positionId)

        try {
            const result = await db.runTransaction(async (rawTransaction) => {
                const transaction = rawTransaction as TransactionLike
                // Firestore requires all reads to happen before writes. This
                // also makes symbol pause and ledger deletion one atomic unit.
                const symbolSnapshot = await transaction.get(symbolRef) as unknown as SnapshotLike
                const policySnapshot = await transaction.get(policyRef) as unknown as SnapshotLike
                const positionSnapshot = await transaction.get(positionRef) as unknown as SnapshotLike
                policyExists = policySnapshot.exists
                positionExists = positionSnapshot.exists
                const symbol = readSymbolForDelete(symbolSnapshot, input.symbolId)
                symbolStatus = (symbol.trade_control as RawRecord).status as 'active' | 'paused'

                if (!policyExists && !positionExists) {
                    throw new StrategySymbolPolicyDeleteNotFoundError(input.strategyId, input.symbolId)
                }

                const currentTradeControl = symbol.trade_control as RawRecord
                const timestamp = toDate(now()) ?? new Date()
                const updatedTradeControl: RawRecord = {
                    ...currentTradeControl,
                    status: 'paused',
                    reason: 'strategy-symbol policy force deletion',
                    updated_at: timestamp,
                    updated_by: 'policy-delete',
                }
                transaction.update(symbolRef, {
                    trade_control: updatedTradeControl,
                    updated_at: timestamp,
                })
                if (policyExists) transaction.delete(policyRef)
                if (positionExists) transaction.delete(positionRef)

                const summary = positionSummary(positionSnapshot, positionId)

                return {
                    strategy_id: input.strategyId,
                    symbol_id: input.symbolId,
                    policy_deleted: policyExists,
                    position_deleted: positionExists,
                    symbol_status: 'paused' as const,
                    ...(summary === undefined ? {} : { position: summary }),
                } satisfies DeleteStrategySymbolPolicyResult
            })

            logger.warn({
                event: 'strategy_symbol_policy:force_deleted',
                request_id: requestId,
                strategy_id: input.strategyId,
                symbol_id: input.symbolId,
                policy_exists: policyExists,
                position_exists: positionExists,
                symbol_status: result.symbol_status,
            }, 'force-deleted strategy-symbol policy and virtual position')
            return result
        } catch (error) {
            logFailure(error)
            throw error
        }
    }
}

export const createDeleteStrategySymbolPolicyFn = (
    options: StrategySymbolPolicyDeleteServiceOptions = {},
): DeleteStrategySymbolPolicyFn => createService(options)

export const createDefaultDeleteStrategySymbolPolicyFn = (): DeleteStrategySymbolPolicyFn => (
    createDeleteStrategySymbolPolicyFn({ db: getFirestoreClient() })
)
