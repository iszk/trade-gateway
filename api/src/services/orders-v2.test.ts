import assert from 'node:assert/strict'
import test from 'node:test'

import {
    createAddOrderV2Fn,
    createListOrderUpdatesFn,
    createListOrdersV2ByDateRangeFn,
    createUpdateOrderV2Fn,
    createUpdateOrderV2AtomicallyFn,
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
    saxo_ifdoco_recovery: order.saxo_ifdoco_recovery
        ? {
            ...order.saxo_ifdoco_recovery,
            last_attempt_at: toTimestamp(order.saxo_ifdoco_recovery.last_attempt_at),
            next_attempt_at: order.saxo_ifdoco_recovery.next_attempt_at
                ? toTimestamp(order.saxo_ifdoco_recovery.next_attempt_at)
                : undefined,
        }
        : undefined,
})

const createDbStub = (orders: OrderV2[]) => {
    const state: {
        whereCalls: { field: string; op: string; value: unknown }[]
        orderByCalls: { field: string; direction?: string }[]
    } = {
        whereCalls: [],
        orderByCalls: [],
    }

    const query = {
        where: (field: string, op: string, value: unknown) => {
            state.whereCalls.push({ field, op, value })
            return query
        },
        orderBy: (field: string, direction?: string) => {
            state.orderByCalls.push({ field, direction })
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

const createTransactionDbStub = (order: OrderV2 | null) => {
    const state: { updatePayload?: Record<string, unknown>, reads: number } = { reads: 0 }
    const docRef = {}
    const db = {
        collection: () => ({ doc: () => docRef }),
        runTransaction: async (callback: (transaction: unknown) => Promise<boolean>) => callback({
            get: async () => {
                state.reads += 1
                return {
                    exists: order !== null,
                    data: () => order ? toFirestoreOrder(order) : undefined,
                }
            },
            update: (_ref: unknown, payload: Record<string, unknown>) => {
                state.updatePayload = payload
            },
        }),
    }
    return { db, state }
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

test('createUpdateOrderV2AtomicallyFn: transaction内の最新orderを正規化して更新する', async () => {
    const current = makeOrder({
        id: 'atomic-order',
        updated_at: new Date('2026-01-02T00:00:00Z'),
        executed_at: new Date('2026-01-01T01:00:00Z'),
        saxo_ifdoco_recovery: {
            status: 'RETRY_PENDING',
            attempt_count: 1,
            last_attempt_at: new Date('2026-01-01T02:00:00Z'),
            next_attempt_at: new Date('2026-01-01T02:10:00Z'),
            result_kind: 'TEMPORARY_FAILURE',
            reason: 'RATE_LIMITED',
        },
    })
    const { db, state } = createTransactionDbStub(current)
    const updateOrderV2Atomically = createUpdateOrderV2AtomicallyFn(db as any)

    const updated = await updateOrderV2Atomically('atomic-order', (latest) => {
        assert.ok(latest.created_at instanceof Date)
        assert.ok(latest.updated_at instanceof Date)
        assert.ok(latest.executed_at instanceof Date)
        assert.ok(latest.saxo_ifdoco_recovery?.last_attempt_at instanceof Date)
        assert.ok(latest.saxo_ifdoco_recovery?.next_attempt_at instanceof Date)
        return { status: 'CANCELED', executed_at: undefined }
    })

    assert.equal(updated, true)
    assert.equal(state.reads, 1)
    assert.equal(state.updatePayload?.status, 'CANCELED')
    assert.equal('executed_at' in (state.updatePayload ?? {}), false)
    assert.ok(state.updatePayload?.updated_at instanceof Date)
})

test('createUpdateOrderV2AtomicallyFn: documentなしと空diffではwriteしない', async () => {
    for (const [order, mutate] of [
        [null, () => null],
        [makeOrder({ id: 'atomic-empty' }), () => ({})],
    ] as const) {
        const { db, state } = createTransactionDbStub(order)
        const updateOrderV2Atomically = createUpdateOrderV2AtomicallyFn(db as any)
        assert.equal(await updateOrderV2Atomically(order?.id ?? 'missing-order', mutate), false)
        assert.equal(state.updatePayload, undefined)
        assert.equal(state.reads, 1)
    }
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

    assert.deepEqual(state.whereCalls, [
        { field: 'executed_at', op: '>=', value: rangeFrom },
        { field: 'executed_at', op: '<', value: rangeTo },
    ])
    assert.deepEqual(state.orderByCalls, [{ field: 'executed_at', direction: 'desc' }])
    assert.deepEqual(
        orders.map((order) => order.id),
        ['executed-later', 'executed-earlier'],
    )
})

test('createListOrderUpdatesFn: updated_at の半開区間を全 status で取得し安定順序にする', async () => {
    const rangeFrom = new Date('2026-02-01T00:00:00Z')
    const rangeTo = new Date('2026-03-01T00:00:00Z')
    const sameTime = new Date('2026-02-10T00:00:00Z')

    const { db, state } = createDbStub([
        makeOrder({ id: 'z-canceled', status: 'CANCELED', updated_at: sameTime }),
        makeOrder({ id: 'executed-first', status: 'EXECUTED', updated_at: new Date('2026-02-02T00:00:00Z') }),
        makeOrder({ id: 'a-failed', status: 'FAILED', updated_at: sameTime }),
        makeOrder({ id: 'pending-last', status: 'PENDING', updated_at: new Date('2026-02-20T00:00:00Z') }),
    ])

    const listOrderUpdates = createListOrderUpdatesFn(db as any)
    const orders = await listOrderUpdates(rangeFrom, rangeTo)

    assert.deepEqual(state.whereCalls, [
        { field: 'updated_at', op: '>=', value: rangeFrom },
        { field: 'updated_at', op: '<', value: rangeTo },
    ])
    assert.deepEqual(state.orderByCalls, [{ field: 'updated_at', direction: 'asc' }])
    assert.deepEqual(
        orders.map((order) => [order.id, order.status]),
        [
            ['executed-first', 'EXECUTED'],
            ['a-failed', 'FAILED'],
            ['z-canceled', 'CANCELED'],
            ['pending-last', 'PENDING'],
        ],
    )
})

test('createListOrderUpdatesFn: 外部 DTO の null、fill、commission を正規化して内部情報を除外する', async () => {
    const common = {
        strategy: 'external-strategy',
        broker: 'bitflyer' as const,
        ticker: 'FX_BTC_JPY',
        side: 'SELL' as const,
        order_type: 'IFDOCO' as const,
        requested_size: 0.01,
        provider_order_ids: ['provider-1', 'provider-2'],
        created_at: new Date('2026-02-01T01:02:03.456Z'),
        updated_at: new Date('2026-02-02T02:03:04.567Z'),
    }
    const orders = [
        makeOrder({
            ...common,
            id: 'unfilled',
            status: 'PENDING',
            executed_size: 0,
            executed_price: null,
            executed_at: undefined,
            execution_costs: undefined,
            exit_sync_status: undefined,
            broker_order_metadata: { broker: 'bitflyer', kind: 'MARKET', product_code: 'FX_BTC_JPY', entry: { acceptance_id: 'secret' } },
            saxo_ifdoco_recovery: {
                status: 'MANUAL_REVIEW',
                attempt_count: 5,
                last_attempt_at: new Date('2026-02-02T00:00:00Z'),
                result_kind: 'CONFLICT',
                reason: 'ENTRY_MISMATCH',
            },
        } as any),
        makeOrder({
            ...common,
            id: 'partial',
            status: 'FAILED',
            executed_size: 0.004,
            executed_price: 100,
            executed_at: new Date('2026-02-01T03:00:00Z'),
            execution_costs: { commission: 0 },
            exit_sync_status: 'MONITORING',
        }),
        makeOrder({
            ...common,
            id: 'epsilon-filled',
            status: 'CANCELED',
            executed_size: 0.01 - 5e-9,
            executed_price: 101,
            execution_costs: { commission: -0.0001 },
            exit_sync_status: 'COMPLETED',
        }),
        makeOrder({
            ...common,
            id: 'overfilled',
            executed_size: 0.011,
            executed_price: 102,
        }),
    ]
    const { db } = createDbStub(orders)

    const result = await createListOrderUpdatesFn(db as any)(
        new Date('2026-02-01T00:00:00Z'),
        new Date('2026-03-01T00:00:00Z'),
    )

    assert.deepEqual(result[0], {
        id: 'epsilon-filled',
        strategy: 'external-strategy',
        broker: 'bitflyer',
        ticker: 'FX_BTC_JPY',
        side: 'SELL',
        order_type: 'IFDOCO',
        requested_size: 0.01,
        executed_size: 0.009999995,
        executed_price: 101,
        fill_status: 'FILLED',
        status: 'CANCELED',
        provider_order_ids: ['provider-1', 'provider-2'],
        execution_costs: { commission: -0.0001 },
        exit_sync_status: 'COMPLETED',
        created_at: '2026-02-01T01:02:03.456Z',
        updated_at: '2026-02-02T02:03:04.567Z',
        executed_at: '2026-01-01T00:00:00.000Z',
    })
    assert.deepEqual(
        Object.fromEntries(result.map((order) => [order.id, {
            fill_status: order.fill_status,
            commission: order.execution_costs.commission,
            executed_at: order.executed_at,
            exit_sync_status: order.exit_sync_status,
        }])),
        {
            'epsilon-filled': { fill_status: 'FILLED', commission: -0.0001, executed_at: '2026-01-01T00:00:00.000Z', exit_sync_status: 'COMPLETED' },
            overfilled: { fill_status: 'FILLED', commission: null, executed_at: '2026-01-01T00:00:00.000Z', exit_sync_status: null },
            partial: { fill_status: 'PARTIALLY_FILLED', commission: 0, executed_at: '2026-02-01T03:00:00.000Z', exit_sync_status: 'MONITORING' },
            unfilled: { fill_status: 'UNFILLED', commission: null, executed_at: null, exit_sync_status: null },
        },
    )
    assert.equal(JSON.stringify(result).includes('broker_order_metadata'), false)
    assert.equal(JSON.stringify(result).includes('acceptance_id'), false)
    assert.equal(JSON.stringify(result).includes('saxo_ifdoco_recovery'), false)
    assert.equal(JSON.stringify(result).includes('ENTRY_MISMATCH'), false)
})
