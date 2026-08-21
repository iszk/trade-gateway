import assert from 'node:assert/strict'
import test from 'node:test'
import type { Firestore } from 'firebase-admin/firestore'

import type { StrategySymbolReservation } from '../types/strategy-symbol-reservation.js'
import type { StrategySymbolPosition } from '../types/strategy-symbol-position.js'
import {
    createApplyStrategySymbolDispatchOutcomeFn,
    createDefaultApplyStrategySymbolDispatchOutcomeFn,
    createDefaultReserveStrategySymbolOrderFn,
    createReserveStrategySymbolOrderFn,
    createStrategySymbolReservationService,
    type CalculateOrderSizeFn,
    type ApplyStrategySymbolDispatchOutcomeInput,
    type ApplyStrategySymbolDispatchOutcomeResult,
    type ReserveStrategySymbolOrderInput,
    type ReserveStrategySymbolOrderFn,
    type ReserveStrategySymbolOrderResult,
    type StrategySymbolDispatchOutcome,
    type StrategySymbolReservationService,
} from './strategy-symbol-reservation-service.js'
import { createStrategySymbolPolicyId } from './strategy-symbol-policies.js'
import { createStrategySymbolPositionId } from './strategy-symbol-positions.js'
import { createStrategySymbolReservationId } from './strategy-symbol-reservations.js'

type RawData = Record<string, unknown>

type MockDbOptions = {
    retry?: boolean
    failOnSetAt?: number
}

const makeFirestoreMock = (options: MockDbOptions = {}) => {
    const docs: Record<string, Record<string, RawData>> = {}
    const writes: { collection: string; id: string; data: RawData }[] = []
    let transactionRuns = 0
    let transactionSetCalls = 0

    const getData = (collection: string, id: string): RawData | undefined => docs[collection]?.[id]
    const makeRef = (collection: string, id: string) => ({ collection, id })
    const snapshot = (collection: string, id: string) => ({
        id,
        exists: getData(collection, id) !== undefined,
        data: () => getData(collection, id),
    })
    const makeTransaction = (staged: Map<string, { collection: string; id: string; data: RawData }>) => ({
        get: async (ref: { collection: string; id: string }) => snapshot(ref.collection, ref.id),
        set: (ref: { collection: string; id: string }, data: RawData) => {
            transactionSetCalls += 1
            if (options.failOnSetAt === transactionSetCalls) throw new Error('simulated transaction write failure')
            staged.set(`${ref.collection}/${ref.id}`, { ...ref, data })
        },
    })
    const db = {
        collection: (collection: string) => ({
            doc: (id: string) => makeRef(collection, id),
        }),
        runTransaction: async <T>(callback: (transaction: unknown) => Promise<T>): Promise<T> => {
            transactionRuns += 1
            const attempts = options.retry ? 2 : 1
            let result!: T
            let lastStaged = new Map<string, { collection: string; id: string; data: RawData }>()
            for (let attempt = 0; attempt < attempts; attempt += 1) {
                const staged = new Map<string, { collection: string; id: string; data: RawData }>()
                result = await callback(makeTransaction(staged))
                lastStaged = staged
                if (options.retry && attempt === 0) {
                    // Simulate a competing commit between attempts.  The next
                    // transaction callback must calculate from this new state.
                    const positionId = Object.keys(docs.strategy_symbol_positions ?? {})[0]
                    if (positionId !== undefined) {
                        docs.strategy_symbol_positions![positionId] = {
                            ...docs.strategy_symbol_positions![positionId],
                            pending_delta: 0.5,
                        }
                    }
                }
            }
            for (const write of lastStaged.values()) {
                docs[write.collection] ??= {}
                docs[write.collection]![write.id] = write.data
                writes.push(write)
            }
            return result
        },
        docs,
        writes,
        get transactionRuns() {
            return transactionRuns
        },
    }
    return db as unknown as Firestore & {
        docs: typeof docs
        writes: typeof writes
        transactionRuns: number
    }
}

const strategyId = 'strategy-atomic'
const symbolId = 'dummy:BTC_JPY'
const policyId = createStrategySymbolPolicyId(strategyId, symbolId)
const positionId = createStrategySymbolPositionId(strategyId, symbolId)

