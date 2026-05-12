import assert from 'node:assert/strict'
import test from 'node:test'

import { pairLogs, createTradeRecordFn, computeStats, getTradeRecordsFn, getTradeStatsFn, addOpenTradeFn, getOpenTradesFn, deleteOpenTradeFn, getPendingExecutionOpenTradesFn, updateOpenTradeExecutionPriceFn } from './trade-records.js'
import type { TradeRecord, OpenTrade, PendingExecutionOpenTrade } from './trade-records.js'

const makeOpenTrade = (overrides: Partial<OpenTrade> & { side: 'BUY' | 'SELL' }): OpenTrade => ({
    event_id: `evt-${Math.random()}`,
    broker: 'bitflyer',
    ticker: 'BTC_JPY',
    size: 0.01,
    strategy: 'MA Crossover',
    interval: '4H',
    execution_price: 10000000,
    created_at: new Date('2026-01-01T00:00:00Z'),
    order_dispatch_log_id: `doc-${Math.random()}`,
    ...overrides,
})

// ─────────────── pairLogs ───────────────

test('pairLogs: BUY → SELL をペアリングして PnL を計算する（ロング）', () => {
    const buy = makeOpenTrade({ side: 'BUY', execution_price: 10000000, created_at: new Date('2026-01-01T00:00:00Z'), event_id: 'evt-buy-1' })
    const sell = makeOpenTrade({ side: 'SELL', execution_price: 11000000, created_at: new Date('2026-01-02T00:00:00Z'), event_id: 'evt-sell-1' })

    const result = pairLogs([buy, sell])

    assert.equal(result.length, 1)
    assert.equal(result[0]?.record.entry_side, 'BUY')
    assert.equal(result[0]?.record.entry_price, 10000000)
    assert.equal(result[0]?.record.exit_price, 11000000)
    assert.ok(Math.abs((result[0]?.record.pnl ?? 0) - 10000) < 0.001) // (11000000 - 10000000) * 0.01
    assert.equal(result[0]?.entryEventId, 'evt-buy-1')
    assert.equal(result[0]?.exitEventId, 'evt-sell-1')
})

test('pairLogs: SELL → BUY をペアリングして PnL を計算する（ショート）', () => {
    const sell = makeOpenTrade({ side: 'SELL', execution_price: 11000000, created_at: new Date('2026-01-01T00:00:00Z'), event_id: 'evt-sell-1' })
    const buy = makeOpenTrade({ side: 'BUY', execution_price: 10000000, created_at: new Date('2026-01-02T00:00:00Z'), event_id: 'evt-buy-1' })

    const result = pairLogs([sell, buy])

    assert.equal(result.length, 1)
    assert.equal(result[0]?.record.entry_side, 'SELL')
    assert.equal(result[0]?.record.entry_price, 11000000)
    assert.equal(result[0]?.record.exit_price, 10000000)
    assert.ok(Math.abs((result[0]?.record.pnl ?? 0) - 10000) < 0.001) // (11000000 - 10000000) * 0.01
})

test('pairLogs: FIFO でペアリングする（複数注文）', () => {
    const buy1 = makeOpenTrade({ side: 'BUY', execution_price: 10000000, created_at: new Date('2026-01-01T00:00:00Z'), event_id: 'evt-1' })
    const sell1 = makeOpenTrade({ side: 'SELL', execution_price: 11000000, created_at: new Date('2026-01-02T00:00:00Z'), event_id: 'evt-3' })
    const buy2 = makeOpenTrade({ side: 'BUY', execution_price: 10500000, created_at: new Date('2026-01-03T00:00:00Z'), event_id: 'evt-2' })
    const sell2 = makeOpenTrade({ side: 'SELL', execution_price: 12000000, created_at: new Date('2026-01-04T00:00:00Z'), event_id: 'evt-4' })

    const result = pairLogs([buy2, sell1, buy1, sell2]) // 順不同で渡す

    assert.equal(result.length, 2)
    // buy1(古い) と sell1(2番目) がペアになる
    assert.equal(result[0]?.entryEventId, 'evt-1')
    assert.equal(result[0]?.exitEventId, 'evt-3')
    // buy2 と sell2 がペアになる
    assert.equal(result[1]?.entryEventId, 'evt-2')
    assert.equal(result[1]?.exitEventId, 'evt-4')
})

