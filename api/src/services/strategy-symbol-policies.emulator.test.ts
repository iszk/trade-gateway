import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { getFirestoreClient } from '../firestore.js'
import {
    createGetStrategySymbolPolicyFn,
    createPutStrategySymbolPolicyFn,
    createStrategySymbolPolicyId,
} from './strategy-symbol-policies.js'

const hasEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST)

if (hasEmulator) {
    process.env.GCLOUD_PROJECT ??= 'trade-gateway-test'
    process.env.GOOGLE_CLOUD_PROJECT ??= process.env.GCLOUD_PROJECT
}

test('strategy-symbol policy transaction preserves versions and unrelated position state', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const symbolId = `dummy:policy_${suffix}`
    const strategyId = `policy_${suffix}`
    const secondStrategyId = `policy_other_${suffix}`
    const invalidNewStrategyIds = [
        `policy_invalid_step_${suffix}`,
        `policy_invalid_min_${suffix}`,
        `policy_invalid_max_${suffix}`,
    ]
    const policyIds = [
        createStrategySymbolPolicyId(strategyId, symbolId),
        createStrategySymbolPolicyId(secondStrategyId, symbolId),
        ...invalidNewStrategyIds.map((invalidStrategyId) => createStrategySymbolPolicyId(invalidStrategyId, symbolId)),
    ]
    const policyRef = db.collection('strategy_symbol_policies').doc(policyIds[0]!)
    const positionRef = db.collection('strategy_symbol_positions').doc(policyIds[0]!)
    const positionCreatedAt = new Date('2026-01-01T00:00:00.000Z')

    t.after(async () => {
        await Promise.all([
            ...policyIds.map((id) => db.collection('strategy_symbol_policies').doc(id).delete()),
            db.collection('tradable_symbols').doc(symbolId).delete(),
            positionRef.delete(),
        ])
    })

    await db.collection('tradable_symbols').doc(symbolId).set({
        id: symbolId,
        order_constraints: {
            quantity_step: 0.1,
            min_order_size: 0.1,
            max_order_size: 1,
        },
    })
    await positionRef.set({
        id: policyIds[0],
        marker: 'must-not-change',
        updated_at: positionCreatedAt,
    })
    const positionBefore = await positionRef.get()
    const positionBeforeData = positionBefore.data()
    const positionBeforeUpdateTime = positionBefore.updateTime?.toMillis()
    assert.ok(positionBeforeData)

    const put = createPutStrategySymbolPolicyFn(db)
    const get = createGetStrategySymbolPolicyFn(db)
    const first = await put({
        strategy_id: strategyId,
        symbol_id: symbolId,
        sizing_mode: 'WEBHOOK_CAPPED',
        enabled: true,
        max_abs_position: 1,
        no_flip: true,
    })
    const other = await put({
        strategy_id: secondStrategyId,
        symbol_id: symbolId,
        sizing_mode: 'MANAGED',
        enabled: true,
        max_abs_position: 1,
        no_flip: false,
        base_order_size: 0.2,
        taper_strength: 1,
    })
    assert.equal(first.version, 1)
    assert.equal(other.version, 1)
    assert.equal((await get(strategyId, symbolId))?.id, policyIds[0])
    assert.equal((await get(secondStrategyId, symbolId))?.id, policyIds[1])

    // Each representative constraint failure must leave a new policy document absent.
    const invalidNewInputs = [
        {
            strategy_id: invalidNewStrategyIds[0]!,
            symbol_id: symbolId,
            sizing_mode: 'WEBHOOK_CAPPED' as const,
            enabled: true,
            max_abs_position: 0.95,
            no_flip: true,
        },
        {
            strategy_id: invalidNewStrategyIds[1]!,
            symbol_id: symbolId,
            sizing_mode: 'WEBHOOK_CAPPED' as const,
            enabled: true,
            max_abs_position: 0.05,
            no_flip: true,
        },
        {
            strategy_id: invalidNewStrategyIds[2]!,
            symbol_id: symbolId,
            sizing_mode: 'MANAGED' as const,
            enabled: true,
            max_abs_position: 1.1,
            no_flip: true,
            base_order_size: 1.1,
            taper_strength: 0,
        },
    ]
    for (const invalidInput of invalidNewInputs) {
        await assert.rejects(put(invalidInput))
        const invalidPolicy = await db.collection('strategy_symbol_policies')
            .doc(createStrategySymbolPolicyId(invalidInput.strategy_id, symbolId))
            .get()
        assert.equal(invalidPolicy.exists, false)
    }

    // The same step/min/max failures must not overwrite an existing policy.
    const policyBeforeInvalidUpdates = await policyRef.get()
    const policyBeforeInvalidData = policyBeforeInvalidUpdates.data()
    const policyBeforeInvalidUpdateTime = policyBeforeInvalidUpdates.updateTime?.toMillis()
    assert.ok(policyBeforeInvalidData)
    const invalidExistingInputs = [
        {
            strategy_id: strategyId,
            symbol_id: symbolId,
            sizing_mode: 'WEBHOOK_CAPPED' as const,
            enabled: true,
            max_abs_position: 0.95,
            no_flip: true,
        },
        {
            strategy_id: strategyId,
            symbol_id: symbolId,
            sizing_mode: 'WEBHOOK_CAPPED' as const,
            enabled: true,
            max_abs_position: 0.05,
            no_flip: true,
        },
        {
            strategy_id: strategyId,
            symbol_id: symbolId,
            sizing_mode: 'MANAGED' as const,
            enabled: true,
            max_abs_position: 1.1,
            no_flip: true,
            base_order_size: 1.1,
            taper_strength: 0,
        },
    ]
    for (const invalidInput of invalidExistingInputs) {
        await assert.rejects(put(invalidInput))
    }
    const policyAfterInvalidUpdates = await policyRef.get()
    assert.deepEqual(policyAfterInvalidUpdates.data(), policyBeforeInvalidData)
    assert.equal(policyAfterInvalidUpdates.updateTime?.toMillis(), policyBeforeInvalidUpdateTime)

    const policyBeforeUpdates = await get(strategyId, symbolId)
    assert.ok(policyBeforeUpdates)

    const updates = await Promise.all([
        put({
            strategy_id: strategyId,
            symbol_id: symbolId,
            sizing_mode: 'WEBHOOK_CAPPED',
            enabled: false,
            max_abs_position: 1,
            no_flip: true,
        }),
        put({
            strategy_id: strategyId,
            symbol_id: symbolId,
            sizing_mode: 'WEBHOOK_CAPPED',
            enabled: true,
            max_abs_position: 0.9,
            no_flip: false,
        }),
    ])
    assert.deepEqual(updates.map((policy) => policy.version).sort((a, b) => a - b), [2, 3])
    const latest = await get(strategyId, symbolId)
    assert.equal(latest?.version, 3)
    assert.equal(latest?.created_at.getTime(), first.created_at.getTime())
    assert.ok(latest)
    assert.ok(latest.updated_at.getTime() > policyBeforeUpdates.updated_at.getTime())
    assert.ok(updates.every((policy) => policy.updated_at.getTime() > policyBeforeUpdates.updated_at.getTime()))

    const position = await positionRef.get()
    assert.deepEqual(position.data(), positionBeforeData)
    assert.equal(position.updateTime?.toMillis(), positionBeforeUpdateTime)
})
