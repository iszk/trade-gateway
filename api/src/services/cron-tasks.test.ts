import assert from 'node:assert/strict'
import test from 'node:test'

import { executeTenMinutelyTask } from './cron-tasks.js'
import type { CronContext } from './cron-tasks.js'
import type { OrderExecution } from '../types/execution.js'
import type { PendingDispatchLog } from './order-dispatch-logs.js'

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

const makeExecution = (overrides: Partial<OrderExecution> & { side: 'BUY' | 'SELL' }): OrderExecution => ({
    id: `exec-${Math.random().toString(36).slice(2)}`,
    strategy: 'MA',
    symbol: 'BTC_JPY',
    interval: '4H',
    broker: 'bitflyer',
    size: 0.01,
    price: 10_000_000,
    executed_at: new Date('2026-01-01'),
    ...overrides,
})

const makeBaseCtx = (overrides: Partial<CronContext> = {}): CronContext => ({
    logger: makeLogger().logger,
    positionFetcher: makePositionFetcherStub(),
    ...overrides,
})

// ─────────────── Step 1: confirmPendingExecutions ───────────────

test('executeTenMinutelyTask: pending dispatch_log の約定価格が確認できたとき order_execution を作成して confirmed に更新する', async () => {
    const pendingLog: PendingDispatchLog = {
        docId: 'log-doc-1',
        event_id: 'evt-1',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        size: 0.01,
        strategy: 'MA',
        interval: '4H',
        provider_order_id: 'JRF-1',
    }

    const addedExecutions: OrderExecution[] = []
    const confirmedDocIds: string[] = []

    const ctx = makeBaseCtx({
        getPendingDispatchLogs: async () => [pendingLog],
        confirmDispatchLog: async (docId) => { confirmedDocIds.push(docId) },
        addOrderExecution: async (e) => { addedExecutions.push(e) },
        executionPriceFetchers: {
            bitflyer: { getExecutionPrice: async () => ({ price: 9_500_000, executed_at: new Date('2026-01-01T10:00:00Z') }) },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(addedExecutions.length, 1)
    assert.equal(addedExecutions[0]!.id, 'evt-1')
    assert.equal(addedExecutions[0]!.price, 9_500_000)
    assert.deepEqual(addedExecutions[0]!.executed_at, new Date('2026-01-01T10:00:00Z'))
    assert.equal(confirmedDocIds.length, 1)
    assert.equal(confirmedDocIds[0], 'log-doc-1')
})

test('executeTenMinutelyTask: 約定価格が null のとき order_execution を作成しない', async () => {
    const pendingLog: PendingDispatchLog = {
        docId: 'log-doc-2',
        event_id: 'evt-2',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        size: 0.01,
        strategy: 'MA',
        interval: '4H',
        provider_order_id: 'JRF-2',
    }

    const addedExecutions: OrderExecution[] = []

    const ctx = makeBaseCtx({
        getPendingDispatchLogs: async () => [pendingLog],
        confirmDispatchLog: async () => { },
        addOrderExecution: async (e) => { addedExecutions.push(e) },
        executionPriceFetchers: {
            bitflyer: { getExecutionPrice: async () => null },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(addedExecutions.length, 0)
})

// ─────────────── Step 2: confirmIfdocoExits ───────────────

test('executeTenMinutelyTask: IFDOCO エントリーの決済約定が確認できたとき exit の order_execution を作成する', async () => {
    const entry = makeExecution({ id: 'entry-1', side: 'BUY', provider_order_id: 'prov-1' })

    const addedExecutions: OrderExecution[] = []

    const ctx = makeBaseCtx({
        getIfdocoEntries: async () => [entry],
        addOrderExecution: async (e) => { addedExecutions.push(e) },
        closingExecutionFetchers: {
            bitflyer: { getClosingExecution: async () => ({ price: 11_000_000, executed_at: new Date('2026-01-02T10:00:00Z') }) },
        },
    })

    await executeTenMinutelyTask(ctx)

    const exits = addedExecutions.filter((e) => e.entry_id === 'entry-1')
    assert.equal(exits.length, 1)
    assert.equal(exits[0]!.side, 'SELL')
    assert.equal(exits[0]!.price, 11_000_000)
    assert.deepEqual(exits[0]!.executed_at, new Date('2026-01-02T10:00:00Z'))
    assert.equal(exits[0]!.entry_id, 'entry-1')
})

test('executeTenMinutelyTask: IFDOCO 決済約定がまだのとき exit を作成しない', async () => {
    const entry = makeExecution({ id: 'entry-2', side: 'BUY', provider_order_id: 'prov-2' })

    const addedExecutions: OrderExecution[] = []

    const ctx = makeBaseCtx({
        getIfdocoEntries: async () => [entry],
        addOrderExecution: async (e) => { addedExecutions.push(e) },
        closingExecutionFetchers: {
            bitflyer: { getClosingExecution: async () => null },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(addedExecutions.length, 0)
})

// ─────────────── Step 3: matchAndSaveTrades (market) ───────────────

test('executeTenMinutelyTask: BUY/SELL がマッチしたとき trade を保存して order_executions を削除する', async () => {
    const buy = makeExecution({ id: 'buy-1', side: 'BUY', price: 10_000_000, executed_at: new Date('2026-01-01') })
    const sell = makeExecution({ id: 'sell-1', side: 'SELL', price: 11_000_000, executed_at: new Date('2026-01-02') })

    const savedTrades: unknown[] = []
    const deletedIds: string[] = []

    const ctx = makeBaseCtx({
        getMarketOrderExecutions: async () => [buy, sell],
        getIfdocoEntries: async () => [],
        getIfdocoExits: async () => [],
        deleteOrderExecution: async (id) => { deletedIds.push(id) },
        addTrade: async (t) => { savedTrades.push(t) },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(savedTrades.length, 1)
    const trade = savedTrades[0] as Record<string, unknown>
    assert.equal(trade.entry_side, 'BUY')
    assert.ok(Math.abs((trade.pnl as number) - 10_000) < 0.001)
    assert.equal(deletedIds.length, 2)
    assert.ok(deletedIds.includes('buy-1'))
    assert.ok(deletedIds.includes('sell-1'))
})

test('executeTenMinutelyTask: 同一方向のみで何もマッチしない', async () => {
    const buy1 = makeExecution({ id: 'buy-1', side: 'BUY' })
    const buy2 = makeExecution({ id: 'buy-2', side: 'BUY' })

    const savedTrades: unknown[] = []

    const ctx = makeBaseCtx({
        getMarketOrderExecutions: async () => [buy1, buy2],
        getIfdocoEntries: async () => [],
        getIfdocoExits: async () => [],
        deleteOrderExecution: async () => { },
        addTrade: async (t) => { savedTrades.push(t) },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(savedTrades.length, 0)
})

// ─────────────── Step 3: matchAndSaveTrades (IFDOCO) ───────────────

test('executeTenMinutelyTask: IFDOCO entry+exit がマッチしたとき trade を保存して削除する', async () => {
    const entry = makeExecution({
        id: 'entry-1', side: 'BUY', price: 10_000_000,
        provider_order_id: 'prov-1',
        executed_at: new Date('2026-01-01'),
    })
    const exit = makeExecution({
        id: 'exit-1', side: 'SELL', price: 11_000_000,
        entry_id: 'entry-1',
        executed_at: new Date('2026-01-02'),
    })

    const savedTrades: unknown[] = []
    const deletedIds: string[] = []

    const ctx = makeBaseCtx({
        getMarketOrderExecutions: async () => [],
        getIfdocoEntries: async () => [entry],
        getIfdocoExits: async () => [exit],
        deleteOrderExecution: async (id) => { deletedIds.push(id) },
        addTrade: async (t) => { savedTrades.push(t) },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(savedTrades.length, 1)
    const trade = savedTrades[0] as Record<string, unknown>
    assert.equal(trade.entry_side, 'BUY')
    assert.ok(Math.abs((trade.pnl as number) - 10_000) < 0.001)
    assert.equal(deletedIds.length, 2)
    assert.ok(deletedIds.includes('entry-1'))
    assert.ok(deletedIds.includes('exit-1'))
})

test('executeTenMinutelyTask: Step 3 に必要な関数が未設定のとき matchAndSaveTrades は実行されない', async () => {
    let called = false

    const ctx = makeBaseCtx({
        // getMarketOrderExecutions を省略 → Step 3 がスキップされる
        addTrade: async () => { called = true },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(called, false)
})
