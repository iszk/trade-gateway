import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { getFirestoreClient } from '../firestore.js'
import type { Transaction } from 'firebase-admin/firestore'
import type { StrategySymbolPolicy } from '../types/strategy-symbol-policy.js'
import type { StrategySymbolPosition } from '../types/strategy-symbol-position.js'
import {
    createApplyStrategySymbolDispatchOutcomeFn,
    createReserveStrategySymbolOrderFn,
} from './strategy-symbol-reservation-service.js'
import { createStrategySymbolPolicyId } from './strategy-symbol-policies.js'
import { createStrategySymbolPositionId } from './strategy-symbol-positions.js'
import { createStrategySymbolReservationId } from './strategy-symbol-reservations.js'

const hasEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST)

if (hasEmulator) {
    process.env.GCLOUD_PROJECT ??= 'trade-gateway-test'
    process.env.GOOGLE_CLOUD_PROJECT ??= process.env.GCLOUD_PROJECT
}

const makePolicy = (
    strategyId: string,
    symbolId: string,
    version = 1,
): StrategySymbolPolicy => ({
    id: createStrategySymbolPolicyId(strategyId, symbolId),
    strategy_id: strategyId,
    symbol_id: symbolId,
    sizing_mode: 'WEBHOOK_CAPPED',
    enabled: true,
    max_abs_position: 1,
    no_flip: true,
    version,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-02T00:00:00.000Z'),
})

const makePosition = (strategyId: string, symbolId: string): StrategySymbolPosition => ({
    id: createStrategySymbolPositionId(strategyId, symbolId),
    strategy_id: strategyId,
    symbol_id: symbolId,
    confirmed_position: 0,
    pending_delta: 0,
    status: 'READY',
    policy_version: 1,
    updated_at: new Date('2026-01-02T00:00:00.000Z'),
    reconciled_at: null,
})

