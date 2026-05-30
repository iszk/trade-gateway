import assert from 'node:assert/strict'
import test from 'node:test'

import { executeTenMinutelyTask } from './cron-tasks.js'
import type { CronContext } from './cron-tasks.js'
import type { ConfirmedIfdOpenTrade } from './trade-records.js'
import type { OpenTrade, PendingExecutionOpenTrade } from './trade-records.js'

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

const makeOpenTrade = (overrides: Partial<OpenTrade> & { side: 'BUY' | 'SELL' }): OpenTrade => ({
    event_id: `evt-${Math.random()}`,
    broker: 'bitflyer',
    ticker: 'BTC_JPY',
    size: 0.01,
    strategy: 'MA',
    interval: '4H',
    execution_price: 10000000,
    created_at: new Date('2026-01-01'),
    order_dispatch_log_id: `doc-${Math.random()}`,
    ...overrides,
})

const makeBaseCtx = (overrides: Partial<CronContext> = {}): CronContext => ({
    logger: makeLogger().logger,
    positionFetcher: makePositionFetcherStub(),
    getOpenTrades: async () => [],
    deleteOpenTrade: async () => { },
    createTradeRecord: async () => { },
    ...overrides,
})

// ─────────────── matchAndRecordOpenTrades ───────────────

test('executeTenMinutelyTask: BUY/SELL がマッチしたとき trade_records を作成して open_trades から削除する', async () => {
    const buy = makeOpenTrade({ side: 'BUY', event_id: 'evt-buy', execution_price: 10000000, created_at: new Date('2026-01-01') })
    const sell = makeOpenTrade({ side: 'SELL', event_id: 'evt-sell', execution_price: 11000000, created_at: new Date('2026-01-02') })

    const createdRecords: unknown[] = []
    const deletedEventIds: string[] = []

    const ctx = makeBaseCtx({
        getOpenTrades: async () => [buy, sell],
        deleteOpenTrade: async (eventId) => { deletedEventIds.push(eventId) },
        createTradeRecord: async (record) => { createdRecords.push(record) },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(createdRecords.length, 1)
    assert.equal(deletedEventIds.length, 2)
    assert.ok(deletedEventIds.includes('evt-buy'))
    assert.ok(deletedEventIds.includes('evt-sell'))
})

test('executeTenMinutelyTask: 同一方向のみで open_trades がいっぱいのとき何もマッチしない', async () => {
    const buy1 = makeOpenTrade({ side: 'BUY', event_id: 'evt-1' })
    const buy2 = makeOpenTrade({ side: 'BUY', event_id: 'evt-2' })

    const createdRecords: unknown[] = []

    const ctx = makeBaseCtx({
        getOpenTrades: async () => [buy1, buy2],
        createTradeRecord: async (record) => { createdRecords.push(record) },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(createdRecords.length, 0)
})

test('executeTenMinutelyTask: getOpenTrades がないとき matchAndRecord は実行されない', async () => {
    const { logger } = makeLogger()
    let called = false

    // getOpenTrades は省略
    const ctx: CronContext = {
        logger,
        positionFetcher: makePositionFetcherStub(),
        deleteOpenTrade: async () => { called = true },
        createTradeRecord: async () => { },
    }

    await executeTenMinutelyTask(ctx)

    assert.equal(called, false)
})

// ─────────────── 新フロー: open_trades の execution_price 更新 ───────────────

test('executeTenMinutelyTask: getPendingExecutionOpenTrades から execution_price を取得して open_trades を更新する', async () => {
    const pendingTrade: PendingExecutionOpenTrade = {
        event_id: 'evt-pending-1',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        provider_order_id: 'JRF-1',
    }
    const updatedTrades: { eventId: string; price: number }[] = []

    const ctx = makeBaseCtx({
        getPendingExecutionOpenTrades: async () => [pendingTrade],
        updateOpenTradeExecutionPrice: async (eventId, price) => { updatedTrades.push({ eventId, price }) },
        executionPriceFetchers: {
            bitflyer: { getExecutionPrice: async () => ({ price: 9500000, size: 0.01 }) },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(updatedTrades.length, 1)
    assert.equal(updatedTrades[0]?.eventId, 'evt-pending-1')
    assert.equal(updatedTrades[0]?.price, 9500000)
})

test('executeTenMinutelyTask: open_trades の execution_price が null を返すとき更新しない', async () => {
    const pendingTrade: PendingExecutionOpenTrade = {
        event_id: 'evt-pending-2',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        provider_order_id: 'JRF-2',
    }
    const updatedTrades: unknown[] = []

    const ctx = makeBaseCtx({
        getPendingExecutionOpenTrades: async () => [pendingTrade],
        updateOpenTradeExecutionPrice: async (eventId, price) => { updatedTrades.push({ eventId, price }) },
        executionPriceFetchers: {
            bitflyer: { getExecutionPrice: async () => null },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(updatedTrades.length, 0)
})

// ─────────────── IFD/IFDOCO: resolveIfdLikeTrades ───────────────

const makeConfirmedIfdTrade = (overrides: Partial<ConfirmedIfdOpenTrade> & { side: 'BUY' | 'SELL' }): ConfirmedIfdOpenTrade => ({
    event_id: `evt-ifd-${Math.random()}`,
    broker: 'bitflyer',
    ticker: 'FX_BTC_JPY',
    size: 0.01,
    strategy: 'MA',
    interval: '4H',
    execution_price: 10000000,
    created_at: new Date('2026-01-01'),
    provider_order_id: `PAR-${Math.random()}`,
    order_method: 'IFDOCO',
    ...overrides,
})

test('executeTenMinutelyTask: IFD/IFDOCO の決済約定が確認できたとき trade_record を作成して open_trade を削除する', async () => {
    const trade = makeConfirmedIfdTrade({
        side: 'BUY',
        event_id: 'evt-ifd-1',
        execution_price: 10000000,
        size: 0.01,
    })

    const createdRecords: unknown[] = []
    const deletedEventIds: string[] = []

    const ctx = makeBaseCtx({
        getConfirmedIfdOpenTrades: async () => [trade],
        closingExecutionFetchers: {
            bitflyer: { getClosingExecution: async () => ({ price: 11000000, size: 0.01 }) },
        },
        deleteOpenTrade: async (id) => { deletedEventIds.push(id) },
        createTradeRecord: async (r) => { createdRecords.push(r) },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(createdRecords.length, 1)
    const record = createdRecords[0] as Record<string, unknown>
    assert.equal(record.entry_price, 10000000)
    assert.equal(record.exit_price, 11000000)
    assert.ok(Math.abs((record.pnl as number) - 10000) < 0.001) // (11000000 - 10000000) * 0.01
    assert.equal(deletedEventIds.length, 1)
    assert.ok(deletedEventIds.includes('evt-ifd-1'))
})

test('executeTenMinutelyTask: IFD/IFDOCO の決済約定がまだのとき何もしない', async () => {
    const trade = makeConfirmedIfdTrade({ side: 'BUY', event_id: 'evt-ifd-2' })

    const createdRecords: unknown[] = []
    const deletedEventIds: string[] = []

    const ctx = makeBaseCtx({
        getConfirmedIfdOpenTrades: async () => [trade],
        closingExecutionFetchers: {
            bitflyer: { getClosingExecution: async () => null },
        },
        deleteOpenTrade: async (id) => { deletedEventIds.push(id) },
        createTradeRecord: async (r) => { createdRecords.push(r) },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(createdRecords.length, 0)
    assert.equal(deletedEventIds.length, 0)
})

test('executeTenMinutelyTask: IFD ショートの PnL を正しく計算する', async () => {
    const trade = makeConfirmedIfdTrade({
        side: 'SELL',
        event_id: 'evt-ifd-short',
        execution_price: 11000000,
        size: 0.01,
        order_method: 'IFD',
    })

    const createdRecords: unknown[] = []

    const ctx = makeBaseCtx({
        getConfirmedIfdOpenTrades: async () => [trade],
        closingExecutionFetchers: {
            bitflyer: { getClosingExecution: async () => ({ price: 10000000, size: 0.01 }) },
        },
        createTradeRecord: async (r) => { createdRecords.push(r) },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(createdRecords.length, 1)
    const record = createdRecords[0] as Record<string, unknown>
    assert.equal(record.entry_side, 'SELL')
    assert.ok(Math.abs((record.pnl as number) - 10000) < 0.001) // (11000000 - 10000000) * 0.01
})

test('executeTenMinutelyTask: getConfirmedIfdOpenTrades が未設定のとき IFD 解決は実行されない', async () => {
    let closingFetcherCalled = false

    const ctx = makeBaseCtx({
        closingExecutionFetchers: {
            bitflyer: {
                getClosingExecution: async () => {
                    closingFetcherCalled = true
                    return null
                },
            },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(closingFetcherCalled, false)
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
        exit_sync_status: 'MONITORING',
    })
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
                    execution: { price: 10500000, size: 0.01 },
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
})
