import assert from 'node:assert/strict'
import test from 'node:test'
import type { Firestore } from 'firebase-admin/firestore'

import type { Position } from '../types/position.js'
import type { StrategySymbolPosition } from '../types/strategy-symbol-position.js'
import type { TradableSymbol } from '../types/tradable-symbol.js'
import {
    aggregateSymbolReconciliation,
    createStrategySymbolReconciliationService,
    decideSymbolReconciliation,
    validateReconciliationBrokerSnapshot,
} from './strategy-symbol-reconciliation.js'

const symbol: Pick<TradableSymbol, 'id' | 'broker' | 'ticker' | 'order_constraints'> = {
    id: 'dummy:BTC_JPY',
    broker: 'dummy',
    ticker: 'BTC_JPY',
    order_constraints: {
        quantity_step: 0.1,
        min_order_size: 0.1,
    },
}

const makeStrategyPosition = (
    strategyId: string,
    overrides: Partial<Pick<StrategySymbolPosition, 'confirmed_position' | 'pending_delta' | 'status'>> = {},
): Pick<StrategySymbolPosition, 'strategy_id' | 'symbol_id' | 'confirmed_position' | 'pending_delta' | 'status'> => ({
    strategy_id: strategyId,
    symbol_id: symbol.id,
    confirmed_position: 0,
    pending_delta: 0,
    status: 'READY',
    ...overrides,
})

const brokerPosition = (side: Position['side'], size: number, ticker = symbol.ticker): Position => ({
    broker: symbol.broker,
    ticker,
    side,
    size,
})

test('single strategy confirmed position matches broker net position', () => {
    const decision = decideSymbolReconciliation({
        symbol,
        strategyPositions: [makeStrategyPosition('alpha', { confirmed_position: 1 })],
        brokerPositions: [brokerPosition('BUY', 1)],
    })

    assert.equal(decision.kind, 'MATCH')
    if (decision.kind === 'MATCH') {
        assert.equal(decision.totals.strategyConfirmedTotal, 1)
        assert.equal(decision.totals.strategyPendingTotal, 0)
        assert.equal(decision.totals.brokerPositionTotal, 1)
        assert.equal(decision.totals.delta, 0)
    }
})

test('multiple strategies are compared as one net symbol aggregate', () => {
    const decision = decideSymbolReconciliation({
        symbol,
        strategyPositions: [
            makeStrategyPosition('long', { confirmed_position: 2 }),
            makeStrategyPosition('short', { confirmed_position: -2 }),
        ],
        brokerPositions: [],
    })
    assert.equal(decision.kind, 'MATCH')
    if (decision.kind === 'MATCH') assert.equal(decision.totals.strategyCount, 2)
})

test('multiple broker legs are netted by side and ticker', () => {
    const aggregate = aggregateSymbolReconciliation({
        symbol,
        strategyPositions: [makeStrategyPosition('alpha', { confirmed_position: 0.5 })],
        brokerPositions: [
            brokerPosition('BUY', 1),
            brokerPosition('SELL', 0.5),
            brokerPosition('BUY', 9, 'ETH_JPY'),
        ],
    })
    assert.ok(aggregate)
    assert.equal(aggregate?.brokerPositionTotal, 0.5)
})

test('pending delta is kept in audit totals and is not compared with broker position', () => {
    const decision = decideSymbolReconciliation({
        symbol,
        strategyPositions: [makeStrategyPosition('alpha', {
            confirmed_position: 1,
            pending_delta: 0.5,
        })],
        brokerPositions: [brokerPosition('BUY', 1)],
    })
    assert.equal(decision.kind, 'MATCH')
    if (decision.kind === 'MATCH') {
        assert.equal(decision.totals.strategyEffectiveTotal, 1.5)
        assert.equal(decision.totals.strategyPendingTotal, 0.5)
    }
})

test('IEEE-754 addition error is accepted at the same quantity step boundary', () => {
    const decision = decideSymbolReconciliation({
        symbol,
        strategyPositions: [makeStrategyPosition('alpha', { confirmed_position: 0.1 }), makeStrategyPosition('beta', { confirmed_position: 0.2 })],
        brokerPositions: [brokerPosition('BUY', 0.3)],
    })
    assert.equal(decision.kind, 'MATCH')
})

test('economically meaningful difference remains MISMATCH even below half a step', () => {
    const decision = decideSymbolReconciliation({
        symbol,
        strategyPositions: [makeStrategyPosition('alpha', { confirmed_position: 1 })],
        brokerPositions: [brokerPosition('BUY', 1.06)],
    })
    assert.equal(decision.kind, 'MISMATCH')
    if (decision.kind === 'MISMATCH') {
        assert.ok(Math.abs(decision.totals.delta - 0.06) <= Number.EPSILON * 32)
    }
})

test('manual broker excess is MISMATCH and empty successful snapshot means zero', () => {
    const excess = decideSymbolReconciliation({
        symbol,
        strategyPositions: [],
        brokerPositions: [brokerPosition('BUY', 0.1)],
    })
    assert.equal(excess.kind, 'MISMATCH')

    const empty = decideSymbolReconciliation({ symbol, strategyPositions: [], brokerPositions: [] })
    assert.equal(empty.kind, 'MATCH')
})

