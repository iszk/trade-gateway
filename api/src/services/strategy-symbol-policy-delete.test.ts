import assert from 'node:assert/strict'
import test from 'node:test'

import type { Firestore } from 'firebase-admin/firestore'
import {
    createDeleteStrategySymbolPolicyFn,
    StrategySymbolPolicyDeleteNotFoundError,
    StrategySymbolPolicyDeleteTargetConfirmationError,
} from './strategy-symbol-policy-delete.js'

type RawData = Record<string, unknown>

const makeDb = (
    initial: Record<string, Record<string, RawData>> = {},
    options: { commitError?: Error } = {},
) => {
    const docs = structuredClone(initial) as Record<string, Record<string, RawData>>
    const db = {
        collection: (collection: string) => ({
            doc: (id: string) => ({
                collection,
                id,
            }),
        }),
        runTransaction: async <T>(callback: (transaction: unknown) => Promise<T>): Promise<T> => {
            const staged: Array<{ kind: 'update' | 'delete'; collection: string; id: string; data?: RawData }> = []
            const snapshot = (collection: string, id: string) => ({
                id,
                exists: docs[collection]?.[id] !== undefined,
                data: () => docs[collection]?.[id],
            })
            const result = await callback({
                get: async (ref: { collection: string; id: string }) => snapshot(ref.collection, ref.id),
                update: (ref: { collection: string; id: string }, data: RawData) => staged.push({ kind: 'update', collection: ref.collection, id: ref.id, data }),
                delete: (ref: { collection: string; id: string }) => staged.push({ kind: 'delete', collection: ref.collection, id: ref.id }),
            })
            if (options.commitError) throw options.commitError
            for (const write of staged) {
                if (write.kind === 'delete') {
                    delete docs[write.collection]?.[write.id]
                    continue
                }
                docs[write.collection] ??= {}
                docs[write.collection]![write.id] = {
                    ...docs[write.collection]?.[write.id],
                    ...write.data,
                }
            }
            return result
        },
        docs,
    }
    return db as unknown as Firestore & { docs: typeof docs }
}

const now = new Date('2026-09-01T00:00:00.000Z')
const symbolId = 'dummy:BTC'
const strategyId = 'alpha'
const ledgerId = `${strategyId}:${symbolId}`

const symbol = () => ({
    id: symbolId,
    broker: 'dummy',
    ticker: 'BTC',
    currency: 'JPY',
    trade_control: { status: 'active', reason: 'trading', updated_at: now },
    created_at: now,
    updated_at: now,
})

const policy = () => ({
    id: ledgerId,
    strategy_id: strategyId,
    symbol_id: symbolId,
    sizing_mode: 'WEBHOOK_CAPPED',
    enabled: true,
    max_abs_position: 2,
    no_flip: true,
    version: 3,
    created_at: now,
    updated_at: now,
})

const position = () => ({
    id: ledgerId,
    strategy_id: strategyId,
    symbol_id: symbolId,
    confirmed_position: 1,
    pending_delta: -0.2,
    status: 'MANUAL_REVIEW',
    policy_version: 2,
    updated_at: now,
    reconciled_at: null,
})

const logger = {
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
}

const input = (overrides: Record<string, unknown> = {}) => ({
    strategyId,
    symbolId,
    confirmTarget: ledgerId,
    requestId: 'request-1',
    ...overrides,
})

test('force deletion pauses the symbol and deletes only policy/virtual position atomically', async () => {
    const db = makeDb({
        tradable_symbols: { [symbolId]: symbol() },
        strategy_symbol_policies: { [ledgerId]: policy() },
        strategy_symbol_positions: { [ledgerId]: position() },
        orders_v2: { order: { marker: 'retain' } },
        strategy_symbol_reservations: { reservation: { marker: 'retain' } },
    })
    const result = await createDeleteStrategySymbolPolicyFn({ db, now: () => now, logger })(input())

    assert.deepEqual(result, {
        strategy_id: strategyId,
        symbol_id: symbolId,
        policy_deleted: true,
        position_deleted: true,
        symbol_status: 'paused',
        position: {
            confirmed_position: 1,
            pending_delta: -0.2,
            status: 'MANUAL_REVIEW',
            policy_version: 2,
        },
    })
    assert.equal(db.docs.strategy_symbol_policies?.[ledgerId], undefined)
    assert.equal(db.docs.strategy_symbol_positions?.[ledgerId], undefined)
    const pausedSymbol = db.docs.tradable_symbols?.[symbolId] as { trade_control?: { status?: unknown } } | undefined
    assert.equal(pausedSymbol?.trade_control?.status, 'paused')
    assert.deepEqual(db.docs.orders_v2?.order, { marker: 'retain' })
    assert.deepEqual(db.docs.strategy_symbol_reservations?.reservation, { marker: 'retain' })
})

