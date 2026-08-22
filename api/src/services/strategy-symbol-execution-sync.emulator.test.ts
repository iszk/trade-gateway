import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { getFirestoreClient } from '../firestore.js'
import type { Firestore, Transaction } from 'firebase-admin/firestore'
import type { OrderV2 } from '../types/order-v2.js'
import { createStrategySymbolPositionId } from './strategy-symbol-positions.js'
import { createStrategySymbolReservationId } from './strategy-symbol-reservations.js'
import { createApplyStrategySymbolExecutionSyncFn } from './strategy-symbol-execution-sync.js'

const hasEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST)
if (hasEmulator) {
    process.env.GCLOUD_PROJECT ??= 'trade-gateway-test'
    process.env.GOOGLE_CLOUD_PROJECT ??= process.env.GCLOUD_PROJECT
}

type EmulatorExecutionState = {
    strategyId: string
    symbolId: string
    eventId: string
    positionId: string
    reservationId: string
    order: OrderV2
    position: Record<string, unknown>
    reservation: Record<string, unknown>
}

const makeEmulatorExecutionState = (suffix: string): EmulatorExecutionState => {
    const strategyId = `execution_${suffix}`
    const ticker = `BTC_JPY_${suffix}`
    const symbolId = `dummy:${ticker}`
    const eventId = `event-${suffix}`
    const positionId = createStrategySymbolPositionId(strategyId, symbolId)
    const reservationId = createStrategySymbolReservationId(strategyId, symbolId, eventId)
    const now = new Date('2026-01-01T00:00:00.000Z')
    return {
        strategyId,
        symbolId,
        eventId,
        positionId,
        reservationId,
        order: {
            id: eventId,
            strategy: strategyId,
            broker: 'dummy',
            ticker,
            side: 'BUY',
            order_type: 'MARKET',
            requested_size: 1,
            executed_size: 0,
            executed_price: null,
            status: 'PENDING',
            provider_order_ids: ['provider'],
            created_at: now,
            updated_at: now,
        },
        position: {
            id: positionId,
            strategy_id: strategyId,
            symbol_id: symbolId,
            confirmed_position: 0,
            pending_delta: 1,
            status: 'READY',
            policy_version: 1,
            updated_at: now,
            reconciled_at: null,
        },
        reservation: {
            id: reservationId,
            event_id: eventId,
            position_id: positionId,
            strategy_id: strategyId,
            symbol_id: symbolId,
            order_id: eventId,
            reserved_delta: 1,
            executed_delta: 0,
            status: 'DISPATCHED',
            policy_version: 1,
            created_at: now,
            updated_at: now,
        },
    }
}

const seedEmulatorExecutionState = async (
    db: Firestore,
    state: EmulatorExecutionState,
): Promise<void> => {
    await Promise.all([
        db.collection('orders_v2').doc(state.eventId).set(state.order),
        db.collection('strategy_symbol_positions').doc(state.positionId).set(state.position),
        db.collection('strategy_symbol_reservations').doc(state.reservationId).set(state.reservation),
    ])
}

const deleteEmulatorExecutionState = async (
    db: Firestore,
    state: EmulatorExecutionState,
): Promise<void> => {
    await Promise.all([
        db.collection('orders_v2').doc(state.eventId).delete(),
        db.collection('strategy_symbol_reservations').doc(state.reservationId).delete(),
        db.collection('strategy_symbol_positions').doc(state.positionId).delete(),
    ])
}

test('Firestore execution sync commits order, reservation, and position atomically and idempotently', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const strategyId = `execution_${suffix}`
    const ticker = `BTC_JPY_${suffix}`
    const symbolId = `dummy:${ticker}`
    const eventId = `event-${suffix}`
    const positionId = createStrategySymbolPositionId(strategyId, symbolId)
    const reservationId = createStrategySymbolReservationId(strategyId, symbolId, eventId)
    const order: OrderV2 = {
        id: eventId,
        strategy: strategyId,
        broker: 'dummy',
        ticker,
        side: 'BUY',
        order_type: 'MARKET',
        requested_size: 1,
        executed_size: 0,
        executed_price: null,
        status: 'PENDING',
        provider_order_ids: ['provider'],
        created_at: new Date(),
        updated_at: new Date(),
    }
    t.after(async () => {
        await Promise.all([
            db.collection('orders_v2').doc(eventId).delete(),
            db.collection('strategy_symbol_reservations').doc(reservationId).delete(),
            db.collection('strategy_symbol_positions').doc(positionId).delete(),
        ])
    })
    await Promise.all([
        db.collection('orders_v2').doc(eventId).set(order),
        db.collection('strategy_symbol_positions').doc(positionId).set({
            id: positionId,
            strategy_id: strategyId,
            symbol_id: symbolId,
            confirmed_position: 0,
            pending_delta: 1,
            status: 'READY',
            policy_version: 1,
            updated_at: new Date(),
            reconciled_at: null,
        }),
        db.collection('strategy_symbol_reservations').doc(reservationId).set({
            id: reservationId,
            event_id: eventId,
            position_id: positionId,
            strategy_id: strategyId,
            symbol_id: symbolId,
            order_id: eventId,
            reserved_delta: 1,
            executed_delta: 0,
            status: 'DISPATCHED',
            policy_version: 1,
            created_at: new Date(),
            updated_at: new Date(),
        }),
    ])

    const apply = createApplyStrategySymbolExecutionSyncFn(db)
    const result = await apply(order, { execution: { size: 1, price: 100 } })
    assert.equal(result.reservation, 'UPDATED')
    assert.equal((await db.collection('strategy_symbol_positions').doc(positionId).get()).data()?.confirmed_position, 1)
    assert.equal((await db.collection('strategy_symbol_reservations').doc(reservationId).get()).data()?.status, 'SETTLED')
    assert.equal((await db.collection('orders_v2').doc(eventId).get()).data()?.status, 'EXECUTED')

    const duplicate = await apply(order, { execution: { size: 1, price: 100 } })
    assert.equal(duplicate.reservation, 'UNCHANGED')
    assert.equal((await db.collection('strategy_symbol_positions').doc(positionId).get()).data()?.confirmed_position, 1)
})

