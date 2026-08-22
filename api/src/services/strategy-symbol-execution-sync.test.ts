import assert from 'node:assert/strict'
import test from 'node:test'
import type { Firestore } from 'firebase-admin/firestore'

import type { OrderV2 } from '../types/order-v2.js'
import type { OrderExecutionSyncResult } from '../types/execution-sync.js'
import type { StrategySymbolPosition } from '../types/strategy-symbol-position.js'
import type { StrategySymbolReservation } from '../types/strategy-symbol-reservation.js'
import { createStrategySymbolPositionId, serializeStrategySymbolPosition } from './strategy-symbol-positions.js'
import { createStrategySymbolReservationId, serializeStrategySymbolReservation } from './strategy-symbol-reservations.js'
import { createApplyStrategySymbolExecutionSyncFn } from './strategy-symbol-execution-sync.js'

type RawData = Record<string, unknown>

const strategyId = 'execution-sync'
const ticker = 'BTC_JPY'
const broker = 'bitflyer'
const symbolId = `${broker}:${ticker}`
const positionId = createStrategySymbolPositionId(strategyId, symbolId)

const makeFirestoreMock = () => {
    const docs: Record<string, Record<string, RawData>> = {}
    const ref = (collection: string, id: string) => ({ collection, id })
    const db = {
        collection: (collection: string) => ({ doc: (id: string) => ref(collection, id) }),
        runTransaction: async <T>(callback: (transaction: unknown) => Promise<T>): Promise<T> => {
            const writes = new Map<string, { collection: string, id: string, data: RawData }>()
            const transaction = {
                get: async (document: { collection: string, id: string }) => ({
                    id: document.id,
                    exists: docs[document.collection]?.[document.id] !== undefined,
                    data: () => docs[document.collection]?.[document.id],
                }),
                set: (document: { collection: string, id: string }, data: RawData) => {
                    writes.set(`${document.collection}/${document.id}`, { ...document, data: { ...data } })
                },
                update: (document: { collection: string, id: string }, data: RawData) => {
                    const current = docs[document.collection]?.[document.id]
                    if (!current) throw new Error('missing update target')
                    writes.set(`${document.collection}/${document.id}`, {
                        ...document,
                        data: { ...current, ...data },
                    })
                },
            }
            const result = await callback(transaction)
            for (const write of writes.values()) {
                docs[write.collection] ??= {}
                docs[write.collection]![write.id] = write.data
            }
            return result
        },
        docs,
    }
    return db as unknown as Firestore & { docs: typeof docs }
}

const makeOrder = (overrides: Partial<OrderV2> = {}): OrderV2 => ({
    id: 'execution-event',
    strategy: strategyId,
    broker,
    ticker,
    side: 'BUY',
    order_type: 'MARKET',
    requested_size: 1,
    executed_size: 0,
    executed_price: null,
    status: 'PENDING',
    provider_order_ids: ['provider-1'],
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
} as OrderV2)

const makeReservation = (overrides: Partial<StrategySymbolReservation> = {}): StrategySymbolReservation => ({
    id: createStrategySymbolReservationId(strategyId, symbolId, 'execution-event'),
    event_id: 'execution-event',
    position_id: positionId,
    strategy_id: strategyId,
    symbol_id: symbolId,
    order_id: 'execution-event',
    reserved_delta: 1,
    executed_delta: 0,
    status: 'DISPATCHED',
    policy_version: 1,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
})

const makePosition = (overrides: Partial<StrategySymbolPosition> = {}): StrategySymbolPosition => ({
    id: positionId,
    strategy_id: strategyId,
    symbol_id: symbolId,
    confirmed_position: 0,
    pending_delta: 1,
    status: 'READY',
    policy_version: 1,
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    reconciled_at: null,
    ...overrides,
})

const seed = (db: ReturnType<typeof makeFirestoreMock>, order = makeOrder(), reservation = makeReservation(), position = makePosition()) => {
    db.docs.orders_v2 = { [order.id]: { ...order } as unknown as RawData }
    db.docs.strategy_symbol_reservations = { [reservation.id]: serializeStrategySymbolReservation(reservation) }
    db.docs.strategy_symbol_positions = { [position.id]: serializeStrategySymbolPosition(position) }
}

