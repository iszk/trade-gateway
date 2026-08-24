import type { Firestore } from 'firebase-admin/firestore'

import { getFirestoreClient } from '../firestore.js'
import { defaultLogger, type Logger } from '../logger.js'
import type { BrokerName } from '../types/order.js'
import type { Position } from '../types/position.js'
import type { StrategySymbolPosition, StrategySymbolPositionStatus } from '../types/strategy-symbol-position.js'
import type { OrderConstraints, TradableSymbol } from '../types/tradable-symbol.js'
import {
    addQuantities,
    compareQuantities,
    isFiniteQuantity,
    isUsableQuantityStep,
    multiplyQuantity,
    subtractQuantities,
} from './quantity.js'
import {
    createSymbolId,
    deserializeTradableSymbolOrderConstraints,
    parseSymbolId,
    type ListTradableSymbolsFn,
} from './tradable-symbols.js'
import { deserializeStrategySymbolPosition } from './strategy-symbol-positions.js'
import type { PositionFetcher } from './position-fetcher.js'

const SYMBOL_COLLECTION = 'tradable_symbols'
const POSITION_COLLECTION = 'strategy_symbol_positions'
const ALL_BROKERS: readonly BrokerName[] = ['bitflyer', 'saxo', 'dummy']
const POSITION_STATUSES: readonly StrategySymbolPositionStatus[] = ['READY', 'MANUAL_REVIEW', 'MISMATCH']

type ReconciliationFailureReason =
    | 'SYMBOL_LIST_FAILED'
    | 'POSITION_LIST_FAILED'
    | 'BROKER_FETCH_FAILED'
    | 'BROKER_SNAPSHOT_INVALID'
    | 'SYMBOL_INVALID'
    | 'SYMBOL_CONSTRAINTS_INVALID'
    | 'POSITION_INVALID'
    | 'ARITHMETIC_OVERFLOW'

type AggregationFailureReason =
    | 'BROKER_SNAPSHOT_INVALID'
    | 'SYMBOL_INVALID'
    | 'SYMBOL_CONSTRAINTS_INVALID'
    | 'POSITION_INVALID'
    | 'ARITHMETIC_OVERFLOW'

export type ReconciliationTotals = {
    symbolId: string
    broker: BrokerName
    ticker: string
    quantityStep: number
    strategyConfirmedTotal: number
    strategyPendingTotal: number
    strategyEffectiveTotal: number
    brokerPositionTotal: number
    delta: number
    strategyCount: number
    statusCounts: Record<StrategySymbolPositionStatus, number>
}

export type SymbolReconciliationDecision =
    | { kind: 'MATCH'; totals: ReconciliationTotals }
    | { kind: 'MISMATCH'; totals: ReconciliationTotals }
    | { kind: 'INDETERMINATE'; reason: ReconciliationFailureReason }

export type StrategySymbolReconciliationInput = {
    symbol: Pick<TradableSymbol, 'id' | 'broker' | 'ticker' | 'order_constraints'>
    strategyPositions: readonly Pick<
        StrategySymbolPosition,
        'strategy_id' | 'symbol_id' | 'confirmed_position' | 'pending_delta' | 'status'
    >[]
    brokerPositions: readonly Position[]
}

type ReconciliationRunBrokerSummary = {
    broker: BrokerName
    success: boolean
    positionCount: number
    reason?: ReconciliationFailureReason
}

type ReconciliationMismatchDetail = {
    symbolId: string
    confirmedTotal: number
    pendingTotal: number
    effectiveTotal: number
    brokerTotal: number
    delta: number
    quantityStep: number
    strategyCount: number
    statusCounts: Record<StrategySymbolPositionStatus, number>
}

export type ReconciliationRunSummary = {
    /** Counts evaluated symbols; matched + mismatched + indeterminate equals checked. */
    checked: number
    matched: number
    mismatched: number
    indeterminate: number
    orphanBrokerPositions: number
    brokers: ReconciliationRunBrokerSummary[]
    mismatches: ReconciliationMismatchDetail[]
    truncatedCount: number
}

