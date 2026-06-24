import assert from 'node:assert/strict'
import test from 'node:test'

import { buildTradeRecordsFromOrdersV2, createGetTradeRecordsFn, createGetTradeStatsFn } from './trade-records-v2.js'
import type { OrderV2 } from '../types/order-v2.js'

const makeOrder = (overrides: Partial<OrderV2>): OrderV2 => ({
    id: `ord-${Math.random()}`,
    strategy: 'alpha',
    broker: 'bitflyer',
    ticker: 'BTC_JPY',
    side: 'BUY',
    order_type: 'MARKET',
    requested_size: 0.1,
    executed_size: 0.1,
    executed_price: 100,
    status: 'EXECUTED',
    provider_order_ids: ['provider-1'],
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    executed_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
} as OrderV2)

test('buildTradeRecordsFromOrdersV2: BUY と SELL を FIFO でペアリングする', () => {
    const entry = makeOrder({ id: 'entry', side: 'BUY', executed_price: 100, executed_at: new Date('2026-01-01T00:00:00Z') })
    const exit = makeOrder({ id: 'exit', side: 'SELL', executed_price: 120, executed_at: new Date('2026-01-02T00:00:00Z') })

    const records = buildTradeRecordsFromOrdersV2([entry, exit])

    assert.equal(records.length, 1)
    assert.equal(records[0]?.strategy, 'alpha')
    assert.equal(records[0]?.entry_side, 'BUY')
    assert.equal(records[0]?.size, 0.1)
    assert.equal(records[0]?.pnl, 2)
})

test('buildTradeRecordsFromOrdersV2: executed_price が null の EXECUTED 注文は対象外にする', () => {
    const legacyEntry = makeOrder({
        id: 'legacy-entry',
        side: 'BUY',
        executed_price: null,
        executed_at: new Date('2026-01-01T00:00:00Z'),
    })
    const exit = makeOrder({
        id: 'exit',
        side: 'SELL',
        executed_price: 120,
        executed_at: new Date('2026-01-02T00:00:00Z'),
    })

    const records = buildTradeRecordsFromOrdersV2([legacyEntry, exit])

    assert.equal(records.length, 0)
})

test('createGetTradeRecordsFn: 範囲前に建てたポジションが範囲内で閉じられたら返す', async () => {
    let receivedFromMs: number | null = null
    const getTradeRecords = createGetTradeRecordsFn(async (from, to) => {
        receivedFromMs = from.getTime()
        assert.equal(to.toISOString(), '2026-01-31T00:00:00.000Z')
        return [
            makeOrder({ id: 'entry', side: 'BUY', executed_price: 100, executed_at: new Date('2025-12-30T00:00:00Z') }),
            makeOrder({ id: 'exit', side: 'SELL', executed_price: 130, executed_at: new Date('2026-01-10T00:00:00Z') }),
        ]
    })

    const records = await getTradeRecords({
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2026-01-31T00:00:00Z'),
    })

    assert.equal(receivedFromMs, 0)
    assert.equal(records.length, 1)
    assert.equal(records[0]?.closed_at.toISOString(), '2026-01-10T00:00:00.000Z')
})

test('createGetTradeStatsFn: strategy 単位だけで集計する', async () => {
    const getTradeStats = createGetTradeStatsFn(async () => [
        {
            docId: '1',
            strategy: 'alpha',
            ticker: 'BTC_JPY',
            broker: 'bitflyer',
            entry_side: 'BUY',
            entry_price: 100,
            exit_price: 110,
            size: 1,
            pnl: 10,
            entry_event_id: 'e1',
            exit_event_id: 'x1',
            opened_at: new Date('2026-01-01T00:00:00Z'),
            closed_at: new Date('2026-01-02T00:00:00Z'),
        },
        {
            docId: '2',
            strategy: 'alpha',
            ticker: 'ETH_JPY',
            broker: 'bitflyer',
            entry_side: 'SELL',
            entry_price: 200,
            exit_price: 190,
            size: 1,
            pnl: 10,
            entry_event_id: 'e2',
            exit_event_id: 'x2',
            opened_at: new Date('2026-01-03T00:00:00Z'),
            closed_at: new Date('2026-01-04T00:00:00Z'),
        },
    ])

    const stats = await getTradeStats({
        from: new Date('2026-01-01T00:00:00Z'),
        to: new Date('2026-01-31T00:00:00Z'),
    })

    assert.equal(stats.groups.length, 1)
    assert.equal(stats.groups[0]?.strategy, 'alpha')
    assert.equal(stats.groups[0]?.total, 2)
    assert.equal(stats.groups[0]?.total_pnl, 20)
})
