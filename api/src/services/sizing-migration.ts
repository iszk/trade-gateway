import type {
    DocumentReference,
    Firestore,
    Query,
    Transaction,
} from 'firebase-admin/firestore'

import { getFirestoreClient } from '../firestore.js'
import type { OrderV2 } from '../types/order-v2.js'
import type { Position } from '../types/position.js'
import type { StrategySymbolPolicy } from '../types/strategy-symbol-policy.js'
import type { StrategySymbolPosition } from '../types/strategy-symbol-position.js'
import type { StrategySymbolReservation } from '../types/strategy-symbol-reservation.js'
import type { OrderConstraints } from '../types/tradable-symbol.js'
import { isCanonicalStrategyId, resolveEffectiveStrategyId, resolveLegacyStrategyId } from './strategy-ids.js'
import {
    createStrategySymbolPolicyId,
    deserializeStrategySymbolPolicy,
} from './strategy-symbol-policies.js'
import {
    createStrategySymbolPositionId,
    deserializeStrategySymbolPosition,
} from './strategy-symbol-positions.js'
import {
    createStrategySymbolReservationId,
    deserializeStrategySymbolReservation,
} from './strategy-symbol-reservations.js'
import {
    decideSymbolReconciliation,
    validateReconciliationBrokerSnapshot,
} from './strategy-symbol-reconciliation.js'
import {
    addQuantities,
    compareQuantities,
    isFiniteQuantity,
    isQuantityStepAligned,
    isUsableQuantityStep,
    multiplyQuantity,
    subtractQuantities,
} from './quantity.js'
import { createSymbolId, parseSymbolId } from './tradable-symbols.js'
import type { BrokerName } from '../types/order.js'

const ORDERS_COLLECTION = 'orders_v2'
const SYMBOLS_COLLECTION = 'tradable_symbols'
const POLICIES_COLLECTION = 'strategy_symbol_policies'
const POSITIONS_COLLECTION = 'strategy_symbol_positions'
const RESERVATIONS_COLLECTION = 'strategy_symbol_reservations'

/** Leave headroom below Firestore's 500-write transaction limit. */
export const SIZING_MIGRATION_MAX_TRANSACTION_WRITES = 450

const BROKERS: readonly BrokerName[] = ['bitflyer', 'saxo', 'dummy']
const ORDER_STATUSES = new Set<OrderV2['status']>(['PENDING', 'EXECUTED', 'FAILED', 'CANCELED'])
const ORDER_SIDES = new Set<OrderV2['side']>(['BUY', 'SELL'])
const ORDER_TYPES = new Set<OrderV2['order_type']>(['MARKET', 'IFDOCO', 'LIMIT', 'STOP'])
const EXECUTION_EPSILON = 1e-8

export type SizingMigrationPolicyManifest = {
    strategy_id: string
    sizing_mode: 'WEBHOOK_CAPPED'
    max_abs_position: number
    no_flip: boolean
}

export type SizingMigrationSymbolManifest = {
    symbol_id: string
    expected_order_constraints: OrderConstraints
    policies: SizingMigrationPolicyManifest[]
}

export type SizingMigrationManifest = {
    project_id: string
    symbols: SizingMigrationSymbolManifest[]
}

export type SizingMigrationOrderRecord = {
    id: string
    data: unknown
}

export type SizingMigrationIssue = {
    reason: string
    symbol_id?: string
    strategy_id?: string
    order_id?: string
    details?: Record<string, unknown>
}

export type SizingMigrationWarning = {
    reason: string
    symbol_id?: string
    strategy_id?: string
    order_id?: string
    details?: Record<string, unknown>
}

export type SizingMigrationPendingReservation = {
    order_id: string
    event_id: string
    strategy_id: string
    symbol_id: string
    reserved_delta: number
    executed_delta: number
    status: 'DISPATCHED'
    policy_version: 1
    projection: OrderSourceProjection
}

export type SizingMigrationAggregate = {
    strategy_id: string
    symbol_id: string
    confirmed_position: number
    pending_delta: number
    pending_reservations: SizingMigrationPendingReservation[]
    order_ids: string[]
    projections: OrderSourceProjection[]
}

export type OrderSourceProjection = {
    id: string
    status: OrderV2['status']
    side: OrderV2['side']
    requested_size: number
    executed_size: number
    strategy: string | undefined
    effective_strategy_id: string | undefined
    strategy_id: string | undefined
    broker: BrokerName
    ticker: string
    provider_order_ids: string[]
}

export type SizingMigrationReconstruction = {
    aggregates: SizingMigrationAggregate[]
    issues: SizingMigrationIssue[]
    warnings: SizingMigrationWarning[]
}

export type SizingMigrationSymbolStatus = 'CREATE' | 'NO_OP' | 'BLOCKED' | 'CONFLICT' | 'APPLIED'

export type SizingMigrationSymbolResult = {
    symbol_id: string
    status: SizingMigrationSymbolStatus
    planned_writes: number
    issues: SizingMigrationIssue[]
    warnings: SizingMigrationWarning[]
}

export type SizingMigrationReport = {
    project_id: string
    mode: 'DRY_RUN' | 'APPLY'
    writes: number
    blocked: boolean
    symbols: SizingMigrationSymbolResult[]
    issues: SizingMigrationIssue[]
    warnings: SizingMigrationWarning[]
}

export type SizingMigrationServiceOptions = {
    db?: Firestore
    manifest: SizingMigrationManifest
    mode?: 'DRY_RUN' | 'APPLY'
    now?: () => Date
    listOrders?: () => Promise<SizingMigrationRecordInput[]>
    listSymbols?: () => Promise<SizingMigrationRecordInput[]>
    listPolicies?: () => Promise<SizingMigrationRecordInput[]>
    listPositions?: () => Promise<SizingMigrationRecordInput[]>
    listReservations?: () => Promise<SizingMigrationRecordInput[]>
    fetchPositionsForReconciliation?: (broker: BrokerName) => Promise<Position[]>
    positionFetcher?: {
        fetchPositionsForReconciliation: (broker: BrokerName) => Promise<Position[]>
    }
    maxTransactionWrites?: number
    logger?: {
        info?: (obj: Record<string, unknown>, message?: string) => void
        warn?: (obj: Record<string, unknown>, message?: string) => void
    }
}

export type SizingMigrationService = {
    run: () => Promise<SizingMigrationReport>
}

type SnapshotRecord = {
    id: string
    data: unknown
}

type SizingMigrationRecordInput = SizingMigrationOrderRecord | Record<string, unknown>

type ParsedOrder = {
    id: string
    strategyId: string
    raw: Record<string, unknown>
    projection: OrderSourceProjection
    signedRequested: number
    signedExecuted: number
    signedPending: number
    pending: boolean
    dryRun: boolean
}

type SymbolPlan = {
    manifest: SizingMigrationSymbolManifest
    symbol: SnapshotRecord | undefined
    aggregates: Map<string, SizingMigrationAggregate>
    brokerPositions: Position[] | undefined
    brokerFailureReason?: string
    issues: SizingMigrationIssue[]
    warnings: SizingMigrationWarning[]
    existing: {
        policies: Map<string, SnapshotRecord>
        positions: Map<string, SnapshotRecord>
        reservations: Map<string, SnapshotRecord>
    }
    expectedDocuments: number
    existingDocuments: number
    plannedWrites: number
    stateConflict: boolean
}

