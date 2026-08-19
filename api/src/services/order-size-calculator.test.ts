import assert from 'node:assert/strict'
import test from 'node:test'

import type { OrderSide } from '../types/order.js'
import type { ManagedStrategySymbolPolicy, StrategySymbolPolicy } from '../types/strategy-symbol-policy.js'
import type { OrderConstraints } from '../types/tradable-symbol.js'
import {
    calculateOrderSize,
    type CalculateOrderSizeInput,
    type SizingConstraint,
    type SizingDecision,
    type SizingDecisionDetails,
} from './order-size-calculator.js'
import { compareQuantities, isQuantityStepAligned } from './quantity.js'

const constraints: OrderConstraints = {
    quantity_step: 0.1,
    min_order_size: 0.1,
}

const managedPolicy = (overrides: Partial<ManagedStrategySymbolPolicy> = {}): ManagedStrategySymbolPolicy => ({
    id: 'strategy-1:bitflyer:BTC_JPY',
    strategy_id: 'strategy-1',
    symbol_id: 'bitflyer:BTC_JPY',
    sizing_mode: 'MANAGED',
    enabled: true,
    max_abs_position: 5,
    no_flip: true,
    version: 1,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    base_order_size: 1,
    taper_strength: 0.5,
    ...overrides,
})

const webhookPolicy = (overrides: Partial<StrategySymbolPolicy> = {}): StrategySymbolPolicy => ({
    id: 'strategy-1:bitflyer:BTC_JPY',
    strategy_id: 'strategy-1',
    symbol_id: 'bitflyer:BTC_JPY',
    sizing_mode: 'WEBHOOK_CAPPED',
    enabled: true,
    max_abs_position: 5,
    no_flip: true,
    version: 1,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
} as StrategySymbolPolicy)

const input = (overrides: Partial<CalculateOrderSizeInput> = {}): CalculateOrderSizeInput => ({
    policy: managedPolicy(),
    constraints,
    confirmedPosition: 0,
    pendingDelta: 0,
    side: 'BUY',
    ...overrides,
})

function assertDispatch(
    decision: SizingDecision,
    expectedSize: number,
): asserts decision is Extract<SizingDecision, { kind: 'DISPATCH' }> {
    assert.equal(decision.kind, 'DISPATCH')
    assert.ok(Math.abs(decision.effectiveSize - expectedSize) <= 1e-12)
    assert.equal(decision.reason, 'CALCULATED')
    assert.ok(decision.details.minOrderSize !== undefined)
    assert.ok(decision.effectiveSize >= decision.details.minOrderSize)
}

const hasAppliedConstraint = (details: SizingDecisionDetails, constraint: SizingConstraint): boolean =>
    details.appliedConstraints.includes(constraint)

test('managed sizing reproduces taper and reduction examples', () => {
    const cases: { position: number; side: OrderSide; expected: number }[] = [
        { position: 0, side: 'BUY', expected: 1 },
        { position: 1, side: 'BUY', expected: 0.9 },
        { position: 1.9, side: 'BUY', expected: 0.8 },
        // SELL は position を縮小するため taper せず base size を使う。
        { position: 2.7, side: 'SELL', expected: 1 },
    ]

    for (const { position, side, expected } of cases) {
        assertDispatch(calculateOrderSize(input({ confirmedPosition: position, side })), expected)
    }
})

test('webhook capped input is required, positive, and step-aligned', () => {
    const base = input({ policy: webhookPolicy() })
    const cases: { inputSize?: number; reason: Extract<SizingDecision, { kind: 'REJECT' }>['reason'] }[] = [
        { reason: 'SIZE_REQUIRED' },
        { inputSize: 0, reason: 'INVALID_SIZE' },
        { inputSize: -0.1, reason: 'INVALID_SIZE' },
        { inputSize: Number.NaN, reason: 'INVALID_SIZE' },
        { inputSize: Number.POSITIVE_INFINITY, reason: 'INVALID_SIZE' },
        { inputSize: 0.06, reason: 'INVALID_SIZE_INCREMENT' },
    ]

    for (const { inputSize, reason } of cases) {
        const decision = calculateOrderSize(inputSize === undefined ? base : { ...base, inputSize })
        assert.equal(decision.kind, 'REJECT')
        assert.equal(decision.reason, reason)
        assert.equal(decision.details.invalidField, 'inputSize')
    }

    assertDispatch(calculateOrderSize({ ...base, inputSize: 0.1 + 0.2 }), 0.3)
})