// Keep the public contract types exercised in-repository as well as through
// the runtime assertions below.  These aliases also make accidental API drift
// visible to typecheck before a route starts consuming the service.
const assertReserveInputType = (_input: ReserveStrategySymbolOrderInput): void => undefined
const assertReserveResultType = (_result: ReserveStrategySymbolOrderResult): void => undefined
const assertOutcomeInputType = (_input: ApplyStrategySymbolDispatchOutcomeInput): void => undefined
const assertOutcomeResultType = (_result: ApplyStrategySymbolDispatchOutcomeResult): void => undefined
const assertOutcomeValueType = (_outcome: StrategySymbolDispatchOutcome): void => undefined
const assertServiceType = (_service: StrategySymbolReservationService): void => undefined
const assertReserveFnType = (_fn: ReserveStrategySymbolOrderFn): void => undefined

// The default factories are intentionally referenced here so the static
// unused-export check keeps the application-facing constructors covered.
void createDefaultReserveStrategySymbolOrderFn
void createDefaultApplyStrategySymbolDispatchOutcomeFn

const makePolicy = (overrides: RawData = {}): RawData => ({
    id: policyId,
    strategy_id: strategyId,
    symbol_id: symbolId,
    sizing_mode: 'WEBHOOK_CAPPED',
    enabled: true,
    max_abs_position: 2,
    no_flip: true,
    version: 3,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
})

const makePosition = (overrides: Partial<StrategySymbolPosition> = {}): RawData => ({
    id: positionId,
    strategy_id: strategyId,
    symbol_id: symbolId,
    confirmed_position: 0,
    pending_delta: 0,
    status: 'READY',
    policy_version: 3,
    updated_at: new Date('2026-01-02T00:00:00.000Z'),
    reconciled_at: null,
    ...overrides,
})

const seedBase = (db: ReturnType<typeof makeFirestoreMock>, position: RawData = makePosition()) => {
    db.docs.tradable_symbols = {
        [symbolId]: {
            id: symbolId,
            order_constraints: {
                quantity_step: 0.1,
                min_order_size: 0.1,
                max_order_size: 1,
            },
        },
    }
    db.docs.strategy_symbol_policies = { [policyId]: makePolicy() }
    db.docs.strategy_symbol_positions = { [positionId]: position }
}

const dispatchDecision = (effectiveSize: number) => ({
    kind: 'DISPATCH' as const,
    reason: 'CALCULATED' as const,
    effectiveSize,
    details: { appliedConstraints: [] },
})

const suppressDecision = {
    kind: 'SUPPRESS' as const,
    reason: 'POLICY_DISABLED' as const,
    details: { appliedConstraints: [] },
}

const rejectDecision = {
    kind: 'REJECT' as const,
    reason: 'SIZE_REQUIRED' as const,
    details: { appliedConstraints: [] },
}

const makeReservation = (
    eventId: string,
    overrides: Partial<StrategySymbolReservation> = {},
): RawData => ({
    id: createStrategySymbolReservationId(strategyId, symbolId, eventId),
    event_id: eventId,
    position_id: positionId,
    strategy_id: strategyId,
    symbol_id: symbolId,
    order_id: 'order-1',
    reserved_delta: 0.5,
    status: 'RESERVED',
    policy_version: 3,
    created_at: new Date('2026-01-03T00:00:00.000Z'),
    updated_at: new Date('2026-01-03T00:00:00.000Z'),
    ...overrides,
})

test('atomic reserve passes the same snapshot to the calculator and writes signed delta atomically', async () => {
    const db = makeFirestoreMock()
    seedBase(db)
    let calculatorInput: unknown
    const calculate: CalculateOrderSizeFn = (input) => {
        calculatorInput = input
        return dispatchDecision(0.5)
    }
    const reserve = createReserveStrategySymbolOrderFn(db, calculate)
    assertReserveFnType(reserve)
    assertReserveInputType({ eventId: 'event-1', orderId: 'order-1', strategyId, symbolId, side: 'BUY' })

    const result = await reserve({
        eventId: 'event-1',
        orderId: 'order-1',
        strategyId,
        symbolId,
        side: 'BUY',
        inputSize: 0.5,
    })

    assert.equal(result.kind, 'DISPATCH')
    assertReserveResultType(result)
    if (result.kind === 'DISPATCH') {
        assert.deepEqual(result.audit, {
            sizingMode: 'WEBHOOK_CAPPED',
            policyVersion: 3,
            positionBefore: 0,
            positionAfter: 0.5,
        })
    }
    const captured = calculatorInput as {
        policy: { id: string; version: number }
        constraints: RawData
        confirmedPosition: number
        pendingDelta: number
        side: string
        inputSize?: number
    }
    assert.equal(captured.policy.id, policyId)
    assert.equal(captured.policy.version, 3)
    assert.deepEqual(captured.constraints, { quantity_step: 0.1, min_order_size: 0.1, max_order_size: 1 })
    assert.equal(captured.confirmedPosition, 0)
    assert.equal(captured.pendingDelta, 0)
    assert.equal(captured.side, 'BUY')
    assert.equal(captured.inputSize, 0.5)
    assert.equal(db.docs.strategy_symbol_positions?.[positionId]?.pending_delta, 0.5)
    const reservationId = createStrategySymbolReservationId(strategyId, symbolId, 'event-1')
    assert.equal(db.docs.strategy_symbol_reservations?.[reservationId]?.reserved_delta, 0.5)
    assert.equal(db.docs.strategy_symbol_reservations?.[reservationId]?.status, 'RESERVED')
    assert.equal(db.writes.length, 2)
})