export type RunStrategySymbolReconciliationFn = () => Promise<ReconciliationRunSummary>

export type StrategySymbolReconciliationServiceOptions = {
    db?: Firestore
    listTradableSymbols?: ListTradableSymbolsFn
    fetchPositionsForReconciliation?: (broker: BrokerName) => Promise<Position[]>
    positionFetcher?: Pick<PositionFetcher, 'fetchPositionsForReconciliation'>
    logger?: Pick<Logger, 'info' | 'warn'>
    maxMismatchDetails?: number
}

type ReconciliationService = {
    runStrategySymbolReconciliation: RunStrategySymbolReconciliationFn
}

type SymbolState = {
    id: string
    broker: BrokerName
    ticker: string
    constraints: OrderConstraints
}

type SymbolStateResult =
    | { ok: true; state: SymbolState }
    | { ok: false; reason: 'SYMBOL_INVALID' | 'SYMBOL_CONSTRAINTS_INVALID' }

type SnapshotLike = {
    id: string
    data: () => unknown
}

type StoredPositionsResult = {
    bySymbol: Map<string, StrategySymbolPosition[]>
    invalidSymbols: Set<string>
    globallyInvalid: boolean
}

type ValidatedBrokerSnapshot =
    | { ok: true; positions: Position[] }
    | { ok: false; reason: 'BROKER_SNAPSHOT_INVALID' }

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isBrokerName = (value: unknown): value is BrokerName => (
    value === 'bitflyer' || value === 'saxo' || value === 'dummy'
)

const isPositionStatus = (value: unknown): value is StrategySymbolPositionStatus => (
    POSITION_STATUSES.includes(value as StrategySymbolPositionStatus)
)

const toDate = (value: unknown): Date | null => {
    try {
        if (value instanceof Date) {
            return Number.isFinite(value.getTime()) ? new Date(value.getTime()) : null
        }
        if (isRecord(value) && typeof value.toDate === 'function') {
            const date = value.toDate()
            return date instanceof Date && Number.isFinite(date.getTime())
                ? new Date(date.getTime())
                : null
        }
    } catch {
        return null
    }
    return null
}

const isValidTicker = (value: unknown): value is string => (
    typeof value === 'string' && value.trim().length > 0 && !value.includes('/')
)

const isValidConstraints = (constraints: unknown): constraints is OrderConstraints => {
    if (!isRecord(constraints)) return false
    const quantityStep = constraints.quantity_step
    const minOrderSize = constraints.min_order_size
    const maxOrderSize = constraints.max_order_size
    if (!isUsableQuantityStep(quantityStep)) return false
    if (!isFiniteQuantity(minOrderSize) || minOrderSize <= 0) return false
    if (maxOrderSize !== undefined &&
        (!isFiniteQuantity(maxOrderSize) || maxOrderSize <= 0 || maxOrderSize < minOrderSize)) {
        return false
    }
    return true
}

const parseSymbolState = (value: unknown, expectedSymbolId: string): SymbolStateResult => {
    if (!isRecord(value) || typeof expectedSymbolId !== 'string') {
        return { ok: false, reason: 'SYMBOL_INVALID' }
    }

    const parsedId = parseSymbolId(expectedSymbolId)
    const broker = value.broker
    const ticker = value.ticker
    if (
        value.id !== expectedSymbolId ||
        parsedId === null ||
        !isBrokerName(broker) ||
        broker !== parsedId.broker ||
        !isValidTicker(ticker) ||
        ticker !== parsedId.ticker
    ) {
        return { ok: false, reason: 'SYMBOL_INVALID' }
    }

    const tradeControl = value.trade_control
    if (!isRecord(tradeControl) ||
        (tradeControl.status !== 'active' && tradeControl.status !== 'paused') ||
        toDate(tradeControl.updated_at) === null ||
        toDate(value.updated_at) === null ||
        (tradeControl.reason !== undefined && typeof tradeControl.reason !== 'string') ||
        (tradeControl.updated_by !== undefined && typeof tradeControl.updated_by !== 'string')) {
        return { ok: false, reason: 'SYMBOL_INVALID' }
    }

    let constraints: OrderConstraints | undefined
    try {
        constraints = deserializeTradableSymbolOrderConstraints(value, expectedSymbolId)
    } catch {
        return { ok: false, reason: 'SYMBOL_CONSTRAINTS_INVALID' }
    }
    if (constraints === undefined || !isValidConstraints(constraints)) {
        return { ok: false, reason: 'SYMBOL_CONSTRAINTS_INVALID' }
    }

    return {
        ok: true,
        state: {
            id: expectedSymbolId,
            broker,
            ticker,
            constraints,
        },
    }
}