test('pairLogs: strategy+interval+ticker+broker が異なればペアリングしない', () => {
    const buy = makeOpenTrade({ side: 'BUY', strategy: 'Strategy A', interval: '1H', ticker: 'BTC_JPY' })
    const sell = makeOpenTrade({ side: 'SELL', strategy: 'Strategy B', interval: '1H', ticker: 'BTC_JPY' })

    const result = pairLogs([buy, sell])

    assert.equal(result.length, 0)
})

test('pairLogs: 余った注文はペアリングされない', () => {
    const buy1 = makeOpenTrade({ side: 'BUY', event_id: 'evt-1' })
    const buy2 = makeOpenTrade({ side: 'BUY', event_id: 'evt-2' })
    const sell1 = makeOpenTrade({ side: 'SELL', event_id: 'evt-3' })

    const result = pairLogs([buy1, buy2, sell1])

    assert.equal(result.length, 1)
})

test('pairLogs: 空配列を渡した場合は空を返す', () => {
    const result = pairLogs([])
    assert.equal(result.length, 0)
})

test('pairLogs: execution_price が null のトレードはペアリングされない', () => {
    const buy = makeOpenTrade({ side: 'BUY', execution_price: null, event_id: 'evt-buy-pending' })
    const sell = makeOpenTrade({ side: 'SELL', execution_price: 11000000, event_id: 'evt-sell-1' })

    const result = pairLogs([buy, sell])

    assert.equal(result.length, 0)
})

test('pairLogs: execution_price が null でないものだけペアリングされる', () => {
    const buy = makeOpenTrade({ side: 'BUY', execution_price: 10000000, created_at: new Date('2026-01-01'), event_id: 'evt-buy-confirmed' })
    const sellPending = makeOpenTrade({ side: 'SELL', execution_price: null, event_id: 'evt-sell-pending' })
    const sellConfirmed = makeOpenTrade({ side: 'SELL', execution_price: 11000000, created_at: new Date('2026-01-02'), event_id: 'evt-sell-confirmed' })

    const result = pairLogs([buy, sellPending, sellConfirmed])

    assert.equal(result.length, 1)
    assert.equal(result[0]?.entryEventId, 'evt-buy-confirmed')
    assert.equal(result[0]?.exitEventId, 'evt-sell-confirmed')
})

test('pairLogs: order_method=IFD のトレードはペアリング対象外', () => {
    const buy = makeOpenTrade({ side: 'BUY', execution_price: 10000000, event_id: 'evt-buy-ifd', order_method: 'IFD' })
    const sell = makeOpenTrade({ side: 'SELL', execution_price: 11000000, event_id: 'evt-sell-1' })

    const result = pairLogs([buy, sell])

    assert.equal(result.length, 0)
})

test('pairLogs: order_method=IFDOCO のトレードはペアリング対象外', () => {
    const buy = makeOpenTrade({ side: 'BUY', execution_price: 10000000, event_id: 'evt-buy-ifdoco', order_method: 'IFDOCO' })
    const sell = makeOpenTrade({ side: 'SELL', execution_price: 11000000, event_id: 'evt-sell-1' })

    const result = pairLogs([buy, sell])

    assert.equal(result.length, 0)
})

test('pairLogs: IFD/IFDOCO と通常トレードが混在しても通常トレードだけペアリングされる', () => {
    const buyIfd = makeOpenTrade({ side: 'BUY', execution_price: 10000000, event_id: 'evt-buy-ifd', order_method: 'IFD' })
    const buyNormal = makeOpenTrade({ side: 'BUY', execution_price: 10000000, created_at: new Date('2026-01-01'), event_id: 'evt-buy-normal' })
    const sellNormal = makeOpenTrade({ side: 'SELL', execution_price: 11000000, created_at: new Date('2026-01-02'), event_id: 'evt-sell-normal' })

    const result = pairLogs([buyIfd, buyNormal, sellNormal])

    assert.equal(result.length, 1)
    assert.equal(result[0]?.entryEventId, 'evt-buy-normal')
    assert.equal(result[0]?.exitEventId, 'evt-sell-normal')
})