test('webhook dispatch never increases the input or candidate size', () => {
    for (const inputSize of [0.1, 0.3, 0.1 + 0.2, 1.1]) {
        const decision = calculateOrderSize({
            ...input({ policy: webhookPolicy(), inputSize }),
        })
        assertDispatch(decision, inputSize)
        assert.ok(decision.effectiveSize <= inputSize)
        assert.ok(decision.effectiveSize <= (decision.details.rawSize ?? Number.POSITIVE_INFINITY))
        assert.ok(decision.effectiveSize <= (decision.details.candidateSize ?? Number.POSITIVE_INFINITY))
    }
})

test('managed optional input is validated but never affects calculated quantity', () => {
    assertDispatch(calculateOrderSize(input({ inputSize: 0.06 })), 1)

    for (const inputSize of [0, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
        const decision = calculateOrderSize(input({ inputSize }))
        assert.equal(decision.kind, 'REJECT')
        assert.equal(decision.reason, 'INVALID_SIZE')
    }
})

test('position headroom includes pending delta and floors below one step', () => {
    const oneStepRemaining = calculateOrderSize(input({
        confirmedPosition: 4,
        pendingDelta: 0.9,
        side: 'BUY',
    }))
    assertDispatch(oneStepRemaining, 0.1)

    const atLimit = calculateOrderSize(input({
        confirmedPosition: 4,
        pendingDelta: 1,
        side: 'BUY',
    }))
    assert.equal(atLimit.kind, 'SUPPRESS')
    assert.equal(atLimit.reason, 'MAX_POSITION')

    const belowOneStep = calculateOrderSize(input({
        confirmedPosition: 4.95,
        side: 'BUY',
    }))
    assert.equal(belowOneStep.kind, 'SUPPRESS')
    assert.equal(belowOneStep.reason, 'MAX_POSITION')
})

test('no_flip controls crossing flat and preserves a safe minimum', () => {
    const noFlip = calculateOrderSize({
        ...input({
            policy: managedPolicy({ no_flip: true }),
            confirmedPosition: 2,
            side: 'SELL',
        }),
    })
    assertDispatch(noFlip, 1)

    const noFlipWebhook = calculateOrderSize({
        ...input({
            policy: webhookPolicy({ no_flip: true }),
            confirmedPosition: 0.05,
            side: 'SELL',
            inputSize: 1,
        }),
    })
    assert.equal(noFlipWebhook.kind, 'SUPPRESS')
    assert.equal(noFlipWebhook.reason, 'NO_FLIP')

    // step より小さい実在 position も 0 とみなして反転させない。
    const tinyResidual = calculateOrderSize({
        ...input({
            policy: webhookPolicy({ no_flip: true }),
            confirmedPosition: Number.EPSILON,
            side: 'SELL',
            inputSize: 0.1,
        }),
    })
    assert.equal(tinyResidual.kind, 'SUPPRESS')
    assert.equal(tinyResidual.reason, 'NO_FLIP')

    const allowFlip = calculateOrderSize({
        ...input({
            policy: webhookPolicy({ no_flip: false }),
            confirmedPosition: 2,
            side: 'SELL',
            inputSize: 5,
        }),
    })
    assertDispatch(allowFlip, 5)
    assert.equal(allowFlip.details.positionAfter, -3)
})

test('no_flip clamp never lets a near-boundary sell cross flat', () => {
    const position = 0.3 - 2e-16
    const inputSize = 0.1 + 0.2
    const decision = calculateOrderSize({
        ...input({
            policy: webhookPolicy({ no_flip: true }),
            confirmedPosition: position,
            side: 'SELL',
            inputSize,
        }),
    })

    assert.equal(decision.kind, 'DISPATCH')
    assert.ok(decision.effectiveSize <= inputSize)
    assert.ok((decision.details.positionAfter ?? Number.NaN) >= 0)
})

test('max order size is applied after position sizing', () => {
    const decision = calculateOrderSize({
        ...input({
            policy: webhookPolicy(),
            constraints: { ...constraints, max_order_size: 0.25 },
            inputSize: 1,
        }),
    })
    assertDispatch(decision, 0.2)
    assert.ok(hasAppliedConstraint(decision.details, 'MAX_ORDER_SIZE'))
    assert.ok(hasAppliedConstraint(decision.details, 'QUANTITY_STEP'))
})

test('max position and max order clamps are exact at floating-point boundaries', () => {
    const maxPosition = 0.3
    const positionDecision = calculateOrderSize({
        ...input({
            policy: webhookPolicy({ max_abs_position: maxPosition }),
            confirmedPosition: 0.1,
            side: 'BUY',
            inputSize: 0.2,
        }),
    })
    assert.equal(positionDecision.kind, 'DISPATCH')
    assert.ok((positionDecision.details.positionAfter ?? Number.NaN) <= maxPosition)
    assert.ok(positionDecision.effectiveSize <= (positionDecision.details.rawSize ?? Number.POSITIVE_INFINITY))

    const maxOrder = 0.3
    const orderDecision = calculateOrderSize({
        ...input({
            policy: webhookPolicy(),
            constraints: { ...constraints, max_order_size: maxOrder },
            inputSize: 0.1 + 0.2,
        }),
    })
    assert.equal(orderDecision.kind, 'DISPATCH')
    assert.ok(orderDecision.effectiveSize <= maxOrder)
    assert.ok(orderDecision.effectiveSize <= (orderDecision.details.candidateSize ?? Number.POSITIVE_INFINITY))
})

test('managed raw values are floored and suppressed below min order size', () => {
    const floorToOneTenth = calculateOrderSize(input({
        policy: managedPolicy({ base_order_size: 0.2, taper_strength: 1 }),
        confirmedPosition: 1,
    }))
    assertDispatch(floorToOneTenth, 0.1)
    assert.ok(Math.abs((floorToOneTenth.details.rawSize ?? 0) - 0.16) <= 1e-12)

    const belowMinimum = calculateOrderSize(input({
        policy: managedPolicy({ base_order_size: 0.2, taper_strength: 1 }),
        confirmedPosition: 3.5,
    }))
    assert.equal(belowMinimum.kind, 'SUPPRESS')
    assert.equal(belowMinimum.reason, 'BELOW_MIN_ORDER_SIZE')
    assert.equal(belowMinimum.details.roundedSize, 0)
})

test('minimum order size is an exact safety threshold', () => {
    const minOrderSize = 0.3
    const inputSize = minOrderSize - 2e-16
    const decision = calculateOrderSize({
        ...input({
            policy: webhookPolicy(),
            constraints: { quantity_step: 0.1, min_order_size: minOrderSize },
            side: 'BUY',
            inputSize,
        }),
    })

    assert.equal(decision.kind, 'SUPPRESS')
    assert.equal(decision.reason, 'BELOW_MIN_ORDER_SIZE')
    assert.ok((decision.details.effectiveSize ?? Number.POSITIVE_INFINITY) < minOrderSize)
})

test('disabled policy suppresses after validating core calculation inputs', () => {
    const decision = calculateOrderSize(input({ policy: managedPolicy({ enabled: false }) }))
    assert.equal(decision.kind, 'SUPPRESS')
    assert.equal(decision.reason, 'POLICY_DISABLED')
    assert.equal(decision.details.effectivePosition, 0)

    const invalidPosition = calculateOrderSize(input({
        policy: managedPolicy({ enabled: false }),
        confirmedPosition: Number.NaN,
    }))
    assert.equal(invalidPosition.kind, 'REJECT')
    assert.equal(invalidPosition.reason, 'INVALID_CALCULATION_INPUT')
})

test('invalid runtime policy, constraints, position, and side fail closed', () => {
    const cases: { value: Partial<CalculateOrderSizeInput>; field: string }[] = [
        { value: { constraints: { quantity_step: 0, min_order_size: 0.1 } }, field: 'constraints.quantity_step' },
        { value: { constraints: { quantity_step: 0.1, min_order_size: 0 } }, field: 'constraints.min_order_size' },
        { value: { constraints: { quantity_step: 0.1, min_order_size: 0.1, max_order_size: 0.05 } }, field: 'constraints.max_order_size' },
        { value: { policy: managedPolicy({ max_abs_position: 0.05 }) }, field: 'policy.max_abs_position' },
        { value: { policy: managedPolicy({ max_abs_position: 5.05 }) }, field: 'policy.max_abs_position' },
        { value: { policy: managedPolicy({ taper_strength: Number.NaN }) }, field: 'policy.taper_strength' },
        { value: { confirmedPosition: Number.POSITIVE_INFINITY }, field: 'confirmedPosition' },
        { value: { pendingDelta: Number.NaN }, field: 'pendingDelta' },
        { value: { side: 'HOLD' as never }, field: 'side' },
    ]

    for (const { value, field } of cases) {
        const decision = calculateOrderSize(input(value))
        assert.equal(decision.kind, 'REJECT', field)
        assert.equal(decision.reason, 'INVALID_CALCULATION_INPUT', field)
        assert.equal(decision.details.invalidField, field, field)
    }
})

test('over-limit positions may only be reduced toward flat', () => {
    const increase = calculateOrderSize(input({ confirmedPosition: 6, side: 'BUY' }))
    assert.equal(increase.kind, 'SUPPRESS')
    assert.equal(increase.reason, 'MAX_POSITION')

    const reduce = calculateOrderSize(input({ confirmedPosition: 6, side: 'SELL' }))
    assertDispatch(reduce, 1)
    assert.ok(Math.abs(reduce.details.positionAfter ?? 0) < 6)

    const flatten = calculateOrderSize({
        ...input({
            policy: webhookPolicy({ no_flip: false }),
            confirmedPosition: 6,
            side: 'SELL',
            inputSize: 10,
        }),
    })
    assertDispatch(flatten, 6)
    assert.equal(flatten.details.positionAfter, 0)
})

test('position and side sign reversal is symmetric', () => {
    for (const position of [-6, -4.9, -2.7, -0.1, 0, 0.1, 2.7, 4.9, 6]) {
        for (const side of ['BUY', 'SELL'] as const) {
            const original = calculateOrderSize(input({ confirmedPosition: position, side }))
            const reversed = calculateOrderSize(input({
                confirmedPosition: -position,
                side: side === 'BUY' ? 'SELL' : 'BUY',
            }))
            assert.equal(reversed.kind, original.kind, `${position}/${side}`)
            assert.equal(reversed.reason, original.reason, `${position}/${side}`)
            if (original.kind === 'DISPATCH' && reversed.kind === 'DISPATCH') {
                assert.equal(reversed.effectiveSize, original.effectiveSize, `${position}/${side}`)
            }
        }
    }
})

test('dispatch decisions satisfy size, step, order-limit, and position invariants', () => {
    const step = constraints.quantity_step
    for (let position = -6; position <= 6; position += 0.1) {
        for (const side of ['BUY', 'SELL'] as const) {
            const decision = calculateOrderSize(input({
                confirmedPosition: position,
                pendingDelta: position % 0.3 === 0 ? 0.1 : 0,
                side,
            }))
            if (decision.kind !== 'DISPATCH') continue

            assert.ok(decision.effectiveSize > 0)
            assert.ok(Number.isFinite(decision.effectiveSize))
            assert.equal(isQuantityStepAligned(decision.effectiveSize, step), true)
            assert.ok(decision.effectiveSize >= (decision.details.minOrderSize ?? Number.POSITIVE_INFINITY))
            assert.ok(decision.effectiveSize <= (decision.details.rawSize ?? Number.POSITIVE_INFINITY))
            assert.ok(decision.effectiveSize <= (decision.details.candidateSize ?? Number.POSITIVE_INFINITY))
            assert.ok(compareQuantities(decision.effectiveSize, decision.details.rawSize ?? 0, step)! <= 0)
            assert.ok(compareQuantities(decision.effectiveSize, 5, step)! <= 0)

            const effectivePosition = decision.details.effectivePosition ?? 0
            const positionAfter = decision.details.positionAfter ?? 0
            const maxAbsPosition = decision.details.maxAbsPosition ?? Number.POSITIVE_INFINITY
            if (Math.abs(effectivePosition) <= maxAbsPosition) {
                assert.ok(Math.abs(positionAfter) <= maxAbsPosition, `${position}/${side}`)
            }
            if (managedPolicy().no_flip && effectivePosition > 0 && side === 'SELL') {
                assert.ok(positionAfter >= 0, `${position}/${side}`)
            }
            if (managedPolicy().no_flip && effectivePosition < 0 && side === 'BUY') {
                assert.ok(positionAfter <= 0, `${position}/${side}`)
            }
            if (decision.details.maxOrderSize !== undefined) {
                assert.ok(decision.effectiveSize <= decision.details.maxOrderSize, `${position}/${side}`)
            }
            if (Math.abs(effectivePosition) > maxAbsPosition) {
                assert.ok(Math.abs(positionAfter) < Math.abs(effectivePosition), `${position}/${side}`)
            }
        }
    }
})
