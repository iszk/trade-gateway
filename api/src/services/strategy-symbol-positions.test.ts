import assert from 'node:assert/strict'
import test from 'node:test'

import type { StrategySymbolPosition } from '../types/strategy-symbol-position.js'
import {
    createGetStrategySymbolPositionFn,
    createSetStrategySymbolPositionFn,
    createStrategySymbolPositionId,
    deserializeStrategySymbolPosition,
    InvalidStoredStrategySymbolPositionError,
    InvalidStrategySymbolPositionError,
    serializeStrategySymbolPosition,
} from './strategy-symbol-positions.js'

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
    return db as unknown as Parameters<typeof createGetStrategySymbolPositionFn>[0] & {
        collections: typeof collections
    }
}

const positionId = createStrategySymbolPositionId('strategy-1', 'bitflyer:BTC_JPY')

const makePosition = (overrides: Partial<StrategySymbolPosition> = {}): StrategySymbolPosition => ({
    id: positionId,
    strategy_id: 'strategy-1',
    symbol_id: 'bitflyer:BTC_JPY',
    confirmed_position: 1.25,
    pending_delta: -0.25,
    status: 'READY',
    policy_version: 3,
    updated_at: new Date('2026-01-02T00:00:00.000Z'),
    reconciled_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
})

test('position ID shares the policy identity contract and separates strategy/symbol pairs', () => {
    assert.equal(positionId, 'strategy-1:bitflyer:BTC_JPY')
    assert.equal(createStrategySymbolPositionId('strategy-1', 'saxo:FX:NAS100'), 'strategy-1:saxo:FX:NAS100')
    assert.notEqual(
        createStrategySymbolPositionId('strategy-1', 'bitflyer:BTC_JPY'),
        createStrategySymbolPositionId('strategy-2', 'bitflyer:BTC_JPY'),
    )
    assert.notEqual(
        createStrategySymbolPositionId('strategy-1', 'bitflyer:BTC_JPY'),
        createStrategySymbolPositionId('strategy-1', 'bitflyer:ETH_JPY'),
    )
    assert.throws(() => createStrategySymbolPositionId('strategy/1', 'bitflyer:BTC_JPY'), InvalidStrategySymbolPositionError)
    assert.throws(() => createStrategySymbolPositionId('strategy-1', 'bitflyer:BTC/JPY'), InvalidStrategySymbolPositionError)
})

test('position serialization round-trips, canonicalizes -0, and defensively copies dates', () => {
    const original = makePosition({ confirmed_position: -0, pending_delta: -0 })
    const serialized = serializeStrategySymbolPosition(original)

    assert.equal(serialized.confirmed_position, 0)
    assert.equal(Object.is(serialized.confirmed_position, -0), false)
    assert.equal(serialized.pending_delta, 0)
    assert.notEqual(serialized.updated_at, original.updated_at)
    assert.notEqual(serialized.reconciled_at, original.reconciled_at)

    const restored = deserializeStrategySymbolPosition(serialized, positionId)
    assert.deepEqual(restored, {
        ...original,
        confirmed_position: 0,
        pending_delta: 0,
    })
    assert.notEqual(restored.updated_at, serialized.updated_at)
    assert.notEqual(restored.reconciled_at, serialized.reconciled_at)
    ;(serialized.updated_at as Date).setUTCFullYear(2030)
    assert.equal(original.updated_at.getUTCFullYear(), 2026)
})

test('position deserialization accepts Timestamp-like dates but rejects invalid or throwing dates', () => {
    const position = makePosition({ reconciled_at: null })
    const serialized = serializeStrategySymbolPosition(position)
    const timestampLike = {
        toDate: () => new Date('2026-01-02T00:00:00.000Z'),
    }
    const restored = deserializeStrategySymbolPosition({
        ...serialized,
        updated_at: timestampLike,
    }, positionId)
    assert.ok(restored.updated_at instanceof Date)
    assert.equal(restored.updated_at.toISOString(), '2026-01-02T00:00:00.000Z')
    assert.equal(restored.reconciled_at, null)

    const malformed = [
        { ...serialized, confirmed_position: '1' },
        { ...serialized, confirmed_position: Number.NaN },
        { ...serialized, pending_delta: Number.POSITIVE_INFINITY },
        { ...serialized, policy_version: 0 },
        { ...serialized, policy_version: 1.5 },
        { ...serialized, status: 'UNKNOWN' },
        { ...serialized, updated_at: new Date('invalid') },
        { ...serialized, updated_at: { toDate: () => { throw new Error('bad timestamp') } } },
        { ...serialized, reconciled_at: new Date('2026-01-03T00:00:00.000Z') },
        { ...serialized, reconciled_at: undefined },
        { ...serialized, extra: true },
        { ...serialized, id: 'wrong-id' },
        { ...serialized, strategy_id: 'other-strategy' },
    ]
    for (const value of malformed) {
        assert.throws(() => deserializeStrategySymbolPosition(value, positionId), InvalidStoredStrategySymbolPositionError)
    }
})

test('position SET/GET uses an independent top-level collection and fails closed on corrupted data', async () => {
    const db = makeFirestoreMock()
    const set = createSetStrategySymbolPositionFn(db)
    const get = createGetStrategySymbolPositionFn(db)
    const position = makePosition()

    await set(position)
    const restored = await get(position.strategy_id, position.symbol_id)
    assert.deepEqual(restored, position)
    assert.ok(db.collections.strategy_symbol_positions?.[position.id])
    assert.equal(db.collections.strategy_symbol_positions?.[position.id]?.reservations, undefined)

    await assert.rejects(set({ ...position, id: 'wrong-id' }), InvalidStrategySymbolPositionError)
    db.collections.strategy_symbol_positions![position.id] = {
        ...db.collections.strategy_symbol_positions![position.id],
        pending_delta: 'not-a-number',
    }
    await assert.rejects(get(position.strategy_id, position.symbol_id), InvalidStoredStrategySymbolPositionError)
})
