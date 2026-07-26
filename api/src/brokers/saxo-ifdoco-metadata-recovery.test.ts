import assert from 'node:assert/strict'
import test from 'node:test'

import type { SaxoIfdocoMetadataRecoveryCandidate } from './saxo-order-metadata.js'
import {
    recoverSaxoIfdocoMetadataFromEvidence,
    type SaxoIfdocoRecoveryEvidence,
    type SaxoOpenOrderEvidence,
} from './saxo-ifdoco-metadata-recovery.js'
import type { SaxoOrderActivity } from './saxo-order-activities.js'

const candidate: SaxoIfdocoMetadataRecoveryCandidate = {
    entryOrderId: 'ENTRY',
    side: 'BUY',
    size: 2,
    assetType: 'CfdOnIndex',
    uic: 4912,
}

const activity = (overrides: Partial<SaxoOrderActivity>): SaxoOrderActivity => ({
    LogId: '1',
    OrderId: 'ENTRY',
    Status: 'Placed',
    SubStatus: 'Confirmed',
    BuySell: 'Buy',
    Amount: 2,
    AssetType: 'CfdOnIndex',
    Uic: 4912,
    OrderType: 'Market',
    ExternalReference: 'tg:event-1',
    RelatedOrders: ['STOP', 'LIMIT'],
    ...overrides,
})

const openOrder = (overrides: Partial<SaxoOpenOrderEvidence>): SaxoOpenOrderEvidence => ({
    OrderId: 'ENTRY',
    BuySell: 'Buy',
    Amount: 2,
    AssetType: 'CfdOnIndex',
    Uic: 4912,
    OpenOrderType: 'Market',
    ExternalReference: 'tg:event-1',
    RelatedOpenOrders: [
        { OrderId: 'STOP', Amount: 2, OpenOrderType: 'StopIfTraded', OrderPrice: 98 },
        { OrderId: 'LIMIT', Amount: 2, OpenOrderType: 'Limit', OrderPrice: 103 },
    ],
    ...overrides,
})

const makeEvidence = (
    entryStatus = 'Placed',
    stopStatus = 'Placed',
    limitStatus = 'Placed',
): SaxoIfdocoRecoveryEvidence => ({
    entryActivities: [activity({ Status: entryStatus })],
    exitActivities: {
        STOP: [activity({
            LogId: '2',
            OrderId: 'STOP',
            Status: stopStatus,
            BuySell: 'Sell',
            OrderType: 'StopIfTraded',
            Price: 98,
            RelatedOrders: ['ENTRY', 'LIMIT'],
        })],
        LIMIT: [activity({
            LogId: '3',
            OrderId: 'LIMIT',
            Status: limitStatus,
            BuySell: 'Sell',
            OrderType: 'Limit',
            Price: 103,
            RelatedOrders: ['ENTRY', 'STOP'],
        })],
    },
    openOrders: [
        openOrder({}),
        openOrder({
            OrderId: 'STOP',
            BuySell: 'Sell',
            OpenOrderType: 'StopIfTraded',
            Price: 98,
            RelatedOpenOrders: [
                { OrderId: 'LIMIT', Amount: 2, OpenOrderType: 'Limit', OrderPrice: 103 },
            ],
        }),
        openOrder({
            OrderId: 'LIMIT',
            BuySell: 'Sell',
            OpenOrderType: 'Limit',
            Price: 103,
            RelatedOpenOrders: [
                { OrderId: 'STOP', Amount: 2, OpenOrderType: 'StopIfTraded', OrderPrice: 98 },
            ],
        }),
    ],
})

const expectedMetadata = {
    kind: 'saxo_order_v1',
    order_id: 'ENTRY',
    external_reference: 'tg:event-1',
    entry: {
        expected: { side: 'BUY', order_type: 'Market', size: 2 },
        resolved: { order_id: 'ENTRY', external_reference: 'tg:event-1' },
    },
    exits: [
        {
            expected: {
                role: 'STOP_LOSS',
                side: 'SELL',
                order_type: 'StopIfTraded',
                size: 2,
                price: 98,
            },
            resolved: { order_id: 'STOP', external_reference: 'tg:event-1' },
        },
        {
            expected: {
                role: 'TAKE_PROFIT',
                side: 'SELL',
                order_type: 'Limit',
                size: 2,
                price: 103,
            },
            resolved: { order_id: 'LIMIT', external_reference: 'tg:event-1' },
        },
    ],
}

