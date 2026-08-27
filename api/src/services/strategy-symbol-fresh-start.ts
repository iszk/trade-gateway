import type {
    DocumentReference,
    Firestore,
    Query,
} from 'firebase-admin/firestore'

import { getFirestoreClient } from '../firestore.js'
import { omitUndefinedFields } from '../omit-undefined-fields.js'
import type { OrderV2 } from '../types/order-v2.js'
import type { StrategySymbolPolicy } from '../types/strategy-symbol-policy.js'
import type { StrategySymbolPosition } from '../types/strategy-symbol-position.js'
import type { OrderConstraints } from '../types/tradable-symbol.js'
import {
    createStrategySymbolPolicyId,
    deserializeStrategySymbolPolicy,
    validateStrategySymbolPolicyInput,
} from './strategy-symbol-policies.js'
import {
    createStrategySymbolPositionId,
    deserializeStrategySymbolPosition,
} from './strategy-symbol-positions.js'
import {
    deserializeStrategySymbolReservation,
} from './strategy-symbol-reservations.js'
import { isCanonicalStrategyId, resolveEffectiveStrategyId, resolveLegacyStrategyId } from './strategy-ids.js'
import { parseSymbolId } from './tradable-symbols.js'

const ORDERS_COLLECTION = 'orders_v2'
const SYMBOLS_COLLECTION = 'tradable_symbols'
const POLICIES_COLLECTION = 'strategy_symbol_policies'
const POSITIONS_COLLECTION = 'strategy_symbol_positions'
const RESERVATIONS_COLLECTION = 'strategy_symbol_reservations'

const ORDER_STATUSES = new Set<OrderV2['status']>(['PENDING', 'EXECUTED', 'FAILED', 'CANCELED'])

/** One strategy × symbol can be initialized by a single request only. */
export type FreshStartStrategySymbolInput = {
    strategyId: string
    symbolId: string
    sizingMode: 'WEBHOOK_CAPPED'
    maxAbsPosition: number
    noFlip: boolean
    apply?: boolean
    confirmProject?: string
}

export type FreshStartIssue = {
    reason: string
    strategy_id: string
    symbol_id: string
    order_id?: string
    document_id?: string
    details?: Record<string, unknown>
}

export type FreshStartStrategySymbolResult = {
    status: 'CREATE' | 'APPLIED'
    mode: 'DRY_RUN' | 'APPLY'
    strategy_id: string
    symbol_id: string
    sizing_mode: 'WEBHOOK_CAPPED'
    max_abs_position: number
    no_flip: boolean
    symbol_status: 'active' | 'paused'
    /** Apply must be run after pausing an active symbol. */
    requires_pause: boolean
    policy?: StrategySymbolPolicy
    position?: StrategySymbolPosition
    issues: FreshStartIssue[]
}

export type FreshStartStrategySymbolFn = (
    input: FreshStartStrategySymbolInput,
) => Promise<FreshStartStrategySymbolResult>

export type FreshStartStrategySymbolServiceOptions = {
    db?: Firestore
    projectId?: string
    now?: () => Date
}

export class InvalidFreshStartStrategySymbolInputError extends Error {
    readonly code = 'INVALID_FRESH_START'

    constructor(message: string) {
        super(message)
        this.name = 'InvalidFreshStartStrategySymbolInputError'
    }
}

export class FreshStartSymbolNotFoundError extends Error {
    readonly code = 'SYMBOL_NOT_FOUND'

    constructor(symbolId: string) {
        super(`symbol is not found: ${symbolId}`)
        this.name = 'FreshStartSymbolNotFoundError'
    }
}

export class FreshStartProjectConfirmationError extends Error {
    readonly code: 'PROJECT_CONFIRMATION_REQUIRED' | 'PROJECT_MISMATCH' | 'PROJECT_ID_UNAVAILABLE'

    constructor(code: 'PROJECT_CONFIRMATION_REQUIRED' | 'PROJECT_MISMATCH' | 'PROJECT_ID_UNAVAILABLE', message: string) {
        super(message)
        this.name = 'FreshStartProjectConfirmationError'
        this.code = code
    }
}

export class FreshStartAlreadyExistsError extends Error {
    readonly code = 'ALREADY_EXISTS'
    readonly issues: FreshStartIssue[]

