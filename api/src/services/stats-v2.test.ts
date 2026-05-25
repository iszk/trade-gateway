import assert from 'node:assert/strict'
import test from 'node:test'
import { computeStatsV2 } from './stats-v2.js'
import type { OrderV2 } from '../types/order-v2.js'

const makeOrder = (overrides: Partial<OrderV2>): OrderV2 => ({
    id: `ord-${Math.random()}`,
    strategy: 'test-strategy',
    broker: 'bitflyer',
    ticker: 'BTC_JPY',
    side: 'BUY',
    order_type: 'MARKET',
    requested_size: 0.01,
    executed_size: 0.01,
    executed_price: 1000000,
    status: 'EXECUTED',
    provider_order_ids: ['test-id'],
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
})

test('computeStatsV2: basic buy and sell', () => {
    const orders: OrderV2[] = [
        makeOrder({ side: 'BUY', executed_price: 1000000, created_at: new Date('2026-01-01T00:00:00Z') }),
        makeOrder({ side: 'SELL', executed_price: 1100000, created_at: new Date('2026-01-01T01:00:00Z') }),
    ]
    const stats = computeStatsV2(orders, 'test-strategy')
    assert.equal(stats.current_position, 0)
    assert.equal(stats.realized_pnl, 1000) // (1100000 - 1000000) * 0.01
    assert.equal(stats.total_trades, 1)
    assert.equal(stats.win_rate, 1)
})

test('computeStatsV2: partial close', () => {
    const orders: OrderV2[] = [
        makeOrder({ side: 'BUY', executed_price: 1000000, executed_size: 0.01, created_at: new Date('2026-01-01T00:00:00Z') }),
        makeOrder({ side: 'SELL', executed_price: 1100000, executed_size: 0.004, created_at: new Date('2026-01-01T01:00:00Z') }),
    ]
    const stats = computeStatsV2(orders, 'test-strategy')
    assert.equal(stats.current_position, 0.006)
    assert.equal(stats.realized_pnl, 400) // (1100000 - 1000000) * 0.004
    assert.equal(stats.total_trades, 1)
})

test('computeStatsV2: doten (reverse position)', () => {
    const orders: OrderV2[] = [
        makeOrder({ side: 'BUY', executed_price: 1000000, executed_size: 0.01, created_at: new Date('2026-01-01T00:00:00Z') }),
        makeOrder({ side: 'SELL', executed_price: 1100000, executed_size: 0.015, created_at: new Date('2026-01-01T01:00:00Z') }),
    ]
    const stats = computeStatsV2(orders, 'test-strategy')
    assert.equal(stats.current_position, -0.005)
    assert.equal(stats.realized_pnl, 1000) // (1100000 - 1000000) * 0.01
    assert.equal(stats.average_entry_price, 1100000)
})
