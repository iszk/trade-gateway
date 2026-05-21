import assert from 'node:assert/strict'
import test from 'node:test'

import { matchMarketExecutions, matchIfdocoExecutions, buildTrade } from './trade-matcher.js'
import type { OrderExecution } from '../types/execution.js'

const makeExecution = (overrides: Partial<OrderExecution> & { side: 'BUY' | 'SELL' }): OrderExecution => ({
    id: `exec-${Math.random().toString(36).slice(2)}`,
    strategy: 'MA Crossover',
    symbol: 'BTC_JPY',
    interval: '4H',
    broker: 'bitflyer',
    size: 0.01,
    price: 10_000_000,
    executed_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
})

// ─────────────── matchMarketExecutions ───────────────

test('matchMarketExecutions: BUY → SELL でロングトレードをマッチングする', () => {
    const buy = makeExecution({ id: 'buy-1', side: 'BUY', price: 10_000_000, executed_at: new Date('2026-01-01T00:00:00Z') })
    const sell = makeExecution({ id: 'sell-1', side: 'SELL', price: 11_000_000, executed_at: new Date('2026-01-02T00:00:00Z') })

    const { matched, remaining } = matchMarketExecutions([buy, sell])

    assert.equal(matched.length, 1)
    assert.equal(matched[0]!.entry.id, 'buy-1')
    assert.equal(matched[0]!.exit.id, 'sell-1')
    assert.equal(remaining.length, 0)
})

test('matchMarketExecutions: SELL → BUY でショートトレードをマッチングする', () => {
    const sell = makeExecution({ id: 'sell-1', side: 'SELL', price: 11_000_000, executed_at: new Date('2026-01-01T00:00:00Z') })
    const buy = makeExecution({ id: 'buy-1', side: 'BUY', price: 10_000_000, executed_at: new Date('2026-01-02T00:00:00Z') })

    const { matched, remaining } = matchMarketExecutions([sell, buy])

    assert.equal(matched.length, 1)
    assert.equal(matched[0]!.entry.id, 'sell-1')
    assert.equal(matched[0]!.exit.id, 'buy-1')
    assert.equal(remaining.length, 0)
})

test('matchMarketExecutions: BUY-BUY-SELL-SELL を FIFO でマッチングする', () => {
    const buy1 = makeExecution({ id: 'buy-1', side: 'BUY', price: 10_000_000, executed_at: new Date('2026-01-01T00:00:00Z') })
    const buy2 = makeExecution({ id: 'buy-2', side: 'BUY', price: 10_500_000, executed_at: new Date('2026-01-02T00:00:00Z') })
    const sell1 = makeExecution({ id: 'sell-1', side: 'SELL', price: 11_000_000, executed_at: new Date('2026-01-03T00:00:00Z') })
    const sell2 = makeExecution({ id: 'sell-2', side: 'SELL', price: 12_000_000, executed_at: new Date('2026-01-04T00:00:00Z') })

    // 順不同で渡す
    const { matched, remaining } = matchMarketExecutions([sell2, buy1, sell1, buy2])

    assert.equal(matched.length, 2)
    assert.equal(matched[0]!.entry.id, 'buy-1')
    assert.equal(matched[0]!.exit.id, 'sell-1')
    assert.equal(matched[1]!.entry.id, 'buy-2')
    assert.equal(matched[1]!.exit.id, 'sell-2')
    assert.equal(remaining.length, 0)
})

test('matchMarketExecutions: SELL-SELL-BUY-BUY を FIFO でマッチングする（ショート）', () => {
    const sell1 = makeExecution({ id: 'sell-1', side: 'SELL', executed_at: new Date('2026-01-01T00:00:00Z') })
    const sell2 = makeExecution({ id: 'sell-2', side: 'SELL', executed_at: new Date('2026-01-02T00:00:00Z') })
    const buy1 = makeExecution({ id: 'buy-1', side: 'BUY', executed_at: new Date('2026-01-03T00:00:00Z') })
    const buy2 = makeExecution({ id: 'buy-2', side: 'BUY', executed_at: new Date('2026-01-04T00:00:00Z') })

    const { matched, remaining } = matchMarketExecutions([buy2, sell1, buy1, sell2])

    assert.equal(matched.length, 2)
    assert.equal(matched[0]!.entry.id, 'sell-1')
    assert.equal(matched[0]!.exit.id, 'buy-1')
    assert.equal(matched[1]!.entry.id, 'sell-2')
    assert.equal(matched[1]!.exit.id, 'buy-2')
    assert.equal(remaining.length, 0)
})

test('matchMarketExecutions: マッチしない注文は remaining に残る', () => {
    const buy1 = makeExecution({ id: 'buy-1', side: 'BUY' })
    const buy2 = makeExecution({ id: 'buy-2', side: 'BUY' })
    const sell1 = makeExecution({ id: 'sell-1', side: 'SELL' })

    const { matched, remaining } = matchMarketExecutions([buy1, buy2, sell1])

    assert.equal(matched.length, 1)
    assert.equal(remaining.length, 1)
    assert.ok(remaining.some((e) => e.id === 'buy-2'))
})

test('matchMarketExecutions: 空配列を渡した場合は空を返す', () => {
    const { matched, remaining } = matchMarketExecutions([])
    assert.equal(matched.length, 0)
    assert.equal(remaining.length, 0)
})

