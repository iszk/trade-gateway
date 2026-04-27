import assert from 'node:assert/strict'
import test from 'node:test'

import { executeTenMinutelyTask } from './cron-tasks.js'
import type { CronContext } from './cron-tasks.js'
import type { OpenTrade, PendingExecutionOpenTrade } from './trade-records.js'
import type { ConfirmedUnpromotedLog } from './order-dispatch-logs.js'

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

const makeConfirmedUnpromotedLog = (overrides: Partial<ConfirmedUnpromotedLog> & { side: 'BUY' | 'SELL' }): ConfirmedUnpromotedLog => ({
    docId: `doc-${Math.random()}`,
    event_id: `evt-${Math.random()}`,
    broker: 'bitflyer',
    ticker: 'BTC_JPY',
    size: 0.01,
    strategy: 'MA',
    interval: '4H',
    execution_price: 10000000,
    created_at: new Date('2026-01-01'),
    ...overrides,
})

const makeBaseCtx = (overrides: Partial<CronContext> = {}): CronContext => ({
    logger: makeLogger().logger,
    positionFetcher: makePositionFetcherStub(),
    getConfirmedUnpromotedLogs: async () => [],
    markOpenTradesWritten: async () => { },
    getOpenTrades: async () => [],
    addOpenTrade: async () => { },
    deleteOpenTrade: async () => { },
    createTradeRecord: async () => { },
    ...overrides,
})

// ─────────────── promoteConfirmedLogsToOpenTrades ───────────────

test('executeTenMinutelyTask: confirmed logs を open_trades に追加し markOpenTradesWritten を呼ぶ', async () => {
    const confirmedLog = makeConfirmedUnpromotedLog({ side: 'BUY', docId: 'doc-1', event_id: 'evt-1' })
    const addedTrades: OpenTrade[] = []
    const markedDocIds: string[] = []

    const ctx = makeBaseCtx({
        getConfirmedUnpromotedLogs: async () => [confirmedLog],
        markOpenTradesWritten: async (docId) => { markedDocIds.push(docId) },
        addOpenTrade: async (trade) => { addedTrades.push(trade) },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(addedTrades.length, 1)
    assert.equal(addedTrades[0]?.event_id, 'evt-1')
    assert.deepEqual(markedDocIds, ['doc-1'])
})

test('executeTenMinutelyTask: confirmed logs がゼロのとき何も追加しない', async () => {
    const addedTrades: OpenTrade[] = []

    const ctx = makeBaseCtx({
        getConfirmedUnpromotedLogs: async () => [],
        addOpenTrade: async (trade) => { addedTrades.push(trade) },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(addedTrades.length, 0)
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

test('executeTenMinutelyTask: open_trades フローは全 fn が揃っていないと実行されない', async () => {
    const { logger } = makeLogger()
    let called = false

    // 全fnが揁わっていない CronContext
    const ctx: CronContext = {
        logger,
        positionFetcher: makePositionFetcherStub(),
        // getConfirmedUnpromotedLogs は省略
        markOpenTradesWritten: async () => { },
        getOpenTrades: async () => { called = true; return [] },
        addOpenTrade: async () => { },
        deleteOpenTrade: async () => { },
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
            bitflyer: { getExecutionPrice: async () => 9500000 },
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
