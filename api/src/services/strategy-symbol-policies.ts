import type { Firestore } from 'firebase-admin/firestore'

import { getFirestoreClient } from '../firestore.js'
import { omitUndefinedFields } from '../omit-undefined-fields.js'
import { parseSymbolId } from './tradable-symbols.js'
import type {
    ManagedStrategySymbolPolicy,
    StrategySymbolPolicy,
    StrategySymbolPolicyInput,
    WebhookCappedStrategySymbolPolicy,
} from '../types/strategy-symbol-policy.js'

const COLLECTION_NAME = 'strategy_symbol_policies'
const SYMBOL_COLLECTION_NAME = 'tradable_symbols'
const STRATEGY_ID_PATTERN = /^[A-Za-z0-9_-]+$/
// 計算由来の ulp 誤差だけを許容し、入力値を丸めて不整合を通さない。
const STEP_ULP_FACTOR = 2
const STEP_RELATIVE_TOLERANCE = Number.EPSILON * 1000

type OrderConstraints = {
    quantity_step: number
    min_order_size: number
    max_order_size?: number
}

export class InvalidStrategySymbolPolicyError extends Error {
    readonly code = 'INVALID_POLICY'

    constructor(message: string) {
        super(message)
        this.name = 'InvalidStrategySymbolPolicyError'
    }
}

export class SymbolNotFoundError extends Error {
    readonly code = 'SYMBOL_NOT_FOUND'

    constructor(symbolId: string) {
        super(`symbol is not found: ${symbolId}`)
        this.name = 'SymbolNotFoundError'
    }
}

export class SymbolConstraintsRequiredError extends Error {
    readonly code = 'SYMBOL_CONSTRAINTS_REQUIRED'

    constructor(symbolId: string) {
        super(`symbol order constraints are required: ${symbolId}`)
        this.name = 'SymbolConstraintsRequiredError'
    }
}

/** A policy document was present but did not satisfy the persisted contract. */
export class InvalidStoredStrategySymbolPolicyError extends Error {
    readonly code = 'INVALID_STORED_POLICY'

    constructor(message: string) {
        super(message)
        this.name = 'InvalidStoredStrategySymbolPolicyError'
    }
}

/** A symbol document has an order_constraints map, but the map itself is malformed. */
class InvalidStoredSymbolConstraintsError extends Error {
    readonly code = 'INVALID_STORED_SYMBOL_CONSTRAINTS'

    constructor(message: string) {
        super(message)
        this.name = 'InvalidStoredSymbolConstraintsError'
    }
}

export type GetStrategySymbolPolicyFn = (
    strategyId: string,
    symbolId: string,
) => Promise<StrategySymbolPolicy | null>

export type PutStrategySymbolPolicyFn = (
    input: StrategySymbolPolicyInput,
) => Promise<StrategySymbolPolicy>

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isFinitePositiveNumber = (value: unknown): value is number => (
    typeof value === 'number' && Number.isFinite(value) && value > 0
)

const isFiniteNumber = (value: unknown): value is number => (
    typeof value === 'number' && Number.isFinite(value)
)

export const isValidStrategyId = (value: unknown): value is string => (
    typeof value === 'string' && value.length > 0 && value === value.trim() && STRATEGY_ID_PATTERN.test(value)
)

const isValidPolicySymbolId = (value: unknown): value is string => (
    typeof value === 'string' && parseSymbolId(value) !== null
)

export const createStrategySymbolPolicyId = (strategyId: string, symbolId: string): string => {
    if (!isValidStrategyId(strategyId)) {
        throw new InvalidStrategySymbolPolicyError('strategy_id is invalid')
    }
    if (!isValidPolicySymbolId(symbolId)) {
        throw new InvalidStrategySymbolPolicyError('symbol_id is invalid')
    }
    return `${strategyId}:${symbolId}`
}

const toDate = (value: unknown): Date | null => {
    try {
        if (value instanceof Date) {
            return Number.isNaN(value.getTime()) ? null : value
        }
        if (isRecord(value) && 'toDate' in value && typeof value.toDate === 'function') {
            const date = value.toDate()
            return date instanceof Date && !Number.isNaN(date.getTime()) ? date : null
        }
    } catch {
        return null
    }
    return null
}