// ─────────────── Firestore 関数 ───────────────

const makeFirestoreMock = () => {
    const store: Record<string, Record<string, unknown>> = {}
    const addedDocs: Record<string, unknown>[] = []
    const updatedDocs: { id: string; data: Record<string, unknown> }[] = []

    const db = {
        collection: (name: string) => ({
            where: (_f: string, _op: string, _v: unknown) => ({
                where: (_f2: string, op2: string, v2: unknown) => ({
                    get: async () => ({
                        docs: Object.entries(store)
                            .filter(([, data]) => {
                                // 2番目の where 条件を模倣 (paired == false)
                                if (op2 === '==') return data[_f2] === v2
                                return true
                            })
                            .map(([id, data]) => ({
                                id,
                                data: () => data,
                            })),
                    }),
                }),
            }),
            add: async (data: Record<string, unknown>) => {
                addedDocs.push({ collection: name, ...data })
            },
            doc: (id: string) => ({
                update: async (data: Record<string, unknown>) => {
                    updatedDocs.push({ id, data })
                },
            }),
        }),
        store,
        addedDocs,
        updatedDocs,
    }

    return db as unknown as Parameters<typeof createTradeRecordFn>[0] & {
        store: typeof store
        addedDocs: typeof addedDocs
        updatedDocs: typeof updatedDocs
    }
}

test('createTradeRecordFn: trade_records に保存し expire_at を設定する', async () => {
    const db = makeFirestoreMock()
    const fn = createTradeRecordFn(db)
    const closedAt = new Date('2026-01-02T00:00:00Z')

    await fn({
        strategy: 'MA', interval: '4H', ticker: 'BTC_JPY', broker: 'bitflyer',
        entry_side: 'BUY', entry_price: 10000000, exit_price: 11000000, size: 0.01, pnl: 10000,
        entry_event_id: 'evt-1', exit_event_id: 'evt-2',
        opened_at: new Date('2026-01-01T00:00:00Z'), closed_at: closedAt,
    })

    assert.equal(db.addedDocs.length, 1)
    const doc = db.addedDocs[0]!
    assert.equal(doc.collection, 'trade_records')
    assert.equal(doc.strategy, 'MA')
    assert.equal(doc.pnl, 10000)
    const expectedExpireAt = new Date(closedAt.getTime() + 2 * 365 * 24 * 60 * 60 * 1000) // 2年後
    assert.equal((doc.expire_at as Date).getTime(), expectedExpireAt.getTime())
})

// ─────────────── open_trades CRUD ───────────────

const makeOpenTradeFirestoreMock = () => {
    const store: Record<string, Record<string, unknown>> = {}
    const setDocs: { id: string; data: Record<string, unknown> }[] = []
    const deletedIds: string[] = []
    const updatedDocs: { id: string; data: Record<string, unknown> }[] = []

    const db = {
        collection: (_name: string) => ({
            get: async () => ({
                docs: Object.entries(store).map(([id, data]) => ({
                    id,
                    data: () => data,
                })),
            }),
            doc: (id: string) => ({
                set: async (data: Record<string, unknown>) => {
                    store[id] = data
                    setDocs.push({ id, data })
                },
                delete: async () => {
                    delete store[id]
                    deletedIds.push(id)
                },
                update: async (data: Record<string, unknown>) => {
                    store[id] = { ...store[id], ...data }
                    updatedDocs.push({ id, data })
                },
            }),
        }),
        store,
        setDocs,
        deletedIds,
        updatedDocs,
    }

    return db as unknown as Parameters<typeof addOpenTradeFn>[0] & {
        store: typeof store
        setDocs: typeof setDocs
        deletedIds: typeof deletedIds
        updatedDocs: typeof updatedDocs
    }
}

test('addOpenTradeFn: open_trades に event_id をドキュメントIDとして upsert する', async () => {
    const db = makeOpenTradeFirestoreMock()
    const fn = addOpenTradeFn(db)

    const trade: OpenTrade = {
        event_id: 'evt-buy-1',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        size: 0.01,
        strategy: 'MA',
        interval: '4H',
        execution_price: 10000000,
        created_at: new Date('2026-01-01'),
        order_dispatch_log_id: 'doc-1',
    }

    await fn(trade)

    assert.equal(db.setDocs.length, 1)
    assert.equal(db.setDocs[0]?.id, 'evt-buy-1')
    assert.equal(db.setDocs[0]?.data.broker, 'bitflyer')
    assert.equal(db.setDocs[0]?.data.order_dispatch_log_id, 'doc-1')
})

