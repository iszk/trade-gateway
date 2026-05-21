import assert from 'node:assert/strict'
import test from 'node:test'

import { addTradeFn, getTradesFn, computeStats } from './trades.js'
import type { Trade } from '../types/trade.js'

const makeTrade = (pnl: number, openedAt: Date = new Date('2026-01-01')): Trade => ({
    id: `trade-${Math.random().toString(36).slice(2)}`,
    strategy: 'MA Crossover',
    symbol: 'BTC_JPY',
    interval: '4H',
    broker: 'bitflyer',
    entry_side: pnl >= 0 ? 'BUY' : 'SELL',
    entry_price: 10_000_000,
    exit_price: 10_000_000 + pnl / 0.01,
    size: 0.01,
    pnl,
    entry_id: 'exec-entry',
    exit_id: 'exec-exit',
    opened_at: openedAt,
    closed_at: new Date(openedAt.getTime() + 3_600_000),
})

// ─────────────── Firestore モック ───────────────

const makeFirestoreMock = () => {
    const store: Record<string, Record<string, unknown>> = {}
    const addedDocs: Record<string, unknown>[] = []

    const db = {
        collection: (name: string) => ({
            where: (_f: string, _op: string, _v: unknown) => ({
                where: (_f2: string, _op2: string, _v2: unknown) => ({
                    orderBy: (_field: string, _dir: string) => ({
                        get: async () => ({
                            docs: Object.entries(store).map(([id, data]) => ({
                                id,
                                data: () => data,
                            })),
                        }),
                    }),
                }),
            }),
            add: async (data: Record<string, unknown>) => {
                addedDocs.push({ _collection: name, ...data })
                return { id: `doc-${addedDocs.length}` }
            },
        }),
        store,
        addedDocs,
    }

    return db as unknown as Parameters<typeof addTradeFn>[0] & {
        store: typeof store
        addedDocs: typeof addedDocs
    }
}

// ─────────────── addTradeFn ───────────────

test('addTradeFn: trades コレクションに保存し expire_at を設定する', async () => {
    const db = makeFirestoreMock()
    const fn = addTradeFn(db)
    const closedAt = new Date('2026-01-02T00:00:00Z')

    await fn({
        strategy: 'MA', interval: '4H', symbol: 'BTC_JPY', broker: 'bitflyer',
        entry_side: 'BUY', entry_price: 10_000_000, exit_price: 11_000_000,
        size: 0.01, pnl: 10_000,
        entry_id: 'exec-1', exit_id: 'exec-2',
        opened_at: new Date('2026-01-01T00:00:00Z'), closed_at: closedAt,
    })

    assert.equal(db.addedDocs.length, 1)
    const doc = db.addedDocs[0]!
    assert.equal(doc._collection, 'trades')
    // expire_at = closed_at + 2年
    const expectedExpire = new Date(closedAt.getTime() + 2 * 365 * 24 * 60 * 60 * 1000)
    assert.deepEqual(doc.expire_at, expectedExpire)
})

// ─────────────── computeStats ───────────────

test('computeStats: 空配列では全 0 / null を返す', () => {
    const stats = computeStats([])

    assert.equal(stats.total, 0)
    assert.equal(stats.win_count, 0)
    assert.equal(stats.loss_count, 0)
    assert.equal(stats.win_rate, 0)
    assert.equal(stats.total_pnl, 0)
    assert.equal(stats.avg_pnl, 0)
    assert.equal(stats.avg_win, null)
    assert.equal(stats.avg_loss, null)
    assert.equal(stats.profit_factor, null)
    assert.equal(stats.max_drawdown, 0)
    assert.equal(stats.sharpe_ratio, null)
})

test('computeStats: 勝ち・負けが混在する基本ケース', () => {
    const trades = [
        makeTrade(1000),
        makeTrade(500),
        makeTrade(-300),
        makeTrade(200),
        makeTrade(-100),
    ]
    const stats = computeStats(trades)

    assert.equal(stats.total, 5)
    assert.equal(stats.win_count, 3)
    assert.equal(stats.loss_count, 2)
    assert.ok(Math.abs(stats.win_rate - 0.6) < 1e-10)
    assert.ok(Math.abs(stats.total_pnl - 1300) < 1e-10)
    assert.ok(Math.abs(stats.avg_pnl - 260) < 1e-10)
    assert.ok(Math.abs((stats.avg_win ?? 0) - 1700 / 3) < 1e-6)
    assert.ok(Math.abs((stats.avg_loss ?? 0) - (-200)) < 1e-10)
    assert.ok(Math.abs((stats.profit_factor ?? 0) - (1700 / 400)) < 1e-10)
})

test('computeStats: 全て勝ちの場合 avg_loss=null / profit_factor=null', () => {
    const trades = [makeTrade(100), makeTrade(200), makeTrade(300)]
    const stats = computeStats(trades)

    assert.equal(stats.loss_count, 0)
    assert.equal(stats.avg_loss, null)
    assert.equal(stats.profit_factor, null)
})

test('computeStats: max_drawdown を正しく計算する', () => {
    // 累積PnL: 1000→1500→1200→1400→1300, peak: 1000→1500→1500→1500→1500
    // drawdown: 0→0→300→100→200 → max=300
    const trades = [
        makeTrade(1000, new Date('2026-01-01')),
        makeTrade(500,  new Date('2026-01-02')),
        makeTrade(-300, new Date('2026-01-03')),
        makeTrade(200,  new Date('2026-01-04')),
        makeTrade(-100, new Date('2026-01-05')),
    ]
    const stats = computeStats(trades)

    assert.ok(Math.abs(stats.max_drawdown - 300) < 1e-10)
})

test('computeStats: sharpe_ratio は10件以上のときのみ計算する', () => {
    const fewTrades = Array.from({ length: 9 }, () => makeTrade(100))
    assert.equal(computeStats(fewTrades).sharpe_ratio, null)

    const enoughTrades = Array.from({ length: 10 }, (_, i) => makeTrade(i % 2 === 0 ? 100 : -50))
    assert.notEqual(computeStats(enoughTrades).sharpe_ratio, null)
})
