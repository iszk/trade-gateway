import { FieldValue, type DocumentReference, type Firestore, type Transaction } from 'firebase-admin/firestore'

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
import {
    deserializeStrategySymbolPosition,
} from './strategy-symbol-positions.js'
import type { PositionFetcher } from './position-fetcher.js'

const SYMBOL_COLLECTION = 'tradable_symbols'
const POSITION_COLLECTION = 'strategy_symbol_positions'
const ALL_BROKERS: readonly BrokerName[] = ['bitflyer', 'saxo', 'dummy']
const POSITION_STATUSES: readonly StrategySymbolPositionStatus[] = ['READY', 'MANUAL_REVIEW', 'MISMATCH']

/** Ownership markers used when reconciliation pauses a symbol. */
export const RECONCILIATION_PAUSE_REASON = 'strategy_symbol_reconciliation:mismatch'
export const RECONCILIATION_PAUSE_UPDATED_BY = 'strategy-symbol-reconciliation'

type ReconciliationFailureReason =
    | 'SYMBOL_LIST_FAILED'
    | 'POSITION_LIST_FAILED'
    | 'BROKER_FETCH_FAILED'
    | 'BROKER_SNAPSHOT_INVALID'
    | 'SYMBOL_INVALID'
    | 'SYMBOL_CONSTRAINTS_INVALID'
    | 'POSITION_INVALID'
    | 'ARITHMETIC_OVERFLOW'
    | 'NOT_FOUND'
    | 'TRANSACTION_FAILED'

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

type MatchDecision = Extract<SymbolReconciliationDecision, { kind: 'MATCH' }>

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
    checked: number
    matched: number
    mismatched: number
    indeterminate: number
    recoveryReady: number
    stateTransitionFailed: number
    orphanBrokerPositions: number
    brokers: ReconciliationRunBrokerSummary[]
    mismatches: ReconciliationMismatchDetail[]
    truncatedCount: number
}

export type RunStrategySymbolReconciliationFn = () => Promise<ReconciliationRunSummary>

type RecoverStrategySymbolResult =
    | { kind: 'RECOVERED'; decision: MatchDecision; transitionedPositions: number }
    | {
        kind: 'RECOVERED_STILL_OPERATOR_PAUSED'
        decision: MatchDecision
        transitionedPositions: number
    }
    | { kind: 'NO_CHANGE'; reason: 'NOT_MISMATCH' }
    | {
        kind: 'BLOCKED'
        reason: 'STILL_MISMATCH' | 'PENDING_NOT_ZERO' | 'MANUAL_REVIEW' | 'INDETERMINATE'
    }
    | { kind: 'NOT_FOUND' }

export type RecoverStrategySymbolFn = (symbolId: string) => Promise<RecoverStrategySymbolResult>

export type StrategySymbolReconciliationServiceOptions = {
    db?: Firestore
    listTradableSymbols?: ListTradableSymbolsFn
    fetchPositionsForReconciliation?: (broker: BrokerName) => Promise<Position[]>
    positionFetcher?: Pick<PositionFetcher, 'fetchPositionsForReconciliation'>
    logger?: Pick<Logger, 'info' | 'warn'>
    now?: () => Date
    maxMismatchDetails?: number
}

type ReconciliationService = {
    runStrategySymbolReconciliation: RunStrategySymbolReconciliationFn
    recoverStrategySymbol: RecoverStrategySymbolFn
}

type SymbolState = {
    id: string
    broker: BrokerName
    ticker: string
    constraints?: OrderConstraints
    tradeControl: {
        status: 'active' | 'paused'
        reason?: string
        updatedBy?: string
        updatedAt: Date
    }
    updatedAt: Date
}

type SymbolStateResult =
    | { ok: true; state: SymbolState }
    | { ok: false; canPause: false; reason: ReconciliationFailureReason }
    | {
        ok: false
        canPause: true
        state: SymbolState
        reason: 'SYMBOL_INVALID' | 'SYMBOL_CONSTRAINTS_INVALID'
    }

const isPausableSymbolState = (
    result: SymbolStateResult,
): result is Extract<SymbolStateResult, { ok: false; canPause: true }> => (
    !result.ok && result.canPause
)

