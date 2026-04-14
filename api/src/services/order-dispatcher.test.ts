import assert from 'node:assert/strict'
import test from 'node:test'

import { BitflyerClient } from '../brokers/bitflyer.js'
import type { SaxoClient } from '../brokers/saxo.js'
import { createOrderDispatcher, resolveBroker } from './order-dispatcher.js'

test('resolveBroker uses bitflyer for auto', () => {
    assert.equal(resolveBroker('auto', 'BTC_JPY'), 'bitflyer')
    assert.equal(resolveBroker(undefined, 'BTC_JPY'), 'bitflyer')
    assert.equal(resolveBroker('bitflyer', 'BTC_JPY'), 'bitflyer')
})

test('resolveBroker resolves broker from ticker when broker is auto', () => {
    assert.equal(resolveBroker('auto', 'BTC_JPY'), 'bitflyer')
    assert.equal(resolveBroker('auto', 'BTC/JPY'), 'bitflyer')
    assert.equal(resolveBroker('auto', 'FX_BTC_JPY'), 'bitflyer')
    assert.equal(resolveBroker('auto', 'BTCJPY'), 'bitflyer')
    assert.equal(resolveBroker('auto', 'btcjpy'), 'bitflyer')
    // マップにない ticker も bitflyer にフォールバック
    assert.equal(resolveBroker('auto', 'UNKNOWN_TICKER'), 'bitflyer')
})

test('createOrderDispatcher dispatches to bitflyer handler', async () => {
    let called = false
    const fakeClient = {
        sendMarketOrder: async () => {
            called = true
            return {
                ok: true,
                broker: 'bitflyer' as const,
                providerOrderId: 'JRF-dispatched',
            }
        },
    } as unknown as BitflyerClient

    const dispatchOrder = createOrderDispatcher({
        bitflyerClient: fakeClient,
    })

    const result = await dispatchOrder({
        eventId: 'evt-1',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        size: 0.01,
        requestId: 'req-1',
    })

    assert.equal(called, true)
    assert.deepEqual(result, {
        ok: true,
        broker: 'bitflyer',
        providerOrderId: 'JRF-dispatched',
    })
})

test('createOrderDispatcher dispatches to saxo handler', async () => {
    let called = false
    const fakeClient = {
        sendMarketOrder: async () => {
            called = true
            return {
                ok: true,
                broker: 'saxo' as const,
                providerOrderId: 'SAXO-dispatched',
            }
        },
    } as unknown as SaxoClient

    const dispatchOrder = createOrderDispatcher({
        saxoClient: fakeClient,
    })

    const result = await dispatchOrder({
        eventId: 'evt-1',
        broker: 'saxo',
        ticker: 'BTC_JPY',
        side: 'BUY',
        size: 0.01,
        requestId: 'req-1',
    })

    assert.equal(called, true)
    assert.deepEqual(result, {
        ok: true,
        broker: 'saxo',
        providerOrderId: 'SAXO-dispatched',
    })
})

test('createOrderDispatcher returns unsupported for unknown broker', async () => {
    const dispatchOrder = createOrderDispatcher({
        bitflyerClient: {
            sendMarketOrder: async () => ({
                ok: true,
                broker: 'bitflyer',
                providerOrderId: 'JRF-not-used',
            }),
        } as unknown as BitflyerClient,
        saxoClient: {} as any, // Mock to avoid Firestore init
    })

    const result = await dispatchOrder({
        eventId: 'evt-unsupported',
        broker: 'unknown' as any,
        ticker: 'BTC_JPY',
        side: 'SELL',
        size: 0.02,
        requestId: 'req-unsupported',
    })

    assert.deepEqual(result, {
        ok: false,
        broker: 'unknown',
        code: 'BROKER_NOT_SUPPORTED',
        message: 'unsupported broker: unknown',
    })
})