test('Firestore transaction keeps concurrent reserves within the policy limit and deduplicates one event', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const strategyId = `atomic_${suffix}`
    const symbolId = `dummy:atomic_${suffix}`
    const policyId = createStrategySymbolPolicyId(strategyId, symbolId)
    const positionId = createStrategySymbolPositionId(strategyId, symbolId)
    const eventIds = Array.from({ length: 8 }, (_, index) => `event-${suffix}-${index}`)
    const reservationIds = eventIds.map((eventId) => createStrategySymbolReservationId(strategyId, symbolId, eventId))
    const duplicateStrategyId = `atomic_duplicate_${suffix}`
    const duplicatePolicyId = createStrategySymbolPolicyId(duplicateStrategyId, symbolId)
    const duplicatePositionId = createStrategySymbolPositionId(duplicateStrategyId, symbolId)
    const duplicateEvent = `event-duplicate-${suffix}`
    const duplicateReservationId = createStrategySymbolReservationId(duplicateStrategyId, symbolId, duplicateEvent)

    t.after(async () => {
        await Promise.all([
            db.collection('tradable_symbols').doc(symbolId).delete(),
            db.collection('strategy_symbol_policies').doc(policyId).delete(),
            db.collection('strategy_symbol_positions').doc(positionId).delete(),
            ...reservationIds.map((id) => db.collection('strategy_symbol_reservations').doc(id).delete()),
            db.collection('strategy_symbol_policies').doc(duplicatePolicyId).delete(),
            db.collection('strategy_symbol_positions').doc(duplicatePositionId).delete(),
            db.collection('strategy_symbol_reservations').doc(duplicateReservationId).delete(),
        ])
    })

    await Promise.all([
        db.collection('tradable_symbols').doc(symbolId).set({
            id: symbolId,
            order_constraints: { quantity_step: 0.1, min_order_size: 0.1, max_order_size: 1 },
        }),
        db.collection('strategy_symbol_policies').doc(policyId).set(makePolicy(strategyId, symbolId)),
        db.collection('strategy_symbol_positions').doc(positionId).set(makePosition(strategyId, symbolId)),
        db.collection('strategy_symbol_policies').doc(duplicatePolicyId).set(makePolicy(duplicateStrategyId, symbolId)),
        db.collection('strategy_symbol_positions').doc(duplicatePositionId).set(makePosition(duplicateStrategyId, symbolId)),
    ])

    const reserve = createReserveStrategySymbolOrderFn(db)
    const results = await Promise.all(eventIds.map((eventId) => reserve({
        eventId,
        orderId: `order-${eventId}`,
        strategyId,
        symbolId,
        side: 'BUY',
        inputSize: 0.3,
    })))

    const dispatches = results.filter((result) => result.kind === 'DISPATCH')
    assert.ok(dispatches.length >= 1)
    const positionSnapshot = await db.collection('strategy_symbol_positions').doc(positionId).get()
    const positionData = positionSnapshot.data() as StrategySymbolPosition
    assert.equal(positionData.strategy_id, strategyId)
    assert.equal(positionData.symbol_id, symbolId)
    assert.equal(positionData.policy_version, 1)
    assert.ok(positionData.confirmed_position + positionData.pending_delta <= 1)

    const storedReservations = await Promise.all(reservationIds.map(async (id) => (
        (await db.collection('strategy_symbol_reservations').doc(id).get()).data()
    )))
    const reservationSum = storedReservations.reduce((sum, reservation) => (
        sum + (typeof reservation?.reserved_delta === 'number' ? reservation.reserved_delta : 0)
    ), 0)
    assert.ok(Math.abs(reservationSum - positionData.pending_delta) <= 1e-12)

    const duplicateResults = await Promise.all(Array.from({ length: 5 }, () => reserve({
        eventId: duplicateEvent,
        orderId: `order-${duplicateEvent}`,
        strategyId: duplicateStrategyId,
        symbolId,
        side: 'BUY',
        inputSize: 0.1,
    })))
    assert.equal(duplicateResults.filter((result) => result.kind === 'DISPATCH').length, 1)
    assert.equal(duplicateResults.filter((result) => result.kind === 'SUPPRESS' && result.reason === 'DUPLICATE_EVENT').length, 4)
    assert.equal((await db.collection('strategy_symbol_reservations').doc(duplicateReservationId).get()).exists, true)
    const duplicatePosition = await db.collection('strategy_symbol_positions').doc(duplicatePositionId).get()
    assert.equal(duplicatePosition.data()?.strategy_id, duplicateStrategyId)
    assert.equal(duplicatePosition.data()?.symbol_id, symbolId)
    assert.equal(duplicatePosition.data()?.pending_delta, 0.1)
    assert.equal(duplicatePosition.data()?.policy_version, 1)
    const duplicateReservation = await db.collection('strategy_symbol_reservations').doc(duplicateReservationId).get()
    assert.equal(duplicateReservation.data()?.strategy_id, duplicateStrategyId)
    assert.equal(duplicateReservation.data()?.symbol_id, symbolId)
    assert.equal(duplicateReservation.data()?.reserved_delta, 0.1)
})

