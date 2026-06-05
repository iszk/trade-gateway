import test from 'node:test'
import assert from 'node:assert/strict'

import { createWebhookEventFn, DuplicateEventError } from './webhook-events.js'
import type { WebhookEventInput } from './webhook-events.js'
import type { Logger } from '../logger.js'

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

const makeLoggerStub = () => {
    const errors: Record<string, unknown>[] = []
    const logger: Logger = {
        info: () => { },
        warn: () => { },
        error: (obj) => { errors.push(obj) },
        child: () => logger,
    }
    return { logger, errors }
}

test('createWebhookEventFn saves document to Firestore', async () => {
    const db = makeFirestoreMock()
    const createWebhookEvent = createWebhookEventFn(db)

    await createWebhookEvent(makeInput('evt-001'))

    assert.ok('bitflyer:BTC_JPY:evt-001' in db.docs)
})

test('createWebhookEventFn omits undefined fields before saving to Firestore', async () => {
    const db = makeFirestoreMock()
    const createWebhookEvent = createWebhookEventFn(db)

    await createWebhookEvent({
        ...makeInput('evt-undefined'),
        rejection_reason: undefined,
    })

    const doc = db.docs['bitflyer:BTC_JPY:evt-undefined'] as Record<string, unknown>
    assert.equal('rejection_reason' in doc, false)
})

test('createWebhookEventFn uses firestore write failure log on create failure', async () => {
    const firestoreError = new Error('Firestore unavailable')
    const db = {
        collection: () => ({
            doc: () => ({
                create: async () => {
                    throw firestoreError
                },
            }),
        }),
    } as unknown as Parameters<typeof createWebhookEventFn>[0]
    const { logger, errors } = makeLoggerStub()
    const createWebhookEvent = createWebhookEventFn(db, { logger })

    await assert.rejects(
        () => createWebhookEvent({
            ...makeInput('evt-firestore-failed'),
            rejection_reason: undefined,
        }),
        firestoreError,
    )

    assert.equal(errors.length, 1)
    assert.equal(errors[0]?.event, 'firestore:write_failed')
    assert.equal(errors[0]?.operation, 'create')
    assert.equal(errors[0]?.collection, 'webhook_events')
    assert.equal(errors[0]?.doc_id, 'bitflyer:BTC_JPY:evt-firestore-failed')
    assert.equal(errors[0]?.error, firestoreError)

    const data = errors[0]?.data as Record<string, unknown>
    assert.equal(data.event_id, 'evt-firestore-failed')
    assert.equal('rejection_reason' in data, false)
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
