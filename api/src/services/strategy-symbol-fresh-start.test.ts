import assert from 'node:assert/strict'
import test from 'node:test'
import type { Firestore } from 'firebase-admin/firestore'

import { createStrategySymbolPolicyId } from './strategy-symbol-policies.js'
import { createStrategySymbolPositionId } from './strategy-symbol-positions.js'
import { createStrategySymbolReservationId } from './strategy-symbol-reservations.js'
import {
    createDefaultFreshStartStrategySymbolFn,
    createFreshStartStrategySymbolFn,
    FreshStartAlreadyExistsError,
    FreshStartConflictError,
    FreshStartSymbolNotPausedError,
    InvalidFreshStartPolicyError,
    InvalidFreshStartStrategySymbolInputError,
    type FreshStartStrategySymbolInput,
} from './strategy-symbol-fresh-start.js'

type RawData = Record<string, unknown>

type MockRef = {
    kind: 'doc'
    collection: string
    id: string
    get: () => Promise<MockSnapshot>
}

type MockQueryFilter = {
    field: string
    value: unknown
}

type MockQuery = {
    kind: 'query'
    collection: string
    filters: MockQueryFilter[]
    where: (field: string, operator: string, value: unknown) => MockQuery
    get: () => Promise<MockQuerySnapshot>
}

type MockSnapshot = {
    id: string
    exists: boolean
    data: () => RawData | undefined
}

type MockQuerySnapshot = {
    docs: MockSnapshot[]
}

type FirestoreMockOptions = {
    beforeTransaction?: () => void
}

const makeFirestoreMock = (options: FirestoreMockOptions = {}) => {
    const docs: Record<string, Record<string, RawData>> = {}
    const writes: { collection: string; id: string; data: RawData }[] = []

    const snapshot = (collection: string, id: string): MockSnapshot => ({
        id,
        exists: docs[collection]?.[id] !== undefined,
        data: () => docs[collection]?.[id],
    })
    const querySnapshot = (collection: string, filters: MockQueryFilter[]): MockQuerySnapshot => ({
        docs: Object.entries(docs[collection] ?? {})
            .filter(([, data]) => filters.every(({ field, value }) => data[field] === value))
            .map(([id]) => snapshot(collection, id)),
    })
    const makeRef = (collection: string, id: string): MockRef => ({
        kind: 'doc',
        collection,
        id,
        get: async () => snapshot(collection, id),
    })
    const makeQuery = (collection: string, filters: MockQueryFilter[]): MockQuery => ({
        kind: 'query',
        collection,
        filters,
        where: (field: string, _operator: string, value: unknown) => (
            makeQuery(collection, [...filters, { field, value }])
        ),
        get: async () => querySnapshot(collection, filters),
    })

    const db = {
        collection: (collection: string) => ({
            doc: (id: string) => makeRef(collection, id),
            where: (field: string, _operator: string, value: unknown) => makeQuery(collection, [{ field, value }]),
        }),
        runTransaction: async <T>(callback: (transaction: unknown) => Promise<T>): Promise<T> => {
            options.beforeTransaction?.()
            const staged: { collection: string; id: string; data: RawData }[] = []
            const transaction = {
                get: async (ref: MockRef | MockQuery) => (
                    ref.kind === 'doc' ? snapshot(ref.collection, ref.id) : querySnapshot(ref.collection, ref.filters)
                ),
                create: (ref: MockRef, data: RawData) => staged.push({ collection: ref.collection, id: ref.id, data }),
            }
            const result = await callback(transaction)
            for (const write of staged) {
                docs[write.collection] ??= {}
                if (docs[write.collection]![write.id] !== undefined) throw new Error('already exists')
                docs[write.collection]![write.id] = write.data
                writes.push(write)
            }
            return result
        },
        docs,
        writes,
    }
    return db as unknown as Firestore & {
        docs: typeof docs
        writes: typeof writes
    }
}

const strategyId = 'fresh_strategy'
const symbolId = 'dummy:FRESH'
const now = new Date('2026-08-20T00:00:00.000Z')

const input = (overrides: Partial<FreshStartStrategySymbolInput> = {}): FreshStartStrategySymbolInput => ({
    strategyId,
    symbolId,
    sizingMode: 'WEBHOOK_CAPPED',
    maxAbsPosition: 2,
    noFlip: true,
    ...overrides,
})

