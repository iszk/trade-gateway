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
    ...overrides,
})

const toFirestoreOrder = (order: OrderV2) => ({
    ...order,
    created_at: toTimestamp(order.created_at),
    updated_at: toTimestamp(order.updated_at),
    executed_at: order.executed_at ? toTimestamp(order.executed_at) : undefined,
})

const createDbStub = (snapshots: { executed_at: OrderV2[]; created_at: OrderV2[] }) => ({
    collection: () => ({
        where: (field: 'executed_at' | 'created_at') => ({
            where: () => ({
                orderBy: () => ({
                    get: async () => ({
                        docs: snapshots[field].map((order) => ({
                            data: () => toFirestoreOrder(order),
                        })),
                    }),
                }),
            }),
        }),
    }),
})

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

test('createListOrdersV2ByDateRangeFn: executed_at を優先しつつ created_at フォールバックで期間抽出する', async () => {
    const rangeFrom = new Date('2026-01-10T00:00:00Z')
    const rangeTo = new Date('2026-01-20T23:59:59Z')

    const executedInRange = makeOrder({
        id: 'executed-in-range',
        created_at: new Date('2026-01-01T00:00:00Z'),
        executed_at: new Date('2026-01-12T00:00:00Z'),
    })
    const createdFallbackInRange = makeOrder({
        id: 'created-fallback-in-range',
        created_at: new Date('2026-01-15T00:00:00Z'),
        executed_at: undefined,
    })
    const executedOutOfRange = makeOrder({
        id: 'executed-out-of-range',
        created_at: new Date('2026-01-16T00:00:00Z'),
        executed_at: new Date('2026-01-25T00:00:00Z'),
    })

    const listOrdersV2ByDateRange = createListOrdersV2ByDateRangeFn(
        createDbStub({
            executed_at: [executedInRange, executedOutOfRange],
            created_at: [createdFallbackInRange, executedOutOfRange],
        }) as any,
    )

    const orders = await listOrdersV2ByDateRange(rangeFrom, rangeTo)

    assert.deepEqual(
        orders.map((order) => order.id),
        ['created-fallback-in-range', 'executed-in-range'],
    )
    assert.equal(orders[0]?.executed_at, undefined)
    assert.deepEqual(orders[1]?.executed_at, new Date('2026-01-12T00:00:00Z'))
})