    constructor(issues: FreshStartIssue[]) {
        super('strategy-symbol sizing ledger already exists')
        this.name = 'FreshStartAlreadyExistsError'
        this.issues = issues
    }
}

export class FreshStartConflictError extends Error {
    readonly code = 'CONFLICT'
    readonly issues: FreshStartIssue[]

    constructor(issues: FreshStartIssue[]) {
        super('strategy-symbol sizing ledger cannot be initialized safely')
        this.name = 'FreshStartConflictError'
        this.issues = issues
    }
}

/** The request is well-formed JSON but violates the symbol's quantity rules. */
export class InvalidFreshStartPolicyError extends Error {
    readonly code = 'INVALID_REQUEST'

    constructor(message: string) {
        super(message)
        this.name = 'InvalidFreshStartPolicyError'
    }
}

export class FreshStartSymbolNotPausedError extends Error {
    readonly code = 'SYMBOL_NOT_PAUSED'

    constructor(symbolId: string) {
        super(`symbol must be paused before apply: ${symbolId}`)
        this.name = 'FreshStartSymbolNotPausedError'
    }
}

type RecordLike = Record<string, unknown>

type SnapshotLike = {
    id: string
    exists: boolean
    data: () => unknown
}

type QuerySnapshotLike = {
    docs: SnapshotLike[]
}

type Reader = {
    get: (ref: DocumentReference | Query) => Promise<SnapshotLike | QuerySnapshotLike>
}

type StoredState = {
    symbol: RecordLike
    symbolStatus: 'active' | 'paused'
    constraints: OrderConstraints
    policy: SnapshotLike | undefined
    position: SnapshotLike | undefined
    orders: SnapshotLike[]
    reservations: SnapshotLike[]
}

const isRecord = (value: unknown): value is RecordLike => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isFiniteNumber = (value: unknown): value is number => (
    typeof value === 'number' && Number.isFinite(value)
)

const isFinitePositiveNumber = (value: unknown): value is number => (
    isFiniteNumber(value) && value > 0
)

const isDateLike = (value: unknown): boolean => {
    try {
        if (value instanceof Date) return Number.isFinite(value.getTime())
        return isRecord(value) && typeof value.toDate === 'function' && Number.isFinite(value.toDate().getTime())
    } catch {
        return false
    }
}

const assertInput = (input: FreshStartStrategySymbolInput): void => {
    if (!isRecord(input)) throw new InvalidFreshStartStrategySymbolInputError('input is invalid')
    if (!isCanonicalStrategyId(input.strategyId)) {
        throw new InvalidFreshStartStrategySymbolInputError('strategy_id is invalid')
    }
    if (typeof input.symbolId !== 'string') {
        throw new InvalidFreshStartStrategySymbolInputError('symbol_id is invalid')
    }
    const parsedSymbol = parseSymbolId(input.symbolId)
    if (!parsedSymbol || parsedSymbol.ticker.length === 0 || parsedSymbol.ticker.includes('/')) {
        throw new InvalidFreshStartStrategySymbolInputError('symbol_id is invalid')
    }
    if (input.sizingMode !== 'WEBHOOK_CAPPED') {
        throw new InvalidFreshStartStrategySymbolInputError('sizing_mode is invalid')
    }
    if (!isFinitePositiveNumber(input.maxAbsPosition)) {
        throw new InvalidFreshStartStrategySymbolInputError('max_abs_position must be a finite positive number')
    }
    if (typeof input.noFlip !== 'boolean') {
        throw new InvalidFreshStartStrategySymbolInputError('no_flip is invalid')
    }
    if (input.apply !== undefined && typeof input.apply !== 'boolean') {
        throw new InvalidFreshStartStrategySymbolInputError('apply is invalid')
    }
    if (input.confirmProject !== undefined && typeof input.confirmProject !== 'string') {
        throw new InvalidFreshStartStrategySymbolInputError('confirmProject is invalid')
    }
}

const issue = (
    input: FreshStartStrategySymbolInput,
    reason: string,
    extra: Omit<FreshStartIssue, 'reason' | 'strategy_id' | 'symbol_id'> = {},
): FreshStartIssue => ({
    reason,
    strategy_id: input.strategyId,
    symbol_id: input.symbolId,
    ...extra,
})

const getSnapshotData = (snapshot: SnapshotLike): unknown => snapshot.data()