test('matchMarketExecutions: strategy+symbol+interval+broker が異なればマッチングしない', () => {
    const buy = makeExecution({ id: 'buy-1', side: 'BUY', strategy: 'Strategy A' })
    const sell = makeExecution({ id: 'sell-1', side: 'SELL', strategy: 'Strategy B' })

    const { matched, remaining } = matchMarketExecutions([buy, sell])

    assert.equal(matched.length, 0)
    assert.equal(remaining.length, 2)
})

test('matchMarketExecutions: 同グループと異グループが混在しても正しくマッチングする', () => {
    const buyA = makeExecution({ id: 'buy-A', side: 'BUY', strategy: 'A' })
    const sellA = makeExecution({ id: 'sell-A', side: 'SELL', strategy: 'A' })
    const buyB = makeExecution({ id: 'buy-B', side: 'BUY', strategy: 'B' })
    // Strategy B の sell なし → buyB は remaining

    const { matched, remaining } = matchMarketExecutions([buyA, sellA, buyB])

    assert.equal(matched.length, 1)
    assert.equal(matched[0]!.entry.id, 'buy-A')
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0]!.id, 'buy-B')
})

// ─────────────── matchIfdocoExecutions ───────────────

test('matchIfdocoExecutions: entry_id で entry と exit を突合する', () => {
    const entry = makeExecution({ id: 'entry-1', side: 'BUY', price: 10_000_000, provider_order_id: 'prov-1' })
    const exit = makeExecution({ id: 'exit-1', side: 'SELL', price: 11_000_000, entry_id: 'entry-1' })

    const { matched, remaining } = matchIfdocoExecutions([entry], [exit])

    assert.equal(matched.length, 1)
    assert.equal(matched[0]!.entry.id, 'entry-1')
    assert.equal(matched[0]!.exit.id, 'exit-1')
    assert.equal(remaining.length, 0)
})

test('matchIfdocoExecutions: 対応するエントリーがない exit は remaining に残る', () => {
    const exit = makeExecution({ id: 'exit-orphan', side: 'SELL', entry_id: 'non-existent' })

    const { matched, remaining } = matchIfdocoExecutions([], [exit])

    assert.equal(matched.length, 0)
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0]!.id, 'exit-orphan')
})

test('matchIfdocoExecutions: エグジットがないエントリーは remaining に残る', () => {
    const entry = makeExecution({ id: 'entry-waiting', side: 'BUY', provider_order_id: 'prov-1' })

    const { matched, remaining } = matchIfdocoExecutions([entry], [])

    assert.equal(matched.length, 0)
    assert.equal(remaining.length, 1)
    assert.equal(remaining[0]!.id, 'entry-waiting')
})

test('matchIfdocoExecutions: 複数ペアを正しく突合する', () => {
    const entry1 = makeExecution({ id: 'entry-1', side: 'BUY', provider_order_id: 'prov-1' })
    const entry2 = makeExecution({ id: 'entry-2', side: 'BUY', provider_order_id: 'prov-2' })
    const exit1 = makeExecution({ id: 'exit-1', side: 'SELL', entry_id: 'entry-1' })
    const exit2 = makeExecution({ id: 'exit-2', side: 'SELL', entry_id: 'entry-2' })

    const { matched, remaining } = matchIfdocoExecutions([entry1, entry2], [exit1, exit2])

    assert.equal(matched.length, 2)
    assert.ok(matched.some((p) => p.entry.id === 'entry-1' && p.exit.id === 'exit-1'))
    assert.ok(matched.some((p) => p.entry.id === 'entry-2' && p.exit.id === 'exit-2'))
    assert.equal(remaining.length, 0)
})

// ─────────────── buildTrade ───────────────

test('buildTrade: ロング（BUY→SELL）の PnL を正しく計算する', () => {
    const entry = makeExecution({ id: 'buy-1', side: 'BUY', price: 10_000_000, size: 0.01, executed_at: new Date('2026-01-01T00:00:00Z') })
    const exit = makeExecution({ id: 'sell-1', side: 'SELL', price: 11_000_000, executed_at: new Date('2026-01-02T00:00:00Z') })

    const trade = buildTrade({ entry, exit })

    assert.equal(trade.entry_side, 'BUY')
    assert.equal(trade.entry_price, 10_000_000)
    assert.equal(trade.exit_price, 11_000_000)
    assert.ok(Math.abs(trade.pnl - 10_000) < 0.001) // (11M - 10M) * 0.01
    assert.equal(trade.entry_id, 'buy-1')
    assert.equal(trade.exit_id, 'sell-1')
    assert.deepEqual(trade.opened_at, new Date('2026-01-01T00:00:00Z'))
    assert.deepEqual(trade.closed_at, new Date('2026-01-02T00:00:00Z'))
})

test('buildTrade: ショート（SELL→BUY）の PnL を正しく計算する', () => {
    const entry = makeExecution({ id: 'sell-1', side: 'SELL', price: 11_000_000, size: 0.01 })
    const exit = makeExecution({ id: 'buy-1', side: 'BUY', price: 10_000_000 })

    const trade = buildTrade({ entry, exit })

    assert.equal(trade.entry_side, 'SELL')
    assert.ok(Math.abs(trade.pnl - 10_000) < 0.001) // (11M - 10M) * 0.01
})

test('buildTrade: PnL が負になるケース（損切り）', () => {
    const entry = makeExecution({ id: 'buy-1', side: 'BUY', price: 10_000_000, size: 0.01 })
    const exit = makeExecution({ id: 'sell-1', side: 'SELL', price: 9_000_000 })

    const trade = buildTrade({ entry, exit })

    assert.ok(trade.pnl < 0)
    assert.ok(Math.abs(trade.pnl - (-10_000)) < 0.001)
})
