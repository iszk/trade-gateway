import assert from 'node:assert/strict'
import test from 'node:test'

import { createListOrdersV2ByDateRangeFn } from './orders-v2.js'
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