const seedSymbol = (
    db: ReturnType<typeof makeFirestoreMock>,
    status: 'active' | 'paused' = 'paused',
    constraints: RawData = { quantity_step: 0.1, min_order_size: 0.1 },
) => {
    db.docs.tradable_symbols ??= {}
    db.docs.tradable_symbols[symbolId] = {
        id: symbolId,
        broker: 'dummy',
        ticker: 'FRESH',
        currency: 'JPY',
        order_constraints: constraints,
        trade_control: { status, updated_at: now },
        created_at: now,
        updated_at: now,
    }
}

test('fresh-start rejects noncanonical service input before reading Firestore', async () => {
    const db = makeFirestoreMock()
    seedSymbol(db)
    const freshStart = createFreshStartStrategySymbolFn({ db, projectId: 'test-project' })
    const invalidInputs = [
        input({ strategyId: ' fresh_strategy' }),
        input({ symbolId: 'dummy:FRESH/JPY' }),
        input({ maxAbsPosition: 0 }),
        input({ sizingMode: 'MANAGED' as never }),
        input({ noFlip: 'true' as never }),
    ]

    for (const invalidInput of invalidInputs) {
        await assert.rejects(freshStart(invalidInput), InvalidFreshStartStrategySymbolInputError)
    }
    assert.equal(db.writes.length, 0)
})

test('fresh-start defaults to a read-only CREATE dry-run', async () => {
    const db = makeFirestoreMock()
    seedSymbol(db, 'active')
    const freshStart = createFreshStartStrategySymbolFn({ db, projectId: 'test-project', now: () => now })

    const result = await freshStart(input())
    assert.equal(result.status, 'CREATE')
    assert.equal(result.mode, 'DRY_RUN')
    assert.equal(result.symbol_status, 'active')
    assert.equal(result.requires_pause, true)
    assert.equal(db.writes.length, 0)
    assert.equal(db.docs.strategy_symbol_policies, undefined)
    assert.equal(db.docs.strategy_symbol_positions, undefined)
})

test('fresh-start apply creates policy and zero position atomically without broker state', async () => {
    const db = makeFirestoreMock()
    seedSymbol(db)
    const freshStart = createFreshStartStrategySymbolFn({ db, projectId: 'test-project', now: () => now })

    const result = await freshStart(input({ apply: true, confirmProject: 'test-project' }))
    assert.equal(result.status, 'APPLIED')
    assert.equal(result.policy?.enabled, true)
    assert.equal(result.policy?.version, 1)
    assert.equal(result.position?.confirmed_position, 0)
    assert.equal(result.position?.pending_delta, 0)
    assert.equal(result.position?.status, 'READY')
    assert.equal(result.position?.reconciled_at, null)
    assert.equal(db.writes.length, 2)
    assert.deepEqual(Object.keys(db.docs.strategy_symbol_policies ?? {}), [createStrategySymbolPolicyId(strategyId, symbolId)])
    assert.deepEqual(Object.keys(db.docs.strategy_symbol_positions ?? {}), [createStrategySymbolPositionId(strategyId, symbolId)])
})

test('fresh-start requires project confirmation and pauses only for apply', async () => {
    const db = makeFirestoreMock()
    seedSymbol(db)
    const freshStart = createFreshStartStrategySymbolFn({ db, projectId: 'test-project' })

    await assert.rejects(freshStart(input({ apply: true })), (error: unknown) => (
        error instanceof Error && 'code' in error && error.code === 'PROJECT_CONFIRMATION_REQUIRED'
    ))
    await assert.rejects(freshStart(input({ apply: true, confirmProject: 'wrong-project' })), (error: unknown) => (
        error instanceof Error && 'code' in error && error.code === 'PROJECT_MISMATCH'
    ))
    assert.equal(db.writes.length, 0)

    const activeDb = makeFirestoreMock()
    seedSymbol(activeDb, 'active')
    const activeFreshStart = createFreshStartStrategySymbolFn({ db: activeDb, projectId: 'test-project' })
    await assert.rejects(
        activeFreshStart(input({ apply: true, confirmProject: 'test-project' })),
        FreshStartSymbolNotPausedError,
    )
    assert.equal(activeDb.writes.length, 0)
})

