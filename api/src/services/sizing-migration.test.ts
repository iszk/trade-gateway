import assert from 'node:assert/strict'
import test from 'node:test'
import type { Firestore } from 'firebase-admin/firestore'

import {
    reconstructSizingState,
    runSizingMigration,
    validateSizingMigrationManifest,
    type SizingMigrationManifest,
} from './sizing-migration.js'

const manifest: SizingMigrationManifest = {
    project_id: 'trade-gateway-test',
    symbols: [
        {
            symbol_id: 'dummy:BTC',
            expected_order_constraints: {
                quantity_step: 0.1,
                min_order_size: 0.1,
            },
            policies: [
                { strategy_id: 'alpha', sizing_mode: 'WEBHOOK_CAPPED', max_abs_position: 2, no_flip: true },
                { strategy_id: 'beta', sizing_mode: 'WEBHOOK_CAPPED', max_abs_position: 2, no_flip: false },
            ],
        },
    ],
}

const date = new Date('2026-08-24T00:00:00.000Z')

const order = (overrides: Record<string, unknown> = {}) => ({
    id: 'order-1',
    strategy: 'alpha',
    broker: 'dummy',
    ticker: 'BTC',
    side: 'BUY',
    order_type: 'MARKET',
    requested_size: 1,
    executed_size: 1,
    executed_price: 100,
    executed_at: date,
    status: 'EXECUTED',
    provider_order_ids: ['provider-1'],
    created_at: date,
    updated_at: date,
    ...overrides,
})

test('manifest validation accepts only WEBHOOK_CAPPED policies and step-aligned limits', () => {
    assert.deepEqual(validateSizingMigrationManifest(manifest), manifest)
    assert.equal(validateSizingMigrationManifest({
        ...manifest,
        symbols: [{
            ...manifest.symbols[0],
            policies: [{ ...manifest.symbols[0].policies[0], sizing_mode: 'MANAGED' }],
        }],
    }), null)
    assert.equal(validateSizingMigrationManifest({
        ...manifest,
        symbols: [{
            ...manifest.symbols[0],
            policies: [{ ...manifest.symbols[0].policies[0], max_abs_position: 0.15 }],
        }],
    }), null)
    assert.equal(validateSizingMigrationManifest({
        ...manifest,
        symbols: [{
            ...manifest.symbols[0],
            policies: [{ ...manifest.symbols[0].policies[0], enabled: true }],
        }],
    }), null)
})

test('reconstruction includes partial fills in confirmed and remaining pending delta', () => {
    const result = reconstructSizingState(manifest, [order({ id: 'partial', requested_size: 1, executed_size: 0.4, status: 'PENDING', executed_price: null })])
    assert.deepEqual(result.issues, [])
    assert.equal(result.aggregates.length, 1)
    assert.equal(result.aggregates[0]?.confirmed_position, 0.4)
    assert.equal(result.aggregates[0]?.pending_delta, 0.6)
    assert.deepEqual(result.aggregates[0]?.pending_reservations[0], {
        order_id: 'partial',
        event_id: 'partial',
        strategy_id: 'alpha',
        symbol_id: 'dummy:BTC',
        reserved_delta: 1,
        executed_delta: 0.4,
        status: 'DISPATCHED',
        policy_version: 1,
        projection: result.aggregates[0]?.pending_reservations[0]?.projection,
    })
})

test('SELL, canceled partial, and failed partial fills remain confirmed', () => {
    const result = reconstructSizingState(manifest, [
        order({ id: 'sell', strategy: 'beta', side: 'SELL', requested_size: 1, executed_size: 1, executed_price: 100 }),
        order({ id: 'canceled', strategy: 'beta', side: 'BUY', requested_size: 0.5, executed_size: 0.2, executed_price: 100, executed_at: date, status: 'CANCELED' }),
        order({ id: 'failed', strategy: 'beta', side: 'SELL', requested_size: 0.4, executed_size: 0.1, executed_price: 100, executed_at: date, status: 'FAILED' }),
    ])
    const aggregate = result.aggregates.find((entry) => entry.strategy_id === 'beta')
    assert.ok(aggregate)
    assert.equal(aggregate.confirmed_position, -0.9)
    assert.equal(aggregate.pending_delta, 0)
    assert.equal(aggregate.pending_reservations.length, 0)
})

