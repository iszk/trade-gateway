import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { getFirestoreClient } from '../firestore.js'
import type { Position } from '../types/position.js'
import type { TradableSymbol } from '../types/tradable-symbol.js'
import { createStrategySymbolReconciliationService } from './strategy-symbol-reconciliation.js'
import { createStrategySymbolPositionId } from './strategy-symbol-positions.js'

const hasEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST)

if (hasEmulator) {
    process.env.GCLOUD_PROJECT ??= 'trade-gateway-test'
    process.env.GOOGLE_CLOUD_PROJECT ??= process.env.GCLOUD_PROJECT
}

const makeSymbol = (symbolId: string, at: Date): TradableSymbol => ({
    id: symbolId,
    broker: 'dummy',
    ticker: symbolId.slice('dummy:'.length),
    currency: 'JPY',
    order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
    trade_control: { status: 'active', updated_at: at },
    created_at: at,
    updated_at: at,
})

test('broker excess is logged as MISMATCH without changing symbol or strategy position', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const symbolId = `dummy:monitor_${suffix}`
    const strategyId = `monitor_${suffix}`
    const positionId = createStrategySymbolPositionId(strategyId, symbolId)
    const at = new Date('2026-01-01T00:00:00.000Z')
    const symbol = makeSymbol(symbolId, at)
    const position = {
        id: positionId,
        strategy_id: strategyId,
        symbol_id: symbolId,
        confirmed_position: 0,
        pending_delta: 0,
        status: 'READY',
        policy_version: 1,
        updated_at: at,
        reconciled_at: null,
    }
    const brokerPositions: Position[] = [{
        broker: 'dummy',
        ticker: symbol.ticker,
        side: 'BUY',
        size: 1,
    }]

    t.after(async () => {
        await Promise.all([
            db.collection('tradable_symbols').doc(symbolId).delete(),
            db.collection('strategy_symbol_positions').doc(positionId).delete(),
        ])
    })
    await db.collection('tradable_symbols').doc(symbolId).set(symbol)
    await db.collection('strategy_symbol_positions').doc(positionId).set(position)

    const service = createStrategySymbolReconciliationService({
        db,
        listTradableSymbols: async () => [symbol],
        fetchPositionsForReconciliation: async (broker) => broker === 'dummy' ? brokerPositions : [],
        logger: { info: () => undefined, warn: () => undefined },
    })

    const beforeSymbol = await db.collection('tradable_symbols').doc(symbolId).get()
    const beforePosition = await db.collection('strategy_symbol_positions').doc(positionId).get()
    const summary = await service.runStrategySymbolReconciliation()
    assert.equal(summary.mismatched, 1)
    assert.equal(summary.indeterminate, 0)
    assert.equal(summary.mismatches[0]?.symbolId, symbolId)

    const afterSymbol = await db.collection('tradable_symbols').doc(symbolId).get()
    const afterPosition = await db.collection('strategy_symbol_positions').doc(positionId).get()
    assert.deepEqual(afterSymbol.data(), beforeSymbol.data())
    assert.equal(afterSymbol.updateTime?.toMillis(), beforeSymbol.updateTime?.toMillis())
    assert.deepEqual(afterPosition.data(), beforePosition.data())
    assert.equal(afterPosition.updateTime?.toMillis(), beforePosition.updateTime?.toMillis())
})

test('broker fetch failure is indeterminate and leaves stored state unchanged', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const symbolId = `dummy:fetch_failure_${suffix}`
    const strategyId = `fetch_failure_${suffix}`
    const positionId = createStrategySymbolPositionId(strategyId, symbolId)
    const at = new Date('2026-01-01T00:00:00.000Z')
    const symbol = makeSymbol(symbolId, at)
    const position = {
        id: positionId,
        strategy_id: strategyId,
        symbol_id: symbolId,
        confirmed_position: 1,
        pending_delta: 0,
        status: 'READY',
        policy_version: 1,
        updated_at: at,
        reconciled_at: null,
    }

    t.after(async () => {
        await Promise.all([
            db.collection('tradable_symbols').doc(symbolId).delete(),
            db.collection('strategy_symbol_positions').doc(positionId).delete(),
        ])
    })
    await db.collection('tradable_symbols').doc(symbolId).set(symbol)
    await db.collection('strategy_symbol_positions').doc(positionId).set(position)

    const service = createStrategySymbolReconciliationService({
        db,
        listTradableSymbols: async () => [symbol],
        fetchPositionsForReconciliation: async (broker) => {
            if (broker === 'dummy') throw new Error('broker unavailable')
            return []
        },
        logger: { info: () => undefined, warn: () => undefined },
    })
    const beforeSymbol = await db.collection('tradable_symbols').doc(symbolId).get()
    const beforePosition = await db.collection('strategy_symbol_positions').doc(positionId).get()

    const summary = await service.runStrategySymbolReconciliation()
    assert.equal(summary.mismatched, 0)
    assert.equal(summary.indeterminate, 1)
    assert.equal(summary.brokers.find((entry) => entry.broker === 'dummy')?.success, false)

    const afterSymbol = await db.collection('tradable_symbols').doc(symbolId).get()
    const afterPosition = await db.collection('strategy_symbol_positions').doc(positionId).get()
    assert.deepEqual(afterSymbol.data(), beforeSymbol.data())
    assert.deepEqual(afterPosition.data(), beforePosition.data())
})

test('invalid stored timestamp is reported without a write or pause', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const symbolId = `dummy:invalid_timestamp_${suffix}`
    const symbol = {
        id: symbolId,
        broker: 'dummy' as const,
        ticker: symbolId.slice('dummy:'.length),
        currency: 'JPY',
        order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
        trade_control: { status: 'active' as const, updated_at: 'not-a-timestamp' },
        created_at: 'not-a-timestamp',
        updated_at: 'not-a-timestamp',
    }

    t.after(async () => {
        await db.collection('tradable_symbols').doc(symbolId).delete()
    })
    await db.collection('tradable_symbols').doc(symbolId).set(symbol)

    const service = createStrategySymbolReconciliationService({
        db,
        listTradableSymbols: async () => [symbol as unknown as TradableSymbol],
        fetchPositionsForReconciliation: async (broker) => broker === 'dummy'
            ? [{ broker: 'dummy', ticker: symbol.ticker, side: 'BUY', size: 1 }]
            : [],
        logger: { info: () => undefined, warn: () => undefined },
    })
    const before = await db.collection('tradable_symbols').doc(symbolId).get()
    const summary = await service.runStrategySymbolReconciliation()
    assert.equal(summary.indeterminate, 1)
    const after = await db.collection('tradable_symbols').doc(symbolId).get()
    assert.deepEqual(after.data(), before.data())
    assert.equal(after.updateTime?.toMillis(), before.updateTime?.toMillis())
})