test('force deletion removes malformed documents by path without fabricating position values', async () => {
    const db = makeDb({
        tradable_symbols: { [symbolId]: symbol() },
        strategy_symbol_policies: { [ledgerId]: { unexpected: 'policy' } },
        strategy_symbol_positions: { [ledgerId]: { pending_delta: 'not-a-number' } },
    })
    const result = await createDeleteStrategySymbolPolicyFn({ db, now: () => now, logger })(input())
    assert.equal(result.policy_deleted, true)
    assert.equal(result.position_deleted, true)
    assert.equal(Object.hasOwn(result, 'position'), false)
    assert.equal(db.docs.strategy_symbol_policies?.[ledgerId], undefined)
    assert.equal(db.docs.strategy_symbol_positions?.[ledgerId], undefined)
})

test('force deletion removes a policy-only partial ledger by path', async () => {
    const db = makeDb({
        tradable_symbols: { [symbolId]: symbol() },
        strategy_symbol_policies: { [ledgerId]: policy() },
    })
    const result = await createDeleteStrategySymbolPolicyFn({ db, now: () => now, logger })(input())

    assert.equal(result.policy_deleted, true)
    assert.equal(result.position_deleted, false)
    assert.equal(db.docs.strategy_symbol_policies?.[ledgerId], undefined)
    assert.equal(db.docs.strategy_symbol_positions?.[ledgerId], undefined)
    assert.equal((db.docs.tradable_symbols?.[symbolId] as { trade_control?: { status?: unknown } }).trade_control?.status, 'paused')
})

test('force deletion removes a position-only partial ledger by path', async () => {
    const db = makeDb({
        tradable_symbols: { [symbolId]: symbol() },
        strategy_symbol_positions: { [ledgerId]: position() },
    })
    const result = await createDeleteStrategySymbolPolicyFn({ db, now: () => now, logger })(input())

    assert.equal(result.policy_deleted, false)
    assert.equal(result.position_deleted, true)
    assert.deepEqual(result.position, {
        confirmed_position: 1,
        pending_delta: -0.2,
        status: 'MANUAL_REVIEW',
        policy_version: 2,
    })
    assert.equal(db.docs.strategy_symbol_policies?.[ledgerId], undefined)
    assert.equal(db.docs.strategy_symbol_positions?.[ledgerId], undefined)
    assert.equal((db.docs.tradable_symbols?.[symbolId] as { trade_control?: { status?: unknown } }).trade_control?.status, 'paused')
})

test('force deletion requires exact target confirmation before reading state', async () => {
    const db = makeDb()
    const service = createDeleteStrategySymbolPolicyFn({ db, logger })
    await assert.rejects(service(input({ confirmTarget: '' })), StrategySymbolPolicyDeleteTargetConfirmationError)
    await assert.rejects(service(input({ confirmTarget: 'alpha:dummy:OTHER' })), StrategySymbolPolicyDeleteTargetConfirmationError)
    assert.equal(db.docs.tradable_symbols, undefined)
})

test('force deletion leaves every document unchanged when transaction commit fails', async () => {
    const db = makeDb({
        tradable_symbols: { [symbolId]: symbol() },
        strategy_symbol_policies: { [ledgerId]: policy() },
        strategy_symbol_positions: { [ledgerId]: position() },
    }, { commitError: new Error('commit failed') })
    const before = structuredClone(db.docs)
    const service = createDeleteStrategySymbolPolicyFn({ db, now: () => now, logger })

    await assert.rejects(service(input()), /commit failed/)
    assert.deepEqual(db.docs, before)
})

test('force deletion warning logs include state identifiers but never confirmations', async () => {
    const calls: Record<string, unknown>[] = []
    const logCapture = {
        info: () => {},
        warn: (details: Record<string, unknown>) => calls.push(details),
        error: () => {},
        child: () => logCapture,
    }
    const db = makeDb({
        tradable_symbols: { [symbolId]: symbol() },
        strategy_symbol_policies: { [ledgerId]: policy() },
        strategy_symbol_positions: { [ledgerId]: position() },
    })
    await createDeleteStrategySymbolPolicyFn({ db, now: () => now, logger: logCapture })(input())

    const serialized = JSON.stringify(calls)
    assert.match(serialized, /strategy_symbol_policy:force_deleted/)
    assert.doesNotMatch(serialized, /confirmTarget|alpha:dummy:BTC/)
    assert.equal(calls.some((call) => Object.hasOwn(call, 'policy_exists') && Object.hasOwn(call, 'position_exists')), true)
})

test('force deletion returns not found without pausing a symbol when both ledger documents are absent', async () => {
    const db = makeDb({ tradable_symbols: { [symbolId]: symbol() } })
    const service = createDeleteStrategySymbolPolicyFn({ db, logger })
    await assert.rejects(service(input()), StrategySymbolPolicyDeleteNotFoundError)
    const unchangedSymbol = db.docs.tradable_symbols?.[symbolId] as { trade_control?: { status?: unknown } } | undefined
    assert.equal(unchangedSymbol?.trade_control?.status, 'active')
})