test('invalid symbol, constraints, position, and broker snapshot preserve their reasons', () => {
    const invalidSnapshot = validateReconciliationBrokerSnapshot('dummy', [
        { broker: 'dummy', ticker: 'BTC_JPY', side: 'HOLD', size: 1 },
    ])
    assert.equal(invalidSnapshot.ok, false)

    const invalidSide = decideSymbolReconciliation({
        symbol,
        strategyPositions: [],
        brokerPositions: [{ broker: 'dummy', ticker: 'BTC_JPY', side: 'HOLD' as Position['side'], size: 1 }],
    })
    assert.equal(invalidSide.kind, 'INDETERMINATE')
    if (invalidSide.kind === 'INDETERMINATE') assert.equal(invalidSide.reason, 'BROKER_SNAPSHOT_INVALID')

    const invalidStep = decideSymbolReconciliation({
        symbol: { ...symbol, order_constraints: { quantity_step: Number.NaN, min_order_size: 0.1 } },
        strategyPositions: [],
        brokerPositions: [],
    })
    assert.equal(invalidStep.kind, 'INDETERMINATE')
    if (invalidStep.kind === 'INDETERMINATE') assert.equal(invalidStep.reason, 'SYMBOL_CONSTRAINTS_INVALID')

    const invalidSymbol = decideSymbolReconciliation({
        symbol: { ...symbol, id: 'invalid' },
        strategyPositions: [],
        brokerPositions: [],
    })
    assert.equal(invalidSymbol.kind, 'INDETERMINATE')
    if (invalidSymbol.kind === 'INDETERMINATE') assert.equal(invalidSymbol.reason, 'SYMBOL_INVALID')

    const invalidPosition = decideSymbolReconciliation({
        symbol,
        strategyPositions: [makeStrategyPosition('broken', { confirmed_position: Number.POSITIVE_INFINITY })],
        brokerPositions: [],
    })
    assert.equal(invalidPosition.kind, 'INDETERMINATE')
    if (invalidPosition.kind === 'INDETERMINATE') assert.equal(invalidPosition.reason, 'POSITION_INVALID')
})

test('arithmetic overflow is distinguished from invalid input', () => {
    const decision = decideSymbolReconciliation({
        symbol,
        strategyPositions: [makeStrategyPosition('overflow', {
            confirmed_position: Number.MAX_VALUE,
            pending_delta: Number.MAX_VALUE,
        })],
        brokerPositions: [],
    })
    assert.equal(decision.kind, 'INDETERMINATE')
    if (decision.kind === 'INDETERMINATE') assert.equal(decision.reason, 'ARITHMETIC_OVERFLOW')
})

test('position list failure marks every listed symbol indeterminate and logs the returned summary', async () => {
    const summaryLogs: Record<string, unknown>[] = []
    const symbolCount = 2
    const at = new Date('2026-01-01T00:00:00.000Z')
    const listedSymbols: TradableSymbol[] = [
        {
            ...symbol,
            currency: 'JPY',
            trade_control: { status: 'active', updated_at: at },
            created_at: at,
            updated_at: at,
        },
        {
            ...symbol,
            id: 'dummy:ETH_JPY',
            ticker: 'ETH_JPY',
            currency: 'JPY',
            trade_control: { status: 'active', updated_at: at },
            created_at: at,
            updated_at: at,
        },
    ]
    const db = {
        collection: () => ({
            get: async () => { throw new Error('position list unavailable') },
        }),
    } as unknown as Firestore
    const service = createStrategySymbolReconciliationService({
        db,
        listTradableSymbols: async () => listedSymbols,
        logger: {
            info: (details) => summaryLogs.push(details),
            warn: (details) => summaryLogs.push(details),
        },
    })

    const summary = await service.runStrategySymbolReconciliation()
    assert.equal(summary.checked, symbolCount)
    assert.equal(summary.matched + summary.mismatched + summary.indeterminate, summary.checked)
    assert.equal(summary.indeterminate, symbolCount)
    const log = summaryLogs.at(-1)
    assert.equal(log?.reason, 'POSITION_LIST_FAILED')
    assert.equal(log?.checked, summary.checked)
    assert.equal(log?.indeterminate, summary.indeterminate)
})

test('symbol list failure leaves per-symbol summary counters at zero and logs the failure reason', async () => {
    const summaryLogs: Record<string, unknown>[] = []
    const service = createStrategySymbolReconciliationService({
        db: {} as Firestore,
        listTradableSymbols: async () => { throw new Error('symbol list unavailable') },
        logger: {
            info: (details) => summaryLogs.push(details),
            warn: (details) => summaryLogs.push(details),
        },
    })

    const summary = await service.runStrategySymbolReconciliation()
    assert.deepEqual(summary, {
        checked: 0,
        matched: 0,
        mismatched: 0,
        indeterminate: 0,
        orphanBrokerPositions: 0,
        brokers: [],
        mismatches: [],
        truncatedCount: 0,
    })
    assert.equal(summaryLogs.at(-1)?.reason, 'SYMBOL_LIST_FAILED')
})
