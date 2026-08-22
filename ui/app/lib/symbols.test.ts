import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { TradableSymbol } from '@trade-gateway/api'
import {
  buildApiSymbolPath,
  buildSymbolDetailPath,
  buildSymbolId,
  buildSymbolOrderConstraintsPayload,
  parseOrderConstraintsForm,
} from './symbols'

test('buildSymbolId joins broker and ticker', () => {
  assert.equal(buildSymbolId('bitflyer', 'BTC_JPY'), 'bitflyer:BTC_JPY')
})

test('buildSymbolDetailPath encodes symbol ids containing colons', () => {
  assert.equal(buildSymbolDetailPath('saxo:FX:NAS100'), '/symbols/saxo%3AFX%3ANAS100')
})

test('buildApiSymbolPath encodes symbol ids containing colons', () => {
  assert.equal(buildApiSymbolPath('saxo:FX:NAS100'), '/api/symbols/saxo%3AFX%3ANAS100')
})

test('parseOrderConstraintsForm accepts integers, decimals, and an omitted max', () => {
  assert.deepEqual(parseOrderConstraintsForm({
    quantity_step: ' 1 ',
    min_order_size: '0.25',
    max_order_size: '',
  }), {
    quantity_step: 1,
    min_order_size: 0.25,
  })
})

test('parseOrderConstraintsForm accepts max equal to min', () => {
  assert.deepEqual(parseOrderConstraintsForm({
    quantity_step: '0.01',
    min_order_size: '10',
    max_order_size: '10',
  }), {
    quantity_step: 0.01,
    min_order_size: 10,
    max_order_size: 10,
  })
})

test('parseOrderConstraintsForm rejects invalid or partial numeric values', () => {
  const invalidValues: Array<[string, Record<string, unknown>, RegExp]> = [
    ['zero quantity step', { quantity_step: '0', min_order_size: '1' }, /quantity_step/],
    ['negative minimum', { quantity_step: '1', min_order_size: '-1' }, /min_order_size/],
    ['NaN quantity step', { quantity_step: 'NaN', min_order_size: '1' }, /quantity_step/],
    ['infinite minimum', { quantity_step: '1', min_order_size: 'Infinity' }, /min_order_size/],
    ['partial quantity step', { quantity_step: '1abc', min_order_size: '1' }, /quantity_step/],
    ['max below minimum', { quantity_step: '1', min_order_size: '2', max_order_size: '1' }, /max_order_size/],
    ['both required fields blank', { quantity_step: '', min_order_size: '' }, /quantity_step.*required/],
    ['missing quantity step', { min_order_size: '1' }, /quantity_step.*required/],
    ['missing minimum', { quantity_step: '1' }, /min_order_size.*required/],
    ['non-string quantity step', { quantity_step: ['1'], min_order_size: '1' }, /quantity_step.*string/],
    ['non-string maximum', { quantity_step: '1', min_order_size: '1', max_order_size: 2 }, /max_order_size.*string/],
  ]

  for (const [name, values, message] of invalidValues) {
    assert.throws(() => parseOrderConstraintsForm(values), message, name)
  }
})

test('buildSymbolOrderConstraintsPayload preserves metadata without trade control', () => {
  const symbol: TradableSymbol = {
    id: 'bitflyer:BTC_JPY',
    broker: 'bitflyer',
    ticker: 'BTC_JPY',
    display_name: 'Bitcoin',
    currency: 'JPY',
    note: 'manual setting',
    trade_control: {
      status: 'paused',
      reason: 'maintenance',
      updated_at: new Date('2026-08-23T00:00:00.000Z'),
    },
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-08-23T00:00:00.000Z'),
  }
  const payload = buildSymbolOrderConstraintsPayload(symbol, {
    quantity_step: 0.001,
    min_order_size: 0.01,
    max_order_size: 1,
  })

  assert.deepEqual(payload, {
    display_name: 'Bitcoin',
    currency: 'JPY',
    note: 'manual setting',
    order_constraints: {
      quantity_step: 0.001,
      min_order_size: 0.01,
      max_order_size: 1,
    },
  })
  assert.equal(Object.hasOwn(payload, 'trade_control'), false)
})
