import assert from 'node:assert/strict'
import test from 'node:test'

import { pairLogs, getUnpairedLogsFn, createTradeRecordFn, markLogPairedFn } from './trade-records.js'
import type { UnpairedLog } from './trade-records.js'

const makeLog = (overrides: Partial<UnpairedLog> & { side: 'BUY' | 'SELL' }): UnpairedLog => ({
    docId: `doc-${Math.random()}`,
    event_id: `evt-${Math.random()}`,
    broker: 'bitflyer',
    ticker: 'BTC_JPY',
    size: 0.01,
    strategy: 'MA Crossover',
    interval: '4H',
    execution_price: 10000000,
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
})

// ─────────────── pairLogs ───────────────

test('pairLogs: BUY → SELL をペアリングして PnL を計算する（ロング）', () => {
    const buy = makeLog({ side: 'BUY', execution_price: 10000000, created_at: new Date('2026-01-01T00:00:00Z'), docId: 'buy-1', event_id: 'evt-buy-1' })
    const sell = makeLog({ side: 'SELL', execution_price: 11000000, created_at: new Date('2026-01-02T00:00:00Z'), docId: 'sell-1', event_id: 'evt-sell-1' })

    const result = pairLogs([buy, sell])

    assert.equal(result.length, 1)
    assert.equal(result[0]?.record.entry_side, 'BUY')
    assert.equal(result[0]?.record.entry_price, 10000000)
    assert.equal(result[0]?.record.exit_price, 11000000)
    assert.ok(Math.abs((result[0]?.record.pnl ?? 0) - 10000) < 0.001) // (11000000 - 10000000) * 0.01
    assert.equal(result[0]?.entryDocId, 'buy-1')
    assert.equal(result[0]?.exitDocId, 'sell-1')
})

test('pairLogs: SELL → BUY をペアリングして PnL を計算する（ショート）', () => {
    const sell = makeLog({ side: 'SELL', execution_price: 11000000, created_at: new Date('2026-01-01T00:00:00Z'), docId: 'sell-1', event_id: 'evt-sell-1' })
    const buy = makeLog({ side: 'BUY', execution_price: 10000000, created_at: new Date('2026-01-02T00:00:00Z'), docId: 'buy-1', event_id: 'evt-buy-1' })

    const result = pairLogs([sell, buy])

    assert.equal(result.length, 1)
    assert.equal(result[0]?.record.entry_side, 'SELL')
    assert.equal(result[0]?.record.entry_price, 11000000)
    assert.equal(result[0]?.record.exit_price, 10000000)
    assert.ok(Math.abs((result[0]?.record.pnl ?? 0) - 10000) < 0.001) // (11000000 - 10000000) * 0.01
})

test('pairLogs: FIFO でペアリングする（複数注文）', () => {
    const buy1 = makeLog({ side: 'BUY', execution_price: 10000000, created_at: new Date('2026-01-01T00:00:00Z'), docId: 'buy-1', event_id: 'evt-1' })
    const sell1 = makeLog({ side: 'SELL', execution_price: 11000000, created_at: new Date('2026-01-02T00:00:00Z'), docId: 'sell-1', event_id: 'evt-3' })
    const buy2 = makeLog({ side: 'BUY', execution_price: 10500000, created_at: new Date('2026-01-03T00:00:00Z'), docId: 'buy-2', event_id: 'evt-2' })
    const sell2 = makeLog({ side: 'SELL', execution_price: 12000000, created_at: new Date('2026-01-04T00:00:00Z'), docId: 'sell-2', event_id: 'evt-4' })

    const result = pairLogs([buy2, sell1, buy1, sell2]) // 順不同で渡す

    assert.equal(result.length, 2)
    // buy1(古い) と sell1(2番目) がペアになる
    assert.equal(result[0]?.entryDocId, 'buy-1')
    assert.equal(result[0]?.exitDocId, 'sell-1')
    // buy2 と sell2 がペアになる
    assert.equal(result[1]?.entryDocId, 'buy-2')
    assert.equal(result[1]?.exitDocId, 'sell-2')
})

test('pairLogs: strategy+interval+ticker+broker が異なればペアリングしない', () => {
    const buy = makeLog({ side: 'BUY', strategy: 'Strategy A', interval: '1H', ticker: 'BTC_JPY' })
    const sell = makeLog({ side: 'SELL', strategy: 'Strategy B', interval: '1H', ticker: 'BTC_JPY' })

    const result = pairLogs([buy, sell])

    assert.equal(result.length, 0)
})

test('pairLogs: 余った注文はペアリングされない', () => {
    const buy1 = makeLog({ side: 'BUY', docId: 'buy-1', event_id: 'evt-1' })
    const buy2 = makeLog({ side: 'BUY', docId: 'buy-2', event_id: 'evt-2' })
    const sell1 = makeLog({ side: 'SELL', docId: 'sell-1', event_id: 'evt-3' })

    const result = pairLogs([buy1, buy2, sell1])

    assert.equal(result.length, 1)
})

test('pairLogs: 空配列を渡した場合は空を返す', () => {
    const result = pairLogs([])
    assert.equal(result.length, 0)
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

    return db as unknown as Parameters<typeof getUnpairedLogsFn>[0] & {
        store: typeof store
        addedDocs: typeof addedDocs
        updatedDocs: typeof updatedDocs
    }
}

// getUnpairedLogsFn のテスト用に import
import { getUnpairedLogsFn } from './trade-records.js'

test('getUnpairedLogsFn: execution_price あり paired=false のみ返す', async () => {
    const db = makeFirestoreMock()

    db.store['doc-1'] = {
        broker: 'bitflyer', ticker: 'BTC_JPY', side: 'BUY', size: 0.01,
        strategy: 'MA', interval: '4H', execution_price: 10000000,
        event_id: 'evt-1', result: 'success', paired: false,
        created_at: { toDate: () => new Date('2026-01-01') },
    }
    // execution_price なし → 対象外
    db.store['doc-2'] = {
        broker: 'bitflyer', ticker: 'BTC_JPY', side: 'SELL', size: 0.01,
        strategy: 'MA', interval: '4H', event_id: 'evt-2',
        result: 'success', paired: false,
        created_at: { toDate: () => new Date('2026-01-02') },
    }
    // paired=true → 対象外
    db.store['doc-3'] = {
        broker: 'bitflyer', ticker: 'BTC_JPY', side: 'SELL', size: 0.01,
        strategy: 'MA', interval: '4H', execution_price: 11000000,
        event_id: 'evt-3', result: 'success', paired: true,
        created_at: { toDate: () => new Date('2026-01-03') },
    }

    const fn = getUnpairedLogsFn(db)
    const logs = await fn()

    assert.equal(logs.length, 1)
    assert.equal(logs[0]?.docId, 'doc-1')
})

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
    const expectedExpireAt = new Date(closedAt.getTime() + 365 * 24 * 60 * 60 * 1000)
    assert.equal((doc.expire_at as Date).getTime(), expectedExpireAt.getTime())
})

test('markLogPairedFn: order_dispatch_logs の paired を true に更新する', async () => {
    const db = makeFirestoreMock()
    const fn = markLogPairedFn(db)

    await fn('doc-1')

    assert.equal(db.updatedDocs.length, 1)
    assert.equal(db.updatedDocs[0]?.id, 'doc-1')
    assert.equal(db.updatedDocs[0]?.data.paired, true)
})