for (const scenario of [
    { name: 'open', evidence: makeEvidence() },
    {
        name: 'filled entry',
        evidence: { ...makeEvidence('FinalFill'), openOrders: makeEvidence().openOrders.filter(({ OrderId }) => OrderId !== 'ENTRY') },
    },
    { name: 'canceled', evidence: { ...makeEvidence('Cancelled', 'Cancelled', 'Cancelled'), openOrders: [] } },
    { name: '片側 exit 約定', evidence: { ...makeEvidence('FinalFill', 'FinalFill', 'Cancelled'), openOrders: [] } },
]) {
    test(`IFDOCO recovery: ${scenario.name} でも完全な broker evidence があれば成功する`, () => {
        assert.deepEqual(recoverSaxoIfdocoMetadataFromEvidence(candidate, scenario.evidence), {
            kind: 'SUCCESS',
            retryable: false,
            metadata: expectedMetadata,
        })
    })
}

test('IFDOCO recovery: child history 欠落は retryable な履歴不足にする', () => {
    const evidence = makeEvidence()
    delete evidence.exitActivities.LIMIT

    const result = recoverSaxoIfdocoMetadataFromEvidence(candidate, evidence)

    assert.deepEqual(result, {
        kind: 'INSUFFICIENT_HISTORY',
        retryable: true,
        reason: 'EXIT_HISTORY_MISSING',
    })
    assert.equal('metadata' in result, false)
})

test('IFDOCO recovery: related order が1件または3件なら要人手確認にする', () => {
    for (const relatedOrders of [
        ['STOP'],
        ['STOP', 'LIMIT', 'UNKNOWN'],
    ]) {
        const evidence = makeEvidence()
        evidence.entryActivities[0] = activity({ RelatedOrders: relatedOrders })

        const result = recoverSaxoIfdocoMetadataFromEvidence(candidate, evidence)

        assert.deepEqual(result, {
            kind: 'MANUAL_REVIEW',
            retryable: false,
            reason: 'AMBIGUOUS_RELATED_ORDERS',
        })
        assert.equal('metadata' in result, false)
    }
})

test('IFDOCO recovery: exit role が一意でなければ要人手確認にする', () => {
    const evidence = makeEvidence()
    evidence.exitActivities.STOP = [activity({
        LogId: '2',
        OrderId: 'STOP',
        BuySell: 'Sell',
        OrderType: 'Limit',
        Price: 98,
        RelatedOrders: ['ENTRY', 'LIMIT'],
    })]

    assert.deepEqual(recoverSaxoIfdocoMetadataFromEvidence(candidate, evidence), {
        kind: 'MANUAL_REVIEW',
        retryable: false,
        reason: 'AMBIGUOUS_EXIT_ROLE',
    })
})

test('IFDOCO recovery: local entry と履歴の side/size/instrument 不一致は conflict にする', () => {
    for (const entryOverride of [
        { BuySell: 'Sell' as const },
        { Amount: 3 },
        { Uic: 9999 },
    ]) {
        const evidence = makeEvidence()
        evidence.entryActivities[0] = activity(entryOverride)

        assert.deepEqual(recoverSaxoIfdocoMetadataFromEvidence(candidate, evidence), {
            kind: 'CONFLICT',
            retryable: false,
            reason: 'ENTRY_MISMATCH',
        })
    }
})

test('IFDOCO recovery: open order の price 不一致は conflict にする', () => {
    const evidence = makeEvidence()
    evidence.openOrders = evidence.openOrders.map((order) => (
        order.OrderId === 'LIMIT' ? { ...order, Price: 104 } : order
    ))

    assert.deepEqual(recoverSaxoIfdocoMetadataFromEvidence(candidate, evidence), {
        kind: 'CONFLICT',
        retryable: false,
        reason: 'OPEN_ORDER_MISMATCH',
    })
})

test('IFDOCO recovery: ExternalReference 不一致は conflict にし、欠落値を生成しない', () => {
    const evidence = makeEvidence()
    evidence.exitActivities.LIMIT = evidence.exitActivities.LIMIT?.map((item) => ({
        ...item,
        ExternalReference: 'tg:other',
    }))

    assert.deepEqual(recoverSaxoIfdocoMetadataFromEvidence(candidate, evidence), {
        kind: 'CONFLICT',
        retryable: false,
        reason: 'EXTERNAL_REFERENCE_MISMATCH',
    })

    const withoutReference = makeEvidence()
    withoutReference.entryActivities = withoutReference.entryActivities.map((item) => ({
        ...item,
        ExternalReference: undefined,
    }))
    withoutReference.exitActivities = Object.fromEntries(
        Object.entries(withoutReference.exitActivities).map(([orderId, activities]) => [
            orderId,
            activities?.map((item) => ({ ...item, ExternalReference: undefined })),
        ]),
    )
    withoutReference.openOrders = []

    const result = recoverSaxoIfdocoMetadataFromEvidence(candidate, withoutReference)
    assert.equal(result.kind, 'SUCCESS')
    if (result.kind === 'SUCCESS') {
        assert.equal('external_reference' in result.metadata, false)
        assert.equal('external_reference' in result.metadata.entry.resolved, false)
        assert.equal(result.metadata.exits.some((exit) => 'external_reference' in exit.resolved), false)
    }
})
