import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { getFirestoreClient } from '../firestore.js'
import type { SizingMigrationManifest } from './sizing-migration.js'
import { runSizingMigration } from './sizing-migration.js'

const hasEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST)

if (hasEmulator) {
    process.env.GCLOUD_PROJECT ??= 'trade-gateway-test'
    process.env.GOOGLE_CLOUD_PROJECT ??= process.env.GCLOUD_PROJECT
}

test('sizing migration apply is atomic and reruns as NO_OP', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const symbolId = `dummy:migration_${suffix}`
    const strategyId = `migration_${suffix}`
    const orderId = `order_${suffix}`
    const now = new Date('2026-08-24T00:00:00.000Z')
    const manifest: SizingMigrationManifest = {
        project_id: process.env.GOOGLE_CLOUD_PROJECT ?? 'trade-gateway-test',
        symbols: [{
            symbol_id: symbolId,
            expected_order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
            policies: [{ strategy_id: strategyId, sizing_mode: 'WEBHOOK_CAPPED', max_abs_position: 2, no_flip: true }],
        }],
    }

    t.after(async () => {
        const collections = [
            'tradable_symbols',
            'orders_v2',
            'strategy_symbol_policies',
            'strategy_symbol_positions',
            'strategy_symbol_reservations',
        ]
        await Promise.all(collections.flatMap((collection) => [
            db.collection(collection).doc(symbolId).delete(),
            db.collection(collection).doc(`${strategyId}:${symbolId}`).delete(),
            db.collection(collection).doc(orderId).delete(),
        ]))
        const reservationQuery = await db.collection('strategy_symbol_reservations').where('symbol_id', '==', symbolId).get()
        await Promise.all(reservationQuery.docs.map((document) => document.ref.delete()))
    })

    await db.collection('tradable_symbols').doc(symbolId).set({
        id: symbolId,
        broker: 'dummy',
        ticker: `migration_${suffix}`,
        currency: 'JPY',
        order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
        trade_control: { status: 'paused', updated_at: now, updated_by: 'test' },
        created_at: now,
        updated_at: now,
    })
    await db.collection('orders_v2').doc(orderId).set({
        id: orderId,
        strategy: strategyId,
        broker: 'dummy',
        ticker: `migration_${suffix}`,
        side: 'BUY',
        order_type: 'MARKET',
        requested_size: 1,
        executed_size: 0.4,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['provider'],
        created_at: now,
        updated_at: now,
    })

    const positionFetcher = {
        fetchPositionsForReconciliation: async (broker: 'bitflyer' | 'saxo' | 'dummy') => broker === 'dummy'
            ? [{ broker: 'dummy' as const, ticker: `migration_${suffix}`, side: 'BUY' as const, size: 0.4 }]
            : [],
    }
    const applied = await runSizingMigration({ db, manifest, mode: 'APPLY', positionFetcher })
    assert.equal(applied.blocked, false)
    assert.equal(applied.symbols[0]?.status, 'APPLIED')
    assert.equal(applied.writes, 3)

    const position = await db.collection('strategy_symbol_positions').doc(`${strategyId}:${symbolId}`).get()
    assert.equal(position.data()?.confirmed_position, 0.4)
    assert.equal(position.data()?.pending_delta, 0.6)
    const reservations = await db.collection('strategy_symbol_reservations').where('symbol_id', '==', symbolId).get()
    assert.equal(reservations.size, 1)
    assert.equal(reservations.docs[0]?.data().executed_delta, 0.4)

    const rerun = await runSizingMigration({ db, manifest, mode: 'APPLY', positionFetcher })
    assert.equal(rerun.blocked, false)
    assert.equal(rerun.symbols[0]?.status, 'NO_OP')
    assert.equal(rerun.writes, 0)

    const dryRun = await runSizingMigration({ db, manifest, mode: 'DRY_RUN', positionFetcher })
    assert.equal(dryRun.blocked, false)
    assert.equal(dryRun.symbols[0]?.status, 'NO_OP')
    assert.equal(dryRun.writes, 0)
})

test('sizing migration refuses an active symbol without writes', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const symbolId = `dummy:active_migration_${suffix}`
    const strategyId = `active_migration_${suffix}`
    const now = new Date('2026-08-24T00:00:00.000Z')
    const manifest: SizingMigrationManifest = {
        project_id: process.env.GOOGLE_CLOUD_PROJECT ?? 'trade-gateway-test',
        symbols: [{
            symbol_id: symbolId,
            expected_order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
            policies: [{ strategy_id: strategyId, sizing_mode: 'WEBHOOK_CAPPED', max_abs_position: 1, no_flip: true }],
        }],
    }
    t.after(() => db.collection('tradable_symbols').doc(symbolId).delete())
    await db.collection('tradable_symbols').doc(symbolId).set({
        id: symbolId,
        broker: 'dummy',
        ticker: `active_migration_${suffix}`,
        currency: 'JPY',
        order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
        trade_control: { status: 'active', updated_at: now },
        created_at: now,
        updated_at: now,
    })

    const report = await runSizingMigration({
        db,
        manifest,
        mode: 'APPLY',
        positionFetcher: { fetchPositionsForReconciliation: async () => [] },
    })
    assert.equal(report.blocked, true)
    assert.equal(report.symbols[0]?.status, 'BLOCKED')
    assert.equal((await db.collection('strategy_symbol_policies').where('symbol_id', '==', symbolId).get()).size, 0)
    assert.equal((await db.collection('strategy_symbol_positions').where('symbol_id', '==', symbolId).get()).size, 0)
})