type SnapshotLike = {
    id: string
    exists: boolean
    data: () => unknown
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isBrokerName = (value: unknown): value is BrokerName => BROKERS.includes(value as BrokerName)

const isFiniteDate = (value: unknown): value is Date => (
    value instanceof Date && Number.isFinite(value.getTime())
)

const toDate = (value: unknown): Date | null => {
    try {
        if (value instanceof Date) return isFiniteDate(value) ? new Date(value.getTime()) : null
        if (isRecord(value) && typeof value.toDate === 'function') {
            const date = value.toDate()
            return isFiniteDate(date) ? new Date(date.getTime()) : null
        }
    } catch {
        return null
    }
    return null
}

const safeNow = (now: () => Date): Date => {
    const value = now()
    return isFiniteDate(value) ? value : new Date()
}

const issue = (
    reason: string,
    details: Omit<SizingMigrationIssue, 'reason'> = {},
): SizingMigrationIssue => ({ reason, ...details })

const warning = (
    reason: string,
    details: Omit<SizingMigrationWarning, 'reason'> = {},
): SizingMigrationWarning => ({ reason, ...details })

const uniqueIssues = (issues: SizingMigrationIssue[]): SizingMigrationIssue[] => {
    const seen = new Set<string>()
    return issues.filter((entry) => {
        const key = JSON.stringify(entry)
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

const uniqueWarnings = (warnings: SizingMigrationWarning[]): SizingMigrationWarning[] => {
    const seen = new Set<string>()
    return warnings.filter((entry) => {
        const key = JSON.stringify(entry)
        if (seen.has(key)) return false
        seen.add(key)
        return true
    })
}

const unwrapRecord = (record: SizingMigrationOrderRecord | Record<string, unknown>): { id: string; data: unknown } => {
    if (isRecord(record) && Object.hasOwn(record, 'data')) {
        return {
            id: typeof record.id === 'string' ? record.id : '',
            data: record.data,
        }
    }
    const data = record as Record<string, unknown>
    return {
        id: typeof data.id === 'string' ? data.id : '',
        data,
    }
}

const isQuantity = (value: unknown, positive = false): value is number => (
    isFiniteQuantity(value) && (!positive || value > 0)
)

const validateConstraints = (value: unknown): value is OrderConstraints => {
    if (!isRecord(value) || !isUsableQuantityStep(value.quantity_step) || !isQuantity(value.min_order_size, true)) {
        return false
    }
    return value.max_order_size === undefined || (
        isQuantity(value.max_order_size, true) && value.max_order_size >= value.min_order_size
    )
}

const validateManifest = (value: unknown): SizingMigrationManifest | null => {
    if (!isRecord(value) || typeof value.project_id !== 'string' || value.project_id.trim().length === 0) return null
    if (!Array.isArray(value.symbols) || value.symbols.length === 0) return null

    const symbols: SizingMigrationSymbolManifest[] = []
    const symbolIds = new Set<string>()
    for (const rawSymbol of value.symbols) {
        if (!isRecord(rawSymbol) || typeof rawSymbol.symbol_id !== 'string' || symbolIds.has(rawSymbol.symbol_id)) return null
        const parsed = parseSymbolId(rawSymbol.symbol_id)
        if (!parsed || !isBrokerName(parsed.broker) || parsed.ticker.trim().length === 0) return null
        if (!validateConstraints(rawSymbol.expected_order_constraints)) return null
        const constraints = rawSymbol.expected_order_constraints as OrderConstraints
        if (!Array.isArray(rawSymbol.policies) || rawSymbol.policies.length === 0) return null

        const policies: SizingMigrationPolicyManifest[] = []
        const strategyIds = new Set<string>()
        for (const rawPolicy of rawSymbol.policies) {
            if (!isRecord(rawPolicy) ||
                typeof rawPolicy.strategy_id !== 'string' ||
                !isCanonicalStrategyId(rawPolicy.strategy_id) ||
                rawPolicy.strategy_id === 'unknown' ||
                strategyIds.has(rawPolicy.strategy_id) ||
                Object.hasOwn(rawPolicy, 'enabled') ||
                rawPolicy.sizing_mode !== 'WEBHOOK_CAPPED' ||
                !isQuantity(rawPolicy.max_abs_position, true) ||
                rawPolicy.no_flip !== true && rawPolicy.no_flip !== false ||
                rawPolicy.max_abs_position < constraints.min_order_size ||
                !isQuantityStepAligned(rawPolicy.max_abs_position, constraints.quantity_step)) {
                return null
            }
            strategyIds.add(rawPolicy.strategy_id)
            policies.push({
                strategy_id: rawPolicy.strategy_id,
                sizing_mode: 'WEBHOOK_CAPPED',
                max_abs_position: rawPolicy.max_abs_position,
                no_flip: rawPolicy.no_flip,
            })
        }
        symbolIds.add(rawSymbol.symbol_id)
        symbols.push({
            symbol_id: rawSymbol.symbol_id,
            expected_order_constraints: {
                quantity_step: constraints.quantity_step,
                min_order_size: constraints.min_order_size,
                ...(constraints.max_order_size === undefined ? {} : { max_order_size: constraints.max_order_size }),
            },
            policies,
        })
    }
    return { project_id: value.project_id.trim(), symbols }
}

/** Validate and normalize a migration manifest. Invalid input returns null. */
export const validateSizingMigrationManifest = (
    value: unknown,
): SizingMigrationManifest | null => validateManifest(value)

const isDryRunOrder = (raw: Record<string, unknown>): boolean => (
    Array.isArray(raw.provider_order_ids) && raw.provider_order_ids.some((id) => id === 'DRY_RUN')
)

const parseOrder = (
    record: SizingMigrationOrderRecord | Record<string, unknown>,
): { order?: ParsedOrder; issues: SizingMigrationIssue[]; warnings: SizingMigrationWarning[] } => {
    const source = unwrapRecord(record)
    const raw = source.data
    const issues: SizingMigrationIssue[] = []
    const warnings: SizingMigrationWarning[] = []
    if (!isRecord(raw)) return { issues: [issue('INVALID_ORDER_DOCUMENT', { order_id: source.id || undefined })], warnings }

    const orderId = source.id || (typeof raw.id === 'string' ? raw.id : '')
    const orderSymbolId = isBrokerName(raw.broker) && typeof raw.ticker === 'string' &&
        raw.ticker.trim().length > 0 && !raw.ticker.includes('/')
        ? createSymbolId(raw.broker, raw.ticker)
        : undefined
    const addOrderIssue = (reason: string, details: Record<string, unknown> = {}) => {
        issues.push(issue(reason, {
            order_id: orderId || undefined,
            symbol_id: orderSymbolId,
            details,
        }))
    }
    if (!orderId || orderId.trim().length === 0 || raw.id !== orderId) addOrderIssue('ORDER_ID_MISMATCH')
    if (!isBrokerName(raw.broker)) addOrderIssue('INVALID_BROKER')
    if (typeof raw.ticker !== 'string' || raw.ticker.trim().length === 0 || raw.ticker.includes('/')) addOrderIssue('INVALID_TICKER')
    if (!ORDER_SIDES.has(raw.side as OrderV2['side'])) addOrderIssue('INVALID_SIDE')
    if (!ORDER_TYPES.has(raw.order_type as OrderV2['order_type'])) addOrderIssue('INVALID_ORDER_TYPE')
    if (!ORDER_STATUSES.has(raw.status as OrderV2['status'])) addOrderIssue('INVALID_STATUS')
    if (!isQuantity(raw.requested_size, true)) addOrderIssue('INVALID_REQUESTED_SIZE')
    if (!isQuantity(raw.executed_size)) addOrderIssue('INVALID_EXECUTED_SIZE')
    if (isQuantity(raw.requested_size, true) && isQuantity(raw.executed_size)) {
        if (raw.executed_size > raw.requested_size + EXECUTION_EPSILON) addOrderIssue('EXECUTED_SIZE_OVER_REQUESTED')
        if (raw.status === 'EXECUTED' && Math.abs(raw.executed_size - raw.requested_size) > EXECUTION_EPSILON) {
            addOrderIssue('EXECUTED_ORDER_NOT_FULL')
        }
    }
    if (!Array.isArray(raw.provider_order_ids) || raw.provider_order_ids.some((id) => typeof id !== 'string' || id.trim().length === 0)) {
        addOrderIssue('INVALID_PROVIDER_ORDER_IDS')
    }
    const createdAt = toDate(raw.created_at)
    const updatedAt = toDate(raw.updated_at)
    if (!createdAt || !updatedAt) addOrderIssue('INVALID_ORDER_DATES')
    else if (updatedAt.getTime() < createdAt.getTime()) addOrderIssue('ORDER_DATE_ORDER_INVALID')
    if (raw.executed_at !== undefined && !toDate(raw.executed_at)) addOrderIssue('INVALID_EXECUTED_AT')
    if (raw.status === 'EXECUTED' && !toDate(raw.executed_at)) addOrderIssue('EXECUTED_AT_REQUIRED')
    if (raw.executed_price !== null && raw.executed_price !== undefined && !isQuantity(raw.executed_price)) addOrderIssue('INVALID_EXECUTED_PRICE')
    if (raw.status === 'EXECUTED' && !isQuantity(raw.executed_price)) addOrderIssue('EXECUTED_PRICE_REQUIRED')
    if (raw.execution_costs !== undefined && (!isRecord(raw.execution_costs) ||
        (raw.execution_costs.commission !== undefined && !isQuantity(raw.execution_costs.commission)))) {
        addOrderIssue('INVALID_EXECUTION_COSTS')
    }

    const symbolId = orderSymbolId
    if (symbolId && parseSymbolId(symbolId) === null) addOrderIssue('INVALID_SYMBOL_ID')

    const hasEffectiveId = raw.effective_strategy_id !== undefined
    const hasExplicitId = raw.strategy_id !== undefined
    const effectiveResolution = resolveEffectiveStrategyId({
        effectiveStrategyId: raw.effective_strategy_id,
        explicitStrategyId: raw.strategy_id,
        legacyStrategy: raw.strategy,
    })
    const legacyResolution = resolveLegacyStrategyId(raw.strategy)
    const explicitResolution = hasExplicitId
        ? resolveEffectiveStrategyId({ explicitStrategyId: raw.strategy_id })
        : undefined
    if (hasEffectiveId && effectiveResolution.effectiveStrategyId === undefined) addOrderIssue(`EFFECTIVE_STRATEGY_${effectiveResolution.reason}`)
    if (hasExplicitId && explicitResolution?.effectiveStrategyId === undefined) addOrderIssue(`EXPLICIT_STRATEGY_${explicitResolution?.reason ?? 'INVALID'}`)
    if (!hasEffectiveId && !hasExplicitId && effectiveResolution.effectiveStrategyId === undefined) {
        addOrderIssue(`LEGACY_STRATEGY_${legacyResolution.reason}`)
    }
    if (raw.strategy !== undefined && typeof raw.strategy !== 'string') addOrderIssue('INVALID_STRATEGY_DISPLAY')
    if (!hasEffectiveId && explicitResolution?.effectiveStrategyId !== undefined && legacyResolution.effectiveStrategyId !== undefined &&
        explicitResolution.effectiveStrategyId !== legacyResolution.effectiveStrategyId) {
        addOrderIssue('EXPLICIT_LEGACY_STRATEGY_CONFLICT')
    }
    if (hasEffectiveId && explicitResolution?.effectiveStrategyId !== undefined &&
        effectiveResolution.effectiveStrategyId !== undefined &&
        explicitResolution.effectiveStrategyId !== effectiveResolution.effectiveStrategyId) {
        addOrderIssue('EFFECTIVE_EXPLICIT_STRATEGY_CONFLICT')
    }
    const strategyId = effectiveResolution.effectiveStrategyId
    if (strategyId === undefined || !isBrokerName(raw.broker) || typeof raw.ticker !== 'string' ||
        !ORDER_SIDES.has(raw.side as OrderV2['side']) || !isQuantity(raw.requested_size, true) || !isQuantity(raw.executed_size)) {
        return { issues, warnings }
    }

    const signedExecuted = multiplyQuantity(raw.executed_size, raw.side === 'BUY' ? 1 : -1)
    const remaining = subtractQuantities(raw.requested_size, raw.executed_size)
    const signedPending = remaining === null ? null : multiplyQuantity(remaining, raw.side === 'BUY' ? 1 : -1)
    const signedRequested = multiplyQuantity(raw.requested_size, raw.side === 'BUY' ? 1 : -1)
    if (signedRequested === null || signedExecuted === null || signedPending === null) addOrderIssue('ORDER_QUANTITY_OVERFLOW')
    if (issues.length > 0 || signedRequested === null || signedExecuted === null || signedPending === null) return { issues, warnings }

    const providerOrderIds = raw.provider_order_ids as string[]
    const dryRun = isDryRunOrder(raw)
    const projection: OrderSourceProjection = {
        id: orderId,
        status: raw.status as OrderV2['status'],
        side: raw.side as OrderV2['side'],
        requested_size: raw.requested_size,
        executed_size: raw.executed_size,
        strategy: typeof raw.strategy === 'string' ? raw.strategy : undefined,
        effective_strategy_id: typeof raw.effective_strategy_id === 'string' ? raw.effective_strategy_id : undefined,
        strategy_id: typeof raw.strategy_id === 'string' ? raw.strategy_id : undefined,
        broker: raw.broker,
        ticker: raw.ticker,
        provider_order_ids: [...providerOrderIds],
    }
    if (dryRun) {
        warnings.push(warning('DRY_RUN_ORDER_EXCLUDED', {
            order_id: orderId,
            symbol_id: symbolId,
            strategy_id: strategyId,
            details: { symbol_id: symbolId, strategy_id: strategyId },
        }))
    }
    return {
        issues,
        warnings,
        order: {
            id: orderId,
            strategyId,
            raw,
            projection,
            signedRequested,
            signedExecuted,
            signedPending,
            pending: raw.status === 'PENDING',
            dryRun,
        },
    }
}

const aggregateByKey = (aggregates: Map<string, SizingMigrationAggregate>, order: ParsedOrder, symbolId: string): boolean => {
    const key = `${symbolId}\u0000${order.strategyId}`
    const current = aggregates.get(key) ?? {
        strategy_id: order.strategyId,
        symbol_id: symbolId,
        confirmed_position: 0,
        pending_delta: 0,
        pending_reservations: [],
        order_ids: [],
        projections: [],
    }
    const confirmed = addQuantities(current.confirmed_position, order.signedExecuted)
    const pending = addQuantities(current.pending_delta, order.pending && !order.dryRun ? order.signedPending : 0)
    if (confirmed === null || pending === null) return false
    current.confirmed_position = confirmed
    current.pending_delta = pending
    current.order_ids.push(order.id)
    current.projections.push(order.projection)
    if (order.pending && !order.dryRun) {
        current.pending_reservations.push({
            order_id: order.id,
            event_id: order.id,
            strategy_id: order.strategyId,
            symbol_id: symbolId,
            reserved_delta: order.signedRequested,
            executed_delta: order.signedExecuted,
            status: 'DISPATCHED',
            policy_version: 1,
            projection: order.projection,
        } as SizingMigrationPendingReservation)
    }
    aggregates.set(key, current)
    return true
}

/**
 * Reconstruct strategy × symbol state from an orders_v2 fixture.
 * This function performs no Firestore or broker I/O and is intentionally
 * exported for fixture tests and dry-run tooling.
 */
export const reconstructSizingState = (
    manifestInput: unknown,
    records: readonly (SizingMigrationOrderRecord | Record<string, unknown>)[],
): SizingMigrationReconstruction => {
    const manifest = validateManifest(manifestInput)
    if (!manifest) return { aggregates: [], issues: [issue('INVALID_MANIFEST')], warnings: [] }
    const aggregates = new Map<string, SizingMigrationAggregate>()
    const issues: SizingMigrationIssue[] = []
    const warnings: SizingMigrationWarning[] = []
    const orderIds = new Set<string>()
    for (const record of records) {
        const parsed = parseOrder(record)
        issues.push(...parsed.issues)
        warnings.push(...parsed.warnings)
        if (parsed.order && orderIds.has(parsed.order.id)) {
            issues.push(issue('DUPLICATE_ORDER_ID', { order_id: parsed.order.id }))
            continue
        }
        if (parsed.order) orderIds.add(parsed.order.id)
        if (!parsed.order) continue
        const symbolId = createSymbolId(parsed.order.raw.broker as BrokerName, parsed.order.raw.ticker as string)
        if (!manifest.symbols.some((symbol) => symbol.symbol_id === symbolId)) {
            issues.push(issue('SYMBOL_NOT_IN_MANIFEST', { symbol_id: symbolId, order_id: parsed.order.id, strategy_id: parsed.order.strategyId }))
            continue
        }
        const symbolManifest = manifest.symbols.find((symbol) => symbol.symbol_id === symbolId)!
        if (!symbolManifest.policies.some((policy) => policy.strategy_id === parsed.order!.strategyId)) {
            issues.push(issue('STRATEGY_NOT_IN_MANIFEST', { symbol_id: symbolId, order_id: parsed.order.id, strategy_id: parsed.order.strategyId }))
            continue
        }
        if (!parsed.order.dryRun && !aggregateByKey(aggregates, parsed.order, symbolId)) {
            issues.push(issue('ARITHMETIC_OVERFLOW', {
                symbol_id: symbolId,
                order_id: parsed.order.id,
                strategy_id: parsed.order.strategyId,
            }))
        }
    }
    return {
        aggregates: [...aggregates.values()].map((aggregate) => ({
            ...aggregate,
            order_ids: [...aggregate.order_ids].sort(),
            projections: [...aggregate.projections].sort((left, right) => left.id.localeCompare(right.id)),
            pending_reservations: [...aggregate.pending_reservations].sort((left, right) => left.order_id.localeCompare(right.order_id)),
        })).sort((left, right) => left.symbol_id.localeCompare(right.symbol_id) || left.strategy_id.localeCompare(right.strategy_id)),
        issues: uniqueIssues(issues),
        warnings,
    }
}

const projectionMatches = (left: OrderSourceProjection, right: OrderSourceProjection): boolean => (
    left.id === right.id &&
    left.status === right.status &&
    left.side === right.side &&
    left.requested_size === right.requested_size &&
    left.executed_size === right.executed_size &&
    left.strategy === right.strategy &&
    left.effective_strategy_id === right.effective_strategy_id &&
    left.strategy_id === right.strategy_id &&
    left.broker === right.broker &&
    left.ticker === right.ticker &&
    JSON.stringify(left.provider_order_ids) === JSON.stringify(right.provider_order_ids)
)

const symbolMatchesManifest = (record: SnapshotRecord | undefined, manifest: SizingMigrationSymbolManifest): boolean => {
    if (!record || !isRecord(record.data)) return false
    const value = record.data
    const parsed = parseSymbolId(manifest.symbol_id)
    return parsed !== null &&
        value.id === manifest.symbol_id &&
        value.broker === parsed.broker &&
        value.ticker === parsed.ticker &&
        isRecord(value.trade_control) &&
        (value.trade_control.status === 'active' || value.trade_control.status === 'paused') &&
        toDate(value.trade_control.updated_at) !== null &&
        toDate(value.created_at) !== null &&
        toDate(value.updated_at) !== null &&
        validateConstraints(value.order_constraints)
}

const constraintsMatch = (record: SnapshotRecord | undefined, expected: OrderConstraints): boolean => {
    if (!record || !isRecord(record.data) || !validateConstraints(record.data.order_constraints)) return false
    const actual = record.data.order_constraints
    return compareQuantities(actual.quantity_step, expected.quantity_step, expected.quantity_step) === 0 &&
        compareQuantities(actual.min_order_size, expected.min_order_size, expected.quantity_step) === 0 &&
        (actual.max_order_size === undefined && expected.max_order_size === undefined ||
            actual.max_order_size !== undefined && expected.max_order_size !== undefined &&
            compareQuantities(actual.max_order_size, expected.max_order_size, expected.quantity_step) === 0)
}

const symbolIsPaused = (record: SnapshotRecord | undefined): boolean => (
    isRecord(record?.data) && isRecord(record.data.trade_control) && record.data.trade_control.status === 'paused'
)

const policyCoreMatches = (policy: StrategySymbolPolicy, expected: SizingMigrationPolicyManifest, symbolId: string): boolean => (
    policy.id === createStrategySymbolPolicyId(expected.strategy_id, symbolId) &&
    policy.strategy_id === expected.strategy_id &&
    policy.symbol_id === symbolId &&
    policy.sizing_mode === 'WEBHOOK_CAPPED' &&
    policy.enabled === true &&
    policy.max_abs_position === expected.max_abs_position &&
    policy.no_flip === expected.no_flip &&
    policy.version === 1
)

const positionCoreMatches = (position: StrategySymbolPosition, aggregate: SizingMigrationAggregate): boolean => (
    position.id === createStrategySymbolPositionId(aggregate.strategy_id, aggregate.symbol_id) &&
    position.strategy_id === aggregate.strategy_id &&
    position.symbol_id === aggregate.symbol_id &&
    position.confirmed_position === aggregate.confirmed_position &&
    position.pending_delta === aggregate.pending_delta &&
    position.status === 'READY' &&
    position.policy_version === 1
)

const reservationCoreMatches = (
    reservation: StrategySymbolReservation,
    expected: SizingMigrationPendingReservation,
): boolean => (
    reservation.id === createStrategySymbolReservationId(expected.strategy_id, expected.symbol_id, expected.event_id) &&
    reservation.event_id === expected.event_id &&
    reservation.order_id === expected.order_id &&
    reservation.position_id === createStrategySymbolPositionId(expected.strategy_id, expected.symbol_id) &&
    reservation.strategy_id === expected.strategy_id &&
    reservation.symbol_id === expected.symbol_id &&
    reservation.reserved_delta === expected.reserved_delta &&
    (reservation.executed_delta ?? 0) === expected.executed_delta &&
    reservation.status === 'DISPATCHED' &&
    reservation.policy_version === 1
)

const expectedAggregate = (
    manifest: SizingMigrationSymbolManifest,
    strategyId: string,
    aggregate: SizingMigrationAggregate | undefined,
): SizingMigrationAggregate => aggregate ?? {
    strategy_id: strategyId,
    symbol_id: manifest.symbol_id,
    confirmed_position: 0,
    pending_delta: 0,
    pending_reservations: [],
    order_ids: [],
    projections: [],
}

const expectedDocumentCount = (manifest: SizingMigrationSymbolManifest, aggregates: SizingMigrationAggregate[]): number => (
    manifest.policies.length + manifest.policies.length + aggregates.reduce((count, aggregate) => count + aggregate.pending_reservations.length, 0)
)

const mapRecords = (records: SnapshotRecord[]): Map<string, SnapshotRecord> => new Map(records.map((record) => [record.id, record]))

const makeRecordMap = (records: SizingMigrationRecordInput[]): SnapshotRecord[] => records.map((record) => {
    const unwrapped = unwrapRecord(record)
    return { id: unwrapped.id, data: unwrapped.data }
})

const parseExistingPolicy = (record: SnapshotRecord, strategyId: string, symbolId: string): StrategySymbolPolicy | null => {
    try {
        const id = createStrategySymbolPolicyId(strategyId, symbolId)
        return deserializeStrategySymbolPolicy(record.data, id, strategyId, symbolId)
    } catch {
        return null
    }
}

const parseExistingPosition = (record: SnapshotRecord, strategyId: string, symbolId: string): StrategySymbolPosition | null => {
    try {
        return deserializeStrategySymbolPosition(record.data, createStrategySymbolPositionId(strategyId, symbolId))
    } catch {
        return null
    }
}

const parseExistingReservation = (record: SnapshotRecord, expected: SizingMigrationPendingReservation): StrategySymbolReservation | null => {
    try {
        // The serializer can read legacy reservations without executed_delta,
        // but migration must not silently treat a schema-short document as a
        // complete backfill.  Updating it would violate create-or-verify.
        if (!isRecord(record.data) || !Object.hasOwn(record.data, 'executed_delta')) return null
        return deserializeStrategySymbolReservation(record.data, createStrategySymbolReservationId(expected.strategy_id, expected.symbol_id, expected.event_id))
    } catch {
        return null
    }
}

const safeAggregateForReconciliation = (
    manifest: SizingMigrationSymbolManifest,
    aggregates: Map<string, SizingMigrationAggregate>,
): SizingMigrationAggregate[] => manifest.policies.map((policy) => expectedAggregate(
    manifest,
    policy.strategy_id,
    aggregates.get(`${manifest.symbol_id}\u0000${policy.strategy_id}`),
))

const createEmptyReport = (manifest: SizingMigrationManifest, mode: 'DRY_RUN' | 'APPLY'): SizingMigrationReport => ({
    project_id: manifest.project_id,
    mode,
    writes: 0,
    blocked: false,
    symbols: [],
    issues: [],
    warnings: [],
})

const readCollection = async (db: Firestore, collection: string): Promise<SnapshotRecord[]> => {
    const snapshot = await db.collection(collection).get()
    return snapshot.docs.map((document) => ({ id: document.id, data: document.data() }))
}

const documentRef = (db: Firestore, collection: string, id: string): DocumentReference => db.collection(collection).doc(id)

const parseTxSnapshot = (snapshot: SnapshotLike): SnapshotRecord | undefined => (
    snapshot.exists ? { id: snapshot.id, data: snapshot.data() } : undefined
)

const compareExistingOrders = async (
    transaction: Transaction,
    db: Firestore,
    projections: OrderSourceProjection[],
): Promise<SizingMigrationIssue[]> => {
    const issues: SizingMigrationIssue[] = []
    for (const projection of projections) {
        const snapshot = await transaction.get(documentRef(db, ORDERS_COLLECTION, projection.id)) as unknown as SnapshotLike
        const raw = snapshot.exists ? snapshot.data() : undefined
        const parsed = parseOrder({ id: projection.id, data: raw })
        if (!parsed.order || parsed.issues.length > 0 || !projectionMatches(parsed.order.projection, projection)) {
            issues.push(issue('SOURCE_ORDER_CHANGED', { order_id: projection.id, symbol_id: createSymbolId(projection.broker, projection.ticker), strategy_id: projection.effective_strategy_id ?? projection.strategy_id }))
        }
    }
    return issues
}

type TransactionQuerySnapshot = { docs: SnapshotLike[] }

const runSymbolTransaction = async (
    db: Firestore,
    plan: SymbolPlan,
    now: Date,
    maxTransactionWrites: number,
): Promise<{ status: 'CREATE' | 'NO_OP'; writes: number }> => {
    const aggregates = safeAggregateForReconciliation(plan.manifest, plan.aggregates)
    const expectedReservations = aggregates.flatMap((aggregate) => aggregate.pending_reservations)
    const expectedWrites = expectedDocumentCount(plan.manifest, aggregates)
    // A logically complete state is a read-only NO_OP even when the original
    // backfill would have exceeded the create budget.  Re-check the budget
    // after the transaction observes the current state for races.
    if (expectedWrites > maxTransactionWrites && plan.existingDocuments !== plan.expectedDocuments) {
        throw new Error('TRANSACTION_WRITE_LIMIT_EXCEEDED')
    }

    return db.runTransaction(async (transaction) => {
        const symbolSnapshot = await transaction.get(documentRef(db, SYMBOLS_COLLECTION, plan.manifest.symbol_id)) as unknown as SnapshotLike
        const sourceIssues = aggregates.flatMap((aggregate) => aggregate.projections)
        const changedOrders = await compareExistingOrders(transaction, db, sourceIssues)
        if (changedOrders.length > 0) throw new Error('SOURCE_ORDER_CHANGED')
        const symbol = parseTxSnapshot(symbolSnapshot)
        if (!symbol || !symbolMatchesManifest(symbol, plan.manifest) || !constraintsMatch(symbol, plan.manifest.expected_order_constraints) || !symbolIsPaused(symbol)) {
            throw new Error('SYMBOL_STATE_CHANGED')
        }

        const policySnapshots = new Map<string, SnapshotRecord | undefined>()
        const positionSnapshots = new Map<string, SnapshotRecord | undefined>()
        for (const policy of plan.manifest.policies) {
            const policyId = createStrategySymbolPolicyId(policy.strategy_id, plan.manifest.symbol_id)
            policySnapshots.set(policy.strategy_id, parseTxSnapshot(await transaction.get(documentRef(db, POLICIES_COLLECTION, policyId)) as unknown as SnapshotLike))
            positionSnapshots.set(policy.strategy_id, parseTxSnapshot(await transaction.get(documentRef(db, POSITIONS_COLLECTION, createStrategySymbolPositionId(policy.strategy_id, plan.manifest.symbol_id))) as unknown as SnapshotLike))
        }

        const policyQuery = db.collection(POLICIES_COLLECTION).where('symbol_id', '==', plan.manifest.symbol_id) as Query
        const positionQuery = db.collection(POSITIONS_COLLECTION).where('symbol_id', '==', plan.manifest.symbol_id) as Query
        const allPolicySnapshots = (await transaction.get(policyQuery) as unknown as TransactionQuerySnapshot).docs
        const allPositionSnapshots = (await transaction.get(positionQuery) as unknown as TransactionQuerySnapshot).docs
        const expectedPolicyIds = new Set(plan.manifest.policies.map((policy) => createStrategySymbolPolicyId(policy.strategy_id, plan.manifest.symbol_id)))
        const expectedPositionIds = new Set(plan.manifest.policies.map((policy) => createStrategySymbolPositionId(policy.strategy_id, plan.manifest.symbol_id)))
        if (allPolicySnapshots.some((snapshot) => !expectedPolicyIds.has(snapshot.id)) ||
            allPositionSnapshots.some((snapshot) => !expectedPositionIds.has(snapshot.id))) {
            throw new Error('EXISTING_STATE_CONFLICT')
        }

        let reservationSnapshots: SnapshotLike[] = []
        try {
            const query = db.collection(RESERVATIONS_COLLECTION).where('symbol_id', '==', plan.manifest.symbol_id) as Query
            const querySnapshot = await transaction.get(query) as unknown as TransactionQuerySnapshot
            reservationSnapshots = querySnapshot.docs
        } catch {
            // A transaction query is required in production.  Re-throwing as a
            // conflict preserves fail-closed behavior for test doubles or old
            // clients that cannot provide this read.
            throw new Error('RESERVATION_QUERY_FAILED')
        }
        const existingReservations = new Map(reservationSnapshots.map((snapshot) => [snapshot.id, snapshot]))

        const existingCount = [...policySnapshots.values(), ...positionSnapshots.values()]
            .filter((snapshot): snapshot is SnapshotRecord => snapshot !== undefined).length + existingReservations.size
        const totalExpected = plan.manifest.policies.length * 2 + expectedReservations.length
        if (existingCount !== 0 && (
            existingReservations.size !== expectedReservations.length ||
            expectedReservations.some((expected) => !existingReservations.has(createStrategySymbolReservationId(expected.strategy_id, expected.symbol_id, expected.event_id))) ||
            existingCount !== totalExpected
        )) {
            throw new Error('EXISTING_STATE_CONFLICT')
        }

        const existingLogical = existingCount === totalExpected
        if (existingLogical) {
            for (const policy of plan.manifest.policies) {
                const currentPolicy = policySnapshots.get(policy.strategy_id)
                const parsedPolicy = currentPolicy && parseExistingPolicy(currentPolicy, policy.strategy_id, plan.manifest.symbol_id)
                const aggregate = expectedAggregate(plan.manifest, policy.strategy_id, plan.aggregates.get(`${plan.manifest.symbol_id}\u0000${policy.strategy_id}`))
                const currentPosition = positionSnapshots.get(policy.strategy_id)
                const parsedPosition = currentPosition && parseExistingPosition(currentPosition, policy.strategy_id, plan.manifest.symbol_id)
                if (!parsedPolicy || !policyCoreMatches(parsedPolicy, policy, plan.manifest.symbol_id) || !parsedPosition || !positionCoreMatches(parsedPosition, aggregate)) {
                    throw new Error('EXISTING_STATE_CONFLICT')
                }
            }
            for (const expected of expectedReservations) {
                const current = existingReservations.get(createStrategySymbolReservationId(expected.strategy_id, expected.symbol_id, expected.event_id))
                const parsed = current ? parseExistingReservation({ id: current.id, data: current.data() }, expected) : null
                if (!parsed || !reservationCoreMatches(parsed, expected)) throw new Error('EXISTING_STATE_CONFLICT')
            }
            return { status: 'NO_OP', writes: 0 }
        }

        if (expectedWrites > maxTransactionWrites) throw new Error('TRANSACTION_WRITE_LIMIT_EXCEEDED')

        for (const policy of plan.manifest.policies) {
            const aggregate = expectedAggregate(plan.manifest, policy.strategy_id, plan.aggregates.get(`${plan.manifest.symbol_id}\u0000${policy.strategy_id}`))
            const policyId = createStrategySymbolPolicyId(policy.strategy_id, plan.manifest.symbol_id)
            const positionId = createStrategySymbolPositionId(policy.strategy_id, plan.manifest.symbol_id)
            transaction.create(documentRef(db, POLICIES_COLLECTION, policyId), {
                id: policyId,
                strategy_id: policy.strategy_id,
                symbol_id: plan.manifest.symbol_id,
                sizing_mode: 'WEBHOOK_CAPPED',
                enabled: true,
                max_abs_position: policy.max_abs_position,
                no_flip: policy.no_flip,
                version: 1,
                created_at: now,
                updated_at: now,
            })
            transaction.create(documentRef(db, POSITIONS_COLLECTION, positionId), {
                id: positionId,
                strategy_id: policy.strategy_id,
                symbol_id: plan.manifest.symbol_id,
                confirmed_position: aggregate.confirmed_position,
                pending_delta: aggregate.pending_delta,
                status: 'READY',
                policy_version: 1,
                updated_at: now,
                reconciled_at: now,
            })
        }
        for (const expected of expectedReservations) {
            const reservationId = createStrategySymbolReservationId(expected.strategy_id, expected.symbol_id, expected.event_id)
            transaction.create(documentRef(db, RESERVATIONS_COLLECTION, reservationId), {
                id: reservationId,
                event_id: expected.event_id,
                position_id: createStrategySymbolPositionId(expected.strategy_id, expected.symbol_id),
                strategy_id: expected.strategy_id,
                symbol_id: expected.symbol_id,
                order_id: expected.order_id,
                reserved_delta: expected.reserved_delta,
                executed_delta: expected.executed_delta,
                status: 'DISPATCHED',
                policy_version: 1,
                created_at: now,
                updated_at: now,
            })
        }
        return { status: 'CREATE', writes: expectedWrites }
    })
}

const createService = (options: SizingMigrationServiceOptions): SizingMigrationService => {
    const db = options.db ?? getFirestoreClient()
    const manifest = validateManifest(options.manifest)
    const mode = options.mode ?? 'DRY_RUN'
    const now = options.now ?? (() => new Date())
    const maxTransactionWrites = options.maxTransactionWrites ?? SIZING_MIGRATION_MAX_TRANSACTION_WRITES
    const list = async (collection: string, override?: () => Promise<SizingMigrationRecordInput[]>): Promise<SnapshotRecord[]> => (
        makeRecordMap(override ? await override() : await readCollection(db, collection))
    )

    return {
        run: async () => {
            if (!manifest) {
                return {
                    project_id: typeof options.manifest?.project_id === 'string' ? options.manifest.project_id : '',
                    mode,
                    writes: 0,
                    blocked: true,
                    symbols: [],
                    issues: [issue('INVALID_MANIFEST')],
                    warnings: [],
                }
            }
            const report = createEmptyReport(manifest, mode)
            const [orderRecords, symbolRecords, policyRecords, positionRecords, reservationRecords] = await Promise.all([
                list(ORDERS_COLLECTION, options.listOrders),
                list(SYMBOLS_COLLECTION, options.listSymbols),
                list(POLICIES_COLLECTION, options.listPolicies),
                list(POSITIONS_COLLECTION, options.listPositions),
                list(RESERVATIONS_COLLECTION, options.listReservations),
            ])
            const reconstruction = reconstructSizingState(manifest, orderRecords)
            report.issues.push(...reconstruction.issues)
            report.warnings.push(...reconstruction.warnings)

            const brokerPositions = new Map<BrokerName, Position[]>()
            const brokerFailures = new Map<BrokerName, string>()
            const fetchPositions = options.fetchPositionsForReconciliation
                ?? options.positionFetcher?.fetchPositionsForReconciliation
            if (!fetchPositions) {
                for (const broker of BROKERS) brokerFailures.set(broker, 'BROKER_FETCH_FAILED')
            } else {
                await Promise.all(BROKERS.map(async (broker) => {
                    try {
                        const result = await fetchPositions(broker)
                        const validated = validateReconciliationBrokerSnapshot(broker, result)
                        if ('reason' in validated) brokerFailures.set(broker, validated.reason)
                        else brokerPositions.set(broker, validated.positions)
                    } catch {
                        brokerFailures.set(broker, 'BROKER_FETCH_FAILED')
                    }
                }))
            }

            const knownSymbols = new Set(manifest.symbols.map((symbol) => symbol.symbol_id))
            for (const positions of brokerPositions.values()) {
                for (const position of positions) {
                    const symbolId = createSymbolId(position.broker, position.ticker)
                    if (!knownSymbols.has(symbolId)) {
                        report.issues.push(issue('BROKER_ONLY_TICKER', { symbol_id: symbolId, details: { broker: position.broker, ticker: position.ticker, size: position.size, side: position.side } }))
                    }
                }
            }

            const symbolsById = mapRecords(symbolRecords)
            const policiesById = mapRecords(policyRecords)
            const positionsById = mapRecords(positionRecords)
            const reservationsBySymbol = new Map<string, SnapshotRecord[]>()
            for (const reservation of reservationRecords) {
                if (isRecord(reservation.data) && typeof reservation.data.symbol_id === 'string') {
                    const listForSymbol = reservationsBySymbol.get(reservation.data.symbol_id) ?? []
                    listForSymbol.push(reservation)
                    reservationsBySymbol.set(reservation.data.symbol_id, listForSymbol)
                }
            }

            const parsedOrderIssuesBySymbol = new Map<string, SizingMigrationIssue[]>()
            for (const migrationIssue of reconstruction.issues) {
                if (!migrationIssue.symbol_id) continue
                const listForSymbol = parsedOrderIssuesBySymbol.get(migrationIssue.symbol_id) ?? []
                listForSymbol.push(migrationIssue)
                parsedOrderIssuesBySymbol.set(migrationIssue.symbol_id, listForSymbol)
            }
            const globalReconstructionIssues = reconstruction.issues.filter((migrationIssue) => !migrationIssue.symbol_id)
            const reconstructionWarningsBySymbol = new Map<string, SizingMigrationWarning[]>()
            for (const migrationWarning of reconstruction.warnings) {
                const detailSymbolId = isRecord(migrationWarning.details) && typeof migrationWarning.details.symbol_id === 'string'
                    ? migrationWarning.details.symbol_id
                    : undefined
                const symbolId = migrationWarning.symbol_id ?? detailSymbolId
                if (!symbolId) continue
                const listForSymbol = reconstructionWarningsBySymbol.get(symbolId) ?? []
                listForSymbol.push(migrationWarning)
                reconstructionWarningsBySymbol.set(symbolId, listForSymbol)
            }

            const plans: SymbolPlan[] = []
            for (const symbolManifest of manifest.symbols) {
                const symbol = symbolsById.get(symbolManifest.symbol_id)
                const aggregates = new Map<string, SizingMigrationAggregate>()
                for (const aggregate of reconstruction.aggregates.filter((entry) => entry.symbol_id === symbolManifest.symbol_id)) {
                    aggregates.set(`${aggregate.symbol_id}\u0000${aggregate.strategy_id}`, aggregate)
                }
                // An order that cannot be assigned to a symbol is a global
                // reconstruction failure.  Do not apply an unrelated symbol
                // while the source collection is ambiguous.
                const symbolIssues = [
                    ...globalReconstructionIssues.map((migrationIssue) => ({
                        ...migrationIssue,
                        symbol_id: symbolManifest.symbol_id,
                    })),
                    ...(parsedOrderIssuesBySymbol.get(symbolManifest.symbol_id) ?? []),
                ]
                const symbolWarnings = [
                    ...(reconstructionWarningsBySymbol.get(symbolManifest.symbol_id) ?? []),
                ]
                if (!symbol || !symbolMatchesManifest(symbol, symbolManifest)) symbolIssues.push(issue('SYMBOL_INVALID', { symbol_id: symbolManifest.symbol_id }))
                if (!symbol || !constraintsMatch(symbol, symbolManifest.expected_order_constraints)) symbolIssues.push(issue('SYMBOL_CONSTRAINTS_MISMATCH', { symbol_id: symbolManifest.symbol_id }))
                if (mode === 'APPLY' && !symbolIsPaused(symbol)) symbolIssues.push(issue('SYMBOL_NOT_PAUSED', { symbol_id: symbolManifest.symbol_id }))

                const broker = parseSymbolId(symbolManifest.symbol_id)?.broker as BrokerName | undefined
                const positions = broker ? brokerPositions.get(broker) : undefined
                const brokerFailureReason = broker ? brokerFailures.get(broker) : 'BROKER_SNAPSHOT_INVALID'
                if (brokerFailureReason) symbolIssues.push(issue(brokerFailureReason, { symbol_id: symbolManifest.symbol_id }))
                if (positions && !brokerFailureReason) {
                    const decisions = decideSymbolReconciliation({
                        symbol: {
                            id: symbolManifest.symbol_id,
                            broker: broker!,
                            ticker: parseSymbolId(symbolManifest.symbol_id)!.ticker,
                            order_constraints: symbolManifest.expected_order_constraints,
                        },
                        strategyPositions: safeAggregateForReconciliation(symbolManifest, aggregates).map((aggregate) => ({
                            strategy_id: aggregate.strategy_id,
                            symbol_id: aggregate.symbol_id,
                            confirmed_position: aggregate.confirmed_position,
                            pending_delta: aggregate.pending_delta,
                            status: 'READY' as const,
                        })),
                        brokerPositions: positions,
                    })
                    if (decisions.kind === 'MISMATCH') {
                        symbolIssues.push(issue('MANUAL_TRADE_CANDIDATE', {
                            symbol_id: symbolManifest.symbol_id,
                            details: {
                                broker_total: decisions.totals.brokerPositionTotal,
                                confirmed_total: decisions.totals.strategyConfirmedTotal,
                                pending_total: decisions.totals.strategyPendingTotal,
                                delta: decisions.totals.delta,
                                quantity_step: decisions.totals.quantityStep,
                            },
                        }))
                    } else if (decisions.kind === 'INDETERMINATE') {
                        symbolIssues.push(issue(decisions.reason, { symbol_id: symbolManifest.symbol_id }))
                    }
                }

                const expectedAggregates = safeAggregateForReconciliation(symbolManifest, aggregates)
                for (const policy of symbolManifest.policies) {
                    const aggregate = expectedAggregates.find((entry) => entry.strategy_id === policy.strategy_id)
                    if (!aggregate) continue
                    const effectivePosition = addQuantities(aggregate.confirmed_position, aggregate.pending_delta)
                    const confirmedComparison = compareQuantities(
                        Math.abs(aggregate.confirmed_position),
                        policy.max_abs_position,
                        symbolManifest.expected_order_constraints.quantity_step,
                    )
                    const effectiveComparison = effectivePosition === null
                        ? null
                        : compareQuantities(
                            Math.abs(effectivePosition),
                            policy.max_abs_position,
                            symbolManifest.expected_order_constraints.quantity_step,
                        )
                    if (confirmedComparison === 1 || effectiveComparison === 1) {
                        symbolWarnings.push(warning('MAX_ABS_POSITION_EXCEEDED', {
                            symbol_id: symbolManifest.symbol_id,
                            strategy_id: policy.strategy_id,
                            details: {
                                confirmed_position: aggregate.confirmed_position,
                                pending_delta: aggregate.pending_delta,
                                effective_position: effectivePosition,
                                max_abs_position: policy.max_abs_position,
                            },
                        }))
                    }
                }
                const policyMap = new Map<string, SnapshotRecord>()
                const positionMap = new Map<string, SnapshotRecord>()
                for (const policy of symbolManifest.policies) {
                    const policyId = createStrategySymbolPolicyId(policy.strategy_id, symbolManifest.symbol_id)
                    const positionId = createStrategySymbolPositionId(policy.strategy_id, symbolManifest.symbol_id)
                    const policyRecord = policiesById.get(policyId)
                    const positionRecord = positionsById.get(positionId)
                    if (policyRecord) policyMap.set(policy.strategy_id, policyRecord)
                    if (positionRecord) positionMap.set(policy.strategy_id, positionRecord)
                    if (policyRecord && !parseExistingPolicy(policyRecord, policy.strategy_id, symbolManifest.symbol_id)) symbolIssues.push(issue('INVALID_STORED_POLICY', { symbol_id: symbolManifest.symbol_id, strategy_id: policy.strategy_id }))
                    if (positionRecord && !parseExistingPosition(positionRecord, policy.strategy_id, symbolManifest.symbol_id)) symbolIssues.push(issue('INVALID_STORED_POSITION', { symbol_id: symbolManifest.symbol_id, strategy_id: policy.strategy_id }))
                }
                const expectedPolicyIds = new Set(symbolManifest.policies.map((policy) => createStrategySymbolPolicyId(policy.strategy_id, symbolManifest.symbol_id)))
                const expectedPositionIds = new Set(symbolManifest.policies.map((policy) => createStrategySymbolPositionId(policy.strategy_id, symbolManifest.symbol_id)))
                for (const record of policyRecords) {
                    if (isRecord(record.data) && record.data.symbol_id === symbolManifest.symbol_id && !expectedPolicyIds.has(record.id)) {
                        symbolIssues.push(issue('EXISTING_STATE_CONFLICT', { symbol_id: symbolManifest.symbol_id, details: { document_id: record.id, collection: POLICIES_COLLECTION } }))
                    }
                }
                for (const record of positionRecords) {
                    if (isRecord(record.data) && record.data.symbol_id === symbolManifest.symbol_id && !expectedPositionIds.has(record.id)) {
                        symbolIssues.push(issue('EXISTING_STATE_CONFLICT', { symbol_id: symbolManifest.symbol_id, details: { document_id: record.id, collection: POSITIONS_COLLECTION } }))
                    }
                }
                const reservationMap = new Map<string, SnapshotRecord>()
                const expectedReservations = expectedAggregates.flatMap((aggregate) => aggregate.pending_reservations)
                for (const reservation of reservationsBySymbol.get(symbolManifest.symbol_id) ?? []) reservationMap.set(reservation.id, reservation)
                for (const expected of expectedReservations) {
                    const reservationId = createStrategySymbolReservationId(expected.strategy_id, expected.symbol_id, expected.event_id)
                    const current = reservationMap.get(reservationId)
                    if (current && !parseExistingReservation(current, expected)) symbolIssues.push(issue('INVALID_STORED_RESERVATION', { symbol_id: symbolManifest.symbol_id, strategy_id: expected.strategy_id, order_id: expected.order_id }))
                }
                const expectedCount = symbolManifest.policies.length * 2 + expectedReservations.length
                const existingCount = policyMap.size + positionMap.size + reservationMap.size
                if (expectedCount > maxTransactionWrites && existingCount !== expectedCount) {
                    symbolIssues.push(issue('TRANSACTION_WRITE_LIMIT_EXCEEDED', {
                        symbol_id: symbolManifest.symbol_id,
                        details: {
                            expected_writes: expectedCount,
                            max_writes: maxTransactionWrites,
                        },
                    }))
                }
                const stateConflict = existingCount !== 0 && existingCount !== expectedCount ||
                    (existingCount === expectedCount && (
                        [...policyMap.values()].some((record) => {
                            const policy = symbolManifest.policies.find((candidate) => record.id === createStrategySymbolPolicyId(candidate.strategy_id, symbolManifest.symbol_id))
                            const parsed = policy ? parseExistingPolicy(record, policy.strategy_id, symbolManifest.symbol_id) : null
                            return !policy || !parsed || !policyCoreMatches(parsed, policy, symbolManifest.symbol_id)
                        }) ||
                        expectedAggregates.some((aggregate) => {
                            const record = positionMap.get(aggregate.strategy_id)
                            const parsed = record ? parseExistingPosition(record, aggregate.strategy_id, symbolManifest.symbol_id) : null
                            return !parsed || !positionCoreMatches(parsed, aggregate)
                        }) ||
                        reservationMap.size !== expectedReservations.length ||
                        expectedReservations.some((expected) => {
                            const record = reservationMap.get(createStrategySymbolReservationId(expected.strategy_id, expected.symbol_id, expected.event_id))
                            const parsed = record ? parseExistingReservation(record, expected) : null
                            return !parsed || !reservationCoreMatches(parsed, expected)
                        })
                    )) ||
                    symbolIssues.some((migrationIssue) => (
                        migrationIssue.reason === 'INVALID_STORED_POLICY' ||
                        migrationIssue.reason === 'INVALID_STORED_POSITION' ||
                        migrationIssue.reason === 'INVALID_STORED_RESERVATION' ||
                        migrationIssue.reason === 'EXISTING_STATE_CONFLICT'
                    ))
                if (stateConflict) symbolIssues.push(issue('EXISTING_STATE_CONFLICT', { symbol_id: symbolManifest.symbol_id }))
                const plannedWrites = existingCount === 0 ? expectedCount : 0
                plans.push({
                    manifest: symbolManifest,
                    symbol,
                    aggregates,
                    brokerPositions: positions,
                    brokerFailureReason,
                    issues: uniqueIssues(symbolIssues),
                    warnings: symbolWarnings,
                    existing: { policies: policyMap, positions: positionMap, reservations: reservationMap },
                    expectedDocuments: expectedCount,
                    existingDocuments: existingCount,
                    plannedWrites,
                    stateConflict,
                })
            }

            for (const plan of plans) {
                const result: SizingMigrationSymbolResult = {
                    symbol_id: plan.manifest.symbol_id,
                    status: plan.issues.length > 0 ? (plan.stateConflict ? 'CONFLICT' : 'BLOCKED') : plan.existingDocuments === plan.expectedDocuments ? 'NO_OP' : mode === 'APPLY' ? 'APPLIED' : 'CREATE',
                    planned_writes: plan.plannedWrites,
                    issues: plan.issues,
                    warnings: plan.warnings,
                }
                if (mode === 'APPLY' && plan.issues.length === 0 &&
                    (result.status === 'APPLIED' || result.status === 'NO_OP')) {
                    try {
                        const applied = await runSymbolTransaction(db, plan, safeNow(now), maxTransactionWrites)
                        result.status = applied.status === 'CREATE' ? 'APPLIED' : 'NO_OP'
                        report.writes += applied.writes
                    } catch (error) {
                        result.status = error instanceof Error && error.message === 'EXISTING_STATE_CONFLICT' ? 'CONFLICT' : 'CONFLICT'
                        result.issues.push(issue(error instanceof Error ? error.message : 'TRANSACTION_FAILED', { symbol_id: plan.manifest.symbol_id }))
                    }
                }
                report.symbols.push(result)
            }
            report.issues.push(...report.symbols.flatMap((symbol) => symbol.issues))
            report.warnings.push(...plans.flatMap((plan) => plan.warnings))
            report.issues = uniqueIssues(report.issues)
            report.warnings = uniqueWarnings(report.warnings)
            report.blocked = report.issues.length > 0 || report.symbols.some((symbol) => symbol.status === 'BLOCKED' || symbol.status === 'CONFLICT')
            options.logger?.info?.({ event: 'sizing_migration:summary', ...report }, 'sizing migration completed')
            return report
        },
    }
}

/** Create an injectable sizing migration service. */
export const createSizingMigrationService = (
    options: SizingMigrationServiceOptions,
): SizingMigrationService => createService(options)

/** Run one dry-run or apply migration. */
export const runSizingMigration = async (
    options: SizingMigrationServiceOptions,
): Promise<SizingMigrationReport> => createService(options).run()
