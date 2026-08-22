import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

import { getFirestoreClient } from '../firestore.js'
import type { StrategySymbolReservation } from '../types/strategy-symbol-reservation.js'
import {
    createGetStrategySymbolReservationFn,
    createSetStrategySymbolReservationFn,
    createStrategySymbolReservationId,
    InvalidStoredStrategySymbolReservationError,
} from './strategy-symbol-reservations.js'

const hasEmulator = Boolean(process.env.FIRESTORE_EMULATOR_HOST)

if (hasEmulator) {
    process.env.GCLOUD_PROJECT ??= 'trade-gateway-test'
    process.env.GOOGLE_CLOUD_PROJECT ??= process.env.GCLOUD_PROJECT
}

test('reservation repository stores independent event/strategy/symbol documents with Firestore timestamps', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const symbolId = `dummy:reservation_${suffix}`
    const strategyId = `reservation_${suffix}`
    const secondStrategyId = `reservation_other_${suffix}`
    const secondSymbolId = `dummy:reservation_other_${suffix}`
    const eventId = `event/${suffix}:同じイベント`
    const secondEventId = `${eventId}:second`
    const createdAt = new Date('2026-01-01T00:00:00.000Z')
    const updatedAt = new Date('2026-01-02T00:00:00.000Z')
    const makeReservation = (
        currentStrategyId: string,
        currentSymbolId: string,
        currentEventId: string,
        orderId: string,
        delta: number,
    ): StrategySymbolReservation => ({
        id: createStrategySymbolReservationId(currentStrategyId, currentSymbolId, currentEventId),
        event_id: currentEventId,
        position_id: `${currentStrategyId}:${currentSymbolId}`,
        strategy_id: currentStrategyId,
        symbol_id: currentSymbolId,
        order_id: orderId,
        reserved_delta: delta,
        status: 'RESERVED',
        policy_version: 1,
        created_at: createdAt,
        updated_at: updatedAt,
    })
    const reservations = [
        makeReservation(strategyId, symbolId, eventId, `order_${suffix}_1`, 1),
        makeReservation(secondStrategyId, symbolId, eventId, `order_${suffix}_2`, -1),
        makeReservation(strategyId, secondSymbolId, eventId, `order_${suffix}_3`, 0.5),
        makeReservation(strategyId, symbolId, secondEventId, `order_${suffix}_4`, -0.5),
    ]
    const positionId = reservations[0]!.position_id
    const positionRef = db.collection('strategy_symbol_positions').doc(positionId)

    t.after(async () => {
        await Promise.all([
            ...reservations.map((reservation) => (
                db.collection('strategy_symbol_reservations').doc(reservation.id).delete()
            )),
            positionRef.delete(),
        ])
    })

    await positionRef.set({
        id: positionId,
        strategy_id: strategyId,
        symbol_id: symbolId,
        confirmed_position: 0,
        pending_delta: 0,
        status: 'READY',
        policy_version: 1,
        updated_at: updatedAt,
        reconciled_at: null,
    })
    const set = createSetStrategySymbolReservationFn(db)
    const get = createGetStrategySymbolReservationFn(db)
    for (const reservation of reservations) await set(reservation)

    assert.deepEqual(await get(strategyId, symbolId, eventId), { ...reservations[0], executed_delta: 0 })
    assert.deepEqual(await get(secondStrategyId, symbolId, eventId), { ...reservations[1], executed_delta: 0 })
    assert.deepEqual(await get(strategyId, secondSymbolId, eventId), { ...reservations[2], executed_delta: 0 })
    assert.deepEqual(await get(strategyId, symbolId, secondEventId), { ...reservations[3], executed_delta: 0 })

    const raw = await db.collection('strategy_symbol_reservations').doc(reservations[0]!.id).get()
    assert.ok(raw.data()?.created_at && typeof raw.data()?.created_at.toDate === 'function')
    assert.equal(raw.data()?.position_reservations, undefined)

    const rawPosition = await positionRef.get()
    assert.equal(rawPosition.exists, true)
    const rawPositionData = rawPosition.data()
    assert.equal(rawPositionData?.reservations, undefined)
    assert.equal(rawPositionData?.position_reservations, undefined)
    assert.equal(Object.values(rawPositionData ?? {}).some((value) => Array.isArray(value)), false)
})

test('reservation repository rejects a malformed stored document in the emulator', { skip: !hasEmulator }, async (t) => {
    const db = getFirestoreClient()
    const suffix = randomUUID().replaceAll('-', '')
    const symbolId = `dummy:reservation_invalid_${suffix}`
    const strategyId = `reservation_invalid_${suffix}`
    const eventId = `event/${suffix}`
    const id = createStrategySymbolReservationId(strategyId, symbolId, eventId)
    t.after(() => db.collection('strategy_symbol_reservations').doc(id).delete())

    await db.collection('strategy_symbol_reservations').doc(id).set({
        id,
        event_id: eventId,
        position_id: `${strategyId}:${symbolId}`,
        strategy_id: strategyId,
        symbol_id: symbolId,
        order_id: `order_${suffix}`,
        reserved_delta: 0,
        status: 'RESERVED',
        policy_version: 1,
        created_at: new Date('2026-01-01T00:00:00.000Z'),
        updated_at: new Date('2026-01-02T00:00:00.000Z'),
    })
    await assert.rejects(
        createGetStrategySymbolReservationFn(db)(strategyId, symbolId, eventId),
        InvalidStoredStrategySymbolReservationError,
    )
})
