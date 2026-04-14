import assert from 'node:assert/strict'
import test from 'node:test'

import { DummyClient } from './dummy.js'

const makeOrder = () => ({
    eventId: 'evt-1',
    broker: 'dummy' as const,
    ticker: 'btc/jpy',
    side: 'BUY' as const,
    size: 0.01,
    requestId: 'req-1',
})

test('DummyClient returns success with providerOrderId derived from requestId', async () => {
    const client = new DummyClient()

    const result = await client.sendMarketOrder(makeOrder())

    assert.deepEqual(result, {
        ok: true,
        broker: 'dummy',
        providerOrderId: 'dummy-req-1',
    })
})