const validateBrokerSnapshot = (
    broker: BrokerName,
    positions: unknown,
): ValidatedBrokerSnapshot => {
    if (!Array.isArray(positions)) return { ok: false, reason: 'BROKER_SNAPSHOT_INVALID' }
    for (const position of positions) {
        if (!isRecord(position) ||
            position.broker !== broker ||
            !isValidTicker(position.ticker) ||
            (position.side !== 'BUY' && position.side !== 'SELL') ||
            !isFiniteQuantity(position.size) ||
            position.size < 0) {
            return { ok: false, reason: 'BROKER_SNAPSHOT_INVALID' }
        }
    }
    return { ok: true, positions: positions as Position[] }
}

const signedSize = (size: unknown, side: unknown): number | null => {
    if (!isFiniteQuantity(size) || size < 0 || (side !== 'BUY' && side !== 'SELL')) return null
    return multiplyQuantity(size, side === 'BUY' ? 1 : -1)
}

const emptyStatusCounts = (): Record<StrategySymbolPositionStatus, number> => ({
    READY: 0,
    MANUAL_REVIEW: 0,
    MISMATCH: 0,
})

type ReconciliationAggregationResult =
    | { ok: true; totals: ReconciliationTotals }
    | { ok: false; reason: AggregationFailureReason }