test('calculator suppress/reject and missing state do not write', async () => {
    for (const decision of [suppressDecision, rejectDecision]) {
        const db = makeFirestoreMock()
        seedBase(db)
        const reserve = createReserveStrategySymbolOrderFn(db, () => decision)
        const result = await reserve({ eventId: `event-${decision.kind}`, orderId: 'order-1', strategyId, symbolId, side: 'BUY', inputSize: 0.5 })
        assert.equal(result.kind, decision.kind)
        assert.equal(db.writes.length, 0)
    }

    const missingPositionDb = makeFirestoreMock()
    missingPositionDb.docs.tradable_symbols = {
        [symbolId]: { id: symbolId, order_constraints: { quantity_step: 0.1, min_order_size: 0.1 } },
    }
    missingPositionDb.docs.strategy_symbol_policies = { [policyId]: makePolicy() }
    const missingPositionResult = await createReserveStrategySymbolOrderFn(missingPositionDb, () => dispatchDecision(0.5))({
        eventId: 'event-missing-position', orderId: 'order-1', strategyId, symbolId, side: 'BUY', inputSize: 0.5,
    })
    assert.deepEqual(missingPositionResult, { kind: 'REJECT', reason: 'POSITION_NOT_FOUND' })
    assert.equal(missingPositionDb.writes.length, 0)
})

test('injected DISPATCHes that violate max, step, or minimum constraints are rejected before persistence', async () => {
    const cases = [
        {
            name: 'max_abs_position',
            effectiveSize: 3,
            inputSize: 3,
            constraints: { quantity_step: 0.1, min_order_size: 0.1 },
        },
        {
            name: 'max_order_size',
            effectiveSize: 1.5,
            inputSize: 1.5,
            constraints: { quantity_step: 0.1, min_order_size: 0.1, max_order_size: 1 },
        },
        {
            name: 'quantity_step',
            effectiveSize: 0.25,
            inputSize: 0.25,
            constraints: { quantity_step: 0.1, min_order_size: 0.1 },
        },
        {
            name: 'min_order_size',
            effectiveSize: 0.1,
            inputSize: 0.1,
            constraints: { quantity_step: 0.1, min_order_size: 0.5 },
        },
    ] as const

    for (const currentCase of cases) {
        const db = makeFirestoreMock()
        seedBase(db)
        db.docs.tradable_symbols![symbolId]!.order_constraints = currentCase.constraints
        const result = await createReserveStrategySymbolOrderFn(db, () => dispatchDecision(currentCase.effectiveSize))({
            eventId: `event-invalid-dispatch-${currentCase.name}`,
            orderId: `order-invalid-dispatch-${currentCase.name}`,
            strategyId,
            symbolId,
            side: 'BUY',
            inputSize: currentCase.inputSize,
        })

        assert.deepEqual(result, { kind: 'REJECT', reason: 'INVALID_STORED_STATE' })
        assert.equal(db.writes.length, 0)
        assert.equal(db.docs.strategy_symbol_positions?.[positionId]?.pending_delta, 0)
        assert.equal(db.docs.strategy_symbol_reservations, undefined)
    }
})

