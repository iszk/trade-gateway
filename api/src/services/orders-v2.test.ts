import assert from 'node:assert/strict'
import test from 'node:test'

import {
    createAddOrderV2Fn,
    createListOrdersV2ByDateRangeFn,
    createUpdateOrderV2Fn,
} from './orders-v2.js'
import type { OrderV2 } from '../types/order-v2.js'

const toTimestamp = (date: Date) => ({
    toDate: () => date,
})

const makeOrder = (overrides: Partial<OrderV2>): OrderV2 => ({
    id: `ord-${Math.random()}`,
    strategy: 'test-strategy',
    broker: 'bitflyer',
    ticker: 'BTC_JPY',
    side: 'BUY',
    order_type: 'MARKET',
    requested_size: 0.01,
    executed_size: 0.01,
    executed_price: 1000000,
    status: 'EXECUTED',
    provider_order_ids: ['provider-1'],
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    executed_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
} as OrderV2)

const toFirestoreOrder = (order: OrderV2) => ({
    ...order,
    created_at: toTimestamp(order.created_at),
    updated_at: toTimestamp(order.updated_at),
    executed_at: order.executed_at ? toTimestamp(order.executed_at) : undefined,
})

const createDbStub = (orders: OrderV2[]) => {
    const state: {
        whereFields: string[]
        orderByFields: string[]
    } = {
        whereFields: [],
        orderByFields: [],
    }

    const query = {
        where: (field: string) => {
            state.whereFields.push(field)
            return query
        },
        orderBy: (field: string) => {
            state.orderByFields.push(field)
            return {
                get: async () => ({
                    docs: orders.map((order) => ({
                        data: () => toFirestoreOrder(order),
                    })),
                }),
            }
        },
    }

    return {
        state,
        db: {
            collection: () => query,
        },
    }
}

const createWriteDbStub = () => {
    const state: {
        setPayload?: Record<string, unknown>
        updatePayload?: Record<string, unknown>
    } = {}

    return {
        state,
        db: {
            collection: () => ({
                doc: () => ({
                    set: async (payload: Record<string, unknown>) => {
                        state.setPayload = payload
                    },
                    update: async (payload: Record<string, unknown>) => {
                        state.updatePayload = payload
                    },
                }),
            }),
        },
    }
}

test('createAddOrderV2Fn: Firestore write 前に undefined フィールドを除去する', async () => {
    const { db, state } = createWriteDbStub()
    const addOrderV2 = createAddOrderV2Fn(db as any)

    await addOrderV2(makeOrder({
        id: 'order-with-undefined',
        executed_at: undefined,
        exit_sync_status: undefined,
    }))

    assert.ok(state.setPayload)
    assert.equal('executed_at' in state.setPayload, false)
    assert.equal('exit_sync_status' in state.setPayload, false)
    assert.equal(state.setPayload.id, 'order-with-undefined')
})

test('createUpdateOrderV2Fn: Firestore update 前に undefined フィールドを除去する', async () => {
    const { db, state } = createWriteDbStub()
    const updateOrderV2 = createUpdateOrderV2Fn(db as any)

    await updateOrderV2('order-with-undefined', {
        executed_at: undefined,
        exit_sync_status: undefined,
        status: 'EXECUTED',
    })

    assert.ok(state.updatePayload)
    assert.equal('executed_at' in state.updatePayload, false)
    assert.equal('exit_sync_status' in state.updatePayload, false)
    assert.equal(state.updatePayload.status, 'EXECUTED')
    assert.ok(state.updatePayload.updated_at instanceof Date)
})

test('createListOrdersV2ByDateRangeFn: executed_at のみで期間抽出し降順に返す', async () => {
    const rangeFrom = new Date('2026-01-10T00:00:00Z')
    const rangeTo = new Date('2026-01-20T23:59:59Z')

    const executedEarlier = makeOrder({
        id: 'executed-earlier',
        created_at: new Date('2026-01-01T00:00:00Z'),
        executed_at: new Date('2026-01-12T00:00:00Z'),
    })
    const executedLater = makeOrder({
        id: 'executed-later',
        created_at: new Date('2026-01-16T00:00:00Z'),
        executed_at: new Date('2026-01-18T00:00:00Z'),
    })
    const legacyWithoutExecutedAt = makeOrder({
        id: 'legacy-without-executed-at',
        created_at: new Date('2026-01-15T00:00:00Z'),
        executed_at: undefined,
    })

    const { db, state } = createDbStub([
        executedEarlier,
        executedLater,
        legacyWithoutExecutedAt,
    ])

    const listOrdersV2ByDateRange = createListOrdersV2ByDateRangeFn(
        db as any,
    )

    const orders = await listOrdersV2ByDateRange(rangeFrom, rangeTo)

    assert.deepEqual(state.whereFields, ['executed_at', 'executed_at'])
    assert.deepEqual(state.orderByFields, ['executed_at'])
    assert.deepEqual(
        orders.map((order) => order.id),
        ['executed-later', 'executed-earlier'],
    )
})