/** Aggregate strategy and broker quantities for one broker symbol with a failure reason. */
const aggregateSymbolReconciliationResult = (
    input: StrategySymbolReconciliationInput,
): ReconciliationAggregationResult => {
    const symbol = input?.symbol
    if (!isRecord(symbol) || typeof symbol.id !== 'string') {
        return { ok: false, reason: 'SYMBOL_INVALID' }
    }

    const parsedId = parseSymbolId(symbol.id)
    if (
        parsedId === null ||
        !isBrokerName(symbol.broker) ||
        parsedId.broker !== symbol.broker ||
        !isValidTicker(symbol.ticker) ||
        parsedId.ticker !== symbol.ticker
    ) return { ok: false, reason: 'SYMBOL_INVALID' }
    if (!isValidConstraints(symbol.order_constraints)) {
        return { ok: false, reason: 'SYMBOL_CONSTRAINTS_INVALID' }
    }

    if (!Array.isArray(input?.strategyPositions)) {
        return { ok: false, reason: 'POSITION_INVALID' }
    }

    let confirmedTotal = 0
    let pendingTotal = 0
    const statusCounts = emptyStatusCounts()
    for (const position of input.strategyPositions) {
        if (!isRecord(position)) return { ok: false, reason: 'POSITION_INVALID' }
        if (
            position.symbol_id !== symbol.id ||
            typeof position.strategy_id !== 'string' ||
            position.strategy_id.trim().length === 0 ||
            !isFiniteQuantity(position.confirmed_position) ||
            !isFiniteQuantity(position.pending_delta) ||
            !isPositionStatus(position.status)
        ) return { ok: false, reason: 'POSITION_INVALID' }
        const nextConfirmed = addQuantities(confirmedTotal, position.confirmed_position)
        const nextPending = addQuantities(pendingTotal, position.pending_delta)
        if (nextConfirmed === null || nextPending === null) {
            return { ok: false, reason: 'ARITHMETIC_OVERFLOW' }
        }
        confirmedTotal = nextConfirmed
        pendingTotal = nextPending
        statusCounts[position.status] += 1
    }

    if (!Array.isArray(input?.brokerPositions)) {
        return { ok: false, reason: 'BROKER_SNAPSHOT_INVALID' }
    }

    let brokerTotal = 0
    for (const position of input.brokerPositions) {
        if (
            !isRecord(position) ||
            position.broker !== symbol.broker ||
            !isValidTicker(position.ticker) ||
            (position.side !== 'BUY' && position.side !== 'SELL') ||
            !isFiniteQuantity(position.size) ||
            position.size < 0
        ) return { ok: false, reason: 'BROKER_SNAPSHOT_INVALID' }
        if (position.ticker !== symbol.ticker) continue
        const signed = signedSize(position.size, position.side)
        if (signed === null) return { ok: false, reason: 'BROKER_SNAPSHOT_INVALID' }
        const nextBroker = addQuantities(brokerTotal, signed)
        if (nextBroker === null) return { ok: false, reason: 'ARITHMETIC_OVERFLOW' }
        brokerTotal = nextBroker
    }

    const effectiveTotal = addQuantities(confirmedTotal, pendingTotal)
    const delta = subtractQuantities(brokerTotal, confirmedTotal)
    if (effectiveTotal === null || delta === null) {
        return { ok: false, reason: 'ARITHMETIC_OVERFLOW' }
    }

    return {
        ok: true,
        totals: {
            symbolId: symbol.id,
            broker: symbol.broker,
            ticker: symbol.ticker,
            quantityStep: symbol.order_constraints.quantity_step,
            strategyConfirmedTotal: confirmedTotal,
            strategyPendingTotal: pendingTotal,
            strategyEffectiveTotal: effectiveTotal,
            brokerPositionTotal: brokerTotal,
            delta,
            strategyCount: input.strategyPositions.length,
            statusCounts,
        },
    }
}

/** Aggregate strategy and broker quantities for one broker symbol. */
export const aggregateSymbolReconciliation = (
    input: StrategySymbolReconciliationInput,
): ReconciliationTotals | null => {
    const result = aggregateSymbolReconciliationResult(input)
    return result.ok ? result.totals : null
}

/** Decide MATCH/MISMATCH using only confirmed position; pending is audit data. */
export const decideSymbolReconciliation = (
    input: StrategySymbolReconciliationInput,
): SymbolReconciliationDecision => {
    const aggregate = aggregateSymbolReconciliationResult(input)
    if (!aggregate.ok) {
        return { kind: 'INDETERMINATE', reason: aggregate.reason }
    }
    const totals = aggregate.totals
    const comparison = compareQuantities(
        totals.brokerPositionTotal,
        totals.strategyConfirmedTotal,
        totals.quantityStep,
    )
    if (comparison === null) {
        return { kind: 'INDETERMINATE', reason: 'SYMBOL_CONSTRAINTS_INVALID' }
    }
    return comparison === 0
        ? { kind: 'MATCH', totals }
        : { kind: 'MISMATCH', totals }
}

/** Explicit parser result for callers that need to distinguish invalid data. */
export const validateReconciliationBrokerSnapshot = (
    broker: BrokerName,
    positions: unknown,
): { ok: true; positions: Position[] } | { ok: false; reason: 'BROKER_SNAPSHOT_INVALID' } => (
    validateBrokerSnapshot(broker, positions)
)

const parseStoredPositionSnapshot = (snapshot: SnapshotLike): StrategySymbolPosition => (
    deserializeStrategySymbolPosition(snapshot.data(), snapshot.id)
)