const getQueryDocs = (value: SnapshotLike | QuerySnapshotLike): SnapshotLike[] => (
    'docs' in value && Array.isArray(value.docs) ? value.docs as unknown as SnapshotLike[] : []
)

const validateOrderConstraints = (value: unknown, input: FreshStartStrategySymbolInput): OrderConstraints => {
    if (value === undefined) {
        throw new FreshStartConflictError([issue(input, 'SYMBOL_CONSTRAINTS_REQUIRED')])
    }
    if (!isRecord(value) || !isFinitePositiveNumber(value.quantity_step) ||
        !isFinitePositiveNumber(value.min_order_size) ||
        (value.max_order_size !== undefined &&
            (!isFinitePositiveNumber(value.max_order_size) || value.max_order_size < value.min_order_size))) {
        throw new FreshStartConflictError([{
            reason: 'INVALID_SYMBOL_CONSTRAINTS',
            strategy_id: input.strategyId,
            symbol_id: input.symbolId,
        }])
    }

    return {
        quantity_step: value.quantity_step,
        min_order_size: value.min_order_size,
        ...(value.max_order_size === undefined ? {} : { max_order_size: value.max_order_size }),
    }
}

const readSymbol = (
    value: unknown,
    input: FreshStartStrategySymbolInput,
): { symbol: RecordLike; status: 'active' | 'paused'; constraints: OrderConstraints } => {
    if (!isRecord(value)) {
        throw new FreshStartConflictError([issue(input, 'INVALID_SYMBOL')])
    }
    const parsed = parseSymbolId(input.symbolId)
    if (!parsed || value.id !== input.symbolId || value.broker !== parsed.broker || value.ticker !== parsed.ticker) {
        throw new FreshStartConflictError([issue(input, 'INVALID_SYMBOL_IDENTITY')])
    }
    if (!isRecord(value.trade_control) ||
        (value.trade_control.status !== 'active' && value.trade_control.status !== 'paused')) {
        throw new FreshStartConflictError([issue(input, 'INVALID_SYMBOL_TRADE_CONTROL')])
    }
    if (value.trade_control.updated_at !== undefined && !isDateLike(value.trade_control.updated_at)) {
        throw new FreshStartConflictError([issue(input, 'INVALID_SYMBOL_TRADE_CONTROL')])
    }
    const constraints = validateOrderConstraints(value.order_constraints, input)
    return {
        symbol: value,
        status: value.trade_control.status,
        constraints,
    }
}

const readState = async (
    reader: Reader,
    db: Firestore,
    input: FreshStartStrategySymbolInput,
): Promise<StoredState> => {
    const policyId = createStrategySymbolPolicyId(input.strategyId, input.symbolId)
    const positionId = createStrategySymbolPositionId(input.strategyId, input.symbolId)
    const symbolRef = db.collection(SYMBOLS_COLLECTION).doc(input.symbolId)
    const policyRef = db.collection(POLICIES_COLLECTION).doc(policyId)
    const positionRef = db.collection(POSITIONS_COLLECTION).doc(positionId)

    const symbolSnapshot = await reader.get(symbolRef) as SnapshotLike
    if (!symbolSnapshot.exists) throw new FreshStartSymbolNotFoundError(input.symbolId)
    if (symbolSnapshot.id !== input.symbolId) {
        throw new FreshStartConflictError([issue(input, 'INVALID_SYMBOL_IDENTITY')])
    }

    const policySnapshot = await reader.get(policyRef) as SnapshotLike
    const positionSnapshot = await reader.get(positionRef) as SnapshotLike

    // Scope the read to the complete symbol identity. The repository does not
    // manage Firestore composite-index definitions; equality-filter index
    // merging is used here, while the application still validates every
    // returned broker/ticker/symbol_id below.
    const parsedSymbol = parseSymbolId(input.symbolId)
    if (!parsedSymbol) throw new InvalidFreshStartStrategySymbolInputError('symbol_id is invalid')
    const ordersQuery = db.collection(ORDERS_COLLECTION)
        .where('broker', '==', parsedSymbol.broker)
        .where('ticker', '==', parsedSymbol.ticker) as Query
    const reservationsQuery = db.collection(RESERVATIONS_COLLECTION).where('symbol_id', '==', input.symbolId) as Query
    const ordersSnapshot = await reader.get(ordersQuery) as QuerySnapshotLike
    const reservationsSnapshot = await reader.get(reservationsQuery) as QuerySnapshotLike

    const symbol = readSymbol(getSnapshotData(symbolSnapshot), input)
    return {
        symbol: symbol.symbol,
        symbolStatus: symbol.status,
        constraints: symbol.constraints,
        policy: policySnapshot.exists ? policySnapshot : undefined,
        position: positionSnapshot.exists ? positionSnapshot : undefined,
        orders: getQueryDocs(ordersSnapshot),
        reservations: getQueryDocs(reservationsSnapshot),
    }
}