const assertStepMultiple = (value: number, step: number, fieldName: string): void => {
    const quotient = value / step
    const nearestInteger = Math.round(quotient)
    // 整数倍を安全に表現できない範囲では、近似判定で誤った注文数量を通さない。
    if (!Number.isSafeInteger(nearestInteger)) {
        throw new InvalidStrategySymbolPolicyError(`${fieldName} must be a multiple of quantity_step`)
    }

    const nearestMultiple = nearestInteger * step
    if (!Number.isFinite(nearestMultiple)) {
        throw new InvalidStrategySymbolPolicyError(`${fieldName} must be a multiple of quantity_step`)
    }

    const tolerance = Math.min(
        STEP_ULP_FACTOR * Number.EPSILON * Math.max(1, Math.abs(value), Math.abs(nearestMultiple)),
        step * STEP_RELATIVE_TOLERANCE,
    )
    // step の半分以上が誤差幅に入る場合は、倍数かどうかを安全に識別できない。
    if (tolerance >= step / 2 || Math.abs(value - nearestMultiple) > tolerance) {
        throw new InvalidStrategySymbolPolicyError(`${fieldName} must be a multiple of quantity_step`)
    }
}

const assertValidOrderConstraints = (value: unknown, symbolId: string): OrderConstraints => {
    if (!isRecord(value)) {
        throw new InvalidStoredSymbolConstraintsError(`symbol order constraints are invalid: ${symbolId}`)
    }

    if (!isFinitePositiveNumber(value.quantity_step)) {
        throw new InvalidStoredSymbolConstraintsError('symbol order constraints quantity_step is invalid')
    }
    if (!isFinitePositiveNumber(value.min_order_size)) {
        throw new InvalidStoredSymbolConstraintsError('symbol order constraints min_order_size is invalid')
    }
    if (value.max_order_size !== undefined && (
        !isFinitePositiveNumber(value.max_order_size) || value.max_order_size < value.min_order_size
    )) {
        throw new InvalidStoredSymbolConstraintsError('symbol order constraints max_order_size is invalid')
    }

    return {
        quantity_step: value.quantity_step,
        min_order_size: value.min_order_size,
        ...(value.max_order_size === undefined ? {} : { max_order_size: value.max_order_size }),
    }
}

const assertValidPolicyInput = (input: StrategySymbolPolicyInput): void => {
    if (!isRecord(input)) {
        throw new InvalidStrategySymbolPolicyError('policy input must be an object')
    }

    if (!isValidStrategyId(input.strategy_id)) {
        throw new InvalidStrategySymbolPolicyError('strategy_id is invalid')
    }
    if (!isValidPolicySymbolId(input.symbol_id)) {
        throw new InvalidStrategySymbolPolicyError('symbol_id is invalid')
    }
    if (typeof input.enabled !== 'boolean') {
        throw new InvalidStrategySymbolPolicyError('enabled is invalid')
    }
    if (typeof input.no_flip !== 'boolean') {
        throw new InvalidStrategySymbolPolicyError('no_flip is invalid')
    }
    if (!isFinitePositiveNumber(input.max_abs_position)) {
        throw new InvalidStrategySymbolPolicyError('max_abs_position must be a finite positive number')
    }
    if (input.sizing_mode !== 'WEBHOOK_CAPPED' && input.sizing_mode !== 'MANAGED') {
        throw new InvalidStrategySymbolPolicyError('sizing_mode is invalid')
    }

    const allowedKeys = input.sizing_mode === 'WEBHOOK_CAPPED'
        ? new Set(['strategy_id', 'symbol_id', 'sizing_mode', 'enabled', 'max_abs_position', 'no_flip'])
        : new Set([
            'strategy_id',
            'symbol_id',
            'sizing_mode',
            'enabled',
            'max_abs_position',
            'no_flip',
            'base_order_size',
            'taper_strength',
        ])
    const unexpectedKey = Object.keys(input).find((key) => !allowedKeys.has(key))
    if (unexpectedKey) {
        throw new InvalidStrategySymbolPolicyError(`${unexpectedKey} is not allowed`)
    }

    if (input.sizing_mode === 'MANAGED') {
        if (!isFinitePositiveNumber(input.base_order_size)) {
            throw new InvalidStrategySymbolPolicyError('base_order_size must be a finite positive number')
        }
        if (!isFiniteNumber(input.taper_strength) || input.taper_strength < 0 || input.taper_strength > 1) {
            throw new InvalidStrategySymbolPolicyError('taper_strength must be between 0 and 1')
        }
    }
}

export const validateStrategySymbolPolicyInput = (
    input: StrategySymbolPolicyInput,
    constraints: OrderConstraints,
): void => {
    assertValidPolicyInput(input)

    if (input.symbol_id.length === 0) {
        throw new InvalidStrategySymbolPolicyError('symbol_id is invalid')
    }
    if (input.max_abs_position < constraints.min_order_size) {
        throw new InvalidStrategySymbolPolicyError('max_abs_position must be at least min_order_size')
    }
    assertStepMultiple(input.max_abs_position, constraints.quantity_step, 'max_abs_position')

    if (input.sizing_mode === 'MANAGED') {
        if (input.base_order_size < constraints.min_order_size) {
            throw new InvalidStrategySymbolPolicyError('base_order_size must be at least min_order_size')
        }
        if (input.base_order_size > input.max_abs_position) {
            throw new InvalidStrategySymbolPolicyError('base_order_size must not exceed max_abs_position')
        }
        assertStepMultiple(input.base_order_size, constraints.quantity_step, 'base_order_size')
        if (constraints.max_order_size !== undefined && input.base_order_size > constraints.max_order_size) {
            throw new InvalidStrategySymbolPolicyError('base_order_size must not exceed max_order_size')
        }
    }
}