test('legacy dry-run orders are excluded and reported as warnings', () => {
    const result = reconstructSizingState(manifest, [order({ id: 'dry', provider_order_ids: ['DRY_RUN'] })])
    assert.equal(result.aggregates.length, 0)
    assert.deepEqual(result.warnings.map((entry) => entry.reason), ['DRY_RUN_ORDER_EXCLUDED'])
})

test('unknown, unregistered, corrupt, and overfilled orders block reconstruction without guessing', () => {
    const result = reconstructSizingState(manifest, [
        order({ id: 'unknown', strategy: 'unknown' }),
        order({ id: 'unregistered', strategy: 'other' }),
        order({ id: 'overfill', requested_size: 1, executed_size: 2 }),
        order({ id: 'corrupt', requested_size: Number.NaN }),
    ])
    assert.ok(result.issues.some((entry) => entry.reason === 'LEGACY_STRATEGY_LITERAL_UNKNOWN'))
    assert.ok(result.issues.some((entry) => entry.reason === 'STRATEGY_NOT_IN_MANIFEST'))
    assert.ok(result.issues.some((entry) => entry.reason === 'EXECUTED_SIZE_OVER_REQUESTED'))
    assert.ok(result.issues.some((entry) => entry.reason === 'INVALID_REQUESTED_SIZE'))
    assert.equal(result.aggregates.length, 0)
})

test('effective strategy ID allows legacy display value unknown when persisted policy identity is present', () => {
    const result = reconstructSizingState(manifest, [order({
        strategy: 'unknown',
        effective_strategy_id: 'alpha',
    })])
    assert.deepEqual(result.issues, [])
    assert.equal(result.aggregates[0]?.strategy_id, 'alpha')
})

test('matching effective and explicit IDs authorize a distinct legacy display label', () => {
    const result = reconstructSizingState(manifest, [order({
        strategy: 'Alpha display',
        strategy_id: 'alpha',
        effective_strategy_id: 'alpha',
    })])
    assert.deepEqual(result.issues, [])
    assert.equal(result.aggregates[0]?.strategy_id, 'alpha')
})

test('explicit and effective strategy IDs that disagree are blocking evidence conflicts', () => {
    const result = reconstructSizingState(manifest, [order({
        strategy_id: 'beta',
        effective_strategy_id: 'alpha',
    })])
    assert.ok(result.issues.some((entry) => entry.reason === 'EFFECTIVE_EXPLICIT_STRATEGY_CONFLICT'))
    assert.equal(result.aggregates.length, 0)
})

test('migration reports a warning when confirmed position exceeds policy max', async () => {
    const migrationManifest = {
        ...manifest,
        symbols: [{
            ...manifest.symbols[0]!,
            policies: [{ ...manifest.symbols[0]!.policies[0]!, max_abs_position: 1 }],
        }],
    }
    const symbolId = 'dummy:BTC'
    const now = new Date('2026-08-24T00:00:00.000Z')
    const report = await runSizingMigration({
        db: {} as Firestore,
        manifest: migrationManifest,
        listOrders: async () => [order({ requested_size: 1.5, executed_size: 1.5 })],
        listSymbols: async () => [{
            id: symbolId,
            broker: 'dummy',
            ticker: 'BTC',
            order_constraints: manifest.symbols[0]!.expected_order_constraints,
            trade_control: { status: 'active', updated_at: now },
            created_at: now,
            updated_at: now,
        }],
        listPolicies: async () => [],
        listPositions: async () => [],
        listReservations: async () => [],
        fetchPositionsForReconciliation: async () => [{
            broker: 'dummy',
            ticker: 'BTC',
            side: 'BUY',
            size: 1.5,
        }],
    })
    assert.equal(report.blocked, false)
    assert.equal(report.symbols[0]?.status, 'CREATE')
    assert.equal(report.writes, 0)
    assert.equal(report.warnings.filter((entry) => entry.reason === 'MAX_ABS_POSITION_EXCEEDED').length, 1)
    assert.ok(report.warnings.some((entry) => entry.reason === 'MAX_ABS_POSITION_EXCEEDED'))
    assert.ok(report.symbols[0]?.warnings.some((entry) => entry.reason === 'MAX_ABS_POSITION_EXCEEDED'))
})