const getCandidateSymbolFromInvalidPosition = (snapshot: SnapshotLike): string | null => {
    const value = snapshot.data()
    if (isRecord(value) && typeof value.symbol_id === 'string' && parseSymbolId(value.symbol_id) !== null) {
        return value.symbol_id
    }
    const separator = snapshot.id.indexOf(':')
    if (separator >= 0) {
        const candidate = snapshot.id.slice(separator + 1)
        return parseSymbolId(candidate) === null ? null : candidate
    }
    return null
}

const readStoredPositions = async (db: Firestore): Promise<StoredPositionsResult> => {
    const snapshot = await db.collection(POSITION_COLLECTION).get()
    const bySymbol = new Map<string, StrategySymbolPosition[]>()
    const invalidSymbols = new Set<string>()
    let globallyInvalid = false

    for (const document of snapshot.docs) {
        const asSnapshot = document as unknown as SnapshotLike
        try {
            const position = parseStoredPositionSnapshot(asSnapshot)
            const positions = bySymbol.get(position.symbol_id) ?? []
            positions.push(position)
            bySymbol.set(position.symbol_id, positions)
        } catch {
            const symbolId = getCandidateSymbolFromInvalidPosition(asSnapshot)
            if (symbolId === null) globallyInvalid = true
            else invalidSymbols.add(symbolId)
        }
    }
    return { bySymbol, invalidSymbols, globallyInvalid }
}

const createEmptySummary = (): ReconciliationRunSummary => ({
    checked: 0,
    matched: 0,
    mismatched: 0,
    indeterminate: 0,
    orphanBrokerPositions: 0,
    brokers: [],
    mismatches: [],
    truncatedCount: 0,
})

const toMismatchDetail = (totals: ReconciliationTotals): ReconciliationMismatchDetail => ({
    symbolId: totals.symbolId,
    confirmedTotal: totals.strategyConfirmedTotal,
    pendingTotal: totals.strategyPendingTotal,
    effectiveTotal: totals.strategyEffectiveTotal,
    brokerTotal: totals.brokerPositionTotal,
    delta: totals.delta,
    quantityStep: totals.quantityStep,
    strategyCount: totals.strategyCount,
    statusCounts: totals.statusCounts,
})

const buildPureInput = (
    symbol: SymbolState,
    strategyPositions: readonly StrategySymbolPosition[],
    brokerPositions: readonly Position[],
): StrategySymbolReconciliationInput => ({
    symbol: {
        id: symbol.id,
        broker: symbol.broker,
        ticker: symbol.ticker,
        order_constraints: symbol.constraints,
    },
    strategyPositions,
    brokerPositions,
})