test('fresh-start returns ALREADY_EXISTS for a complete initial state and CONFLICT for partial state', async () => {
    const db = makeFirestoreMock()
    seedSymbol(db)
    const freshStart = createFreshStartStrategySymbolFn({ db, projectId: 'test-project', now: () => now })
    await freshStart(input({ apply: true, confirmProject: 'test-project' }))

    await assert.rejects(freshStart(input()), FreshStartAlreadyExistsError)

    const partialDb = makeFirestoreMock()
    seedSymbol(partialDb)
    partialDb.docs.strategy_symbol_policies = {
        [createStrategySymbolPolicyId(strategyId, symbolId)]: db.docs.strategy_symbol_policies![createStrategySymbolPolicyId(strategyId, symbolId)]!,
    }
    const partialFreshStart = createFreshStartStrategySymbolFn({ db: partialDb, projectId: 'test-project' })
    await assert.rejects(partialFreshStart(input()), FreshStartConflictError)
    assert.equal(partialDb.writes.length, 0)
})

test('fresh-start blocks target history and reservation but ignores another strategy', async () => {
    const db = makeFirestoreMock()
    seedSymbol(db)
    db.docs.orders_v2 = {
        other: {
            id: 'other',
            broker: 'dummy',
            ticker: 'FRESH',
            strategy_id: 'other_strategy',
            status: 'PENDING',
        },
        target: {
            id: 'target',
            broker: 'dummy',
            ticker: 'FRESH',
            strategy: 'fresh_strategy',
            status: 'PENDING',
        },
    }
    const freshStart = createFreshStartStrategySymbolFn({ db, projectId: 'test-project' })
    await assert.rejects(freshStart(input()), (error: unknown) => (
        error instanceof FreshStartConflictError && error.issues.some((entry) => entry.reason === 'PENDING_ORDER')
    ))
    assert.equal(db.writes.length, 0)

    delete db.docs.orders_v2.target
    db.docs.strategy_symbol_reservations = {
        reservation: {
            id: 'reservation',
            strategy_id: strategyId,
            symbol_id: symbolId,
        },
    }
    await assert.rejects(freshStart(input()), (error: unknown) => (
        error instanceof FreshStartConflictError && error.issues.some((entry) => entry.reason === 'INVALID_STORED_RESERVATION')
    ))
    assert.equal(db.writes.length, 0)
})

test('fresh-start uses persisted effective identity before the legacy display value', async () => {
    const db = makeFirestoreMock()
    seedSymbol(db)
    db.docs.orders_v2 = {
        effectiveUnknown: {
            id: 'effectiveUnknown',
            broker: 'dummy',
            ticker: 'FRESH',
            effective_strategy_id: strategyId,
            strategy: 'unknown',
            status: 'EXECUTED',
        },
    }
    const freshStart = createFreshStartStrategySymbolFn({ db, projectId: 'test-project' })
    await assert.rejects(freshStart(input()), (error: unknown) => (
        error instanceof FreshStartConflictError && error.issues.some((entry) => entry.reason === 'ORDER_HISTORY')
    ))

    db.docs.orders_v2.effectiveUnknown = {
        id: 'effectiveUnknown',
        broker: 'dummy',
        ticker: 'FRESH',
        effective_strategy_id: strategyId,
        strategy_id: strategyId,
        strategy: 'display label',
        status: 'FAILED',
    }
    await assert.rejects(freshStart(input()), (error: unknown) => (
        error instanceof FreshStartConflictError && error.issues.some((entry) => entry.reason === 'ORDER_HISTORY')
    ))

    db.docs.orders_v2.effectiveUnknown = {
        id: 'effectiveUnknown',
        broker: 'dummy',
        ticker: 'FRESH',
        effective_strategy_id: 'another_strategy',
        strategy_id: strategyId,
        status: 'EXECUTED',
    }
    await assert.rejects(freshStart(input()), (error: unknown) => (
        error instanceof FreshStartConflictError && error.issues.some((entry) => entry.reason === 'ORDER_IDENTITY_CONFLICT')
    ))
})

test('fresh-start fails closed on conflicting order symbol identity and scopes out another broker', async () => {
    for (const status of ['PENDING', 'EXECUTED'] as const) {
        const db = makeFirestoreMock()
        seedSymbol(db)
        db.docs.orders_v2 = {
            sameTickerOtherBroker: {
                id: 'sameTickerOtherBroker',
                broker: 'saxo',
                ticker: 'FRESH',
                strategy_id: strategyId,
                status: 'PENDING',
            },
        }
        const freshStart = createFreshStartStrategySymbolFn({ db, projectId: 'test-project' })
        assert.equal((await freshStart(input())).status, 'CREATE')

        db.docs.orders_v2.conflictingSymbol = {
            id: 'conflictingSymbol',
            broker: 'dummy',
            ticker: 'FRESH',
            symbol_id: 'dummy:OTHER',
            strategy_id: strategyId,
            status,
        }
        await assert.rejects(freshStart(input()), (error: unknown) => (
            error instanceof FreshStartConflictError &&
            error.issues.some((entry) => entry.reason === 'ORDER_SYMBOL_IDENTITY_CONFLICT') &&
            !error.issues.some((entry) => entry.reason === (status === 'PENDING' ? 'PENDING_ORDER' : 'ORDER_HISTORY'))
        ))
        assert.equal(db.writes.length, 0)
    }
})