test('Firestore execution sync abort leaves all three documents unchanged', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const state = makeEmulatorExecutionState(randomUUID().replaceAll('-', ''))
    t.after(() => deleteEmulatorExecutionState(db, state))
    await seedEmulatorExecutionState(db, state)

    const before = await Promise.all([
        db.collection('orders_v2').doc(state.eventId).get(),
        db.collection('strategy_symbol_reservations').doc(state.reservationId).get(),
        db.collection('strategy_symbol_positions').doc(state.positionId).get(),
    ])
    const abortAfterStaging = async <T>(
        updateFunction: (transaction: Transaction) => Promise<T>,
    ): Promise<T> => db.runTransaction(async (transaction) => {
        await updateFunction(transaction)
        throw new Error('intentional execution sync transaction abort after staging')
    })

    const apply = createApplyStrategySymbolExecutionSyncFn(db, abortAfterStaging)
    await assert.rejects(
        apply(state.order, { execution: { size: 1, price: 100 } }),
        /intentional execution sync transaction abort after staging/,
    )

    const after = await Promise.all([
        db.collection('orders_v2').doc(state.eventId).get(),
        db.collection('strategy_symbol_reservations').doc(state.reservationId).get(),
        db.collection('strategy_symbol_positions').doc(state.positionId).get(),
    ])
    assert.deepEqual(after[0].data(), before[0].data())
    assert.deepEqual(after[1].data(), before[1].data())
    assert.deepEqual(after[2].data(), before[2].data())
})

test('Firestore execution sync applies a concurrent snapshot only once', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const state = makeEmulatorExecutionState(randomUUID().replaceAll('-', ''))
    t.after(() => deleteEmulatorExecutionState(db, state))
    await seedEmulatorExecutionState(db, state)

    const apply = createApplyStrategySymbolExecutionSyncFn(db)
    await Promise.all([
        apply(state.order, { execution: { size: 1, price: 100 } }),
        apply(state.order, { execution: { size: 1, price: 100 } }),
    ])

    const order = (await db.collection('orders_v2').doc(state.eventId).get()).data()
    const reservation = (await db.collection('strategy_symbol_reservations').doc(state.reservationId).get()).data()
    const position = (await db.collection('strategy_symbol_positions').doc(state.positionId).get()).data()
    assert.equal(order?.status, 'EXECUTED')
    assert.equal(order?.executed_size, 1)
    assert.equal(reservation?.status, 'SETTLED')
    assert.equal(reservation?.executed_delta, 1)
    assert.equal(position?.confirmed_position, 1)
    assert.equal(position?.pending_delta, 0)
})

test('Firestore execution sync settles only the unfilled remainder on a later cancel', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const state = makeEmulatorExecutionState(randomUUID().replaceAll('-', ''))
    t.after(() => deleteEmulatorExecutionState(db, state))
    await seedEmulatorExecutionState(db, state)

    const apply = createApplyStrategySymbolExecutionSyncFn(db)
    const partial = await apply(state.order, { execution: { size: 0.4, price: 100 } })
    assert.equal(partial.reservation, 'UPDATED')
    const partialPosition = (await db.collection('strategy_symbol_positions').doc(state.positionId).get()).data()
    assert.equal(partialPosition?.confirmed_position, 0.4)
    assert.equal(partialPosition?.pending_delta, 0.6)

    const canceled = await apply(state.order, {
        execution: { size: 0.4, price: 100 },
        terminalStatus: 'CANCELED',
        terminalReason: 'cancelled',
    })
    assert.equal(canceled.reservation, 'UPDATED')
    const canceledPosition = (await db.collection('strategy_symbol_positions').doc(state.positionId).get()).data()
    assert.equal(canceledPosition?.confirmed_position, 0.4)
    assert.equal(canceledPosition?.pending_delta, 0)
    assert.equal((await db.collection('strategy_symbol_reservations').doc(state.reservationId).get()).data()?.status, 'SETTLED')

    const duplicate = await apply(state.order, {
        execution: { size: 0.4, price: 100 },
        terminalStatus: 'CANCELED',
        terminalReason: 'cancelled',
    })
    assert.equal(duplicate.reservation, 'UNCHANGED')
    const finalPosition = (await db.collection('strategy_symbol_positions').doc(state.positionId).get()).data()
    assert.equal(finalPosition?.confirmed_position, 0.4)
    assert.equal(finalPosition?.pending_delta, 0)
})