const identityValues = (raw: RecordLike): {
    effective?: string
    explicit?: string
    legacy?: string
    invalidReason?: string
    conflict?: boolean
} => {
    const hasEffective = Object.hasOwn(raw, 'effective_strategy_id')
    const hasExplicit = Object.hasOwn(raw, 'strategy_id')
    const hasLegacy = Object.hasOwn(raw, 'strategy')
    const effectiveResolution = resolveEffectiveStrategyId({ effectiveStrategyId: raw.effective_strategy_id })
    const explicitResolution = resolveEffectiveStrategyId({ explicitStrategyId: raw.strategy_id })
    const legacyResolution = resolveLegacyStrategyId(raw.strategy)

    if (hasEffective && effectiveResolution.effectiveStrategyId === undefined) {
        return { invalidReason: `EFFECTIVE_STRATEGY_${effectiveResolution.reason}` }
    }
    if (hasExplicit && explicitResolution.effectiveStrategyId === undefined) {
        return { invalidReason: `EXPLICIT_STRATEGY_${explicitResolution.reason}` }
    }
    // `strategy` is a legacy display value.  Once a persisted effective or
    // explicit canonical ID exists, it must not be treated as a contradictory
    // identity merely because the display value is `unknown` or uses a
    // different human-readable label.  This mirrors the migration parser.
    // A non-string display field is still malformed evidence and is rejected.
    if (hasLegacy && raw.strategy !== undefined && typeof raw.strategy !== 'string') {
        return { invalidReason: `LEGACY_STRATEGY_${legacyResolution.reason}` }
    }
    const effective = effectiveResolution.effectiveStrategyId
    const explicit = explicitResolution.effectiveStrategyId
    const legacy = legacyResolution.effectiveStrategyId
    if (!hasEffective && !hasExplicit && !hasLegacy) {
        return { invalidReason: 'LEGACY_STRATEGY_MISSING' }
    }
    if (effective !== undefined && explicit !== undefined && explicit !== effective) {
        return { effective, explicit, legacy, conflict: true }
    }
    if (effective === undefined && explicit !== undefined && legacy !== undefined && legacy !== explicit) {
        return { effective, explicit, legacy, conflict: true }
    }
    if (effective === undefined && explicit === undefined && legacy === undefined) {
        return { invalidReason: `LEGACY_STRATEGY_${legacyResolution.reason}` }
    }
    return { effective, explicit, legacy }
}

type OrderSymbolMatch = 'MATCH' | 'IDENTITY_CONFLICT'

const orderSymbolMatch = (
    raw: RecordLike,
    input: FreshStartStrategySymbolInput,
): OrderSymbolMatch => {
    const parsed = parseSymbolId(input.symbolId)
    // The query is already scoped by broker+ticker. A returned document that
    // does not satisfy those exact fields is therefore malformed or came from
    // an unexpected read path; fail closed instead of classifying it as other
    // strategy/symbol state.
    if (!parsed || raw.broker !== parsed.broker || raw.ticker !== parsed.ticker) return 'IDENTITY_CONFLICT'
    if (Object.hasOwn(raw, 'symbol_id') && raw.symbol_id !== input.symbolId) return 'IDENTITY_CONFLICT'
    return 'MATCH'
}