test('getOpenTradesFn: open_trades の全件を返す', async () => {
    const db = makeOpenTradeFirestoreMock()
    db.store['evt-1'] = {
        broker: 'bitflyer', ticker: 'BTC_JPY', side: 'BUY', size: 0.01,
        strategy: 'MA', interval: '4H', execution_price: 10000000,
        order_dispatch_log_id: 'doc-1',
        created_at: { toDate: () => new Date('2026-01-01') },
    }
    db.store['evt-2'] = {
        broker: 'bitflyer', ticker: 'BTC_JPY', side: 'SELL', size: 0.01,
        strategy: 'MA', interval: '4H', execution_price: 11000000,
        order_dispatch_log_id: 'doc-2',
        created_at: { toDate: () => new Date('2026-01-02') },
    }

    const fn = getOpenTradesFn(db)
    const trades = await fn()

    assert.equal(trades.length, 2)
    const eventIds = trades.map((t) => t.event_id).sort()
    assert.deepEqual(eventIds, ['evt-1', 'evt-2'])
})

test('deleteOpenTradeFn: open_trades から event_id のドキュメントを削除する', async () => {
    const db = makeOpenTradeFirestoreMock()
    const fn = deleteOpenTradeFn(db)

    await fn('evt-buy-1')

    assert.equal(db.deletedIds.length, 1)
    assert.equal(db.deletedIds[0], 'evt-buy-1')
})

test('addOpenTradeFn: execution_price が null の open_trade を upsert できる', async () => {
    const db = makeOpenTradeFirestoreMock()
    const fn = addOpenTradeFn(db)

    const trade: OpenTrade = {
        event_id: 'evt-new-1',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        size: 0.01,
        strategy: 'MA',
        interval: '4H',
        execution_price: null,
        created_at: new Date('2026-01-01'),
        provider_order_id: 'JRF-new-1',
    }

    await fn(trade)

    assert.equal(db.setDocs.length, 1)
    assert.equal(db.setDocs[0]?.id, 'evt-new-1')
    assert.equal(db.setDocs[0]?.data.execution_price, null)
    assert.equal(db.setDocs[0]?.data.provider_order_id, 'JRF-new-1')
})

test('getPendingExecutionOpenTradesFn: execution_price=null かつ provider_order_id ありのものを返す', async () => {
    const db = makeOpenTradeFirestoreMock()
    // execution_price あり → 対象外
    db.store['evt-confirmed'] = { broker: 'bitflyer', ticker: 'BTC_JPY', execution_price: 9500000, provider_order_id: 'JRF-1' }
    // execution_price=null & provider_order_id あり → 対象
    db.store['evt-pending'] = { broker: 'bitflyer', ticker: 'BTC_JPY', execution_price: null, provider_order_id: 'JRF-2' }
    // provider_order_id なし → 対象外
    db.store['evt-no-order'] = { broker: 'bitflyer', ticker: 'BTC_JPY', execution_price: null }

    const fn = getPendingExecutionOpenTradesFn(db)
    const result = await fn()

    assert.equal(result.length, 1)
    assert.equal(result[0]?.event_id, 'evt-pending')
    assert.equal(result[0]?.provider_order_id, 'JRF-2')
})

test('updateOpenTradeExecutionPriceFn: open_trades の execution_price を更新する', async () => {
    const db = makeOpenTradeFirestoreMock()
    db.store['evt-1'] = { broker: 'bitflyer', execution_price: null, provider_order_id: 'JRF-1' }

    const fn = updateOpenTradeExecutionPriceFn(db)
    await fn('evt-1', 9500000)

    assert.equal(db.updatedDocs.length, 1)
    assert.equal(db.updatedDocs[0]?.id, 'evt-1')
    assert.equal(db.updatedDocs[0]?.data.execution_price, 9500000)
})

// ─────────────── computeStats ───────────────