test('Firestore reserve suppress/rejects without writes and fails closed for missing or malformed state', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const symbolId = `dummy:guards_${suffix}`
    const strategies = {
        suppress: `guard_suppress_${suffix}`,
        reject: `guard_reject_${suffix}`,
        missing: `guard_missing_${suffix}`,
        malformed: `guard_malformed_${suffix}`,
    }
    const policyIds = Object.values(strategies).map((strategyId) => createStrategySymbolPolicyId(strategyId, symbolId))
    const positionIds = Object.values(strategies).map((strategyId) => createStrategySymbolPositionId(strategyId, symbolId))
    const reservationIds = Object.values(strategies).map((strategyId, index) => (
        createStrategySymbolReservationId(strategyId, symbolId, `guard-event-${index}-${suffix}`)
    ))

    t.after(async () => {
        await Promise.all([
            db.collection('tradable_symbols').doc(symbolId).delete(),
            ...policyIds.map((id) => db.collection('strategy_symbol_policies').doc(id).delete()),
            ...positionIds.map((id) => db.collection('strategy_symbol_positions').doc(id).delete()),
            ...reservationIds.map((id) => db.collection('strategy_symbol_reservations').doc(id).delete()),
        ])
    })

    await db.collection('tradable_symbols').doc(symbolId).set({
        id: symbolId,
        order_constraints: { quantity_step: 0.1, min_order_size: 0.1, max_order_size: 1 },
    })
    const strategyEntries = Object.entries(strategies)
    await Promise.all(strategyEntries.map(async ([kind, strategyId]) => {
        await db.collection('strategy_symbol_policies').doc(createStrategySymbolPolicyId(strategyId, symbolId)).set({
            ...makePolicy(strategyId, symbolId),
            ...(kind === 'suppress' ? { enabled: false } : {}),
        })
        if (kind !== 'missing') {
            const position = makePosition(strategyId, symbolId)
            await db.collection('strategy_symbol_positions').doc(position.id).set(
                kind === 'malformed' ? { ...position, pending_delta: '0' } : position,
            )
        }
    }))

    const reserve = createReserveStrategySymbolOrderFn(db)
    const suppressEvent = `guard-event-0-${suffix}`
    const suppress = await reserve({
        eventId: suppressEvent,
        orderId: `order-${suppressEvent}`,
        strategyId: strategies.suppress,
        symbolId,
        side: 'BUY',
        inputSize: 0.3,
    })
    assert.deepEqual(suppress.kind, 'SUPPRESS')
    assert.equal(suppress.reason, 'POLICY_DISABLED')
    assert.equal((await db.collection('strategy_symbol_reservations').doc(reservationIds[0]!).get()).exists, false)
    assert.equal((await db.collection('strategy_symbol_positions').doc(positionIds[0]!).get()).data()?.pending_delta, 0)

    const rejectEvent = `guard-event-1-${suffix}`
    const reject = await reserve({
        eventId: rejectEvent,
        orderId: `order-${rejectEvent}`,
        strategyId: strategies.reject,
        symbolId,
        side: 'BUY',
    })
    assert.deepEqual(reject.kind, 'REJECT')
    assert.equal(reject.reason, 'SIZE_REQUIRED')
    assert.equal((await db.collection('strategy_symbol_reservations').doc(reservationIds[1]!).get()).exists, false)
    assert.equal((await db.collection('strategy_symbol_positions').doc(positionIds[1]!).get()).data()?.pending_delta, 0)

    const missingEvent = `guard-event-2-${suffix}`
    const missing = await reserve({
        eventId: missingEvent,
        orderId: `order-${missingEvent}`,
        strategyId: strategies.missing,
        symbolId,
        side: 'BUY',
        inputSize: 0.3,
    })
    assert.deepEqual(missing, { kind: 'REJECT', reason: 'POSITION_NOT_FOUND' })
    assert.equal((await db.collection('strategy_symbol_positions').doc(positionIds[2]!).get()).exists, false)
    assert.equal((await db.collection('strategy_symbol_reservations').doc(reservationIds[2]!).get()).exists, false)

    const malformedEvent = `guard-event-3-${suffix}`
    const malformed = await reserve({
        eventId: malformedEvent,
        orderId: `order-${malformedEvent}`,
        strategyId: strategies.malformed,
        symbolId,
        side: 'BUY',
        inputSize: 0.3,
    })
    assert.deepEqual(malformed, { kind: 'REJECT', reason: 'INVALID_STORED_STATE' })
    const malformedPosition = await db.collection('strategy_symbol_positions').doc(positionIds[3]!).get()
    assert.equal(malformedPosition.data()?.pending_delta, '0')
    assert.equal((await db.collection('strategy_symbol_reservations').doc(reservationIds[3]!).get()).exists, false)
})