const inspectOrders = (
    input: FreshStartStrategySymbolInput,
    snapshots: SnapshotLike[],
): FreshStartIssue[] => {
    const issues: FreshStartIssue[] = []
    for (const snapshot of snapshots) {
        const raw = getSnapshotData(snapshot)
        // An order returned by the ticker query with an invalid shape cannot
        // be safely classified as another strategy's order.
        if (!isRecord(raw)) {
            issues.push(issue(input, 'ORDER_IDENTITY_INVALID', { order_id: snapshot.id }))
            continue
        }
        const symbolMatch = orderSymbolMatch(raw, input)
        if (symbolMatch === 'IDENTITY_CONFLICT') {
            issues.push(issue(input, 'ORDER_SYMBOL_IDENTITY_CONFLICT', { order_id: snapshot.id }))
            continue
        }
        const identity = identityValues(raw)
        if (identity.invalidReason) {
            issues.push(issue(input, identity.invalidReason, { order_id: snapshot.id }))
            continue
        }
        if (identity.conflict) {
            issues.push(issue(input, 'ORDER_IDENTITY_CONFLICT', { order_id: snapshot.id }))
            continue
        }
        const strategyId = identity.effective ?? identity.explicit ?? identity.legacy
        if (strategyId !== input.strategyId) continue

        if (raw.id !== undefined && raw.id !== snapshot.id) {
            issues.push(issue(input, 'ORDER_IDENTITY_INVALID', { order_id: snapshot.id }))
            continue
        }
        if (!ORDER_STATUSES.has(raw.status as OrderV2['status'])) {
            issues.push(issue(input, 'ORDER_INVALID_STATUS', { order_id: snapshot.id }))
            continue
        }
        const isDryRunMarker = Array.isArray(raw.provider_order_ids) &&
            raw.provider_order_ids.some((providerOrderId) => providerOrderId === 'DRY_RUN')
        issues.push(issue(input, raw.status === 'PENDING' ? 'PENDING_ORDER' : 'ORDER_HISTORY', {
            order_id: snapshot.id,
            details: {
                status: raw.status,
                ...(isDryRunMarker ? { dry_run: true } : {}),
            },
        }))
    }
    return issues
}

const inspectReservations = (
    input: FreshStartStrategySymbolInput,
    snapshots: SnapshotLike[],
): FreshStartIssue[] => {
    const issues: FreshStartIssue[] = []
    for (const snapshot of snapshots) {
        const raw = getSnapshotData(snapshot)
        if (!isRecord(raw)) {
            issues.push(issue(input, 'INVALID_STORED_RESERVATION', { document_id: snapshot.id }))
            continue
        }
        // The query is intentionally scoped by symbol. Any document whose
        // strategy identity is the target belongs to this fresh-start guard.
        if (raw.strategy_id !== input.strategyId) continue
        try {
            deserializeStrategySymbolReservation(raw, snapshot.id)
            issues.push(issue(input, 'RESERVATION_EXISTS', { document_id: snapshot.id }))
        } catch {
            issues.push(issue(input, 'INVALID_STORED_RESERVATION', { document_id: snapshot.id }))
        }
    }
    return issues
}

const parseExistingPolicy = (
    snapshot: SnapshotLike | undefined,
    input: FreshStartStrategySymbolInput,
): StrategySymbolPolicy | null => {
    if (!snapshot) return null
    try {
        const policyId = createStrategySymbolPolicyId(input.strategyId, input.symbolId)
        if (snapshot.id !== policyId) return null
        return deserializeStrategySymbolPolicy(snapshot.data(), policyId, input.strategyId, input.symbolId)
    } catch {
        return null
    }
}

const parseExistingPosition = (
    snapshot: SnapshotLike | undefined,
    input: FreshStartStrategySymbolInput,
): StrategySymbolPosition | null => {
    if (!snapshot) return null
    try {
        const positionId = createStrategySymbolPositionId(input.strategyId, input.symbolId)
        if (snapshot.id !== positionId) return null
        return deserializeStrategySymbolPosition(snapshot.data(), positionId)
    } catch {
        return null
    }
}

