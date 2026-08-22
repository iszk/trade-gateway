import assert from 'node:assert/strict'
import test from 'node:test'

import type {
    StrategySymbolReservation,
    StrategySymbolReservationTransition,
} from '../types/strategy-symbol-reservation.js'
import {
    createGetStrategySymbolReservationFn,
    createSetStrategySymbolReservationFn,
    createStrategySymbolReservationId,
    deserializeStrategySymbolReservation,
    InvalidStoredStrategySymbolReservationError,
    InvalidStrategySymbolReservationError,
    serializeStrategySymbolReservation,
    isAllowedStrategySymbolReservationTransition,
} from './strategy-symbol-reservations.js'

const makeFirestoreMock = () => {
    const collections: Record<string, Record<string, Record<string, unknown>>> = {}
    const db = {
        collection: (collection: string) => ({
            doc: (id: string) => ({
                id,
                get: async () => {
                    const data = collections[collection]?.[id]
                    return {
                        id,
                        exists: data !== undefined,
                        data: () => data,
                    }
                },
                set: async (data: Record<string, unknown>) => {
                    collections[collection] ??= {}
                    collections[collection]![id] = data
                },
            }),
        }),
        collections,
    }
    return db as unknown as Parameters<typeof createGetStrategySymbolReservationFn>[0] & {
        collections: typeof collections
    }
}

const strategyId = 'strategy-1'
const symbolId = 'bitflyer:BTC_JPY'
const eventId = 'event/日本語:1'
const positionId = `${strategyId}:${symbolId}`
const reservationId = createStrategySymbolReservationId(strategyId, symbolId, eventId)

const makeReservation = (overrides: Partial<StrategySymbolReservation> = {}): StrategySymbolReservation => ({
    id: reservationId,
    event_id: eventId,
    position_id: positionId,
    strategy_id: strategyId,
    symbol_id: symbolId,
    order_id: 'order/決定済み:1',
    reserved_delta: -0.5,
    status: 'RESERVED',
    policy_version: 7,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
})

test('reservation ID is stable, fixed-length, and separates every tuple component', () => {
    assert.equal(createStrategySymbolReservationId(strategyId, symbolId, eventId), reservationId)
    assert.match(reservationId, /^r_[0-9a-f]{64}$/)
    assert.equal(reservationId.length, 66)
    assert.notEqual(createStrategySymbolReservationId('strategy-2', symbolId, eventId), reservationId)
    assert.notEqual(createStrategySymbolReservationId(strategyId, 'saxo:FX:NAS100', eventId), reservationId)
    assert.notEqual(createStrategySymbolReservationId(strategyId, symbolId, `${eventId}-other`), reservationId)
    assert.throws(() => createStrategySymbolReservationId(strategyId, symbolId, ''), InvalidStrategySymbolReservationError)
    assert.throws(() => createStrategySymbolReservationId(strategyId, symbolId, '  \t'), InvalidStrategySymbolReservationError)
})

test('reservation serialization round-trips and defensively copies dates', () => {
    const original = makeReservation()
    const serialized = serializeStrategySymbolReservation(original)
    assert.equal(serialized.event_id, eventId)
    assert.equal(serialized.order_id, 'order/決定済み:1')
    assert.notEqual(serialized.created_at, original.created_at)
    assert.notEqual(serialized.updated_at, original.updated_at)

    const restored = deserializeStrategySymbolReservation(serialized, reservationId)
    assert.deepEqual(restored, original)
    assert.notEqual(restored.created_at, serialized.created_at)
    ;(serialized.created_at as Date).setUTCFullYear(2030)
    assert.equal(original.created_at.getUTCFullYear(), 2026)
})

