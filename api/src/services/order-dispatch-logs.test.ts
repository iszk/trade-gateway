import assert from 'node:assert/strict'
import test from 'node:test'

import { createOrderDispatchLogFn, getPendingExecutionLogsFn, updateExecutionPriceFn } from './order-dispatch-logs.js'

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
        strategy: 'MA Crossover',
        interval: '4H',
        price: 18000,
        provider_order_id: 'order-123',
        request_payload: {},
        result: 'success',
    })

    const savedDoc = db.addedDocs[0]
    assert.equal(savedDoc?.ticker, 'CfdOnIndex:4912')
    assert.equal(savedDoc?.side, 'SELL')
    assert.equal(savedDoc?.size, 1)
    assert.equal(savedDoc?.strategy, 'MA Crossover')
    assert.equal(savedDoc?.interval, '4H')
    assert.equal(savedDoc?.price, 18000)
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

// getPendingExecutionLogsFn / updateExecutionPriceFn のテスト用モック
const makeFullFirestoreMock = () => {
    const store: Record<string, Record<string, unknown>> = {}
    const updatedDocs: { id: string; data: Record<string, unknown> }[] = []

    const db = {
        collection: (_name: string) => ({
            where: (_field: string, _op: string, _val: unknown) => ({
                where: (_field2: string, _op2: string, _val2: unknown) => ({
                    get: async () => ({
                        docs: Object.entries(store).map(([id, data]) => ({
                            id,
                            data: () => data,
                        })),
                    }),
                }),
            }),
            doc: (id: string) => ({
                update: async (data: Record<string, unknown>) => {
                    updatedDocs.push({ id, data })
                },
            }),
        }),
        store,
        updatedDocs,
    }

    return db as unknown as Parameters<typeof getPendingExecutionLogsFn>[0] & {
        store: Record<string, Record<string, unknown>>
        updatedDocs: { id: string; data: Record<string, unknown> }[]
    }
}

test('getPendingExecutionLogsFn returns logs missing execution_price', async () => {
    const db = makeFullFirestoreMock()

    // execution_price あり → 対象外
    db.store['doc-1'] = { broker: 'bitflyer', provider_order_id: 'JRF-1', result: 'success', execution_price: 9500000, created_at: new Date() }
    // execution_price なし → 対象
    db.store['doc-2'] = { broker: 'bitflyer', provider_order_id: 'JRF-2', result: 'success', created_at: new Date() }
    // provider_order_id なし → 対象外
    db.store['doc-3'] = { broker: 'bitflyer', result: 'success', created_at: new Date() }

    const getPendingExecutionLogs = getPendingExecutionLogsFn(db)
    const logs = await getPendingExecutionLogs()

    assert.equal(logs.length, 1)
    assert.equal(logs[0]?.docId, 'doc-2')
    assert.equal(logs[0]?.broker, 'bitflyer')
    assert.equal(logs[0]?.provider_order_id, 'JRF-2')
})

test('updateExecutionPriceFn updates the document with execution_price', async () => {
    const db = makeFullFirestoreMock()
    const update = updateExecutionPriceFn(db)

    await update('doc-1', 9500000)

    assert.equal(db.updatedDocs.length, 1)
    assert.equal(db.updatedDocs[0]?.id, 'doc-1')
    assert.equal(db.updatedDocs[0]?.data.execution_price, 9500000)
})