const matchingExistingState = (
    state: StoredState,
    input: FreshStartStrategySymbolInput,
): { kind: 'NONE' | 'MATCH' | 'CONFLICT'; issues: FreshStartIssue[]; policy?: StrategySymbolPolicy; position?: StrategySymbolPosition } => {
    const hasPolicy = state.policy !== undefined
    const hasPosition = state.position !== undefined
    if (!hasPolicy && !hasPosition) return { kind: 'NONE', issues: [] }

    const issues: FreshStartIssue[] = []
    const policy = parseExistingPolicy(state.policy, input)
    const position = parseExistingPosition(state.position, input)
    if (state.policy && !policy) issues.push(issue(input, 'INVALID_STORED_POLICY', { document_id: state.policy.id }))
    if (state.position && !position) issues.push(issue(input, 'INVALID_STORED_POSITION', { document_id: state.position.id }))
    if (issues.length > 0 || !policy || !position) {
        if (!hasPolicy) issues.push(issue(input, 'POLICY_MISSING'))
        if (!hasPosition) issues.push(issue(input, 'POSITION_MISSING'))
        return { kind: 'CONFLICT', issues }
    }

    const policyMatches = policy.sizing_mode === 'WEBHOOK_CAPPED' &&
        policy.enabled === true &&
        policy.max_abs_position === input.maxAbsPosition &&
        policy.no_flip === input.noFlip &&
        policy.version === 1
    const positionMatches = position.confirmed_position === 0 &&
        position.pending_delta === 0 &&
        position.status === 'READY' &&
        position.policy_version === 1 &&
        position.reconciled_at === null
    if (policyMatches && positionMatches) return { kind: 'MATCH', issues: [], policy, position }
    return { kind: 'CONFLICT', issues: [
        issue(input, 'EXISTING_STATE_MISMATCH'),
    ], policy, position }
}

const validateRequestedPolicy = (state: StoredState, input: FreshStartStrategySymbolInput): void => {
    try {
        validateStrategySymbolPolicyInput({
            strategy_id: input.strategyId,
            symbol_id: input.symbolId,
            sizing_mode: 'WEBHOOK_CAPPED',
            enabled: true,
            max_abs_position: input.maxAbsPosition,
            no_flip: input.noFlip,
        }, state.constraints)
    } catch (error) {
        if (error instanceof Error) {
            throw new InvalidFreshStartPolicyError(error.message)
        }
        throw new InvalidFreshStartPolicyError('policy is invalid')
    }
}

const inspectState = (
    state: StoredState,
    input: FreshStartStrategySymbolInput,
): { existing: ReturnType<typeof matchingExistingState>; issues: FreshStartIssue[] } => {
    validateRequestedPolicy(state, input)
    const existing = matchingExistingState(state, input)
    const orderIssues = inspectOrders(input, state.orders)
    const reservationIssues = inspectReservations(input, state.reservations)
    return {
        existing,
        issues: [...existing.issues, ...orderIssues, ...reservationIssues],
    }
}

const ensurePreconditions = (
    state: StoredState,
    input: FreshStartStrategySymbolInput,
): { policy?: StrategySymbolPolicy; position?: StrategySymbolPosition } => {
    const inspected = inspectState(state, input)
    if (inspected.existing.kind === 'MATCH' && inspected.issues.length === 0) {
        throw new FreshStartAlreadyExistsError([issue(input, 'ALREADY_EXISTS')])
    }
    if (inspected.existing.kind !== 'NONE' || inspected.issues.length > 0) {
        throw new FreshStartConflictError(inspected.issues.length > 0
            ? inspected.issues
            : [issue(input, 'CONFLICT')])
    }
    if (input.apply && state.symbolStatus !== 'paused') {
        throw new FreshStartSymbolNotPausedError(input.symbolId)
    }
    return {}
}

const validNow = (now: () => Date): Date => {
    const value = now()
    return value instanceof Date && Number.isFinite(value.getTime()) ? new Date(value.getTime()) : new Date()
}

const createPolicy = (input: FreshStartStrategySymbolInput, now: Date): StrategySymbolPolicy => ({
    id: createStrategySymbolPolicyId(input.strategyId, input.symbolId),
    strategy_id: input.strategyId,
    symbol_id: input.symbolId,
    sizing_mode: 'WEBHOOK_CAPPED',
    enabled: true,
    max_abs_position: input.maxAbsPosition,
    no_flip: input.noFlip,
    version: 1,
    created_at: now,
    updated_at: now,
})

const createPosition = (input: FreshStartStrategySymbolInput, now: Date): StrategySymbolPosition => ({
    id: createStrategySymbolPositionId(input.strategyId, input.symbolId),
    strategy_id: input.strategyId,
    symbol_id: input.symbolId,
    confirmed_position: 0,
    pending_delta: 0,
    status: 'READY',
    policy_version: 1,
    updated_at: now,
    // A fresh-start ledger deliberately does not claim broker reconciliation.
    reconciled_at: null,
})

