import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { getFirestoreClient } from '../firestore.js'
import { createStrategySymbolPolicyId } from './strategy-symbol-policies.js'
import { createStrategySymbolPositionId } from './strategy-symbol-positions.js'
import { createDeleteStrategySymbolPolicyFn } from './strategy-symbol-policy-delete.js'

const hasEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST)

if (hasEmulator) {
    process.env.GCLOUD_PROJECT ??= 'trade-gateway-test'
    process.env.GOOGLE_CLOUD_PROJECT ??= process.env.GCLOUD_PROJECT
}

test('force deletion emulator transaction pauses symbol, removes ledger, and retains history', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const symbolId = `dummy:delete_${suffix}`
    const strategyId = `delete_${suffix}`
    const ledgerId = createStrategySymbolPolicyId(strategyId, symbolId)
    const positionId = createStrategySymbolPositionId(strategyId, symbolId)
    const now = new Date('2026-09-01T00:00:00.000Z')

    t.after(async () => {
        await Promise.all([
            db.collection('tradable_symbols').doc(symbolId).delete(),
            db.collection('strategy_symbol_policies').doc(ledgerId).delete(),
            db.collection('strategy_symbol_positions').doc(positionId).delete(),
            db.collection('orders_v2').doc(`delete-order-${suffix}`).delete(),
            db.collection('strategy_symbol_reservations').doc(`delete-reservation-${suffix}`).delete(),
        ])
    })

    await db.collection('tradable_symbols').doc(symbolId).set({
        id: symbolId,
        broker: 'dummy',
        ticker: `delete_${suffix}`,
        currency: 'JPY',
        order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
        trade_control: { status: 'active', updated_at: now },
        created_at: now,
        updated_at: now,
    })
    await db.collection('strategy_symbol_policies').doc(ledgerId).set({
        id: ledgerId,
        strategy_id: strategyId,
        symbol_id: symbolId,
        sizing_mode: 'WEBHOOK_CAPPED',
        enabled: true,
        max_abs_position: 2,
        no_flip: true,
        version: 1,
        created_at: now,
        updated_at: now,
    })
    await db.collection('strategy_symbol_positions').doc(positionId).set({
        id: positionId,
        strategy_id: strategyId,
        symbol_id: symbolId,
        confirmed_position: 0.8,
        pending_delta: -0.1,
        status: 'MANUAL_REVIEW',
        policy_version: 1,
        updated_at: now,
        reconciled_at: null,
    })
    await db.collection('orders_v2').doc(`delete-order-${suffix}`).set({ marker: 'retain' })
    await db.collection('strategy_symbol_reservations').doc(`delete-reservation-${suffix}`).set({ marker: 'retain' })

    const result = await createDeleteStrategySymbolPolicyFn({ db, now: () => now })({
        strategyId,
        symbolId,
        confirmTarget: ledgerId,
        requestId: `delete-request-${suffix}`,
    })

    assert.equal(result.policy_deleted, true)
    assert.equal(result.position_deleted, true)
    assert.equal(result.symbol_status, 'paused')
    assert.deepEqual(result.position, {
        confirmed_position: 0.8,
        pending_delta: -0.1,
        status: 'MANUAL_REVIEW',
        policy_version: 1,
    })
    assert.equal((await db.collection('tradable_symbols').doc(symbolId).get()).data()?.trade_control.status, 'paused')
    assert.equal((await db.collection('strategy_symbol_policies').doc(ledgerId).get()).exists, false)
    assert.equal((await db.collection('strategy_symbol_positions').doc(positionId).get()).exists, false)
    assert.equal((await db.collection('orders_v2').doc(`delete-order-${suffix}`).get()).data()?.marker, 'retain')
    assert.equal((await db.collection('strategy_symbol_reservations').doc(`delete-reservation-${suffix}`).get()).data()?.marker, 'retain')
})