test('Firestore outcome transactions release exactly once and retain unknown pending state', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const strategyId = `outcome_${suffix}`
    const symbolId = `dummy:outcome_${suffix}`
    const policyId = createStrategySymbolPolicyId(strategyId, symbolId)
    const positionId = createStrategySymbolPositionId(strategyId, symbolId)
    const failureEvent = `failure-${suffix}`
    const unknownEvent = `unknown-${suffix}`
    const rollbackEvent = `rollback-${suffix}`
    const failureReservationId = createStrategySymbolReservationId(strategyId, symbolId, failureEvent)
    const unknownReservationId = createStrategySymbolReservationId(strategyId, symbolId, unknownEvent)
    const rollbackReservationId = createStrategySymbolReservationId(strategyId, symbolId, rollbackEvent)

    t.after(async () => {
        await Promise.all([
            db.collection('tradable_symbols').doc(symbolId).delete(),
            db.collection('strategy_symbol_policies').doc(policyId).delete(),
            db.collection('strategy_symbol_positions').doc(positionId).delete(),
            db.collection('strategy_symbol_reservations').doc(failureReservationId).delete(),
            db.collection('strategy_symbol_reservations').doc(unknownReservationId).delete(),
            db.collection('strategy_symbol_reservations').doc(rollbackReservationId).delete(),
        ])
    })

    await Promise.all([
        db.collection('tradable_symbols').doc(symbolId).set({
            id: symbolId,
            order_constraints: { quantity_step: 0.1, min_order_size: 0.1 },
        }),
        db.collection('strategy_symbol_policies').doc(policyId).set(makePolicy(strategyId, symbolId)),
        db.collection('strategy_symbol_positions').doc(positionId).set(makePosition(strategyId, symbolId)),
    ])

    const reserve = createReserveStrategySymbolOrderFn(db)
    await reserve({ eventId: failureEvent, orderId: `order-${failureEvent}`, strategyId, symbolId, side: 'BUY', inputSize: 0.3 })
    const apply = createApplyStrategySymbolDispatchOutcomeFn(db)
    const releaseResults = await Promise.all([
        apply({ strategyId, symbolId, eventId: failureEvent, outcome: 'CONFIRMED_FAILURE' }),
        apply({ strategyId, symbolId, eventId: failureEvent, outcome: 'CONFIRMED_FAILURE' }),
    ])
    assert.equal(releaseResults.filter((result) => result.kind === 'UPDATED').length, 1)
    assert.equal(releaseResults.filter((result) => result.kind === 'UNCHANGED').length, 1)
    assert.equal((await db.collection('strategy_symbol_positions').doc(positionId).get()).data()?.pending_delta, 0)
    const releasedAgain = await apply({ strategyId, symbolId, eventId: failureEvent, outcome: 'CONFIRMED_FAILURE' })
    assert.equal(releasedAgain.kind, 'UNCHANGED')
    assert.equal((await db.collection('strategy_symbol_positions').doc(positionId).get()).data()?.pending_delta, 0)

    await reserve({ eventId: rollbackEvent, orderId: `order-${rollbackEvent}`, strategyId, symbolId, side: 'BUY', inputSize: 0.3 })
    const beforeRollbackReservation = await db.collection('strategy_symbol_reservations').doc(rollbackReservationId).get()
    const beforeRollbackPosition = await db.collection('strategy_symbol_positions').doc(positionId).get()
    const abortAfterStaging = async <T>(
        updateFunction: (transaction: Transaction) => Promise<T>,
    ): Promise<T> => db.runTransaction(async (transaction) => {
        await updateFunction(transaction)
        throw new Error('intentional emulator transaction abort after staging')
    })
    const applyWithAbort = createApplyStrategySymbolDispatchOutcomeFn(db, abortAfterStaging)
    await assert.rejects(
        applyWithAbort({ strategyId, symbolId, eventId: rollbackEvent, outcome: 'CONFIRMED_FAILURE' }),
        /intentional emulator transaction abort after staging/,
    )
    const afterRollbackReservation = await db.collection('strategy_symbol_reservations').doc(rollbackReservationId).get()
    const afterRollbackPosition = await db.collection('strategy_symbol_positions').doc(positionId).get()
    assert.deepEqual(afterRollbackReservation.data(), beforeRollbackReservation.data())
    assert.deepEqual(afterRollbackPosition.data(), beforeRollbackPosition.data())
    assert.equal(afterRollbackReservation.data()?.status, 'RESERVED')
    assert.equal(afterRollbackPosition.data()?.pending_delta, 0.3)

    await reserve({ eventId: unknownEvent, orderId: `order-${unknownEvent}`, strategyId, symbolId, side: 'BUY', inputSize: 0.3 })
    const unknown = await apply({ strategyId, symbolId, eventId: unknownEvent, outcome: 'UNKNOWN' })
    assert.equal(unknown.kind, 'UPDATED')
    const unknownPosition = (await db.collection('strategy_symbol_positions').doc(positionId).get()).data()
    assert.equal(unknownPosition?.status, 'MANUAL_REVIEW')
    assert.equal(unknownPosition?.pending_delta, 0.6)
    assert.equal((await db.collection('strategy_symbol_reservations').doc(unknownReservationId).get()).data()?.status, 'MANUAL_REVIEW')
})