const createService = (options: StrategySymbolReconciliationServiceOptions = {}): ReconciliationService => {
    const db = options.db ?? getFirestoreClient()
    // Reconciliation reads raw symbol documents so a malformed symbol is
    // counted as INDETERMINATE without turning the whole collection read into
    // an empty successful snapshot.  This path never writes the document.
    const listTradableSymbols = options.listTradableSymbols ?? (async (): Promise<TradableSymbol[]> => {
        const snapshot = await db.collection(SYMBOL_COLLECTION).get()
        return snapshot.docs.map((document) => document.data() as TradableSymbol)
    })
    const fetchPositions = options.fetchPositionsForReconciliation
        ?? options.positionFetcher?.fetchPositionsForReconciliation
        ?? (async (_broker: BrokerName) => { throw new Error('reconciliation position fetcher is not configured') })
    const logger = options.logger ?? defaultLogger
    const maxMismatchDetails = options.maxMismatchDetails ?? 100

    const runStrategySymbolReconciliation: RunStrategySymbolReconciliationFn = async () => {
        const summary = createEmptySummary()
        let symbols: TradableSymbol[]
        try {
            symbols = await listTradableSymbols()
        } catch (error) {
            // No symbol was observed, so per-symbol counters remain zero. The
            // collection-level failure reason is carried by the warning log.
            logger.warn({ event: 'strategy_symbol_reconciliation:run_summary', reason: 'SYMBOL_LIST_FAILED', ...summary, error }, 'symbol reconciliation could not list symbols')
            return summary
        }

        let storedPositions: StoredPositionsResult
        try {
            storedPositions = await readStoredPositions(db)
        } catch (error) {
            summary.checked = symbols.length
            summary.indeterminate += symbols.length
            logger.warn({ event: 'strategy_symbol_reconciliation:run_summary', reason: 'POSITION_LIST_FAILED', ...summary, error }, 'symbol reconciliation could not list positions')
            return summary
        }

        const parsedSymbols = new Map<string, SymbolStateResult>()
        for (const symbol of symbols) {
            const symbolRecord = isRecord(symbol) ? symbol : {}
            const symbolId = isRecord(symbol) && typeof symbol.id === 'string' ? symbol.id : ''
            parsedSymbols.set(symbolId, parseSymbolState(symbolRecord, symbolId))
        }

        const brokerPositions = new Map<BrokerName, Position[]>()
        const failedBrokers = new Set<BrokerName>()
        const brokerTasks = ALL_BROKERS.map(async (broker): Promise<ReconciliationRunBrokerSummary> => {
            try {
                const fetched = await fetchPositions(broker)
                const validation = validateBrokerSnapshot(broker, fetched)
                if (!validation.ok) {
                    failedBrokers.add(broker)
                    return { broker, success: false, positionCount: 0, reason: validation.reason }
                }
                brokerPositions.set(broker, validation.positions)
                return { broker, success: true, positionCount: validation.positions.length }
            } catch {
                failedBrokers.add(broker)
                return { broker, success: false, positionCount: 0, reason: 'BROKER_FETCH_FAILED' }
            }
        })
        summary.brokers = await Promise.all(brokerTasks)

        const knownSymbolIds = new Set(symbols
            .filter((symbol) => isRecord(symbol) && typeof symbol.id === 'string')
            .map((symbol) => symbol.id))
        for (const positions of brokerPositions.values()) {
            for (const position of positions) {
                if (!knownSymbolIds.has(createSymbolId(position.broker, position.ticker))) {
                    summary.orphanBrokerPositions += 1
                }
            }
        }

        for (const symbol of symbols) {
            const symbolId = isRecord(symbol) && typeof symbol.id === 'string' ? symbol.id : ''
            summary.checked += 1
            const parsed = parsedSymbols.get(symbolId)
            if (parsed === undefined || !parsed.ok) {
                summary.indeterminate += 1
                continue
            }

            const state = parsed.state
            if (failedBrokers.has(state.broker)) {
                summary.indeterminate += 1
                continue
            }

            if (storedPositions.globallyInvalid || storedPositions.invalidSymbols.has(symbolId)) {
                summary.indeterminate += 1
                continue
            }

            const positions = storedPositions.bySymbol.get(symbolId) ?? []
            const decision = decideSymbolReconciliation(buildPureInput(
                state,
                positions,
                brokerPositions.get(state.broker) ?? [],
            ))
            if (decision.kind === 'INDETERMINATE') {
                summary.indeterminate += 1
                continue
            }
            if (decision.kind === 'MATCH') {
                summary.matched += 1
                continue
            }

            summary.mismatched += 1
            if (summary.mismatches.length < maxMismatchDetails) {
                summary.mismatches.push(toMismatchDetail(decision.totals))
            } else {
                summary.truncatedCount += 1
            }
        }

        logger.info({ event: 'strategy_symbol_reconciliation:run_summary', ...summary }, 'strategy symbol reconciliation completed')
        return summary
    }

    return { runStrategySymbolReconciliation }
}

export const createStrategySymbolReconciliationService = (
    options: StrategySymbolReconciliationServiceOptions = {},
): ReconciliationService => createService(options)

export const createDefaultRunStrategySymbolReconciliationFn = (
    options: StrategySymbolReconciliationServiceOptions = {},
): RunStrategySymbolReconciliationFn => createService(options).runStrategySymbolReconciliation
