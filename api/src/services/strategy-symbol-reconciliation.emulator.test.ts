import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { getFirestoreClient } from '../firestore.js'
import type { Position } from '../types/position.js'
import type { TradableSymbol } from '../types/tradable-symbol.js'
import {
    createStrategySymbolReconciliationService,
    RECONCILIATION_PAUSE_REASON,
    RECONCILIATION_PAUSE_UPDATED_BY,
} from './strategy-symbol-reconciliation.js'
import { createStrategySymbolPositionId } from './strategy-symbol-positions.js'

const hasEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST)

if (hasEmulator) {
    process.env.GCLOUD_PROJECT ??= 'trade-gateway-test'
    process.env.GOOGLE_CLOUD_PROJECT ??= process.env.GCLOUD_PROJECT
}

test('reconciliation transaction pauses MISMATCH idempotently and manual recovery restores READY', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const symbolId = `dummy:reconcile_${suffix}`
    const strategyId = `reconcile_${suffix}`
    const positionId = createStrategySymbolPositionId(strategyId, symbolId)
    const at = new Date('2026-01-01T00:00:00.000Z')
    const symbol: TradableSymbol = {
        id: symbolId,
        broker: 'dummy',
        ticker: symbolId.slice('dummy:'.length),
        currency: 'JPY',
        order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
        trade_control: { status: 'active', updated_at: at },
        created_at: at,
        updated_at: at,
    }
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
    let brokerPositions: Position[] = [{ broker: 'dummy', ticker: symbol.ticker, side: 'BUY', size: 1 }]

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
        now: () => new Date('2026-01-02T00:00:00.000Z'),
        logger: { info: () => undefined, warn: () => undefined },
    })

    const first = await service.runStrategySymbolReconciliation()
    assert.equal(first.mismatched, 1)
    const paused = await db.collection('tradable_symbols').doc(symbolId).get()
    assert.equal(paused.data()?.trade_control?.status, 'paused')
    assert.equal(paused.data()?.trade_control?.reason, RECONCILIATION_PAUSE_REASON)
    assert.equal(paused.data()?.trade_control?.updated_by, RECONCILIATION_PAUSE_UPDATED_BY)
    const mismatchPosition = await db.collection('strategy_symbol_positions').doc(positionId).get()
    assert.equal(mismatchPosition.data()?.status, 'MISMATCH')
    const firstUpdateTime = paused.updateTime?.toMillis()
    const second = await service.runStrategySymbolReconciliation()
    assert.equal(second.mismatched, 1)
    const pausedAgain = await db.collection('tradable_symbols').doc(symbolId).get()
    assert.equal(pausedAgain.updateTime?.toMillis(), firstUpdateTime)

    brokerPositions = []
    const recovered = await service.recoverStrategySymbol(symbolId)
    assert.equal(recovered.kind, 'RECOVERED')
    const active = await db.collection('tradable_symbols').doc(symbolId).get()
    assert.equal(active.data()?.trade_control?.status, 'active')
    assert.equal(active.data()?.trade_control?.reason, undefined)
    assert.equal((await db.collection('strategy_symbol_positions').doc(positionId).get()).data()?.status, 'READY')
})

test('manual recovery keeps an operator-owned pause', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const symbolId = `dummy:operator_${suffix}`
    const strategyId = `operator_${suffix}`
    const positionId = createStrategySymbolPositionId(strategyId, symbolId)
    const at = new Date('2026-01-01T00:00:00.000Z')
    const symbol: TradableSymbol = {
        id: symbolId,
        broker: 'dummy',
        ticker: symbolId.slice('dummy:'.length),
        currency: 'JPY',
        order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
        trade_control: { status: 'paused', reason: 'operator maintenance', updated_by: 'operator', updated_at: at },
        created_at: at,
        updated_at: at,
    }
    t.after(async () => {
        await Promise.all([
            db.collection('tradable_symbols').doc(symbolId).delete(),
            db.collection('strategy_symbol_positions').doc(positionId).delete(),
        ])
    })
    await db.collection('tradable_symbols').doc(symbolId).set(symbol)
    await db.collection('strategy_symbol_positions').doc(positionId).set({
        id: positionId,
        strategy_id: strategyId,
        symbol_id: symbolId,
        confirmed_position: 1,
        pending_delta: 0,
        status: 'MISMATCH',
        policy_version: 1,
        updated_at: at,
        reconciled_at: at,
    })

    const service = createStrategySymbolReconciliationService({
        db,
        listTradableSymbols: async () => [symbol],
        fetchPositionsForReconciliation: async (broker) => broker === 'dummy'
            ? [{ broker: 'dummy', ticker: symbol.ticker, side: 'BUY', size: 1 }]
            : [],
        now: () => new Date('2026-01-02T00:00:00.000Z'),
        logger: { info: () => undefined, warn: () => undefined },
    })

    const recovered = await service.recoverStrategySymbol(symbolId)
    assert.equal(recovered.kind, 'RECOVERED_STILL_OPERATOR_PAUSED')
    const storedSymbol = await db.collection('tradable_symbols').doc(symbolId).get()
    assert.equal(storedSymbol.data()?.trade_control?.status, 'paused')
    assert.equal(storedSymbol.data()?.trade_control?.reason, 'operator maintenance')
    assert.equal((await db.collection('strategy_symbol_positions').doc(positionId).get()).data()?.status, 'READY')
})