test('duplicate event suppresses without calculator or second pending addition and conflicts on order/side', async () => {
    const db = makeFirestoreMock()
    seedBase(db, makePosition({ pending_delta: 0.5 }))
    db.docs.strategy_symbol_reservations = { ['unused']: makeReservation('event-duplicate') }
    const reservationId = createStrategySymbolReservationId(strategyId, symbolId, 'event-duplicate')
    db.docs.strategy_symbol_reservations = { [reservationId]: makeReservation('event-duplicate') }
    let calls = 0
    const reserve = createReserveStrategySymbolOrderFn(db, () => {
        calls += 1
        return dispatchDecision(0.5)
    })

    const duplicate = await reserve({ eventId: 'event-duplicate', orderId: 'order-1', strategyId, symbolId, side: 'BUY', inputSize: 0.5 })
    assert.equal(duplicate.kind, 'SUPPRESS')
    assert.equal(duplicate.reason, 'DUPLICATE_EVENT')
    assert.equal(calls, 0)
    assert.equal(db.docs.strategy_symbol_positions?.[positionId]?.pending_delta, 0.5)
    assert.equal(db.writes.length, 0)

    const conflict = await reserve({ eventId: 'event-duplicate', orderId: 'different-order', strategyId, symbolId, side: 'BUY', inputSize: 0.5 })
    assert.deepEqual(conflict, { kind: 'REJECT', reason: 'EVENT_CONFLICT' })
    assert.equal(db.writes.length, 0)
})

test('SELL reserves a negative delta and a BUY replay of the same event is a side conflict', async () => {
    const db = makeFirestoreMock()
    seedBase(db)
    const reserve = createReserveStrategySymbolOrderFn(db)
    const input = {
        eventId: 'event-sell',
        orderId: 'order-sell',
        strategyId,
        symbolId,
        side: 'SELL' as const,
        inputSize: 0.5,
    }
    const dispatched = await reserve(input)
    assert.equal(dispatched.kind, 'DISPATCH')
    assert.equal(dispatched.kind === 'DISPATCH' ? dispatched.reservation.reserved_delta : undefined, -0.5)
    assert.equal(db.docs.strategy_symbol_positions?.[positionId]?.pending_delta, -0.5)

    const conflict = await reserve({ ...input, side: 'BUY' })
    assert.deepEqual(conflict, { kind: 'REJECT', reason: 'EVENT_CONFLICT' })
    assert.equal(db.docs.strategy_symbol_positions?.[positionId]?.pending_delta, -0.5)
    assert.equal(db.writes.length, 2)
})

test('transaction retry calculates from the latest pending and commits only the final attempt', async () => {
    const db = makeFirestoreMock({ retry: true })
    seedBase(db)
    const pendingValues: number[] = []
    const reserve = createReserveStrategySymbolOrderFn(db, (input) => {
        pendingValues.push(input.pendingDelta)
        return dispatchDecision(0.5)
    })
    const result = await reserve({ eventId: 'event-retry', orderId: 'order-retry', strategyId, symbolId, side: 'BUY', inputSize: 0.5 })

    assert.equal(result.kind, 'DISPATCH')
    assert.deepEqual(pendingValues, [0, 0.5])
    assert.equal(db.docs.strategy_symbol_positions?.[positionId]?.pending_delta, 1)
    assert.equal(db.writes.length, 2)
    assert.equal(db.transactionRuns, 1)
})