const makeTradeRecord = (pnl: number, openedAt: Date = new Date('2026-01-01')): TradeRecord => ({
    strategy: 'MA', interval: '4H', ticker: 'BTC_JPY', broker: 'bitflyer',
    entry_side: pnl >= 0 ? 'BUY' : 'SELL',
    entry_price: 10000000, exit_price: 10000000 + pnl / 0.01,
    size: 0.01, pnl,
    entry_event_id: 'evt-entry', exit_event_id: 'evt-exit',
    opened_at: openedAt, closed_at: new Date(openedAt.getTime() + 3600_000),
})

test('computeStats: ロング/ショート混在の正常ケース', () => {
    const records = [
        makeTradeRecord(1000),   // 勝ち
        makeTradeRecord(500),    // 勝ち
        makeTradeRecord(-300),   // 負け
        makeTradeRecord(200),    // 勝ち
        makeTradeRecord(-100),   // 負け
    ]
    const stats = computeStats(records)

    assert.equal(stats.total, 5)
    assert.equal(stats.win_count, 3)
    assert.equal(stats.loss_count, 2)
    assert.ok(Math.abs(stats.win_rate - 0.6) < 1e-10)
    assert.ok(Math.abs(stats.total_pnl - 1300) < 1e-10)  // 1000+500-300+200-100
    assert.ok(Math.abs(stats.avg_pnl - 260) < 1e-10)
    // avg_win = (1000+500+200)/3
    assert.ok(Math.abs((stats.avg_win ?? 0) - (1700 / 3)) < 1e-6)
    // avg_loss = (-300+-100)/2
    assert.ok(Math.abs((stats.avg_loss ?? 0) - (-200)) < 1e-10)
    // profit_factor = 1700 / 400
    assert.ok(Math.abs((stats.profit_factor ?? 0) - (1700 / 400)) < 1e-10)
    // max_drawdown: cumulative = [1000, 1500, 1200, 1400, 1300], peak=[1000,1500,1500,1500,1500] → max drawdown = 1500-1200 = 300
    assert.ok(Math.abs(stats.max_drawdown - 300) < 1e-10)
    // sharpe_ratio: null because total < 10
    assert.equal(stats.sharpe_ratio, null)
})

test('computeStats: 全勝（profit_factor は null）', () => {
    const records = [makeTradeRecord(100), makeTradeRecord(200)]
    const stats = computeStats(records)

    assert.equal(stats.win_count, 2)
    assert.equal(stats.loss_count, 0)
    assert.equal(stats.profit_factor, null)
    assert.equal(stats.avg_loss, null)
    assert.ok(Math.abs(stats.win_rate - 1) < 1e-10)
})

test('computeStats: 全敗（avg_win は null）', () => {
    const records = [makeTradeRecord(-100), makeTradeRecord(-200)]
    const stats = computeStats(records)

    assert.equal(stats.win_count, 0)
    assert.equal(stats.loss_count, 2)
    assert.equal(stats.avg_win, null)
    assert.ok(Math.abs(stats.win_rate - 0) < 1e-10)
})

test('computeStats: 空配列は全ゼロ/null', () => {
    const stats = computeStats([])

    assert.equal(stats.total, 0)
    assert.equal(stats.total_pnl, 0)
    assert.equal(stats.profit_factor, null)
    assert.equal(stats.sharpe_ratio, null)
})

test('computeStats: 10件以上のとき sharpe_ratio を計算する', () => {
    const records = Array.from({ length: 10 }, (_, i) => makeTradeRecord(i % 2 === 0 ? 100 : -50))
    const stats = computeStats(records)

    assert.notEqual(stats.sharpe_ratio, null)
    assert.equal(typeof stats.sharpe_ratio, 'number')
})

test('computeStats: max_drawdown は開始から一度も下がらない場合 0', () => {
    // 単調増加
    const records = [
        makeTradeRecord(100, new Date('2026-01-01')),
        makeTradeRecord(200, new Date('2026-01-02')),
        makeTradeRecord(300, new Date('2026-01-03')),
    ]
    const stats = computeStats(records)
    assert.equal(stats.max_drawdown, 0)
})

// ─────────────── getTradeRecordsFn ───────────────

