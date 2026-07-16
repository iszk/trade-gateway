import assert from 'node:assert/strict'
import test from 'node:test'

import { applyOrderExecutionSyncResult, executeTenMinutelyTask } from './cron-tasks.js'
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
            bitflyer: { getExecutionPriceForOrderV2: async () => ({ execution: { price: 9800000, size: 0.01 } }) },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(updatedOrders.length, 1)
    assert.equal(updatedOrders[0].status, 'EXECUTED')
    assert.equal(updatedOrders[0].executed_price, 9800000)
    assert.equal(updatedOrders[0].executed_size, 0.01)
    assert.deepEqual(updatedOrders[0].executed_at, new Date('2026-01-01T00:00:00Z'))
})

test('executeTenMinutelyTask: entry の部分約定を PENDING のまま累積同期し、再取得では no-op にする', async () => {
    const createdAt = new Date('2026-01-01T00:00:00Z')
    const partialAt = new Date('2026-01-01T00:05:00Z')
    const fullAt = new Date('2026-01-01T00:10:00Z')
    const partialOrder: any = {
        id: 'v2-entry-partial',
        broker: 'bitflyer',
        ticker: 'FX_BTC_JPY',
        status: 'PENDING',
        provider_order_ids: ['JRF-entry-partial'],
        requested_size: 0.01,
        executed_size: 0,
        executed_price: null,
        created_at: createdAt,
        updated_at: createdAt,
    }
    const partialUpdates: any[] = []
    const partialCtx = makeBaseCtx({
        getPendingOrdersV2: async () => [partialOrder],
        updateOrderV2: async (id, updates) => { partialUpdates.push({ id, ...updates }) },
        executionPriceFetchers: {
            bitflyer: {
                getExecutionPriceForOrderV2: async () => ({
                    execution: { price: 9800000, size: 0.004, executed_at: partialAt, commission: 0 },
                }),
            },
        },
    })

    await executeTenMinutelyTask(partialCtx)

    assert.deepEqual(partialUpdates, [{
        id: 'v2-entry-partial',
        executed_price: 9800000,
        executed_size: 0.004,
        executed_at: partialAt,
        execution_costs: { commission: 0 },
    }])

    const fullOrder = {
        ...partialOrder,
        executed_size: 0.004,
        executed_price: 9800000,
        executed_at: partialAt,
        execution_costs: { commission: 0 },
    }
    const fullUpdates: any[] = []
    const fullCtx = makeBaseCtx({
        getPendingOrdersV2: async () => [fullOrder],
        updateOrderV2: async (id, updates) => { fullUpdates.push({ id, ...updates }) },
        executionPriceFetchers: {
            bitflyer: {
                getExecutionPriceForOrderV2: async () => ({
                    execution: { price: 9810000, size: 0.01, executed_at: fullAt, commission: -0.0001 },
                }),
            },
        },
    })

    await executeTenMinutelyTask(fullCtx)

    assert.deepEqual(fullUpdates, [{
        id: 'v2-entry-partial',
        status: 'EXECUTED',
        executed_price: 9810000,
        executed_size: 0.01,
        executed_at: fullAt,
        execution_costs: { commission: -0.0001 },
    }])

    const noOpUpdates: any[] = []
    const noOpCtx = makeBaseCtx({
        getPendingOrdersV2: async () => [{
            ...fullOrder,
            status: 'EXECUTED',
            executed_size: 0.01,
            executed_price: 9810000,
            executed_at: fullAt,
            execution_costs: { commission: -0.0001 },
        }],
        updateOrderV2: async (id, updates) => { noOpUpdates.push({ id, ...updates }) },
        executionPriceFetchers: {
            bitflyer: {
                getExecutionPriceForOrderV2: async () => ({
                    execution: { price: 9810000, size: 0.01, executed_at: fullAt, commission: -0.0001 },
                }),
            },
        },
    })

    await executeTenMinutelyTask(noOpCtx)

    assert.equal(noOpUpdates.length, 0)
})