const applyResult = (size: number, overrides: Partial<OrderExecutionSyncResult> = {}): OrderExecutionSyncResult => ({
    execution: { size, price: 100 },
    ...overrides,
} as OrderExecutionSyncResult)

const read = <T>(db: ReturnType<typeof makeFirestoreMock>, collection: string, id: string): T => (
    db.docs[collection]![id] as unknown as T
)

test('full and partial fills move only the cumulative increment and settle once', async () => {
    const db = makeFirestoreMock()
    seed(db)
    const apply = createApplyStrategySymbolExecutionSyncFn(db)

    const partial = await apply(makeOrder(), applyResult(0.4))
    assert.equal(partial.reservation, 'UPDATED')
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).confirmed_position, 0.4)
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).pending_delta, 0.6)
    assert.equal(read<RawData>(db, 'strategy_symbol_reservations', makeReservation().id).executed_delta, 0.4)
    assert.equal(read<RawData>(db, 'strategy_symbol_reservations', makeReservation().id).status, 'DISPATCHED')

    const progressed = await apply(makeOrder(), applyResult(0.7))
    assert.equal(progressed.reservation, 'UPDATED')
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).confirmed_position, 0.7)
    assert.ok(Math.abs(Number(read<RawData>(db, 'strategy_symbol_positions', positionId).pending_delta) - 0.3) < 1e-12)

    const full = await apply(makeOrder(), applyResult(1))
    assert.equal(full.reservation, 'UPDATED')
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).confirmed_position, 1)
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).pending_delta, 0)
    assert.equal(read<RawData>(db, 'strategy_symbol_reservations', makeReservation().id).status, 'SETTLED')
    assert.equal(read<RawData>(db, 'strategy_symbol_reservations', makeReservation().id).executed_delta, 1)

    const duplicate = await apply(makeOrder(), applyResult(1))
    assert.equal(duplicate.reservation, 'UNCHANGED')
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).confirmed_position, 1)
})

test('cancel releases only the unfilled remainder, including an unfilled cancel', async () => {
    const db = makeFirestoreMock()
    seed(db)
    const apply = createApplyStrategySymbolExecutionSyncFn(db)

    const canceled = await apply(makeOrder(), {
        execution: { size: 0.4, price: 100 },
        terminalStatus: 'CANCELED',
        terminalReason: 'cancelled',
    })
    assert.equal(canceled.reservation, 'UPDATED')
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).confirmed_position, 0.4)
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).pending_delta, 0)
    assert.equal(read<RawData>(db, 'strategy_symbol_reservations', makeReservation().id).status, 'SETTLED')

    const unfilledDb = makeFirestoreMock()
    seed(unfilledDb)
    const unfilled = await createApplyStrategySymbolExecutionSyncFn(unfilledDb)(
        makeOrder(),
        { execution: null, terminalStatus: 'FAILED', terminalReason: 'rejected' },
    )
    assert.equal(unfilled.reservation, 'UPDATED')
    assert.equal(read<RawData>(unfilledDb, 'strategy_symbol_positions', positionId).confirmed_position, 0)
    assert.equal(read<RawData>(unfilledDb, 'strategy_symbol_positions', positionId).pending_delta, 0)
})

test('SELL execution keeps the reservation and position signs symmetric', async () => {
    const db = makeFirestoreMock()
    const order = makeOrder({ id: 'sell-event', side: 'SELL' })
    const reservation = makeReservation({
        id: createStrategySymbolReservationId(strategyId, symbolId, order.id),
        event_id: order.id,
        order_id: order.id,
        reserved_delta: -1,
    })
    seed(db, order, reservation, makePosition({ pending_delta: -1 }))
    const result = await createApplyStrategySymbolExecutionSyncFn(db)(order, applyResult(0.4))
    assert.equal(result.reservation, 'UPDATED')
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).confirmed_position, -0.4)
    assert.ok(Math.abs(Number(read<RawData>(db, 'strategy_symbol_positions', positionId).pending_delta) + 0.6) < 1e-12)
    assert.equal(read<RawData>(db, 'strategy_symbol_reservations', reservation.id).executed_delta, -0.4)
})