const makeFirestoreTradeRecordMock = () => {
    type FirestoreDoc = {
        opened_at: { toDate(): Date; valueOf(): number }
        closed_at: { toDate(): Date }
        strategy: string
        interval: string
        ticker: string
        broker: string
        entry_side: 'BUY' | 'SELL'
        entry_price: number
        exit_price: number
        size: number
        pnl: number
        entry_event_id: string
        exit_event_id: string
    }
    const records: Record<string, FirestoreDoc> = {}

    const db = {
        collection: (_name: string) => ({
            where: (field: string, op: string, val: unknown) => {
                const filtered1 = () => Object.entries(records).filter(([, data]) => {
                    if (op === '>=' && field === 'opened_at') return data.opened_at.valueOf() >= (val as Date).getTime()
                    if (op === '<=' && field === 'opened_at') return data.opened_at.valueOf() <= (val as Date).getTime()
                    return true
                })
                return {
                    where: (f2: string, op2: string, val2: unknown) => ({
                        orderBy: () => ({
                            get: async () => ({
                                docs: filtered1()
                                    .filter(([, data]) => {
                                        if (op2 === '<=' && f2 === 'opened_at') return data.opened_at.valueOf() <= (val2 as Date).getTime()
                                        return true
                                    })
                                    .map(([id, data]) => ({ id, data: () => data })),
                            }),
                        }),
                    }),
                }
            },
        }),
        records,
    }

    return db as unknown as Parameters<typeof getTradeRecordsFn>[0] & { records: typeof records }
}

const toFirestoreDate = (d: Date) => ({ toDate: () => d, valueOf: () => d.getTime() })

test('getTradeRecordsFn: 期間内のレコードのみ返す', async () => {
    const db = makeFirestoreTradeRecordMock()
    db.records['r1'] = {
        opened_at: toFirestoreDate(new Date('2026-03-01')),
        closed_at: toFirestoreDate(new Date('2026-03-01T01:00:00Z')),
        strategy: 'MA', interval: '4H', ticker: 'BTC_JPY', broker: 'bitflyer',
        entry_side: 'BUY', entry_price: 10000000, exit_price: 11000000, size: 0.01, pnl: 10000,
        entry_event_id: 'e1', exit_event_id: 'e2',
    }
    db.records['r2'] = {
        opened_at: toFirestoreDate(new Date('2026-02-01')), // 期間外
        closed_at: toFirestoreDate(new Date('2026-02-01T01:00:00Z')),
        strategy: 'MA', interval: '4H', ticker: 'BTC_JPY', broker: 'bitflyer',
        entry_side: 'SELL', entry_price: 11000000, exit_price: 10000000, size: 0.01, pnl: 10000,
        entry_event_id: 'e3', exit_event_id: 'e4',
    }

    const fn = getTradeRecordsFn(db)
    const result = await fn({ from: new Date('2026-02-15'), to: new Date('2026-04-01') })

    assert.equal(result.length, 1)
    assert.equal(result[0]?.docId, 'r1')
})

test('getTradeRecordsFn: strategy フィルターが機能する', async () => {
    const db = makeFirestoreTradeRecordMock()
    db.records['r1'] = {
        opened_at: toFirestoreDate(new Date('2026-03-01')),
        closed_at: toFirestoreDate(new Date('2026-03-01T01:00:00Z')),
        strategy: 'StratA', interval: '4H', ticker: 'BTC_JPY', broker: 'bitflyer',
        entry_side: 'BUY', entry_price: 10000000, exit_price: 11000000, size: 0.01, pnl: 10000,
        entry_event_id: 'e1', exit_event_id: 'e2',
    }
    db.records['r2'] = {
        opened_at: toFirestoreDate(new Date('2026-03-02')),
        closed_at: toFirestoreDate(new Date('2026-03-02T01:00:00Z')),
        strategy: 'StratB', interval: '4H', ticker: 'BTC_JPY', broker: 'bitflyer',
        entry_side: 'BUY', entry_price: 10000000, exit_price: 11000000, size: 0.01, pnl: 10000,
        entry_event_id: 'e3', exit_event_id: 'e4',
    }

    const fn = getTradeRecordsFn(db)
    const result = await fn({ from: new Date('2026-01-01'), to: new Date('2026-12-31'), strategy: 'StratA' })

    assert.equal(result.length, 1)
    assert.equal(result[0]?.strategy, 'StratA')
})

