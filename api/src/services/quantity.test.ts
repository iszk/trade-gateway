import assert from 'node:assert/strict'
import test from 'node:test'

import {
    addQuantities,
    compareQuantities,
    floorToQuantityStep,
    isFiniteQuantity,
    isQuantityStepAligned,
    isUsableQuantityStep,
    multiplyQuantity,
    subtractQuantities,
} from './quantity.js'

test('quantity step alignment accepts common decimal representations', () => {
    const cases = [
        { value: 0.3, step: 0.1 },
        { value: 0.1 + 0.2, step: 0.1 },
        { value: 0.25, step: 0.25 },
        { value: 0.001, step: 0.001 },
        { value: -0.3, step: 0.1 },
    ]

    for (const { value, step } of cases) {
        assert.equal(isQuantityStepAligned(value, step), true, `${value} / ${step}`)
    }

    assert.equal(isQuantityStepAligned(0.06, 0.1), false)
    assert.equal(isQuantityStepAligned(0.26, 0.25), false)
    assert.equal(isQuantityStepAligned(Number.NaN, 0.1), false)
    assert.equal(isQuantityStepAligned(0.1, Number.POSITIVE_INFINITY), false)
})

test('floorToQuantityStep rounds only toward zero for non-negative quantities', () => {
    const cases = [
        { value: 0.16, step: 0.1, expected: 0.1 },
        { value: 0.06, step: 0.1, expected: 0 },
        { value: 0.3, step: 0.1, expected: 0.3 },
        { value: 0.1 + 0.2, step: 0.1, expected: 0.1 + 0.2 },
        { value: 0.5, step: 0.25, expected: 0.5 },
        { value: 0.3 - 1e-12, step: 0.1, expected: 0.2 },
    ]

    for (const { value, step, expected } of cases) {
        assert.equal(floorToQuantityStep(value, step), expected, `${value} / ${step}`)
        const rounded = floorToQuantityStep(value, step)
        assert.ok(rounded !== null && rounded <= value)
        assert.equal(isQuantityStepAligned(rounded, step), true)
    }

    assert.equal(floorToQuantityStep(-0.1, 0.1), null)
    assert.equal(floorToQuantityStep(Number.NaN, 0.1), null)
    assert.equal(floorToQuantityStep(Number.POSITIVE_INFINITY, 0.1), null)
})

test('floorToQuantityStep never returns a near-boundary value above its input', () => {
    const input = 0.3 - 2e-16
    const result = floorToQuantityStep(input, 0.1)

    assert.ok(result !== null)
    assert.ok(result <= input)
    assert.equal(isQuantityStepAligned(result, 0.1), true)
})

test('quantity operations fail closed for non-finite and overflowing values', () => {
    assert.equal(isFiniteQuantity(1), true)
    assert.equal(isFiniteQuantity(Number.NaN), false)
    assert.equal(isFiniteQuantity(Number.POSITIVE_INFINITY), false)
    assert.equal(isUsableQuantityStep(0.1), true)
    assert.equal(isUsableQuantityStep(0), false)
    assert.equal(isUsableQuantityStep(-0.1), false)
    assert.equal(isUsableQuantityStep(Number.NaN), false)
    assert.equal(isUsableQuantityStep(Number.POSITIVE_INFINITY), false)
    assert.equal(isUsableQuantityStep(Number.MIN_VALUE), false)

    assert.equal(addQuantities(0.1, 0.2), 0.30000000000000004)
    assert.equal(subtractQuantities(0.3, 0.1), 0.19999999999999998)
    assert.equal(multiplyQuantity(0.3, 3), 0.8999999999999999)
    assert.equal(addQuantities(Number.MAX_VALUE, Number.MAX_VALUE), null)
    assert.equal(subtractQuantities(Number.POSITIVE_INFINITY, 1), null)
    assert.equal(multiplyQuantity(Number.MAX_VALUE, 2), null)

    // 整数 step 比を安全な Number で表現できない値は受理しない。
    assert.equal(isQuantityStepAligned(1e16, 0.001), false)
    assert.equal(floorToQuantityStep(1e16, 0.001), null)
})

test('step-aware subtraction preserves an aligned one-step headroom', () => {
    assert.equal(subtractQuantities(5, 4.9, 0.1), 0.1)
    assert.equal(subtractQuantities(0.3, 0.1, 0.1), 0.2)
    assert.equal(subtractQuantities(0.3, 0.1), 0.19999999999999998)
    assert.equal(subtractQuantities(1, 0.06, 0.1), 0.94)
    assert.equal(subtractQuantities(1, 0.1, Number.MIN_VALUE), null)
})

test('compareQuantities treats only floating point noise as equal', () => {
    assert.equal(compareQuantities(0.1 + 0.2, 0.3, 0.1), 0)
    assert.equal(compareQuantities(1.0000000000000002, 1, 0.1), 0)
    assert.equal(compareQuantities(1.01, 1, 0.1), 1)
    assert.equal(compareQuantities(0.99, 1, 0.1), -1)
    assert.equal(compareQuantities(1, 1, Number.NaN), null)
})