test('stale execution does not roll back the latest order or virtual position', async () => {
    const db = makeFirestoreMock()
    seed(db)
    const apply = createApplyStrategySymbolExecutionSyncFn(db)
    await apply(makeOrder(), applyResult(0.7))
    const stale = await apply(makeOrder(), applyResult(0.4))
    assert.equal(stale.reservation, 'UNCHANGED')
    assert.equal(stale.noOpReason, 'STALE')
    assert.equal(read<RawData>(db, 'orders_v2', 'execution-event').executed_size, 0.7)
    assert.equal(read<RawData>(db, 'strategy_symbol_reservations', makeReservation().id).executed_delta, 0.7)
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).confirmed_position, 0.7)
})

test('overfill and identity conflicts do not change quantity and require manual review', async () => {
    const db = makeFirestoreMock()
    seed(db)
    const apply = createApplyStrategySymbolExecutionSyncFn(db)
    const overfill = await apply(makeOrder(), applyResult(1.1))
    assert.equal(overfill.reservation, 'MANUAL_REVIEW')
    assert.equal(overfill.noOpReason, 'OVERFILL')
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).confirmed_position, 0)
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).pending_delta, 1)
    assert.equal(read<RawData>(db, 'strategy_symbol_reservations', makeReservation().id).status, 'MANUAL_REVIEW')

    const identityDb = makeFirestoreMock()
    seed(identityDb, makeOrder(), makeReservation({ order_id: 'other-order' }))
    const conflict = await createApplyStrategySymbolExecutionSyncFn(identityDb)(makeOrder(), applyResult(1))
    assert.equal(conflict.reservation, 'MANUAL_REVIEW')
    assert.equal(conflict.noOpReason, 'CONFLICT')
    assert.equal(read<RawData>(identityDb, 'strategy_symbol_positions', positionId).confirmed_position, 0)
    assert.equal(read<RawData>(identityDb, 'strategy_symbol_positions', positionId).pending_delta, 1)
})

test('incomplete metadata recovery result does not move virtual quantity', async () => {
    const db = makeFirestoreMock()
    seed(db)
    const result = await createApplyStrategySymbolExecutionSyncFn(db)(makeOrder(), {
        execution: { size: 1, price: 100 },
        brokerOrderMetadataPolicy: 'SET_IF_UNSET',
    } as OrderExecutionSyncResult)

    assert.equal(result.reservation, 'MANUAL_REVIEW')
    assert.equal(result.noOpReason, 'CONFLICT')
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).confirmed_position, 0)
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).pending_delta, 1)
    assert.equal(read<RawData>(db, 'strategy_symbol_reservations', makeReservation().id).status, 'MANUAL_REVIEW')
})

test('legacy reservation without executed_delta is read as zero and upgraded on execution', async () => {
    const db = makeFirestoreMock()
    const reservation = makeReservation()
    const { executed_delta: _executedDelta, ...legacy } = serializeStrategySymbolReservation(reservation)
    seed(db)
    db.docs.strategy_symbol_reservations![reservation.id] = legacy
    const result = await createApplyStrategySymbolExecutionSyncFn(db)(makeOrder(), applyResult(1))
    assert.equal(result.reservation, 'UPDATED')
    assert.equal(db.docs.strategy_symbol_reservations![reservation.id]!.executed_delta, 1)
})

test('fill epsilon boundaries settle at the canonical reservation quantity', async () => {
    const db = makeFirestoreMock()
    seed(db)
    const apply = createApplyStrategySymbolExecutionSyncFn(db)

    const result = await apply(makeOrder(), applyResult(1 - 5e-9))
    assert.equal(result.reservation, 'UPDATED')
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).confirmed_position, 1)
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).pending_delta, 0)
    assert.equal(read<RawData>(db, 'strategy_symbol_reservations', makeReservation().id).executed_delta, 1)
    assert.equal(read<RawData>(db, 'strategy_symbol_reservations', makeReservation().id).status, 'SETTLED')
})

