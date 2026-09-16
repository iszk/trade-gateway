import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { getFirestoreClient } from '../firestore.js'
import { createStrategySymbolPolicyId } from './strategy-symbol-policies.js'
import { createStrategySymbolPositionId } from './strategy-symbol-positions.js'
import { createListStrategySymbolPolicyDashboardFn } from './strategy-symbol-policy-dashboard.js'

const hasEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST)

if (hasEmulator) {
    process.env.GCLOUD_PROJECT ??= 'trade-gateway-test'
    process.env.GOOGLE_CLOUD_PROJECT ??= process.env.GCLOUD_PROJECT
}

test('policy dashboard emulator pairs timestamps and isolates malformed documents', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const symbolId = `dummy:dashboard_${suffix}`
    const strategyId = `dashboard_${suffix}`
    const healthyId = createStrategySymbolPolicyId(strategyId, symbolId)
    const invalidPolicyId = createStrategySymbolPolicyId(`dashboard_invalid_${suffix}`, symbolId)
    const invalidPositionId = createStrategySymbolPositionId(`dashboard_position_invalid_${suffix}`, symbolId)
    const createdAt = new Date('2026-09-01T00:00:00.000Z')

    t.after(async () => {
        await Promise.all([
            db.collection('strategy_symbol_policies').doc(healthyId).delete(),
            db.collection('strategy_symbol_policies').doc(invalidPolicyId).delete(),
            db.collection('strategy_symbol_positions').doc(healthyId).delete(),
            db.collection('strategy_symbol_positions').doc(invalidPositionId).delete(),
        ])
    })

    await db.collection('strategy_symbol_policies').doc(healthyId).set({
        id: healthyId,
        strategy_id: strategyId,
        symbol_id: symbolId,
        sizing_mode: 'WEBHOOK_CAPPED',
        enabled: true,
        max_abs_position: 2,
        no_flip: true,
        version: 1,
        created_at: createdAt,
        updated_at: createdAt,
    })
    await db.collection('strategy_symbol_positions').doc(healthyId).set({
        id: healthyId,
        strategy_id: strategyId,
        symbol_id: symbolId,
        confirmed_position: 0.4,
        pending_delta: 0.1,
        status: 'READY',
        policy_version: 1,
        updated_at: createdAt,
        reconciled_at: null,
    })
    await db.collection('strategy_symbol_policies').doc(invalidPolicyId).set({
        id: 'wrong-id',
        strategy_id: 'not-the-path',
        symbol_id: symbolId,
        sizing_mode: 'WEBHOOK_CAPPED',
        enabled: true,
        max_abs_position: 2,
        no_flip: true,
        version: 1,
        created_at: createdAt,
        updated_at: createdAt,
    })
    await db.collection('strategy_symbol_positions').doc(invalidPositionId).set({
        id: invalidPositionId,
        strategy_id: `dashboard_position_invalid_${suffix}`,
        symbol_id: symbolId,
        confirmed_position: 0,
        pending_delta: 'not-a-number',
        status: 'READY',
        policy_version: 1,
        updated_at: createdAt,
        reconciled_at: null,
    })

    const result = await createListStrategySymbolPolicyDashboardFn({ db })()
    const healthy = result.entries.find((entry) => entry.id === healthyId)
    const invalidPolicy = result.entries.find((entry) => entry.id === invalidPolicyId)
    const invalidPosition = result.entries.find((entry) => entry.id === invalidPositionId)

    assert.equal(healthy?.ledger_health, 'READY')
    assert.equal(healthy?.policy?.created_at instanceof Date, true)
    assert.equal(healthy?.position?.updated_at instanceof Date, true)
    assert.equal(invalidPolicy?.ledger_health, 'INVALID_POLICY')
    assert.equal(invalidPolicy?.strategy_id, 'dashboard_invalid_' + suffix)
    assert.equal(invalidPolicy?.policy, undefined)
    assert.equal(invalidPosition?.ledger_health, 'INVALID_POSITION')
    assert.equal(invalidPosition?.position, undefined)
})