test('fresh-start validates stored constraints through the policy validator', async () => {
    const db = makeFirestoreMock()
    seedSymbol(db, 'paused', { quantity_step: 0.1, min_order_size: 0.1 })
    const freshStart = createFreshStartStrategySymbolFn({ db, projectId: 'test-project' })

    await assert.rejects(freshStart(input({ maxAbsPosition: 0.15 })), InvalidFreshStartPolicyError)
    assert.equal(db.writes.length, 0)

    const invalidConstraintsDb = makeFirestoreMock()
    seedSymbol(invalidConstraintsDb, 'paused', { quantity_step: 0, min_order_size: 0.1 })
    const invalidConstraintsFreshStart = createFreshStartStrategySymbolFn({ db: invalidConstraintsDb, projectId: 'test-project' })
    await assert.rejects(invalidConstraintsFreshStart(input()), FreshStartConflictError)
    assert.equal(invalidConstraintsDb.writes.length, 0)
})

test('fresh-start apply re-reads state and refuses races without partial creates', async () => {
    const policyId = createStrategySymbolPolicyId(strategyId, symbolId)
    const positionId = createStrategySymbolPositionId(strategyId, symbolId)
    const reservationEventId = 'fresh-start-race'
    const reservationId = createStrategySymbolReservationId(strategyId, symbolId, reservationEventId)
    const mutations: Array<{
        name: string
        mutate: (db: ReturnType<typeof makeFirestoreMock>) => void
    }> = [
        {
            name: 'target pending order',
            mutate: (db) => {
                db.docs.orders_v2 = {
                    target: {
                        id: 'target',
                        broker: 'dummy',
                        ticker: 'FRESH',
                        strategy_id: strategyId,
                        status: 'PENDING',
                    },
                }
            },
        },
        {
            name: 'target reservation',
            mutate: (db) => {
                db.docs.strategy_symbol_reservations = {
                    [reservationId]: {
                        id: reservationId,
                        event_id: reservationEventId,
                        position_id: positionId,
                        strategy_id: strategyId,
                        symbol_id: symbolId,
                        order_id: 'race-order',
                        reserved_delta: 0.1,
                        executed_delta: 0,
                        status: 'RESERVED',
                        policy_version: 1,
                        created_at: now,
                        updated_at: now,
                    },
                }
            },
        },
        {
            name: 'policy state',
            mutate: (db) => {
                db.docs.strategy_symbol_policies = { [policyId]: { id: policyId } }
            },
        },
        {
            name: 'position state',
            mutate: (db) => {
                db.docs.strategy_symbol_positions = { [positionId]: { id: positionId } }
            },
        },
        {
            name: 'symbol active state',
            mutate: (db) => {
                db.docs.tradable_symbols![symbolId]!.trade_control = { status: 'active', updated_at: now }
            },
        },
        {
            name: 'symbol constraints corruption',
            mutate: (db) => {
                db.docs.tradable_symbols![symbolId]!.order_constraints = {
                    quantity_step: 0,
                    min_order_size: 0.1,
                }
            },
        },
    ]

    for (const mutation of mutations) {
        let applyMutation: (() => void) | undefined
        const db = makeFirestoreMock({ beforeTransaction: () => applyMutation?.() })
        seedSymbol(db)
        const freshStart = createFreshStartStrategySymbolFn({ db, projectId: 'test-project', now: () => now })
        assert.equal((await freshStart(input())).status, 'CREATE', mutation.name)
        applyMutation = () => mutation.mutate(db)

        await assert.rejects(
            freshStart(input({ apply: true, confirmProject: 'test-project' })),
            (error: unknown) => error instanceof FreshStartConflictError || error instanceof FreshStartSymbolNotPausedError,
            mutation.name,
        )
        assert.equal(db.writes.length, 0, mutation.name)
    }
})

test('default factory remains an application-facing constructor', () => {
    assert.equal(typeof createDefaultFreshStartStrategySymbolFn, 'function')
})