test('full-fill canonicalization removes residual pending dust from a near-full stored delta', async () => {
    const db = makeFirestoreMock()
    const reservation = makeReservation({ executed_delta: 1 - 5e-9 })
    seed(
        db,
        makeOrder({ executed_size: 1 - 5e-9 }),
        reservation,
        makePosition({ confirmed_position: 1 - 5e-9, pending_delta: 5e-9 }),
    )

    const result = await createApplyStrategySymbolExecutionSyncFn(db)(makeOrder(), applyResult(0.4))
    assert.equal(result.reservation, 'UPDATED')
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).confirmed_position, 1)
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).pending_delta, 0)
    assert.equal(read<RawData>(db, 'strategy_symbol_reservations', reservation.id).executed_delta, 1)
    assert.equal(read<RawData>(db, 'strategy_symbol_reservations', reservation.id).status, 'SETTLED')
})

test('transaction rejects an order document whose stored ID does not match its path', async () => {
    const db = makeFirestoreMock()
    seed(db)
    db.docs.orders_v2!['execution-event'] = {
        ...db.docs.orders_v2!['execution-event'],
        id: 'different-event',
    }
    const result = await createApplyStrategySymbolExecutionSyncFn(db)(makeOrder(), applyResult(1))

    assert.equal(result.orderUpdated, false)
    assert.equal(result.reservation, 'NOT_FOUND')
    assert.equal(result.noOpReason, 'INVALID_STORED_STATE')
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).confirmed_position, 0)
    assert.equal(read<RawData>(db, 'strategy_symbol_reservations', makeReservation().id).executed_delta, 0)
})

test('malformed stored order lifecycle is rejected without inferring execution state', async () => {
    const db = makeFirestoreMock()
    seed(db)
    db.docs.orders_v2!['execution-event'] = {
        ...db.docs.orders_v2!['execution-event'],
        status: 'UNKNOWN',
    }
    const result = await createApplyStrategySymbolExecutionSyncFn(db)(makeOrder(), applyResult(1))

    assert.equal(result.orderUpdated, false)
    assert.equal(result.reservation, 'MANUAL_REVIEW')
    assert.equal(result.noOpReason, 'INVALID_STORED_STATE')
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).confirmed_position, 0)
    assert.equal(read<RawData>(db, 'strategy_symbol_reservations', makeReservation().id).executed_delta, 0)
})

test('policy-backed invalid reservation or position keeps every document pending for retry', async () => {
    const cases: Array<{ name: string, corrupt: (db: ReturnType<typeof makeFirestoreMock>) => void }> = [
        {
            name: 'missing position',
            corrupt: (db) => {
                delete db.docs.strategy_symbol_positions![positionId]
            },
        },
        {
            name: 'invalid reservation',
            corrupt: (db) => {
                const reservation = makeReservation()
                db.docs.strategy_symbol_reservations![reservation.id] = {
                    ...serializeStrategySymbolReservation(reservation),
                    executed_delta: -1,
                }
            },
        },
        {
            name: 'invalid position',
            corrupt: (db) => {
                const position = makePosition()
                db.docs.strategy_symbol_positions![position.id] = {
                    ...serializeStrategySymbolPosition(position),
                    confirmed_position: Number.NaN,
                }
            },
        },
    ]

    for (const scenario of cases) {
        const db = makeFirestoreMock()
        seed(db)
        scenario.corrupt(db)
        const before = structuredClone(db.docs)
        const result = await createApplyStrategySymbolExecutionSyncFn(db)(makeOrder(), applyResult(1))

        assert.equal(result.orderUpdated, false, scenario.name)
        assert.equal(result.reservation, 'MANUAL_REVIEW', scenario.name)
        assert.equal(result.noOpReason, 'INVALID_STORED_STATE', scenario.name)
        assert.deepEqual(db.docs, before, scenario.name)
    }
})

test('latest terminal order status releases the remainder when a stale result omits terminal evidence', async () => {
    const db = makeFirestoreMock()
    seed(db, makeOrder({ status: 'CANCELED' }))
    const result = await createApplyStrategySymbolExecutionSyncFn(db)(makeOrder(), applyResult(0.4))

    assert.equal(result.reservation, 'UPDATED')
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).confirmed_position, 0.4)
    assert.equal(read<RawData>(db, 'strategy_symbol_positions', positionId).pending_delta, 0)
    assert.equal(read<RawData>(db, 'strategy_symbol_reservations', makeReservation().id).status, 'SETTLED')
})
