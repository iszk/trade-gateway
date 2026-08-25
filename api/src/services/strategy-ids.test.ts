import assert from 'node:assert/strict'
import test from 'node:test'

import {
    normalizeLegacyStrategyId,
    resolveEffectiveStrategyId,
    resolveLegacyStrategyId,
} from './strategy-ids.js'

test('legacy strategy IDs trim and normalize consecutive whitespace', () => {
    assert.equal(normalizeLegacyStrategyId('  MA   Crossover\tV2 '), 'MA_Crossover_V2')
    assert.deepEqual(resolveLegacyStrategyId('  MA   Crossover\tV2 '), {
        effectiveStrategyId: 'MA_Crossover_V2',
        reason: 'VALID',
        source: 'LEGACY',
    })
})

test('strategy identity reports missing, blank, unknown, and invalid values separately', () => {
    assert.equal(resolveLegacyStrategyId(undefined).reason, 'MISSING')
    assert.equal(resolveLegacyStrategyId('   ').reason, 'BLANK')
    assert.equal(resolveLegacyStrategyId('unknown').reason, 'LITERAL_UNKNOWN')
    assert.equal(resolveLegacyStrategyId('strategy/name').reason, 'INVALID')
    assert.equal(resolveEffectiveStrategyId({ explicitStrategyId: null }).reason, 'INVALID')
})

test('persisted effective ID takes precedence over the legacy display value', () => {
    assert.deepEqual(resolveEffectiveStrategyId({
        effectiveStrategyId: 'policy_alpha',
        legacyStrategy: 'Display Name',
    }), {
        effectiveStrategyId: 'policy_alpha',
        reason: 'VALID',
        source: 'EFFECTIVE',
    })
})

test('explicit strategy ID is strict and is not trimmed or fuzzy-mapped', () => {
    assert.equal(resolveEffectiveStrategyId({
        explicitStrategyId: ' alpha ',
        legacyStrategy: 'alpha',
    }).reason, 'INVALID')
    assert.equal(resolveEffectiveStrategyId({
        explicitStrategyId: 'unknown',
        legacyStrategy: 'alpha',
    }).reason, 'LITERAL_UNKNOWN')
})
