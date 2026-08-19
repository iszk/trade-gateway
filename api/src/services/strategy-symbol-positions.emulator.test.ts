import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { getFirestoreClient } from '../firestore.js'
import type { StrategySymbolPosition } from '../types/strategy-symbol-position.js'
import {
    createGetStrategySymbolPositionFn,
    createSetStrategySymbolPositionFn,
    createStrategySymbolPositionId,
    InvalidStoredStrategySymbolPositionError,
} from './strategy-symbol-positions.js'

const hasEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST)

if (hasEmulator) {
    process.env.GCLOUD_PROJECT ??= 'trade-gateway-test'
    process.env.GOOGLE_CLOUD_PROJECT ??= process.env.GCLOUD_PROJECT
}

test('position repository round-trips Firestore timestamps and keeps strategies independent', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const symbolId = `dummy:position_${suffix}`
    const strategyId = `position_${suffix}`
    const secondStrategyId = `position_other_${suffix}`
    const firstId = createStrategySymbolPositionId(strategyId, symbolId)
    const secondId = createStrategySymbolPositionId(secondStrategyId, symbolId)
    const createdAt = new Date('2026-01-01T00:00:00.000Z')
    const updatedAt = new Date('2026-01-02T00:00:00.000Z')
    const first: StrategySymbolPosition = {
        id: firstId,
        strategy_id: strategyId,
        symbol_id: symbolId,
        confirmed_position: 1,
        pending_delta: -0.2,
        status: 'READY',
        policy_version: 1,
        updated_at: updatedAt,
        reconciled_at: createdAt,
    }
    const second: StrategySymbolPosition = {
        ...first,
        id: secondId,
        strategy_id: secondStrategyId,
        confirmed_position: -2,
        pending_delta: 0,
        status: 'MANUAL_REVIEW',
        policy_version: 2,
        reconciled_at: null,
    }

    t.after(async () => {
        await Promise.all([
            db.collection('strategy_symbol_positions').doc(firstId).delete(),
            db.collection('strategy_symbol_positions').doc(secondId).delete(),
        ])
    })

    const set = createSetStrategySymbolPositionFn(db)
    const get = createGetStrategySymbolPositionFn(db)
    await set(first)
    await set(second)

    const firstRestored = await get(strategyId, symbolId)
    const secondRestored = await get(secondStrategyId, symbolId)
    assert.deepEqual(firstRestored, first)
    assert.deepEqual(secondRestored, second)
    assert.ok(firstRestored?.updated_at instanceof Date)
    assert.ok(firstRestored?.reconciled_at instanceof Date)
    assert.equal(secondRestored?.reconciled_at, null)

    const raw = await db.collection('strategy_symbol_positions').doc(firstId).get()
    assert.ok(raw.data()?.updated_at && typeof raw.data()?.updated_at.toDate === 'function')
    assert.equal(raw.data()?.reservations, undefined)
})
test('position repository rejects a malformed stored document in the emulator', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const symbolId = `dummy:position_invalid_${suffix}`
    const strategyId = `position_invalid_${suffix}`
    const id = createStrategySymbolPositionId(strategyId, symbolId)
    t.after(() => db.collection('strategy_symbol_positions').doc(id).delete())

    await db.collection('strategy_symbol_positions').doc(id).set({
        id,
        strategy_id: strategyId,
        symbol_id: symbolId,
        confirmed_position: 0,
        pending_delta: '0',
        status: 'READY',
        policy_version: 1,
        updated_at: new Date('2026-01-02T00:00:00.000Z'),
        reconciled_at: null,
    })
    await assert.rejects(
        createGetStrategySymbolPositionFn(db)(strategyId, symbolId),
        InvalidStoredStrategySymbolPositionError,
    )
})