const assertDateField = (record: Record<string, unknown>, fieldName: string): Date => {
    const date = toDate(record[fieldName])
    if (!date) {
        throw new InvalidStoredStrategySymbolPolicyError(`${fieldName} is invalid`)
    }
    return date
}

const assertStoredPolicy = (
    value: unknown,
    expectedId: string,
    expectedStrategyId: string,
    expectedSymbolId: string,
): StrategySymbolPolicy => {
    if (!isRecord(value)) {
        throw new InvalidStoredStrategySymbolPolicyError('policy document is not an object')
    }

    if (value.id !== expectedId || value.strategy_id !== expectedStrategyId || value.symbol_id !== expectedSymbolId) {
        throw new InvalidStoredStrategySymbolPolicyError('policy document identity does not match its document path')
    }
    if (value.sizing_mode !== 'WEBHOOK_CAPPED' && value.sizing_mode !== 'MANAGED') {
        throw new InvalidStoredStrategySymbolPolicyError('policy sizing_mode is invalid')
    }
    if (typeof value.enabled !== 'boolean') {
        throw new InvalidStoredStrategySymbolPolicyError('policy enabled is invalid')
    }
    if (!isFinitePositiveNumber(value.max_abs_position)) {
        throw new InvalidStoredStrategySymbolPolicyError('policy max_abs_position is invalid')
    }
    if (typeof value.no_flip !== 'boolean') {
        throw new InvalidStoredStrategySymbolPolicyError('policy no_flip is invalid')
    }
    if (typeof value.version !== 'number' || !Number.isSafeInteger(value.version) || value.version <= 0) {
        throw new InvalidStoredStrategySymbolPolicyError('policy version is invalid')
    }
    const version = value.version

    const createdAt = assertDateField(value, 'created_at')
    const updatedAt = assertDateField(value, 'updated_at')
    if (updatedAt.getTime() < createdAt.getTime()) {
        throw new InvalidStoredStrategySymbolPolicyError('updated_at must not be before created_at')
    }

    const common = {
        id: expectedId,
        strategy_id: expectedStrategyId,
        symbol_id: expectedSymbolId,
        enabled: value.enabled,
        max_abs_position: value.max_abs_position,
        no_flip: value.no_flip,
        version,
        created_at: createdAt,
        updated_at: updatedAt,
    }

    if (value.sizing_mode === 'WEBHOOK_CAPPED') {
        if (Object.hasOwn(value, 'base_order_size') || Object.hasOwn(value, 'taper_strength')) {
            throw new InvalidStoredStrategySymbolPolicyError('WEBHOOK_CAPPED policy has managed-only fields')
        }
        const allowedKeys = new Set([
            'id',
            'strategy_id',
            'symbol_id',
            'sizing_mode',
            'enabled',
            'max_abs_position',
            'no_flip',
            'version',
            'created_at',
            'updated_at',
        ])
        if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
            throw new InvalidStoredStrategySymbolPolicyError('policy document has unexpected fields')
        }
        return { ...common, sizing_mode: 'WEBHOOK_CAPPED' } satisfies WebhookCappedStrategySymbolPolicy
    }

    if (!isFinitePositiveNumber(value.base_order_size)) {
        throw new InvalidStoredStrategySymbolPolicyError('policy base_order_size is invalid')
    }
    if (!isFiniteNumber(value.taper_strength) || value.taper_strength < 0 || value.taper_strength > 1) {
        throw new InvalidStoredStrategySymbolPolicyError('policy taper_strength is invalid')
    }
    const allowedKeys = new Set([
        'id',
        'strategy_id',
        'symbol_id',
        'sizing_mode',
        'enabled',
        'max_abs_position',
        'no_flip',
        'version',
        'created_at',
        'updated_at',
        'base_order_size',
        'taper_strength',
    ])
    if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
        throw new InvalidStoredStrategySymbolPolicyError('policy document has unexpected fields')
    }
    return {
        ...common,
        sizing_mode: 'MANAGED',
        base_order_size: value.base_order_size,
        taper_strength: value.taper_strength,
    } satisfies ManagedStrategySymbolPolicy
}

