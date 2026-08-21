import assert from 'node:assert/strict'
import test from 'node:test'

import { createOrderDispatchLogFn } from './order-dispatch-logs.js'

const makeFirestoreMock = () => {
    const addedDocs: Record<string, unknown>[] = []

    const db = {
        collection: (name: string) => ({
            add: async (data: Record<string, unknown>) => {
                addedDocs.push({ collection: name, ...data })
            },
        }),
        addedDocs,
    }

    return db as unknown as Parameters<typeof createOrderDispatchLogFn>[0] & {
        addedDocs: Record<string, unknown>[]
    }
}

test('createOrderDispatchLogFn omits undefined fields before saving to Firestore', async () => {
    const db = makeFirestoreMock()
    const createOrderDispatchLog = createOrderDispatchLogFn(db)

    await createOrderDispatchLog({
        event_id: 'evt-001',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        size: 0.01,
        request_payload: {
            eventId: 'evt-001',
        },
        response_payload: undefined,
        result: 'success',
        error_code: undefined,
    })

    assert.equal(db.addedDocs.length, 1)
    const savedDoc = db.addedDocs[0]

    assert.equal(savedDoc?.collection, 'order_dispatch_logs')
    assert.equal('response_payload' in savedDoc, false)
    assert.equal('error_code' in savedDoc, false)
    assert.equal(savedDoc?.event_id, 'evt-001')
    assert.equal(savedDoc?.result, 'success')
})

test('createOrderDispatchLogFn saves ticker, side, size as structured fields', async () => {
    const db = makeFirestoreMock()
    const createOrderDispatchLog = createOrderDispatchLogFn(db)

    await createOrderDispatchLog({
        event_id: 'evt-002',
        broker: 'saxo',
        ticker: 'CfdOnIndex:4912',
        side: 'SELL',
        size: 1,
        input_size: 2,
        effective_size: 1,
        sizing_mode: 'WEBHOOK_CAPPED',
        policy_version: 4,
        position_before: 0.5,
        position_after: -0.5,
        decision_reason: 'CALCULATED',
        dry_run: true,
        certainty: 'CONFIRMED_SUCCESS',
        strategy_id: 'alpha',
        symbol_id: 'saxo:CfdOnIndex:4912',
        order_id: 'evt-002',
        reservation_id: 'r_123',
        provider_order_id: 'order-123',
        request_payload: {},
        result: 'success',
    })

    const savedDoc = db.addedDocs[0]
    assert.equal(savedDoc?.ticker, 'CfdOnIndex:4912')
    assert.equal(savedDoc?.side, 'SELL')
    assert.equal(savedDoc?.size, 1)
    assert.equal(savedDoc?.input_size, 2)
    assert.equal(savedDoc?.effective_size, 1)
    assert.equal(savedDoc?.sizing_mode, 'WEBHOOK_CAPPED')
    assert.equal(savedDoc?.policy_version, 4)
    assert.equal(savedDoc?.position_before, 0.5)
    assert.equal(savedDoc?.position_after, -0.5)
    assert.equal(savedDoc?.decision_reason, 'CALCULATED')
    assert.equal(savedDoc?.dry_run, true)
    assert.equal(savedDoc?.certainty, 'CONFIRMED_SUCCESS')
    assert.equal(savedDoc?.strategy_id, 'alpha')
    assert.equal(savedDoc?.symbol_id, 'saxo:CfdOnIndex:4912')
    assert.equal(savedDoc?.order_id, 'evt-002')
    assert.equal(savedDoc?.reservation_id, 'r_123')
    assert.equal('price' in savedDoc, false)
    assert.equal(savedDoc?.provider_order_id, 'order-123')
})

test('createOrderDispatchLogFn omits optional fields when not provided', async () => {
    const db = makeFirestoreMock()
    const createOrderDispatchLog = createOrderDispatchLogFn(db)

    await createOrderDispatchLog({
        event_id: 'evt-003',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        side: 'BUY',
        size: 0.05,
        request_payload: {},
        result: 'failure',
        error_code: 'BROKER_REQUEST_FAILED',
    })

    const savedDoc = db.addedDocs[0]
    assert.equal('strategy' in savedDoc, false)
    assert.equal('interval' in savedDoc, false)
    assert.equal('price' in savedDoc, false)
    assert.equal('provider_order_id' in savedDoc, false)
    assert.equal('execution_price' in savedDoc, false)
    assert.equal(savedDoc?.error_code, 'BROKER_REQUEST_FAILED')
})