test('executeTenMinutelyTask: entry の overfill は保存しない', async () => {
    const updatedOrders: any[] = []
    const ctx = makeBaseCtx({
        getPendingOrdersV2: async () => [{
            id: 'v2-entry-overfill',
            broker: 'bitflyer',
            ticker: 'FX_BTC_JPY',
            status: 'PENDING',
            provider_order_ids: ['JRF-entry-overfill'],
            requested_size: 0.01,
            executed_size: 0,
            executed_price: null,
            created_at: new Date('2026-01-01T00:00:00Z'),
        } as any],
        updateOrderV2: async (id, updates) => { updatedOrders.push({ id, ...updates }) },
        executionPriceFetchers: {
            bitflyer: {
                getExecutionPriceForOrderV2: async () => ({ execution: { price: 9800000, size: 0.01000002, commission: 0 } }),
            },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(updatedOrders.length, 0)
})

const makeApplyOrder = (overrides: Record<string, unknown> = {}): any => ({
    id: 'v2-apply-order',
    strategy: 'test',
    broker: 'saxo',
    ticker: 'FxSpot:21',
    side: 'BUY',
    order_type: 'MARKET',
    requested_size: 1,
    executed_size: 0,
    executed_price: null,
    status: 'PENDING',
    provider_order_ids: ['ORD-apply-order'],
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
})

test('applyOrderExecutionSyncResult: terminal status と execution snapshot を優先順位どおり適用する', async () => {
    const cases = [
        {
            name: '全量約定',
            result: { execution: { price: 101, size: 1, executed_at: new Date('2026-01-01T00:01:00Z') } },
            expected: { status: 'EXECUTED', executed_price: 101, executed_size: 1, executed_at: new Date('2026-01-01T00:01:00Z') },
        },
        {
            name: '部分約定',
            result: { execution: { price: 100, size: 0.4, commission: 0 } },
            expected: { executed_price: 100, executed_size: 0.4, executed_at: new Date('2026-01-01T00:00:00Z'), execution_costs: { commission: 0 } },
        },
        {
            name: '部分約定後の取消',
            result: { execution: { price: 100, size: 0.4 }, terminalStatus: 'CANCELED' as const },
            expected: { status: 'CANCELED', executed_price: 100, executed_size: 0.4, executed_at: new Date('2026-01-01T00:00:00Z') },
        },
        {
            name: '未約定取消',
            result: { execution: null, terminalStatus: 'CANCELED' as const },
            expected: { status: 'CANCELED' },
        },
        {
            name: '失効',
            result: { execution: null, terminalStatus: 'CANCELED' as const },
            expected: { status: 'CANCELED' },
        },
        {
            name: '発注拒否',
            result: { execution: null, terminalStatus: 'FAILED' as const },
            expected: { status: 'FAILED' },
        },
        {
            name: 'cancel rejected は継続',
            result: { execution: null },
            expected: {},
        },
        {
            name: 'DoneForDay は継続',
            result: { execution: null },
            expected: {},
        },
    ]

    for (const testCase of cases) {
        const updates: any[] = []
        const changed = await applyOrderExecutionSyncResult(
            makeApplyOrder(),
            testCase.result,
            async (id, update) => { updates.push({ id, ...update }) },
        )
        assert.equal(changed, Object.keys(testCase.expected).length > 0, testCase.name)
        assert.deepEqual(updates[0], Object.keys(testCase.expected).length > 0
            ? { id: 'v2-apply-order', ...testCase.expected }
            : undefined, testCase.name)
    }
})

test('applyOrderExecutionSyncResult: 同一 snapshot と overfill は no-op にする', async () => {
    const order = makeApplyOrder({
        status: 'EXECUTED',
        executed_size: 1,
        executed_price: 101,
        executed_at: new Date('2026-01-01T00:01:00Z'),
    })
    const updates: any[] = []

    const unchanged = await applyOrderExecutionSyncResult(
        order,
        { execution: { price: 101, size: 1, executed_at: new Date('2026-01-01T00:01:00Z') } },
        async (id, update) => { updates.push({ id, ...update }) },
    )
    const overfilled = await applyOrderExecutionSyncResult(
        makeApplyOrder(),
        { execution: { price: 101, size: 1.00000002 } },
        async (id, update) => { updates.push({ id, ...update }) },
    )

    assert.equal(unchanged, false)
    assert.equal(overfilled, false)
    assert.equal(updates.length, 0)
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
            bitflyer: { getExecutionPriceForOrderV2: async () => ({ execution: { price: 9800000, size: 0.01 } }) },
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

test('executeTenMinutelyTask: entry metadata はキー順だけが異なる場合に no-op にする', async () => {
    const metadata: any = {
        kind: 'bitflyer_parent_order_v1',
        parent_order_acceptance_id: 'JRF-v2-pending-meta-order',
        order_method: 'IFDOCO',
        entry: {
            expected: { role: 'ENTRY', side: 'BUY', condition_type: 'MARKET', size: 0.01 },
            resolved: { acceptance_id: 'JRF-entry-order' },
        },
        exits: [],
    }
    const reorderedMetadata: any = {
        exits: [],
        entry: {
            resolved: { acceptance_id: 'JRF-entry-order' },
            expected: { size: 0.01, condition_type: 'MARKET', side: 'BUY', role: 'ENTRY' },
        },
        order_method: 'IFDOCO',
        parent_order_acceptance_id: 'JRF-v2-pending-meta-order',
        kind: 'bitflyer_parent_order_v1',
    }
    const updatedOrders: any[] = []
    const ctx = makeBaseCtx({
        getPendingOrdersV2: async () => [{
            id: 'v2-pending-meta-order',
            strategy: 'MA',
            broker: 'bitflyer',
            ticker: 'FX_BTC_JPY',
            side: 'BUY',
            order_type: 'IFDOCO',
            requested_size: 0.01,
            executed_size: 0,
            executed_price: null,
            status: 'PENDING',
            provider_order_ids: ['JRF-v2-pending-meta-order'],
            broker_order_metadata: metadata,
            created_at: new Date('2026-01-01T00:00:00Z'),
            updated_at: new Date('2026-01-01T00:00:00Z'),
        }],
        updateOrderV2: async (id, updates) => { updatedOrders.push({ id, ...updates }) },
        executionPriceFetchers: {
            bitflyer: {
                getExecutionPriceForOrderV2: async () => ({
                    execution: null,
                    brokerOrderMetadata: reorderedMetadata,
                }),
            },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(updatedOrders.length, 0)
})

test('executeTenMinutelyTask: 古い Saxo PENDING 注文は約定同期をスキップする', async () => {
    const oldPendingOrder: any = {
        id: 'v2-saxo-stale-pending',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        order_type: 'MARKET',
        status: 'PENDING',
        provider_order_ids: ['ORD-stale-pending'],
        requested_size: 1000,
        created_at: new Date(Date.now() - 25 * 60 * 60 * 1000),
    }
    let fetchCount = 0
    const updatedOrders: any[] = []

    const ctx = makeBaseCtx({
        getPendingOrdersV2: async () => [oldPendingOrder],
        updateOrderV2: async (id, updates) => { updatedOrders.push({ id, ...updates }) },
        executionPriceFetchers: {
            saxo: {
                getExecutionPriceForOrderV2: async () => {
                    fetchCount += 1
                    return { execution: { price: 101.5, size: 1000 } }
                },
            },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(fetchCount, 0)
    assert.equal(updatedOrders.length, 0)
})

test('executeTenMinutelyTask: Saxo PENDING 注文の約定同期は10件を超えてもスキップしない', async () => {
    const pendingOrders = Array.from({ length: 12 }, (_, index) => ({
        id: `v2-saxo-pending-${index}`,
        broker: 'saxo',
        ticker: 'FxSpot:21',
        order_type: 'MARKET',
        status: 'PENDING',
        provider_order_ids: [`ORD-saxo-pending-${index}`],
        requested_size: 1000,
        created_at: new Date(),
    } as any))
    let fetchCount = 0

    const ctx = makeBaseCtx({
        getPendingOrdersV2: async () => pendingOrders,
        updateOrderV2: async () => { },
        executionPriceFetchers: {
            saxo: {
                getExecutionPriceForOrderV2: async () => {
                    fetchCount += 1
                    return { execution: null }
                },
            },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(fetchCount, 12)
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
            bitflyer: { getClosingExecutionForOrderV2: async () => ({ execution: { price: 10500000, size: 0.004, commission: 0 } }) },
        },
    })
    await executeTenMinutelyTask(ctx1)
    assert.equal(addedOrders.length, 1)
    assert.equal(addedOrders[0].id, 'v2-ifd-partial-exit')
    assert.equal(addedOrders[0].executed_size, 0.004)
    assert.deepEqual(addedOrders[0].execution_costs, { commission: 0 })
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
            bitflyer: { getClosingExecutionForOrderV2: async () => ({ execution: { price: 10600000, size: 0.007, commission: 0.0002 } }) },
        },
    })
    await executeTenMinutelyTask(ctx2)
    assert.equal(addedOrders2.length, 0)
    assert.equal(updatedOrders2.length, 1)
    assert.equal(updatedOrders2[0].executed_size, 0.007)
    assert.equal(updatedOrders2[0].executed_price, 10600000)
    assert.deepEqual(updatedOrders2[0].execution_costs, { commission: 0.0002 })
    assert.deepEqual(updatedOrders2[0].executed_at, new Date('2026-01-01T00:01:00Z'))

    // ケース2.5: 同一 snapshot の再取得は no-op
    const noOpUpdates: any[] = []
    const noOpExistingExit = {
        ...existingExit,
        executed_at: new Date('2026-01-01T00:02:00Z'),
    }
    const noOpCtx = makeBaseCtx({
        getActiveIfdOrdersV2: async () => [order],
        getOrderV2: async (id) => id === 'v2-ifd-partial-exit' ? noOpExistingExit : null,
        addOrderV2: async () => { },
        updateOrderV2: async (id, u) => { noOpUpdates.push({ id, ...u }) },
        closingExecutionFetchers: {
            bitflyer: { getClosingExecutionForOrderV2: async () => ({ execution: { price: 10500000, size: 0.004, commission: 0 } }) },
        },
    })
    await executeTenMinutelyTask(noOpCtx)
    assert.equal(noOpUpdates.length, 0)

    // ケース3: full close で親注文の監視状態を COMPLETED にする
    const updatedOrders3: any[] = []
    const ctx3 = makeBaseCtx({
        getActiveIfdOrdersV2: async () => [order],
        getOrderV2: async (id) => id === 'v2-ifd-partial-exit' ? existingExit : null,
        addOrderV2: async () => { },
        updateOrderV2: async (id, u) => { updatedOrders3.push({ id, ...u }) },
        closingExecutionFetchers: {
            bitflyer: { getClosingExecutionForOrderV2: async () => ({ execution: { price: 10700000, size: 0.01, commission: 0.0003 } }) },
        },
    })
    await executeTenMinutelyTask(ctx3)
    assert.equal(updatedOrders3.length, 2)
    assert.deepEqual(updatedOrders3[0], {
        id: 'v2-ifd-partial-exit',
        executed_size: 0.01,
        executed_price: 10700000,
        executed_at: new Date('2026-01-01T00:01:00Z'),
        execution_costs: { commission: 0.0003 },
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
            bitflyer: { getClosingExecutionForOrderV2: async () => ({ execution: { price: 10500000, size: 0.02 } }) },
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
    assert.equal('execution_costs' in addedOrders[0], false)
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
            saxo: { getClosingExecutionForOrderV2: async () => ({ execution: { price: 105, size: 1 } }) },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(addedOrders.length, 1)
    assert.equal(addedOrders[0].id, 'v2-saxo-ifd-exit')
    assert.equal(addedOrders[0].broker, 'saxo')
    assert.equal(addedOrders[0].executed_price, 105)
    assert.deepEqual(updatedOrders[0], { id: 'v2-saxo-ifd', exit_sync_status: 'COMPLETED' })
})

test('executeTenMinutelyTask: Saxo exit 同期は10件を超えてもスキップしない', async () => {
    const orders = Array.from({ length: 12 }, (_, index) => ({
        id: `v2-saxo-ifd-limit-${index}`,
        strategy: 'saxo-strategy',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'BUY',
        order_type: 'IFDOCO',
        status: 'EXECUTED',
        exit_sync_status: 'MONITORING',
        provider_order_ids: [`ORD-saxo-entry-${index}`],
        requested_size: 1,
        executed_size: 1,
        created_at: new Date('2026-01-01T00:00:00Z'),
        executed_at: new Date('2026-01-01T00:01:00Z'),
    } as any))
    let fetchCount = 0

    const ctx = makeBaseCtx({
        getActiveIfdOrdersV2: async () => orders,
        getOrderV2: async () => null,
        addOrderV2: async () => { },
        updateOrderV2: async () => { },
        closingExecutionFetchers: {
            saxo: {
                getClosingExecutionForOrderV2: async () => {
                    fetchCount += 1
                    return { execution: null }
                },
            },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(fetchCount, 12)
})