const getSnapshotId = (snapshot: unknown, fallback: string): string => (
    isRecord(snapshot) && typeof snapshot.id === 'string' ? snapshot.id : fallback
)

const getSnapshotData = (snapshot: unknown): unknown => (
    isRecord(snapshot) && typeof snapshot.data === 'function' ? snapshot.data() : undefined
)

const isSnapshotExisting = (snapshot: unknown): boolean => (
    isRecord(snapshot) && snapshot.exists === true
)

export const createGetStrategySymbolPolicyFn = (
    db: Firestore = getFirestoreClient(),
): GetStrategySymbolPolicyFn => {
    return async (strategyId, symbolId) => {
        const policyId = createStrategySymbolPolicyId(strategyId, symbolId)
        const snapshot = await db.collection(COLLECTION_NAME).doc(policyId).get()
        if (!snapshot.exists) return null

        const actualDocumentId = getSnapshotId(snapshot, policyId)
        if (actualDocumentId !== policyId) {
            throw new InvalidStoredStrategySymbolPolicyError('policy document ID does not match its requested path')
        }
        return assertStoredPolicy(snapshot.data(), policyId, strategyId, symbolId)
    }
}

export const createPutStrategySymbolPolicyFn = (
    db: Firestore = getFirestoreClient(),
): PutStrategySymbolPolicyFn => {
    return async (input) => {
        assertValidPolicyInput(input)
        const policyId = createStrategySymbolPolicyId(input.strategy_id, input.symbol_id)
        const symbolRef = db.collection(SYMBOL_COLLECTION_NAME).doc(input.symbol_id)
        const policyRef = db.collection(COLLECTION_NAME).doc(policyId)

        return db.runTransaction(async (transaction) => {
            const symbolSnapshot = await transaction.get(symbolRef)
            const currentPolicySnapshot = await transaction.get(policyRef)

            if (!symbolSnapshot.exists) {
                throw new SymbolNotFoundError(input.symbol_id)
            }

            const symbolData = symbolSnapshot.data() as Record<string, unknown> | undefined
            if (!symbolData || symbolData.order_constraints === undefined) {
                throw new SymbolConstraintsRequiredError(input.symbol_id)
            }
            const constraints = assertValidOrderConstraints(symbolData.order_constraints, input.symbol_id)

            const currentPolicy = currentPolicySnapshot.exists
                ? (() => {
                    const actualDocumentId = getSnapshotId(currentPolicySnapshot, policyId)
                    if (actualDocumentId !== policyId) {
                        throw new InvalidStoredStrategySymbolPolicyError('policy document ID does not match its requested path')
                    }
                    return assertStoredPolicy(
                        getSnapshotData(currentPolicySnapshot),
                        policyId,
                        input.strategy_id,
                        input.symbol_id,
                    )
                })()
                : null

            validateStrategySymbolPolicyInput(input, constraints)

            const now = new Date()
            if (currentPolicy && currentPolicy.version >= Number.MAX_SAFE_INTEGER) {
                throw new InvalidStoredStrategySymbolPolicyError('policy version cannot be incremented safely')
            }
            const updatedAt = currentPolicy && now.getTime() <= currentPolicy.updated_at.getTime()
                ? new Date(currentPolicy.updated_at.getTime() + 1)
                : now
            const version = currentPolicy ? currentPolicy.version + 1 : 1
            const policy: StrategySymbolPolicy = input.sizing_mode === 'MANAGED'
                ? {
                    id: policyId,
                    strategy_id: input.strategy_id,
                    symbol_id: input.symbol_id,
                    sizing_mode: 'MANAGED',
                    enabled: input.enabled,
                    max_abs_position: input.max_abs_position,
                    no_flip: input.no_flip,
                    base_order_size: input.base_order_size,
                    taper_strength: input.taper_strength,
                    version,
                    created_at: currentPolicy?.created_at ?? now,
                    updated_at: updatedAt,
                }
                : {
                    id: policyId,
                    strategy_id: input.strategy_id,
                    symbol_id: input.symbol_id,
                    sizing_mode: 'WEBHOOK_CAPPED',
                    enabled: input.enabled,
                    max_abs_position: input.max_abs_position,
                    no_flip: input.no_flip,
                    version,
                    created_at: currentPolicy?.created_at ?? now,
                    updated_at: updatedAt,
                }

            transaction.set(policyRef, omitUndefinedFields(policy as unknown as Record<string, unknown>))
            return policy
        })
    }
}

export const createDefaultGetStrategySymbolPolicyFn = (): GetStrategySymbolPolicyFn =>
    createGetStrategySymbolPolicyFn(getFirestoreClient())

export const createDefaultPutStrategySymbolPolicyFn = (): PutStrategySymbolPolicyFn =>
    createPutStrategySymbolPolicyFn(getFirestoreClient())