test('reservation deserialization accepts Timestamp-like values but rejects malformed documents', () => {
    const reservation = makeReservation()
    const serialized = serializeStrategySymbolReservation(reservation)
    const valid = deserializeStrategySymbolReservation({
        ...serialized,
        created_at: { toDate: () => new Date('2026-01-01T00:00:00.000Z') },
        updated_at: { toDate: () => new Date('2026-01-02T00:00:00.000Z') },
    }, reservationId)
    assert.ok(valid.created_at instanceof Date)
    assert.ok(valid.updated_at instanceof Date)

    const malformed = [
        { ...serialized, event_id: '' },
        { ...serialized, event_id: '   ' },
        { ...serialized, position_id: 'wrong-position' },
        { ...serialized, order_id: '' },
        { ...serialized, reserved_delta: 0 },
        { ...serialized, reserved_delta: '0.5' },
        { ...serialized, reserved_delta: Number.NaN },
        { ...serialized, status: 'UNKNOWN' },
        { ...serialized, policy_version: Number.POSITIVE_INFINITY },
        { ...serialized, created_at: new Date('2026-01-03T00:00:00.000Z') },
        { ...serialized, updated_at: { toDate: () => { throw new Error('bad timestamp') } } },
        { ...serialized, extra: true },
        { ...serialized, id: 'r_wrong' },
        { ...serialized, strategy_id: 'other-strategy' },
    ]
    for (const value of malformed) {
        assert.throws(() => deserializeStrategySymbolReservation(value, reservationId), InvalidStoredStrategySymbolReservationError)
    }
})

test('reservation state transitions allow only the fail-closed lifecycle table and idempotent self-transitions', () => {
    const statuses = ['RESERVED', 'DISPATCHED', 'RELEASED', 'MANUAL_REVIEW', 'SETTLED'] as const
    for (const status of statuses) {
        const selfTransition: StrategySymbolReservationTransition = { from: status, to: status }
        assert.equal(isAllowedStrategySymbolReservationTransition(selfTransition.from, selfTransition.to), true)
    }

    const allowed: [typeof statuses[number], typeof statuses[number]][] = [
        ['RESERVED', 'DISPATCHED'],
        ['RESERVED', 'RELEASED'],
        ['RESERVED', 'SETTLED'],
        ['RESERVED', 'MANUAL_REVIEW'],
        ['DISPATCHED', 'SETTLED'],
        ['DISPATCHED', 'MANUAL_REVIEW'],
        ['MANUAL_REVIEW', 'DISPATCHED'],
        ['MANUAL_REVIEW', 'RELEASED'],
        ['MANUAL_REVIEW', 'SETTLED'],
    ]
    for (const [from, to] of allowed) {
        assert.equal(isAllowedStrategySymbolReservationTransition(from, to), true, `${from} -> ${to}`)
    }

    const denied: [typeof statuses[number], typeof statuses[number]][] = [
        ['DISPATCHED', 'RESERVED'],
        ['DISPATCHED', 'RELEASED'],
        ['RELEASED', 'RESERVED'],
        ['RELEASED', 'SETTLED'],
        ['SETTLED', 'RESERVED'],
        ['SETTLED', 'MANUAL_REVIEW'],
    ]
    for (const [from, to] of denied) {
        assert.equal(isAllowedStrategySymbolReservationTransition(from, to), false, `${from} -> ${to}`)
    }
    assert.equal(isAllowedStrategySymbolReservationTransition('UNKNOWN' as never, 'RESERVED'), false)
})

test('reservation SET/GET remains independent from position documents', async () => {
    const db = makeFirestoreMock()
    const set = createSetStrategySymbolReservationFn(db)
    const get = createGetStrategySymbolReservationFn(db)
    const reservation = makeReservation()

    await set(reservation)
    const restored = await get(strategyId, symbolId, eventId)
    assert.deepEqual(restored, reservation)
    assert.ok(db.collections.strategy_symbol_reservations?.[reservation.id])
    assert.equal(db.collections.strategy_symbol_reservations?.[reservation.id]?.reservations, undefined)
    assert.equal(db.collections.strategy_symbol_positions, undefined)

    await assert.rejects(set({ ...reservation, id: 'r_wrong' }), InvalidStrategySymbolReservationError)
    db.collections.strategy_symbol_reservations![reservation.id] = {
        ...db.collections.strategy_symbol_reservations![reservation.id],
        position_id: 'wrong-position',
    }
    await assert.rejects(get(strategyId, symbolId, eventId), InvalidStoredStrategySymbolReservationError)
})
