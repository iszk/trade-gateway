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
            bitflyer: { getClosingExecution: async () => ({ price: 11000000 }) },
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
            bitflyer: { getClosingExecution: async () => ({ price: 10000000 }) },
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