const refsFor = (db: Firestore, input: FreshStartStrategySymbolInput) => ({
    symbol: db.collection(SYMBOLS_COLLECTION).doc(input.symbolId),
    policy: db.collection(POLICIES_COLLECTION).doc(createStrategySymbolPolicyId(input.strategyId, input.symbolId)),
    position: db.collection(POSITIONS_COLLECTION).doc(createStrategySymbolPositionId(input.strategyId, input.symbolId)),
})

const runApply = async (
    db: Firestore,
    input: FreshStartStrategySymbolInput,
    now: Date,
): Promise<FreshStartStrategySymbolResult> => {
    const refs = refsFor(db, input)
    return db.runTransaction(async (transaction) => {
        const reader: Reader = {
            get: (ref) => transaction.get(ref as never) as unknown as Promise<SnapshotLike | QuerySnapshotLike>,
        }
        const state = await readState(reader, db, input)
        ensurePreconditions(state, input)
        // readState/ensurePreconditions completed every read before the first
        // write, so these creates are atomic and cannot overwrite a race.
        const policy = createPolicy(input, now)
        const position = createPosition(input, now)
        transaction.create(refs.policy, omitUndefinedFields(policy as unknown as Record<string, unknown>))
        transaction.create(refs.position, omitUndefinedFields(position as unknown as Record<string, unknown>))
        return {
            status: 'APPLIED',
            mode: 'APPLY',
            strategy_id: input.strategyId,
            symbol_id: input.symbolId,
            sizing_mode: input.sizingMode,
            max_abs_position: input.maxAbsPosition,
            no_flip: input.noFlip,
            symbol_status: state.symbolStatus,
            requires_pause: false,
            policy,
            position,
            issues: [],
        } satisfies FreshStartStrategySymbolResult
    })
}

const createService = (options: FreshStartStrategySymbolServiceOptions): FreshStartStrategySymbolFn => {
    const db = options.db ?? getFirestoreClient()
    const projectId = options.projectId ?? process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT
    const now = options.now ?? (() => new Date())

    return async (input) => {
        assertInput(input)
        const apply = input.apply === true
        if (apply) {
            if (input.confirmProject === undefined || input.confirmProject.length === 0) {
                throw new FreshStartProjectConfirmationError('PROJECT_CONFIRMATION_REQUIRED', 'X-Confirm-Project is required for apply')
            }
            if (!projectId) {
                throw new FreshStartProjectConfirmationError('PROJECT_ID_UNAVAILABLE', 'runtime project id is unavailable')
            }
            if (input.confirmProject !== projectId) {
                throw new FreshStartProjectConfirmationError('PROJECT_MISMATCH', 'X-Confirm-Project does not match the runtime project')
            }
        }

        const state = await readState({
            get: (ref) => ref.get() as unknown as Promise<SnapshotLike | QuerySnapshotLike>,
        }, db, input)
        const inspected = inspectState(state, input)
        if (inspected.existing.kind === 'MATCH' && inspected.issues.length === 0) {
            throw new FreshStartAlreadyExistsError([issue(input, 'ALREADY_EXISTS')])
        }
        if (inspected.existing.kind !== 'NONE' || inspected.issues.length > 0) {
            throw new FreshStartConflictError(inspected.issues.length > 0
                ? inspected.issues
                : [issue(input, 'CONFLICT')])
        }
        if (apply) return runApply(db, input, validNow(now))

        return {
            status: 'CREATE',
            mode: 'DRY_RUN',
            strategy_id: input.strategyId,
            symbol_id: input.symbolId,
            sizing_mode: input.sizingMode,
            max_abs_position: input.maxAbsPosition,
            no_flip: input.noFlip,
            symbol_status: state.symbolStatus,
            requires_pause: state.symbolStatus !== 'paused',
            issues: [],
        }
    }
}

export const createFreshStartStrategySymbolFn = (
    options: FreshStartStrategySymbolServiceOptions = {},
): FreshStartStrategySymbolFn => createService(options)

export const createDefaultFreshStartStrategySymbolFn = (): FreshStartStrategySymbolFn =>
    createFreshStartStrategySymbolFn({ db: getFirestoreClient() })
