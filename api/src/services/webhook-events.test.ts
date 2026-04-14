import test from 'node:test'
import assert from 'node:assert/strict'

import { createWebhookEventFn, DuplicateEventError } from './webhook-events.js'
import type { WebhookEventInput } from './webhook-events.js'

const makeInput = (eventId: string): WebhookEventInput => ({
    event_id: eventId,
    source: 'tradingview',
    broker: 'bitflyer',
    symbol: 'BTC_JPY',
    side: 'BUY',
    order_type: 'MARKET',
    size: 0.01,
    occurred_at: new Date('2026-01-01T00:00:00Z'),
    received_at: new Date('2026-01-01T00:00:01Z'),
    status: 'accepted',
})

const makeFirestoreMock = () => {
    const docs: Record<string, unknown> = {}

    const docRef = (id: string) => ({
        create: async (data: unknown) => {
            if (id in docs) {
                const error = new Error('Document already exists') as Error & { code: number }
                error.code = 6
                throw error
            }
            docs[id] = data
        },
    })

    const db = {
        collection: (_name: string) => ({
            doc: (id: string) => docRef(id),
        }),
        docs,
    }

    return db as unknown as Parameters<typeof createWebhookEventFn>[0] & { docs: Record<string, unknown> }
}

test('createWebhookEventFn saves document to Firestore', async () => {
    const db = makeFirestoreMock()
    const createWebhookEvent = createWebhookEventFn(db)

    await createWebhookEvent(makeInput('evt-001'))

    assert.ok('bitflyer:BTC_JPY:evt-001' in db.docs)
})

test('createWebhookEventFn sets expire_at to received_at + 90 days', async () => {
    const db = makeFirestoreMock()
    const createWebhookEvent = createWebhookEventFn(db)

    const receivedAt = new Date('2026-01-01T00:00:00Z')
    await createWebhookEvent({ ...makeInput('evt-expire-1'), received_at: receivedAt })

    const doc = db.docs['bitflyer:BTC_JPY:evt-expire-1'] as Record<string, unknown>
    const expectedExpireAt = new Date(receivedAt.getTime() + 90 * 24 * 60 * 60 * 1000)
    assert.deepEqual(doc.expire_at, expectedExpireAt)
})

test('createWebhookEventFn throws DuplicateEventError on duplicate event_id', async () => {
    const db = makeFirestoreMock()
    const createWebhookEvent = createWebhookEventFn(db)

    await createWebhookEvent(makeInput('evt-dup'))

    await assert.rejects(
        () => createWebhookEvent(makeInput('evt-dup')),
        (error) => {
            assert.ok(error instanceof DuplicateEventError)
            return true
        },
    )
})
