import assert from 'node:assert/strict'
import test from 'node:test'

import { executeTenMinutelyTask } from './cron-tasks.js'
import type { CronContext } from './cron-tasks.js'
import type { OpenTrade, UnpairedLog } from './trade-records.js'

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

const makeUnpairedLog = (overrides: Partial<UnpairedLog> & { side: 'BUY' | 'SELL' }): UnpairedLog => ({
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
    checkMigrationDone: async () => true,
    setMigrationDone: async () => { },
    getUnpairedLogsForMigration: async () => [],
    getConfirmedUnpromotedLogs: async () => [],
    markOpenTradesWritten: async () => { },
    getOpenTrades: async () => [],
    addOpenTrade: async () => { },
    deleteOpenTrade: async () => { },
    createTradeRecord: async () => { },
    ...overrides,
})

// ─────────────── runMigrationIfNeeded ───────────────

test('executeTenMinutelyTask: migration 未実施のとき unpaired logs を open_trades に移行する', async () => {
    const buyLog = makeUnpairedLog({ side: 'BUY', docId: 'doc-buy', event_id: 'evt-buy' })
    const addedTrades: OpenTrade[] = []
    let migrationFlagSet = false

    const ctx = makeBaseCtx({
        checkMigrationDone: async () => false,
        setMigrationDone: async () => { migrationFlagSet = true },
        getUnpairedLogsForMigration: async () => [buyLog],
        addOpenTrade: async (trade) => { addedTrades.push(trade) },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(addedTrades.length, 1)
    assert.equal(addedTrades[0]?.event_id, 'evt-buy')
    assert.equal(addedTrades[0]?.order_dispatch_log_id, 'doc-buy')
    assert.equal(migrationFlagSet, true)
})

test('executeTenMinutelyTask: migration 済みのとき unpaired logs のクエリをしない', async () => {
    let migrationQueried = false

    const ctx = makeBaseCtx({
        checkMigrationDone: async () => true,
        getUnpairedLogsForMigration: async () => { migrationQueried = true; return [] },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(migrationQueried, false)
})

// ─────────────── promoteConfirmedLogsToOpenTrades ───────────────

test('executeTenMinutelyTask: confirmed logs を open_trades に追加し markOpenTradesWritten を呼ぶ', async () => {
    const confirmedLog = makeUnpairedLog({ side: 'BUY', docId: 'doc-1', event_id: 'evt-1' })
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

    // checkMigrationDone を省いた CronContext
    const ctx: CronContext = {
        logger,
        positionFetcher: makePositionFetcherStub(),
        // checkMigrationDone は省略
        setMigrationDone: async () => { },
        getUnpairedLogsForMigration: async () => [],
        getConfirmedUnpromotedLogs: async () => [],
        markOpenTradesWritten: async () => { },
        getOpenTrades: async () => { called = true; return [] },
        addOpenTrade: async () => { },
        deleteOpenTrade: async () => { },
        createTradeRecord: async () => { },
    }

    await executeTenMinutelyTask(ctx)

    assert.equal(called, false)
})
