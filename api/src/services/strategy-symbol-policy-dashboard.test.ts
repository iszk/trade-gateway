import assert from 'node:assert/strict'
import test from 'node:test'
import type { Firestore } from 'firebase-admin/firestore'

import {
    createListStrategySymbolPolicyDashboardFn,
} from './strategy-symbol-policy-dashboard.js'

type RawDocument = { id: string; data: () => Record<string, unknown> }

const makeDb = (collections: Record<string, Record<string, Record<string, unknown>>>) => {
    const get = (collection: string) => ({
        docs: Object.entries(collections[collection] ?? {}).map(([id, data]): RawDocument => ({
            id,
            data: () => data,
        })),
    })
    return {
        collection: (collection: string) => ({
            get: async () => get(collection),
        }),
    } as unknown as Firestore
}

const createdAt = new Date('2026-01-01T00:00:00.000Z')
const policy = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    strategy_id: 'alpha',
    symbol_id: 'dummy:BTC',
    sizing_mode: 'WEBHOOK_CAPPED',
    enabled: true,
    max_abs_position: 2,
    no_flip: true,
    version: 1,
    created_at: createdAt,
    updated_at: createdAt,
    ...overrides,
})
const position = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    strategy_id: 'alpha',
    symbol_id: 'dummy:BTC',
    confirmed_position: 0.5,
    pending_delta: 0.1,
    status: 'READY',
    policy_version: 1,
    updated_at: createdAt,
    reconciled_at: null,
    ...overrides,
})

test('dashboard service pairs policy and position by document ID and classifies ledger states', async () => {
    const db = makeDb({
        strategy_symbol_policies: {
            'alpha:dummy:BTC': policy('alpha:dummy:BTC'),
            'beta:dummy:ETH': policy('beta:dummy:ETH', { strategy_id: 'beta', symbol_id: 'dummy:ETH' }),
            'gamma:dummy:X': policy('gamma:dummy:X', { strategy_id: 'gamma', symbol_id: 'dummy:X', version: 2 }),
            'broken:dummy:Y': policy('broken:dummy:Y', { id: 'wrong-id' }),
        },
        strategy_symbol_positions: {
            'alpha:dummy:BTC': position('alpha:dummy:BTC'),
            'gamma:dummy:X': position('gamma:dummy:X', { strategy_id: 'gamma', symbol_id: 'dummy:X', policy_version: 1 }),
            'orphan:dummy:USD': position('orphan:dummy:USD', { strategy_id: 'orphan', symbol_id: 'dummy:USD' }),
            'invalid:dummy:JPY': position('invalid:dummy:JPY', { pending_delta: '0' }),
        },
    })
    const list = createListStrategySymbolPolicyDashboardFn({ db, now: () => 123 })

    const result = await list()
    assert.equal(result.updated_at, 123)
    assert.deepEqual(result.entries.map((entry) => [entry.id, entry.ledger_health]), [
        ['alpha:dummy:BTC', 'READY'],
        ['beta:dummy:ETH', 'MISSING_POSITION'],
        ['broken:dummy:Y', 'INVALID_POLICY'],
        ['gamma:dummy:X', 'VERSION_MISMATCH'],
        ['invalid:dummy:JPY', 'INVALID_POSITION'],
        ['orphan:dummy:USD', 'ORPHAN_POSITION'],
    ])
    const invalid = result.entries.find((entry) => entry.id === 'invalid:dummy:JPY')
    assert.equal(invalid?.position, undefined)
    assert.equal(invalid?.strategy_id, 'invalid')
    assert.equal(invalid?.symbol_id, 'dummy:JPY')
})

test('dashboard service does not infer identity from malformed policy fields', async () => {
    const db = makeDb({
        strategy_symbol_policies: {
            'alpha:dummy:BTC': policy('alpha:dummy:BTC', {
                strategy_id: 'attacker',
                symbol_id: 'dummy:OTHER',
            }),
        },
        strategy_symbol_positions: {},
    })
    const result = await createListStrategySymbolPolicyDashboardFn({ db })()
    const entry = result.entries[0]
    assert.equal(entry?.ledger_health, 'INVALID_POLICY')
    assert.equal(entry?.strategy_id, 'alpha')
    assert.equal(entry?.symbol_id, 'dummy:BTC')
    assert.equal(entry?.policy, undefined)
})