test('dispatch outcomes atomically confirm, release, or retain an unknown reservation', async () => {
    const successDb = makeFirestoreMock()
    seedBase(successDb, makePosition({ pending_delta: 0.5 }))
    successDb.docs.strategy_symbol_reservations = { [createStrategySymbolReservationId(strategyId, symbolId, 'success')]: makeReservation('success') }
    const applySuccess = createApplyStrategySymbolDispatchOutcomeFn(successDb)
    assertServiceType(createStrategySymbolReservationService(successDb))
    assertOutcomeValueType('CONFIRMED_SUCCESS')
    assertOutcomeInputType({ strategyId, symbolId, eventId: 'success', outcome: 'CONFIRMED_SUCCESS' })
    const success = await applySuccess({ strategyId, symbolId, eventId: 'success', outcome: 'CONFIRMED_SUCCESS' })
    assert.equal(success.kind, 'UPDATED')
    assertOutcomeResultType(success)
    assert.equal(successDb.docs.strategy_symbol_reservations?.[createStrategySymbolReservationId(strategyId, symbolId, 'success')]?.status, 'DISPATCHED')
    assert.equal(successDb.docs.strategy_symbol_positions?.[positionId]?.pending_delta, 0.5)

    const failureDb = makeFirestoreMock()
    seedBase(failureDb, makePosition({ pending_delta: 0.5 }))
    failureDb.docs.strategy_symbol_reservations = { [createStrategySymbolReservationId(strategyId, symbolId, 'failure')]: makeReservation('failure') }
    const applyFailure = createApplyStrategySymbolDispatchOutcomeFn(failureDb)
    const failure = await applyFailure({ strategyId, symbolId, eventId: 'failure', outcome: 'CONFIRMED_FAILURE' })
    assert.equal(failure.kind, 'UPDATED')
    assert.equal(failureDb.docs.strategy_symbol_reservations?.[createStrategySymbolReservationId(strategyId, symbolId, 'failure')]?.status, 'RELEASED')
    assert.equal(failureDb.docs.strategy_symbol_positions?.[positionId]?.pending_delta, 0)
    const releaseAgain = await applyFailure({ strategyId, symbolId, eventId: 'failure', outcome: 'CONFIRMED_FAILURE' })
    assert.equal(releaseAgain.kind, 'UNCHANGED')
    assert.equal(failureDb.docs.strategy_symbol_positions?.[positionId]?.pending_delta, 0)

    const unknownDb = makeFirestoreMock()
    seedBase(unknownDb, makePosition({ pending_delta: 0.5 }))
    unknownDb.docs.strategy_symbol_reservations = { [createStrategySymbolReservationId(strategyId, symbolId, 'unknown')]: makeReservation('unknown') }
    const applyUnknown = createApplyStrategySymbolDispatchOutcomeFn(unknownDb)
    const unknown = await applyUnknown({ strategyId, symbolId, eventId: 'unknown', outcome: 'UNKNOWN' })
    assert.equal(unknown.kind, 'UPDATED')
    assert.equal(unknownDb.docs.strategy_symbol_reservations?.[createStrategySymbolReservationId(strategyId, symbolId, 'unknown')]?.status, 'MANUAL_REVIEW')
    assert.equal(unknownDb.docs.strategy_symbol_positions?.[positionId]?.status, 'MANUAL_REVIEW')
    assert.equal(unknownDb.docs.strategy_symbol_positions?.[positionId]?.pending_delta, 0.5)
    const unknownAgain = await applyUnknown({ strategyId, symbolId, eventId: 'unknown', outcome: 'UNKNOWN' })
    assert.equal(unknownAgain.kind, 'UNCHANGED')
})

test('outcome rejects an unsafe reverse transition without writing', async () => {
    const db = makeFirestoreMock()
    seedBase(db, makePosition({ pending_delta: 0.5 }))
    const eventId = 'event-dispatched'
    const reservationId = createStrategySymbolReservationId(strategyId, symbolId, eventId)
    db.docs.strategy_symbol_reservations = { [reservationId]: makeReservation(eventId, { status: 'DISPATCHED' }) }
    const result = await createApplyStrategySymbolDispatchOutcomeFn(db)({
        strategyId,
        symbolId,
        eventId,
        outcome: 'CONFIRMED_FAILURE',
    })
    assert.deepEqual(result, { kind: 'REJECT', reason: 'INVALID_TRANSITION' })
    assert.equal(db.writes.length, 0)
    assert.equal(db.docs.strategy_symbol_positions?.[positionId]?.pending_delta, 0.5)
})

test('release transaction failure leaves reservation and position unchanged', async () => {
    const db = makeFirestoreMock({ failOnSetAt: 2 })
    seedBase(db, makePosition({ pending_delta: 0.5 }))
    const eventId = 'event-release-write-failure'
    const reservationId = createStrategySymbolReservationId(strategyId, symbolId, eventId)
    db.docs.strategy_symbol_reservations = { [reservationId]: makeReservation(eventId) }

    await assert.rejects(
        createApplyStrategySymbolDispatchOutcomeFn(db)({
            strategyId,
            symbolId,
            eventId,
            outcome: 'CONFIRMED_FAILURE',
        }),
        /simulated transaction write failure/,
    )
    assert.equal(db.writes.length, 0)
    assert.equal(db.docs.strategy_symbol_positions?.[positionId]?.pending_delta, 0.5)
    assert.equal(db.docs.strategy_symbol_reservations?.[reservationId]?.status, 'RESERVED')
})
