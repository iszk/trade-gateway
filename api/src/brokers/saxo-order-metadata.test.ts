import assert from 'node:assert/strict'
import test from 'node:test'

import {
    buildSaxoLegacyMarketMetadata,
    classifySaxoOrderMetadata,
} from './saxo-order-metadata.js'

const makeOrder = (overrides: Record<string, unknown> = {}) => ({
    broker: 'saxo',
    ticker: 'FxSpot:21',
    order_type: 'MARKET',
    side: 'BUY',
    requested_size: 1,
    provider_order_ids: ['ORD-1'],
    broker_order_metadata: undefined,
    ...overrides,
}) as any

const validMetadata = {
    kind: 'saxo_order_v1',
    order_id: 'ORD-1',
    entry: {
        expected: { side: 'BUY', order_type: 'Market', size: 1 },
        resolved: { order_id: 'ORD-1' },
    },
    exits: [],
}

test('Saxo metadata classifier: metadata 欠落の単体 MARKET は最小 metadata を合成する', () => {
    const result = classifySaxoOrderMetadata(makeOrder())

    assert.deepEqual(result, {
        kind: 'RECOVERABLE_MARKET',
        metadata: buildSaxoLegacyMarketMetadata({ side: 'BUY', requested_size: 1 }, 'ORD-1'),
    })
    assert.equal('external_reference' in result.metadata, false)
    assert.deepEqual(result.metadata.exits, [])
})

test('Saxo metadata classifier: null metadata の単体 MARKET は未設定として最小 metadata を合成する', () => {
    assert.deepEqual(
        classifySaxoOrderMetadata(makeOrder({ broker_order_metadata: null })),
        {
            kind: 'RECOVERABLE_MARKET',
            metadata: buildSaxoLegacyMarketMetadata({ side: 'BUY', requested_size: 1 }, 'ORD-1'),
        },
    )
})

test('Saxo metadata classifier: provider ID は trim して metadata に保存する', () => {
    const result = classifySaxoOrderMetadata(makeOrder({ provider_order_ids: [' ORD-1 '] }))

    assert.equal(result.kind, 'RECOVERABLE_MARKET')
    if (result.kind === 'RECOVERABLE_MARKET') {
        assert.equal(result.metadata.order_id, 'ORD-1')
        assert.equal(result.metadata.entry.resolved.order_id, 'ORD-1')
    }
})

test('Saxo metadata classifier: valid metadata は同一 object を VALID として返す', () => {
    const order = makeOrder({ broker_order_metadata: validMetadata })
    const result = classifySaxoOrderMetadata(order)

    assert.equal(result.kind, 'VALID')
    if (result.kind === 'VALID') assert.strictEqual(result.metadata, validMetadata)
})

test('Saxo metadata classifier: IFDOCO の valid metadata は自動補完対象外だが VALID として扱う', () => {
    const metadata = {
        ...validMetadata,
        exits: [{
            expected: {
                role: 'TAKE_PROFIT', side: 'SELL', order_type: 'Limit', size: 1, price: 101,
            },
            resolved: { order_id: 'ORD-exit' },
        }],
    }
    const result = classifySaxoOrderMetadata(makeOrder({ order_type: 'IFDOCO', broker_order_metadata: metadata }))

    assert.equal(result.kind, 'VALID')
})

test('Saxo metadata classifier: metadata 欠落 IFDOCO は正規化済み recovery candidate にする', () => {
    const result = classifySaxoOrderMetadata(makeOrder({
        ticker: ' CfdOnIndex:4912 ',
        order_type: 'IFDOCO',
        provider_order_ids: [' ORD-entry '],
        side: 'SELL',
        requested_size: 2,
    }))

    assert.deepEqual(result, {
        kind: 'RECOVERABLE_IFDOCO',
        candidate: {
            entryOrderId: 'ORD-entry',
            side: 'SELL',
            size: 2,
            assetType: 'CfdOnIndex',
            uic: 4912,
        },
    })
})

test('Saxo metadata classifier: null metadata の IFDOCO は未設定として recovery candidate にする', () => {
    assert.equal(classifySaxoOrderMetadata(makeOrder({
        order_type: 'IFDOCO',
        broker_order_metadata: null,
    })).kind, 'RECOVERABLE_IFDOCO')
})

test('Saxo metadata classifier: IFDOCO の空 exits metadata は完全な metadata とみなさない', () => {
    assert.deepEqual(classifySaxoOrderMetadata(makeOrder({
        order_type: 'IFDOCO',
        broker_order_metadata: validMetadata,
    })), {
        kind: 'UNRECOVERABLE',
        reason: 'METADATA_CONFLICT',
    })
})

const unrecoverableCases: Array<[string, Record<string, unknown>, string]> = [
    ['broker mismatch', { broker: 'bitflyer' }, 'BROKER_MISMATCH'],
    ['unsupported order type', { order_type: 'LIMIT' }, 'ORDER_TYPE_UNSUPPORTED'],
    ['invalid IFDOCO ticker', { order_type: 'IFDOCO', ticker: 'FxSpot:not-a-uic' }, 'TICKER_INVALID'],
    ['provider id missing', { provider_order_ids: [] }, 'PROVIDER_ORDER_ID_MISSING'],
    ['provider id blank', { provider_order_ids: ['  '] }, 'PROVIDER_ORDER_ID_MISSING'],
    ['dry run', { provider_order_ids: ['DRY_RUN'] }, 'DRY_RUN'],
    ['trimmed dry run', { provider_order_ids: [' DRY_RUN '] }, 'DRY_RUN'],
    ['wrong metadata kind', { broker_order_metadata: { kind: 'bitflyer_parent_order_v1' } }, 'METADATA_KIND_CONFLICT'],
    ['malformed Saxo metadata', { broker_order_metadata: { kind: 'saxo_order_v1' } }, 'METADATA_INVALID'],
    ['provider id conflict', { broker_order_metadata: { ...validMetadata, order_id: 'ORD-other' } }, 'METADATA_CONFLICT'],
    ['side conflict', {
        broker_order_metadata: {
            ...validMetadata,
            entry: { ...validMetadata.entry, expected: { ...validMetadata.entry.expected, side: 'SELL' } },
        },
    }, 'METADATA_CONFLICT'],
    ['market with exits', {
        broker_order_metadata: {
            ...validMetadata,
            exits: [{
                expected: { role: 'STOP_LOSS', side: 'SELL', order_type: 'StopIfTraded', size: 1, price: 99 },
                resolved: { order_id: null },
            }],
        },
    }, 'METADATA_CONFLICT'],
]

for (const [name, overrides, reason] of unrecoverableCases) {
    test(`Saxo metadata classifier: ${name}`, () => {
        assert.deepEqual(classifySaxoOrderMetadata(makeOrder(overrides)), {
            kind: 'UNRECOVERABLE',
            reason,
        })
    })
}
