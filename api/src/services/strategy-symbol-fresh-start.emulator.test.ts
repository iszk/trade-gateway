import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { getFirestoreClient } from '../firestore.js'
import { createStrategySymbolPolicyId } from './strategy-symbol-policies.js'
import { createStrategySymbolPositionId } from './strategy-symbol-positions.js'
import {
    createFreshStartStrategySymbolFn,
    FreshStartAlreadyExistsError,
    FreshStartConflictError,
    FreshStartSymbolNotPausedError,
} from './strategy-symbol-fresh-start.js'

const hasEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST)

if (hasEmulator) {
    process.env.GCLOUD_PROJECT ??= 'trade-gateway-test'
    process.env.GOOGLE_CLOUD_PROJECT ??= process.env.GCLOUD_PROJECT
}

test('fresh-start emulator flow creates atomically, reruns fail-closed, and ignores another strategy', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const symbolId = `dummy:fresh_${suffix}`
    const strategyId = `fresh_${suffix}`
    const otherStrategyId = `other_${suffix}`
    const policyId = createStrategySymbolPolicyId(strategyId, symbolId)
    const positionId = createStrategySymbolPositionId(strategyId, symbolId)
    const otherPolicyId = createStrategySymbolPolicyId(otherStrategyId, symbolId)
    const now = new Date('2026-08-20T00:00:00.000Z')
    const freshStart = createFreshStartStrategySymbolFn({
        db,
        projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'trade-gateway-test',
        now: () => now,
    })

    t.after(async () => {
        const reservationQuery = await db.collection('strategy_symbol_reservations')
            .where('symbol_id', '==', symbolId)
            .get()
        await Promise.all([
            db.collection('tradable_symbols').doc(symbolId).delete(),
            db.collection('strategy_symbol_policies').doc(policyId).delete(),
            db.collection('strategy_symbol_policies').doc(otherPolicyId).delete(),
            db.collection('strategy_symbol_positions').doc(positionId).delete(),
            ...reservationQuery.docs.map((document) => document.ref.delete()),
        ])
    })

    await db.collection('tradable_symbols').doc(symbolId).set({
        id: symbolId,
        broker: 'dummy',
        ticker: `fresh_${suffix}`,
        currency: 'JPY',
        order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
        trade_control: { status: 'paused', updated_at: now },
        created_at: now,
        updated_at: now,
    })
    await db.collection('strategy_symbol_policies').doc(otherPolicyId).set({
        id: otherPolicyId,
        strategy_id: otherStrategyId,
        symbol_id: symbolId,
        sizing_mode: 'WEBHOOK_CAPPED',
        enabled: true,
        max_abs_position: 1,
        no_flip: true,
        version: 1,
        created_at: now,
        updated_at: now,
    })

    const dryRun = await freshStart({
        strategyId,
        symbolId,
        sizingMode: 'WEBHOOK_CAPPED',
        maxAbsPosition: 2,
        noFlip: true,
    })
    assert.equal(dryRun.status, 'CREATE')
    assert.equal((await db.collection('strategy_symbol_policies').doc(policyId).get()).exists, false)
    assert.equal((await db.collection('strategy_symbol_positions').doc(positionId).get()).exists, false)

    const applied = await freshStart({
        strategyId,
        symbolId,
        sizingMode: 'WEBHOOK_CAPPED',
        maxAbsPosition: 2,
        noFlip: true,
        apply: true,
        confirmProject: process.env.GOOGLE_CLOUD_PROJECT ?? 'trade-gateway-test',
    })
    assert.equal(applied.status, 'APPLIED')
    assert.equal((await db.collection('strategy_symbol_positions').doc(positionId).get()).data()?.confirmed_position, 0)
    assert.equal((await db.collection('strategy_symbol_positions').doc(positionId).get()).data()?.pending_delta, 0)
    assert.equal((await db.collection('strategy_symbol_policies').doc(otherPolicyId).get()).exists, true)

    await assert.rejects(freshStart({
        strategyId,
        symbolId,
        sizingMode: 'WEBHOOK_CAPPED',
        maxAbsPosition: 2,
        noFlip: true,
    }), FreshStartAlreadyExistsError)

    const activeSymbolId = `dummy:active_${suffix}`
    await db.collection('tradable_symbols').doc(activeSymbolId).set({
        id: activeSymbolId,
        broker: 'dummy',
        ticker: `active_${suffix}`,
        currency: 'JPY',
        order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
        trade_control: { status: 'active', updated_at: now },
        created_at: now,
        updated_at: now,
    })
    t.after(() => db.collection('tradable_symbols').doc(activeSymbolId).delete())
    await assert.rejects(createFreshStartStrategySymbolFn({
        db,
        projectId: process.env.GOOGLE_CLOUD_PROJECT ?? 'trade-gateway-test',
    })({
        strategyId,
        symbolId: activeSymbolId,
        sizingMode: 'WEBHOOK_CAPPED',
        maxAbsPosition: 2,
        noFlip: true,
        apply: true,
        confirmProject: process.env.GOOGLE_CLOUD_PROJECT ?? 'trade-gateway-test',
    }), FreshStartSymbolNotPausedError)

    await db.collection('strategy_symbol_positions').doc(positionId).delete()
    await assert.rejects(freshStart({
        strategyId,
        symbolId,
        sizingMode: 'WEBHOOK_CAPPED',
        maxAbsPosition: 2,
        noFlip: true,
    }), FreshStartConflictError)
})