type SnapshotLike = {
    id: string
    exists: boolean
    data: () => unknown
}

type QuerySnapshotLike = {
    docs: SnapshotLike[]
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

const safeDateAfter = (candidate: Date, previous: Date): Date => (
    candidate.getTime() > previous.getTime()
        ? new Date(candidate.getTime())
        : new Date(previous.getTime() + 1)
)

// A malformed persisted timestamp must never be copied back into Firestore.
// This value is only an internal ordering baseline for the minimal pause
// state; updatePauseIfNeeded always replaces both persisted timestamps with
// the current reconciliation time.
const INVALID_TIMESTAMP_BASELINE = new Date(0)

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
    if (!isRecord(value)) return { ok: false, canPause: false, reason: 'SYMBOL_INVALID' }

    if (typeof expectedSymbolId !== 'string') return { ok: false, canPause: false, reason: 'SYMBOL_INVALID' }
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
        return { ok: false, canPause: false, reason: 'SYMBOL_INVALID' }
    }

    const tradeControl = value.trade_control
    if (!isRecord(tradeControl) ||
        (tradeControl.status !== 'active' && tradeControl.status !== 'paused')) {
        return { ok: false, canPause: false, reason: 'SYMBOL_INVALID' }
    }
    const tradeControlUpdatedAt = toDate(tradeControl.updated_at)
    const updatedAt = toDate(value.updated_at)
    const reasonIsValid = tradeControl.reason === undefined || typeof tradeControl.reason === 'string'
    const updatedByIsValid = tradeControl.updated_by === undefined || typeof tradeControl.updated_by === 'string'
    const minimalState: SymbolState = {
        id: expectedSymbolId,
        broker,
        ticker,
        tradeControl: {
            status: tradeControl.status,
            ...(typeof tradeControl.reason === 'string' ? { reason: tradeControl.reason } : {}),
            ...(typeof tradeControl.updated_by === 'string' ? { updatedBy: tradeControl.updated_by } : {}),
            updatedAt: tradeControlUpdatedAt ?? INVALID_TIMESTAMP_BASELINE,
        },
        updatedAt: updatedAt ?? INVALID_TIMESTAMP_BASELINE,
    }
    if (tradeControlUpdatedAt === null || updatedAt === null || !reasonIsValid || !updatedByIsValid) {
        return { ok: false, canPause: true, state: minimalState, reason: 'SYMBOL_INVALID' }
    }

    let constraints: OrderConstraints | undefined
    try {
        constraints = deserializeTradableSymbolOrderConstraints(value, expectedSymbolId)
    } catch {
        return {
            ok: false,
            canPause: true,
            state: minimalState,
            reason: 'SYMBOL_CONSTRAINTS_INVALID',
        }
    }
    if (constraints !== undefined && !isValidConstraints(constraints)) {
        return {
            ok: false,
            canPause: true,
            state: { ...minimalState, constraints },
            reason: 'SYMBOL_CONSTRAINTS_INVALID',
        }
    }
    if (constraints === undefined) {
        return {
            ok: false,
            canPause: true,
            state: minimalState,
            reason: 'SYMBOL_CONSTRAINTS_INVALID',
        }
    }

    return {
        ok: true,
        state: { ...minimalState, constraints },
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

/** Aggregate strategy and broker quantities for one broker symbol. */
export const aggregateSymbolReconciliation = (
    input: StrategySymbolReconciliationInput,
): ReconciliationTotals | null => {
    const parsedId = parseSymbolId(input.symbol.id)
    if (
        parsedId === null ||
        !isBrokerName(input.symbol.broker) ||
        parsedId.broker !== input.symbol.broker ||
        parsedId.ticker !== input.symbol.ticker ||
        !isValidTicker(input.symbol.ticker) ||
        !isValidConstraints(input.symbol.order_constraints)
    ) return null

    let confirmedTotal = 0
    let pendingTotal = 0
    const statusCounts = emptyStatusCounts()
    for (const position of input.strategyPositions) {
        if (
            position.symbol_id !== input.symbol.id ||
            typeof position.strategy_id !== 'string' ||
            position.strategy_id.trim().length === 0 ||
            !isFiniteQuantity(position.confirmed_position) ||
            !isFiniteQuantity(position.pending_delta) ||
            !isPositionStatus(position.status)
        ) return null
        const nextConfirmed = addQuantities(confirmedTotal, position.confirmed_position)
        const nextPending = addQuantities(pendingTotal, position.pending_delta)
        if (nextConfirmed === null || nextPending === null) return null
        confirmedTotal = nextConfirmed
        pendingTotal = nextPending
        statusCounts[position.status] += 1
    }

    let brokerTotal = 0
    for (const position of input.brokerPositions) {
        if (
            !isRecord(position) ||
            position.broker !== input.symbol.broker ||
            !isValidTicker(position.ticker) ||
            (position.side !== 'BUY' && position.side !== 'SELL') ||
            !isFiniteQuantity(position.size) ||
            position.size < 0
        ) return null
        if (position.ticker !== input.symbol.ticker) continue
        const signed = signedSize(position.size, position.side)
        if (signed === null) return null
        const nextBroker = addQuantities(brokerTotal, signed)
        if (nextBroker === null) return null
        brokerTotal = nextBroker
    }

    const effectiveTotal = addQuantities(confirmedTotal, pendingTotal)
    const delta = subtractQuantities(brokerTotal, confirmedTotal)
    if (effectiveTotal === null || delta === null) return null

    return {
        symbolId: input.symbol.id,
        broker: input.symbol.broker,
        ticker: input.symbol.ticker,
        quantityStep: input.symbol.order_constraints.quantity_step,
        strategyConfirmedTotal: confirmedTotal,
        strategyPendingTotal: pendingTotal,
        strategyEffectiveTotal: effectiveTotal,
        brokerPositionTotal: brokerTotal,
        delta,
        strategyCount: input.strategyPositions.length,
        statusCounts,
    }
}

/** Decide MATCH/MISMATCH using only confirmed position; pending is audit data. */
export const decideSymbolReconciliation = (
    input: StrategySymbolReconciliationInput,
): SymbolReconciliationDecision => {
    const totals = aggregateSymbolReconciliation(input)
    if (totals === null) {
        return { kind: 'INDETERMINATE', reason: 'ARITHMETIC_OVERFLOW' }
    }
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
    recoveryReady: 0,
    stateTransitionFailed: 0,
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

const isReconciliationOwnedPause = (state: SymbolState): boolean => (
    state.tradeControl.status === 'paused' &&
    state.tradeControl.reason === RECONCILIATION_PAUSE_REASON &&
    state.tradeControl.updatedBy === RECONCILIATION_PAUSE_UPDATED_BY
)

const updatePauseIfNeeded = (
    transaction: Transaction,
    symbolRef: DocumentReference,
    state: SymbolState,
    now: Date,
): boolean => {
    if (state.tradeControl.status === 'paused') {
        return false
    }
    const updatedAt = safeDateAfter(now, state.updatedAt)
    transaction.update(symbolRef, {
        'trade_control.status': 'paused',
        'trade_control.reason': RECONCILIATION_PAUSE_REASON,
        'trade_control.updated_at': updatedAt,
        'trade_control.updated_by': RECONCILIATION_PAUSE_UPDATED_BY,
        updated_at: updatedAt,
    })
    return true
}

const readTransactionPositions = async (
    db: Firestore,
    transaction: Transaction,
    symbolId: string,
): Promise<{ positions: StrategySymbolPosition[]; invalid: boolean }> => {
    const query = db.collection(POSITION_COLLECTION).where('symbol_id', '==', symbolId)
    const snapshot = await transaction.get(query) as unknown as QuerySnapshotLike
    const positions: StrategySymbolPosition[] = []
    let invalid = false
    for (const document of snapshot.docs) {
        try {
            positions.push(parseStoredPositionSnapshot(document))
        } catch {
            invalid = true
        }
    }
    return { positions, invalid }
}

type ApplyMismatchResult =
    | { kind: 'APPLIED'; transitionedPositions: number }
    | { kind: 'NO_CHANGE' }
    | { kind: 'INDETERMINATE' }

const applyMismatchTransaction = async (
    db: Firestore,
    symbolId: string,
    brokerPositions: readonly Position[],
    now: Date,
): Promise<ApplyMismatchResult> => db.runTransaction(async (transaction) => {
    const symbolRef = db.collection(SYMBOL_COLLECTION).doc(symbolId)
    const symbolSnapshot = await transaction.get(symbolRef) as unknown as SnapshotLike
    if (!symbolSnapshot.exists) return { kind: 'INDETERMINATE' }
    const symbolResult = parseSymbolState(symbolSnapshot.data(), symbolId)
    if (!symbolResult.ok && !isPausableSymbolState(symbolResult)) return { kind: 'INDETERMINATE' }
    const state = symbolResult.state
    const storedPositions = await readTransactionPositions(db, transaction, symbolId)

    if (storedPositions.invalid) {
        // A valid symbol with a corrupt strategy position is still safe to
        // pause, but the malformed position itself must never be guessed or
        // rewritten.
        updatePauseIfNeeded(transaction, symbolRef, state, now)
        return { kind: 'APPLIED', transitionedPositions: 0 }
    }
    if (!symbolResult.ok) {
        if (isPausableSymbolState(symbolResult)) {
            updatePauseIfNeeded(transaction, symbolRef, state, now)
            return { kind: 'APPLIED', transitionedPositions: 0 }
        }
        return { kind: 'INDETERMINATE' }
    }

    const decision = decideSymbolReconciliation({
        symbol: {
            id: state.id,
            broker: state.broker,
            ticker: state.ticker,
            order_constraints: state.constraints,
        },
        strategyPositions: storedPositions.positions,
        brokerPositions,
    })
    if (decision.kind === 'MATCH') {
        // A later MATCH only makes a symbol eligible for explicit recovery;
        // regular reconciliation must remain write-free.
        return { kind: 'NO_CHANGE' }
    }
    if (decision.kind === 'INDETERMINATE') {
        updatePauseIfNeeded(transaction, symbolRef, state, now)
        return { kind: 'APPLIED', transitionedPositions: 0 }
    }

    let transitionedPositions = 0
    for (const position of storedPositions.positions) {
        if (position.status !== 'READY') continue
        const positionRef = db.collection(POSITION_COLLECTION).doc(position.id)
        const updatedAt = safeDateAfter(now, position.updated_at)
        transaction.update(positionRef, {
            status: 'MISMATCH',
            updated_at: updatedAt,
            reconciled_at: updatedAt,
        })
        transitionedPositions += 1
    }
    updatePauseIfNeeded(transaction, symbolRef, state, now)
    return { kind: 'APPLIED', transitionedPositions }
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
    // Read raw symbol documents here instead of using the normal symbol
    // repository parser.  Reconciliation must be able to distinguish a
    // single malformed constraint document (which can still be safely paused)
    // from a collection read failure (which must leave all state untouched).
    const listTradableSymbols = options.listTradableSymbols ?? (async (): Promise<TradableSymbol[]> => {
        const snapshot = await db.collection(SYMBOL_COLLECTION).get()
        return snapshot.docs.map((document) => document.data() as TradableSymbol)
    })
    const fetchPositions = options.fetchPositionsForReconciliation
        ?? options.positionFetcher?.fetchPositionsForReconciliation
        ?? (async (_broker: BrokerName) => { throw new Error('reconciliation position fetcher is not configured') })
    const logger = options.logger ?? defaultLogger
    const now = options.now ?? (() => new Date())
    const maxMismatchDetails = options.maxMismatchDetails ?? 100

    const parseListedSymbol = (symbol: TradableSymbol): SymbolStateResult => parseSymbolState(symbol, symbol.id)

    const runStrategySymbolReconciliation: RunStrategySymbolReconciliationFn = async () => {
        const summary = createEmptySummary()
        let symbols: TradableSymbol[]
        try {
            symbols = await listTradableSymbols()
        } catch (error) {
            summary.indeterminate += 1
            logger.warn({ event: 'strategy_symbol_reconciliation:run_summary', reason: 'SYMBOL_LIST_FAILED', error }, 'symbol reconciliation could not list symbols')
            return summary
        }

        let storedPositions: StoredPositionsResult
        try {
            storedPositions = await readStoredPositions(db)
        } catch (error) {
            summary.indeterminate += symbols.length
            logger.warn({ event: 'strategy_symbol_reconciliation:run_summary', reason: 'POSITION_LIST_FAILED', error }, 'symbol reconciliation could not list positions')
            return summary
        }

        const parsedSymbols = new Map<string, SymbolStateResult>()
        for (const symbol of symbols) {
            const parsed = parseListedSymbol(symbol)
            parsedSymbols.set(symbol.id, parsed)
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

        const knownSymbolIds = new Set(symbols.map((symbol) => symbol.id))
        for (const positions of brokerPositions.values()) {
            for (const position of positions) {
                if (!knownSymbolIds.has(createSymbolId(position.broker, position.ticker))) {
                    summary.orphanBrokerPositions += 1
                }
            }
        }

        for (const symbol of symbols) {
            summary.checked += 1
            const parsed = parsedSymbols.get(symbol.id)
            if (parsed === undefined || (!parsed.ok && !isPausableSymbolState(parsed))) {
                summary.indeterminate += 1
                continue
            }
            const state = parsed.state
            if (failedBrokers.has(state.broker)) {
                summary.indeterminate += 1
                continue
            }
            const positions = storedPositions.bySymbol.get(symbol.id) ?? []
            if (storedPositions.globallyInvalid || storedPositions.invalidSymbols.has(symbol.id)) {
                summary.indeterminate += 1
                try {
                    // A valid symbol can still be safely paused when one of
                    // its strategy positions is malformed.  The transaction
                    // re-reads and preserves that malformed position without
                    // attempting to infer or rewrite its quantity.
                    const result = await applyMismatchTransaction(db, symbol.id, brokerPositions.get(state.broker) ?? [], now())
                    if (result.kind === 'INDETERMINATE') summary.stateTransitionFailed += 1
                } catch (error) {
                    summary.stateTransitionFailed += 1
                    logger.warn({ event: 'strategy_symbol_reconciliation:state_transition_failed', symbol_id: symbol.id, error }, 'failed to pause invalid symbol state')
                }
                continue
            }
            if (!parsed.ok) {
                summary.indeterminate += 1
                try {
                    await applyMismatchTransaction(db, symbol.id, brokerPositions.get(state.broker) ?? [], now())
                } catch (error) {
                    summary.stateTransitionFailed += 1
                    logger.warn({ event: 'strategy_symbol_reconciliation:state_transition_failed', symbol_id: symbol.id, error }, 'failed to pause invalid symbol constraints')
                }
                continue
            }

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
                if (decision.totals.statusCounts.MISMATCH > 0 || isReconciliationOwnedPause(state)) {
                    summary.recoveryReady += 1
                }
                continue
            }

            summary.mismatched += 1
            if (summary.mismatches.length < maxMismatchDetails) {
                summary.mismatches.push(toMismatchDetail(decision.totals))
            } else {
                summary.truncatedCount += 1
            }
            try {
                const result = await applyMismatchTransaction(db, symbol.id, brokerPositions.get(state.broker) ?? [], now())
                if (result.kind === 'INDETERMINATE') summary.stateTransitionFailed += 1
            } catch (error) {
                summary.stateTransitionFailed += 1
                logger.warn({ event: 'strategy_symbol_reconciliation:state_transition_failed', symbol_id: symbol.id, error }, 'failed to apply symbol mismatch state')
            }
        }

        logger.info({ event: 'strategy_symbol_reconciliation:run_summary', ...summary }, 'strategy symbol reconciliation completed')
        return summary
    }

    const recoverStrategySymbol: RecoverStrategySymbolFn = async (symbolId) => {
        const symbolRef = db.collection(SYMBOL_COLLECTION).doc(symbolId)
        const initialSnapshot = await symbolRef.get()
        if (!initialSnapshot.exists) return { kind: 'NOT_FOUND' }
        const initialState = parseSymbolState(initialSnapshot.data(), symbolId)
        if (!initialState.ok) return { kind: 'BLOCKED', reason: 'INDETERMINATE' }

        let freshPositions: Position[]
        try {
            freshPositions = await fetchPositions(initialState.state.broker)
        } catch {
            return { kind: 'BLOCKED', reason: 'INDETERMINATE' }
        }
        const validated = validateBrokerSnapshot(initialState.state.broker, freshPositions)
        if (!validated.ok) return { kind: 'BLOCKED', reason: 'INDETERMINATE' }

        return db.runTransaction(async (transaction): Promise<RecoverStrategySymbolResult> => {
            const latestSymbolSnapshot = await transaction.get(symbolRef) as unknown as SnapshotLike
            if (!latestSymbolSnapshot.exists) return { kind: 'NOT_FOUND' }
            const latestStateResult = parseSymbolState(latestSymbolSnapshot.data(), symbolId)
            if (!latestStateResult.ok) return { kind: 'BLOCKED', reason: 'INDETERMINATE' }
            const latestState = latestStateResult.state
            const stored = await readTransactionPositions(db, transaction, symbolId)
            if (stored.invalid) return { kind: 'BLOCKED', reason: 'INDETERMINATE' }
            const mismatchCount = stored.positions.filter((position) => position.status === 'MISMATCH').length
            const reconciliationPause = isReconciliationOwnedPause(latestState)
            if (mismatchCount === 0 && !reconciliationPause) {
                return { kind: 'NO_CHANGE', reason: 'NOT_MISMATCH' }
            }

            const decision = decideSymbolReconciliation(buildPureInput(
                latestState,
                stored.positions,
                validated.positions,
            ))
            if (decision.kind === 'INDETERMINATE') return { kind: 'BLOCKED', reason: 'INDETERMINATE' }
            if (decision.kind === 'MISMATCH') return { kind: 'BLOCKED', reason: 'STILL_MISMATCH' }
            if (decision.totals.statusCounts.MANUAL_REVIEW > 0) {
                return { kind: 'BLOCKED', reason: 'MANUAL_REVIEW' }
            }
            if (compareQuantities(decision.totals.strategyPendingTotal, 0, decision.totals.quantityStep) !== 0) {
                return { kind: 'BLOCKED', reason: 'PENDING_NOT_ZERO' }
            }

            const recoveryNow = now()
            let transitionedPositions = 0
            for (const position of stored.positions) {
                if (position.status !== 'MISMATCH') continue
                const positionRef = db.collection(POSITION_COLLECTION).doc(position.id)
                const updatedAt = safeDateAfter(recoveryNow, position.updated_at)
                transaction.update(positionRef, {
                    status: 'READY',
                    updated_at: updatedAt,
                    reconciled_at: updatedAt,
                })
                transitionedPositions += 1
            }

            const operatorPaused = latestState.tradeControl.status === 'paused' && !isReconciliationOwnedPause(latestState)
            if (isReconciliationOwnedPause(latestState)) {
                const updatedAt = safeDateAfter(recoveryNow, latestState.updatedAt)
                transaction.update(symbolRef, {
                    'trade_control.status': 'active',
                    'trade_control.reason': FieldValue.delete(),
                    'trade_control.updated_by': FieldValue.delete(),
                    'trade_control.updated_at': updatedAt,
                    updated_at: updatedAt,
                })
            }
            return operatorPaused
                ? { kind: 'RECOVERED_STILL_OPERATOR_PAUSED', decision, transitionedPositions }
                : { kind: 'RECOVERED', decision, transitionedPositions }
        })
    }

    return { runStrategySymbolReconciliation, recoverStrategySymbol }
}

export const createStrategySymbolReconciliationService = (
    options: StrategySymbolReconciliationServiceOptions = {},
): ReconciliationService => createService(options)

export const createDefaultRunStrategySymbolReconciliationFn = (
    options: StrategySymbolReconciliationServiceOptions = {},
): RunStrategySymbolReconciliationFn => createService(options).runStrategySymbolReconciliation

export const createDefaultRecoverStrategySymbolFn = (
    options: StrategySymbolReconciliationServiceOptions = {},
): RecoverStrategySymbolFn => createService(options).recoverStrategySymbol