// ─────────────── getTradeStatsFn ───────────────

test('getTradeStatsFn: 4軸でグループ化し統計を返す', async () => {
    const db = makeFirestoreTradeRecordMock()
    // グループA: StratA/4H/BTC_JPY/bitflyer (勝ち1、負け1)
    db.records['r1'] = {
        opened_at: toFirestoreDate(new Date('2026-03-01')),
        closed_at: toFirestoreDate(new Date('2026-03-01T01:00:00Z')),
        strategy: 'StratA', interval: '4H', ticker: 'BTC_JPY', broker: 'bitflyer',
        entry_side: 'BUY', entry_price: 10000000, exit_price: 11000000, size: 0.01, pnl: 10000,
        entry_event_id: 'e1', exit_event_id: 'e2',
    }
    db.records['r2'] = {
        opened_at: toFirestoreDate(new Date('2026-03-02')),
        closed_at: toFirestoreDate(new Date('2026-03-02T01:00:00Z')),
        strategy: 'StratA', interval: '4H', ticker: 'BTC_JPY', broker: 'bitflyer',
        entry_side: 'BUY', entry_price: 11000000, exit_price: 10000000, size: 0.01, pnl: -10000,
        entry_event_id: 'e3', exit_event_id: 'e4',
    }
    // グループB: StratB/1H/ETH_JPY/bitflyer (勝ち1)
    db.records['r3'] = {
        opened_at: toFirestoreDate(new Date('2026-03-03')),
        closed_at: toFirestoreDate(new Date('2026-03-03T01:00:00Z')),
        strategy: 'StratB', interval: '1H', ticker: 'ETH_JPY', broker: 'bitflyer',
        entry_side: 'BUY', entry_price: 500000, exit_price: 510000, size: 0.1, pnl: 1000,
        entry_event_id: 'e5', exit_event_id: 'e6',
    }

    const fn = getTradeStatsFn(db)
    const result = await fn({ from: new Date('2026-01-01'), to: new Date('2026-12-31') })

    assert.equal(result.groups.length, 2)

    const groupA = result.groups.find((g) => g.strategy === 'StratA')
    assert.ok(groupA)
    assert.equal(groupA.total, 2)
    assert.equal(groupA.win_count, 1)
    assert.equal(groupA.loss_count, 1)
    assert.ok(Math.abs(groupA.total_pnl - 0) < 1e-10)

    const groupB = result.groups.find((g) => g.strategy === 'StratB')
    assert.ok(groupB)
    assert.equal(groupB.total, 1)
    assert.equal(groupB.win_count, 1)
    assert.equal(groupB.total_pnl, 1000)
})

test('getTradeStatsFn: total_pnl 降順でソートされる', async () => {
    const db = makeFirestoreTradeRecordMock()
    db.records['r1'] = {
        opened_at: toFirestoreDate(new Date('2026-03-01')),
        closed_at: toFirestoreDate(new Date('2026-03-01T01:00:00Z')),
        strategy: 'Low', interval: '4H', ticker: 'BTC_JPY', broker: 'bitflyer',
        entry_side: 'BUY', entry_price: 10000000, exit_price: 10100000, size: 0.01, pnl: 1000,
        entry_event_id: 'e1', exit_event_id: 'e2',
    }
    db.records['r2'] = {
        opened_at: toFirestoreDate(new Date('2026-03-02')),
        closed_at: toFirestoreDate(new Date('2026-03-02T01:00:00Z')),
        strategy: 'High', interval: '4H', ticker: 'BTC_JPY', broker: 'bitflyer',
        entry_side: 'BUY', entry_price: 10000000, exit_price: 11000000, size: 0.01, pnl: 10000,
        entry_event_id: 'e3', exit_event_id: 'e4',
    }

    const fn = getTradeStatsFn(db)
    const result = await fn({ from: new Date('2026-01-01'), to: new Date('2026-12-31') })

    assert.equal(result.groups[0]?.strategy, 'High')
    assert.equal(result.groups[1]?.strategy, 'Low')
})
