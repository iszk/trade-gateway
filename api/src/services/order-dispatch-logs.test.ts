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