test('corrupt strategy position pauses an otherwise valid symbol without rewriting the position', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const symbolId = `dummy:corrupt_${suffix}`
    const corruptPositionId = `corrupt_${suffix}:${symbolId}`
    const at = new Date('2026-01-01T00:00:00.000Z')
    const symbol: TradableSymbol = {
        id: symbolId,
        broker: 'dummy',
        ticker: symbolId.slice('dummy:'.length),
        currency: 'JPY',
        order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
        trade_control: { status: 'active', updated_at: at },
        created_at: at,
        updated_at: at,
    }

    t.after(async () => {
        await Promise.all([
            db.collection('tradable_symbols').doc(symbolId).delete(),
            db.collection('strategy_symbol_positions').doc(corruptPositionId).delete(),
        ])
    })
    await db.collection('tradable_symbols').doc(symbolId).set(symbol)
    await db.collection('strategy_symbol_positions').doc(corruptPositionId).set({
        id: corruptPositionId,
        symbol_id: symbolId,
        // Deliberately omit strategy_id and the quantity fields.  The
        // reconciliation path must never infer a replacement position.
    })

    const service = createStrategySymbolReconciliationService({
        db,
        listTradableSymbols: async () => [symbol],
        fetchPositionsForReconciliation: async () => [],
        now: () => new Date('2026-01-02T00:00:00.000Z'),
        logger: { info: () => undefined, warn: () => undefined },
    })

    const summary = await service.runStrategySymbolReconciliation()
    assert.equal(summary.indeterminate, 1)
    const storedSymbol = await db.collection('tradable_symbols').doc(symbolId).get()
    assert.equal(storedSymbol.data()?.trade_control?.status, 'paused')
    assert.equal(storedSymbol.data()?.trade_control?.reason, RECONCILIATION_PAUSE_REASON)
    assert.deepEqual((await db.collection('strategy_symbol_positions').doc(corruptPositionId).get()).data(), {
        id: corruptPositionId,
        symbol_id: symbolId,
    })
})

test('broker fetch failure leaves symbol and strategy position unchanged', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const symbolId = `dummy:fetch_failure_${suffix}`
    const strategyId = `fetch_failure_${suffix}`
    const positionId = createStrategySymbolPositionId(strategyId, symbolId)
    const at = new Date('2026-01-01T00:00:00.000Z')
    const symbol: TradableSymbol = {
        id: symbolId,
        broker: 'dummy',
        ticker: symbolId.slice('dummy:'.length),
        currency: 'JPY',
        order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
        trade_control: { status: 'active', updated_at: at },
        created_at: at,
        updated_at: at,
    }
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
        now: () => new Date('2026-01-02T00:00:00.000Z'),
        logger: { info: () => undefined, warn: () => undefined },
    })

    const summary = await service.runStrategySymbolReconciliation()
    assert.equal(summary.indeterminate, 1)
    assert.equal((await db.collection('tradable_symbols').doc(symbolId).get()).data()?.trade_control?.status, 'active')
    assert.equal((await db.collection('strategy_symbol_positions').doc(positionId).get()).data()?.status, 'READY')
})

test('corrupt symbol timestamps still pause a broker-excess symbol', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const symbolId = `dummy:timestamp_corrupt_${suffix}`
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
        now: () => new Date('2026-01-02T00:00:00.000Z'),
        logger: { info: () => undefined, warn: () => undefined },
    })

    const summary = await service.runStrategySymbolReconciliation()
    assert.equal(summary.indeterminate, 1)
    const stored = await db.collection('tradable_symbols').doc(symbolId).get()
    assert.equal(stored.data()?.trade_control?.status, 'paused')
    assert.equal(stored.data()?.trade_control?.reason, RECONCILIATION_PAUSE_REASON)
    assert.equal(stored.data()?.trade_control?.updated_by, RECONCILIATION_PAUSE_UPDATED_BY)
    assert.ok(stored.data()?.updated_at?.toDate() instanceof Date)
    assert.ok(stored.data()?.trade_control?.updated_at?.toDate() instanceof Date)
})

