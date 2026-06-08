import assert from 'node:assert/strict'
import test from 'node:test'

import { executeTenMinutelyTask } from './cron-tasks.js'
import type { CronContext } from './cron-tasks.js'

const makeLogger = () => {
    const logs: Record<string, unknown>[] = []
    return {
        logger: {
            info: (obj: Record<string, unknown>) => logs.push(obj),
            warn: (obj: Record<string, unknown>) => logs.push(obj),
        },
        logs,
    }
}

const makePositionFetcherStub = () => ({
    fetchAllPositions: async () => [],
})

const makeBaseCtx = (overrides: Partial<CronContext> = {}): CronContext => ({
    logger: makeLogger().logger,
    positionFetcher: makePositionFetcherStub(),
    ...overrides,
})

// ─────────────── Phase 3: orders_v2 sync ───────────────

test('executeTenMinutelyTask: orders_v2 の PENDING を EXECUTED に更新する', async () => {
    const pendingOrder: any = {
        id: 'v2-pending-1',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        status: 'PENDING',
        provider_order_ids: ['JRF-v2-1'],
        requested_size: 0.01,
        created_at: new Date('2026-01-01T00:00:00Z'),
    }
    const updatedOrders: any[] = []

    const ctx = makeBaseCtx({
        getPendingOrdersV2: async () => [pendingOrder],
        updateOrderV2: async (id, updates) => { updatedOrders.push({ id, ...updates }) },
        executionPriceFetchers: {
            bitflyer: { getExecutionPrice: async () => ({ price: 9800000, size: 0.01 }) },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(updatedOrders.length, 1)
    assert.equal(updatedOrders[0].status, 'EXECUTED')
    assert.equal(updatedOrders[0].executed_price, 9800000)
    assert.equal(updatedOrders[0].executed_size, 0.01)
    assert.deepEqual(updatedOrders[0].executed_at, new Date('2026-01-01T00:00:00Z'))
})

test('executeTenMinutelyTask: PENDING の IFDOCO 親注文が EXECUTED になったとき exit_sync_status を MONITORING にする', async () => {
    const pendingOrder: any = {
        id: 'v2-pending-ifd-1',
        broker: 'bitflyer',
        ticker: 'FX_BTC_JPY',
        order_type: 'IFDOCO',
        status: 'PENDING',
        provider_order_ids: ['PAR-pending-ifd-1'],
        requested_size: 0.01,
        created_at: new Date('2026-01-01T00:00:00Z'),
    }

    const updatedOrders: any[] = []
    const ctx = makeBaseCtx({
        getPendingOrdersV2: async () => [pendingOrder],
        updateOrderV2: async (id, u) => { updatedOrders.push({ id, ...u }) },
        executionPriceFetchers: {
            bitflyer: { getExecutionPrice: async () => ({ price: 9800000, size: 0.01 }) },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(updatedOrders.length, 1)
    assert.deepEqual(updatedOrders[0], {
        id: 'v2-pending-ifd-1',
        status: 'EXECUTED',
        executed_price: 9800000,
        executed_size: 0.01,
        executed_at: new Date('2026-01-01T00:00:00Z'),
        exit_sync_status: 'MONITORING',
    })
})

test('executeTenMinutelyTask: orders_v2 の実約定時刻を fetcher の値で保存する', async () => {
    const pendingOrder: any = {
        id: 'v2-pending-executed-at-1',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        status: 'PENDING',
        provider_order_ids: ['JRF-v2-executed-at-1'],
        requested_size: 0.01,
        created_at: new Date('2026-01-01T00:00:00Z'),
    }

    const updatedOrders: any[] = []
    const executedAt = new Date('2026-01-01T00:05:00Z')
    const ctx = makeBaseCtx({
        getPendingOrdersV2: async () => [pendingOrder],
        updateOrderV2: async (id, updates) => { updatedOrders.push({ id, ...updates }) },
        executionPriceFetchers: {
            bitflyer: {
                getExecutionPrice: async () => null,
                getExecutionPriceForOrderV2: async () => ({
                    execution: { price: 9810000, size: 0.01, executed_at: executedAt },
                }),
            },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(updatedOrders.length, 1)
    assert.deepEqual(updatedOrders[0].executed_at, executedAt)
})

test('executeTenMinutelyTask: orders_v2 の entry metadata 解決結果を保存する', async () => {
    const pendingOrder: any = {
        id: 'v2-pending-meta-1',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        status: 'PENDING',
        provider_order_ids: ['JRF-v2-meta-1'],
        requested_size: 0.01,
        broker_order_metadata: {
            kind: 'bitflyer_parent_order_v1',
            parent_order_acceptance_id: 'JRF-v2-meta-1',
            order_method: 'IFDOCO',
            entry: {
                expected: { role: 'ENTRY', side: 'BUY', condition_type: 'MARKET', size: 0.01 },
                resolved: { acceptance_id: null },
            },
            exits: [],
        },
    }
    const updatedOrders: any[] = []

    const ctx = makeBaseCtx({
        getPendingOrdersV2: async () => [pendingOrder],
        updateOrderV2: async (id, updates) => { updatedOrders.push({ id, ...updates }) },
        executionPriceFetchers: {
            bitflyer: {
                getExecutionPrice: async () => null,
                getExecutionPriceForOrderV2: async () => ({
                    execution: null,
                    brokerOrderMetadata: {
                        ...pendingOrder.broker_order_metadata,
                        entry: {
                            ...pendingOrder.broker_order_metadata.entry,
                            resolved: { acceptance_id: 'JRF-child-entry-1' },
                        },
                    },
                }),
            },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(updatedOrders.length, 1)
    assert.deepEqual(updatedOrders[0].broker_order_metadata.entry.resolved, { acceptance_id: 'JRF-child-entry-1' })
    assert.equal(updatedOrders[0].status, undefined)
})

test('executeTenMinutelyTask: IFDOCO の決済約定を確認して exit レコードを作成・更新する (部分約定対応)', async () => {
    const order: any = {
        id: 'v2-ifd-partial',
        strategy: 'FX_BTC_JPY',
        broker: 'bitflyer',
        ticker: 'FX_BTC_JPY',
        side: 'BUY',
        order_type: 'IFDOCO',
        status: 'EXECUTED',
        exit_sync_status: 'MONITORING',
        provider_order_ids: ['PAR-ifd-partial'],
        requested_size: 0.01,
        executed_size: 0.01,
        created_at: new Date('2026-01-01T00:00:00Z'),
        executed_at: new Date('2026-01-01T00:01:00Z'),
    }

    // ケース1: 初回作成 (部分約定)
    const addedOrders: any[] = []
    const updatedOrders: any[] = []

    const ctx1 = makeBaseCtx({
        getActiveIfdOrdersV2: async () => [order],
        getOrderV2: async () => null,
        addOrderV2: async (o) => { addedOrders.push(o) },
        updateOrderV2: async (id, u) => { updatedOrders.push({ id, ...u }) },
        closingExecutionFetchers: {
            bitflyer: { getClosingExecution: async () => ({ price: 10500000, size: 0.004 }) },
        },
    })
    await executeTenMinutelyTask(ctx1)
    assert.equal(addedOrders.length, 1)
    assert.equal(addedOrders[0].id, 'v2-ifd-partial-exit')
    assert.equal(addedOrders[0].executed_size, 0.004)
    assert.deepEqual(addedOrders[0].executed_at, new Date('2026-01-01T00:01:00Z'))
    assert.equal('exit_sync_status' in addedOrders[0], false)

    // ケース2: 追加約定
    const existingExit: any = addedOrders[0]
    const addedOrders2: any[] = []
    const updatedOrders2: any[] = []
    const ctx2 = makeBaseCtx({
        getActiveIfdOrdersV2: async () => [order],
        getOrderV2: async (id) => id === 'v2-ifd-partial-exit' ? existingExit : null,
        addOrderV2: async (o) => { addedOrders2.push(o) },
        updateOrderV2: async (id, u) => { updatedOrders2.push({ id, ...u }) },
        closingExecutionFetchers: {
            bitflyer: { getClosingExecution: async () => ({ price: 10600000, size: 0.007 }) },
        },
    })
    await executeTenMinutelyTask(ctx2)
    assert.equal(addedOrders2.length, 0)
    assert.equal(updatedOrders2.length, 1)
    assert.equal(updatedOrders2[0].executed_size, 0.007)
    assert.equal(updatedOrders2[0].executed_price, 10600000)
    assert.deepEqual(updatedOrders2[0].executed_at, new Date('2026-01-01T00:01:00Z'))

    // ケース3: full close で親注文の監視状態を COMPLETED にする
    const updatedOrders3: any[] = []
    const ctx3 = makeBaseCtx({
        getActiveIfdOrdersV2: async () => [order],
        getOrderV2: async (id) => id === 'v2-ifd-partial-exit' ? existingExit : null,
        addOrderV2: async () => { },
        updateOrderV2: async (id, u) => { updatedOrders3.push({ id, ...u }) },
        closingExecutionFetchers: {
            bitflyer: { getClosingExecution: async () => ({ price: 10700000, size: 0.01 }) },
        },
    })
    await executeTenMinutelyTask(ctx3)
    assert.equal(updatedOrders3.length, 2)
    assert.deepEqual(updatedOrders3[0], {
        id: 'v2-ifd-partial-exit',
        executed_size: 0.01,
        executed_price: 10700000,
        executed_at: new Date('2026-01-01T00:01:00Z'),
    })
    assert.deepEqual(updatedOrders3[1], {
        id: 'v2-ifd-partial',
        exit_sync_status: 'COMPLETED',
    })
})

test('executeTenMinutelyTask: IFDOCO の closing.size が requested_size を超えると更新しない', async () => {
    const order: any = {
        id: 'v2-ifd-invalid-size',
        strategy: 'FX_BTC_JPY',
        broker: 'bitflyer',
        ticker: 'FX_BTC_JPY',
        side: 'BUY',
        order_type: 'IFDOCO',
        status: 'EXECUTED',
        exit_sync_status: 'MONITORING',
        provider_order_ids: ['PAR-ifd-invalid-size'],
        requested_size: 0.01,
        executed_size: 0.01,
    }

    const addedOrders: any[] = []
    const updatedOrders: any[] = []

    const ctx = makeBaseCtx({
        getActiveIfdOrdersV2: async () => [order],
        getOrderV2: async () => null,
        addOrderV2: async (o) => { addedOrders.push(o) },
        updateOrderV2: async (id, u) => { updatedOrders.push({ id, ...u }) },
        closingExecutionFetchers: {
            bitflyer: { getClosingExecution: async () => ({ price: 10500000, size: 0.02 }) },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(addedOrders.length, 0)
    assert.equal(updatedOrders.length, 0)
})

test('executeTenMinutelyTask: IFDOCO の close metadata 解決結果を親 orders_v2 に保存する', async () => {
    const order: any = {
        id: 'v2-ifd-meta',
        strategy: 'FX_BTC_JPY',
        broker: 'bitflyer',
        ticker: 'FX_BTC_JPY',
        side: 'BUY',
        order_type: 'IFDOCO',
        status: 'EXECUTED',
        exit_sync_status: 'MONITORING',
        provider_order_ids: ['PAR-ifd-meta'],
        requested_size: 0.01,
        executed_size: 0.01,
        created_at: new Date('2026-01-01T00:00:00Z'),
        executed_at: new Date('2026-01-01T00:01:00Z'),
        broker_order_metadata: {
            kind: 'bitflyer_parent_order_v1',
            parent_order_acceptance_id: 'PAR-ifd-meta',
            order_method: 'IFDOCO',
            entry: {
                expected: { role: 'ENTRY', side: 'BUY', condition_type: 'MARKET', size: 0.01 },
                resolved: { acceptance_id: 'JRF-entry-meta' },
            },
            exits: [
                {
                    expected: { role: 'STOP_LOSS', side: 'SELL', condition_type: 'STOP', size: 0.01, trigger_price: 9500000 },
                    resolved: { acceptance_id: null },
                },
            ],
        },
    }

    const updatedOrders: any[] = []
    const addedOrders: any[] = []

    const ctx = makeBaseCtx({
        getActiveIfdOrdersV2: async () => [order],
        getOrderV2: async () => null,
        addOrderV2: async (o) => { addedOrders.push(o) },
        updateOrderV2: async (id, updates) => { updatedOrders.push({ id, ...updates }) },
        closingExecutionFetchers: {
            bitflyer: {
                getClosingExecution: async () => null,
                getClosingExecutionForOrderV2: async () => ({
                    execution: { price: 10500000, size: 0.01, executed_at: new Date('2026-01-01T00:30:00Z') },
                    brokerOrderMetadata: {
                        ...order.broker_order_metadata,
                        exits: [
                            {
                                ...order.broker_order_metadata.exits[0],
                                resolved: { acceptance_id: 'JRF-stop-meta' },
                            },
                        ],
                    },
                }),
            },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(updatedOrders.length, 2)
    assert.deepEqual(updatedOrders[0].broker_order_metadata.exits[0].resolved, { acceptance_id: 'JRF-stop-meta' })
    assert.deepEqual(updatedOrders[1], { id: 'v2-ifd-meta', exit_sync_status: 'COMPLETED' })
    assert.equal(addedOrders.length, 1)
    assert.deepEqual(addedOrders[0].executed_at, new Date('2026-01-01T00:30:00Z'))
})

test('executeTenMinutelyTask: Saxo の closingExecutionFetcher で exit レコードを作成する', async () => {
    const order: any = {
        id: 'v2-saxo-ifd',
        strategy: 'saxo-strategy',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'BUY',
        order_type: 'IFDOCO',
        status: 'EXECUTED',
        exit_sync_status: 'MONITORING',
        provider_order_ids: ['ORD-saxo-entry'],
        requested_size: 1,
        executed_size: 1,
        created_at: new Date('2026-01-01T00:00:00Z'),
        executed_at: new Date('2026-01-01T00:01:00Z'),
    }

    const addedOrders: any[] = []
    const updatedOrders: any[] = []

    const ctx = makeBaseCtx({
        getActiveIfdOrdersV2: async () => [order],
        getOrderV2: async () => null,
        addOrderV2: async (o) => { addedOrders.push(o) },
        updateOrderV2: async (id, u) => { updatedOrders.push({ id, ...u }) },
        closingExecutionFetchers: {
            saxo: { getClosingExecution: async () => ({ price: 105, size: 1 }) },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(addedOrders.length, 1)
    assert.equal(addedOrders[0].id, 'v2-saxo-ifd-exit')
    assert.equal(addedOrders[0].broker, 'saxo')
    assert.equal(addedOrders[0].executed_price, 105)
    assert.deepEqual(updatedOrders[0], { id: 'v2-saxo-ifd', exit_sync_status: 'COMPLETED' })
})