test('manual recovery remains blocked for pending, manual review, and broker fetch failure', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const at = new Date('2026-01-01T00:00:00.000Z')
    const cases = [
        { name: 'pending', status: 'MISMATCH' as const, pending: 0.1, reason: 'PENDING_NOT_ZERO' as const },
        { name: 'manual', status: 'MANUAL_REVIEW' as const, pending: 0, reason: 'MANUAL_REVIEW' as const },
    ]
    const resources: { symbolId: string; positionId: string }[] = []

    t.after(async () => {
        await Promise.all(resources.flatMap(({ symbolId, positionId }) => [
            db.collection('tradable_symbols').doc(symbolId).delete(),
            db.collection('strategy_symbol_positions').doc(positionId).delete(),
        ]))
    })

    for (const recoveryCase of cases) {
        const symbolId = `dummy:recovery_${recoveryCase.name}_${suffix}`
        const strategyId = `recovery_${recoveryCase.name}_${suffix}`
        const positionId = createStrategySymbolPositionId(strategyId, symbolId)
        resources.push({ symbolId, positionId })
        await db.collection('tradable_symbols').doc(symbolId).set({
            id: symbolId,
            broker: 'dummy',
            ticker: symbolId.slice('dummy:'.length),
            currency: 'JPY',
            order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
            trade_control: {
                status: 'paused',
                reason: RECONCILIATION_PAUSE_REASON,
                updated_by: RECONCILIATION_PAUSE_UPDATED_BY,
                updated_at: at,
            },
            created_at: at,
            updated_at: at,
        })
        await db.collection('strategy_symbol_positions').doc(positionId).set({
            id: positionId,
            strategy_id: strategyId,
            symbol_id: symbolId,
            confirmed_position: 1,
            pending_delta: recoveryCase.pending,
            status: recoveryCase.status,
            policy_version: 1,
            updated_at: at,
            reconciled_at: at,
        })

        const service = createStrategySymbolReconciliationService({
            db,
            fetchPositionsForReconciliation: async (broker) => broker === 'dummy'
                ? [{ broker: 'dummy', ticker: symbolId.slice('dummy:'.length), side: 'BUY', size: 1 }]
                : [],
            now: () => new Date('2026-01-02T00:00:00.000Z'),
            logger: { info: () => undefined, warn: () => undefined },
        })
        const result = await service.recoverStrategySymbol(symbolId)
        assert.deepEqual(result.kind === 'BLOCKED' ? result.reason : undefined, recoveryCase.reason)
        assert.equal((await db.collection('tradable_symbols').doc(symbolId).get()).data()?.trade_control?.status, 'paused')
        assert.equal((await db.collection('strategy_symbol_positions').doc(positionId).get()).data()?.status, recoveryCase.status)
    }

    const fetchFailureSymbolId = `dummy:recovery_fetch_failure_${suffix}`
    const fetchFailureStrategyId = `recovery_fetch_failure_${suffix}`
    const fetchFailurePositionId = createStrategySymbolPositionId(fetchFailureStrategyId, fetchFailureSymbolId)
    resources.push({ symbolId: fetchFailureSymbolId, positionId: fetchFailurePositionId })
    await db.collection('tradable_symbols').doc(fetchFailureSymbolId).set({
        id: fetchFailureSymbolId,
        broker: 'dummy',
        ticker: fetchFailureSymbolId.slice('dummy:'.length),
        currency: 'JPY',
        order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
        trade_control: {
            status: 'paused',
            reason: RECONCILIATION_PAUSE_REASON,
            updated_by: RECONCILIATION_PAUSE_UPDATED_BY,
            updated_at: at,
        },
        created_at: at,
        updated_at: at,
    })
    await db.collection('strategy_symbol_positions').doc(fetchFailurePositionId).set({
        id: fetchFailurePositionId,
        strategy_id: fetchFailureStrategyId,
        symbol_id: fetchFailureSymbolId,
        confirmed_position: 1,
        pending_delta: 0,
        status: 'MISMATCH',
        policy_version: 1,
        updated_at: at,
        reconciled_at: at,
    })
    const fetchFailureService = createStrategySymbolReconciliationService({
        db,
        fetchPositionsForReconciliation: async (broker) => {
            if (broker === 'dummy') throw new Error('broker unavailable')
            return []
        },
        now: () => new Date('2026-01-02T00:00:00.000Z'),
        logger: { info: () => undefined, warn: () => undefined },
    })
    const fetchFailureResult = await fetchFailureService.recoverStrategySymbol(fetchFailureSymbolId)
    assert.deepEqual(fetchFailureResult.kind === 'BLOCKED' ? fetchFailureResult.reason : undefined, 'INDETERMINATE')
    assert.equal((await db.collection('tradable_symbols').doc(fetchFailureSymbolId).get()).data()?.trade_control?.status, 'paused')
    assert.equal((await db.collection('strategy_symbol_positions').doc(fetchFailurePositionId).get()).data()?.status, 'MISMATCH')
})
