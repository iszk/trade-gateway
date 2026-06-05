import type { Firestore } from 'firebase-admin/firestore'
import { getFirestoreClient } from '../firestore.js'
import { defaultLogger, type Logger } from '../logger.js'
import { omitUndefinedFields } from '../omit-undefined-fields.js'

export type WebhookEventInput = {
    event_id: string
    source: string
    broker: string
    symbol: string
    side: string
    order_type: string
    size: number
    occurred_at: Date
    received_at: Date
    status: 'accepted' | 'rejected' | 'suppressed'
    rejection_reason?: string
}

export class DuplicateEventError extends Error {
    constructor(eventId: string) {
        super(`event_id already exists: ${eventId}`)
        this.name = 'DuplicateEventError'
    }
}

export type CreateWebhookEventFn = (data: WebhookEventInput) => Promise<void>

type CreateWebhookEventOptions = {
    logger?: Logger
}

const isAlreadyExistsError = (error: unknown): boolean =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 6

export const createWebhookEventFn = (db: Firestore, options: CreateWebhookEventOptions = {}): CreateWebhookEventFn => {
    const logger = options.logger ?? defaultLogger

    return async (data) => {
        const docId = `${data.broker}:${data.symbol}:${data.event_id}`
        const docRef = db.collection('webhook_events').doc(docId)
        const expireAt = new Date(data.received_at.getTime() + 90 * 24 * 60 * 60 * 1000)
        const firestoreData = omitUndefinedFields({
            ...data,
            expire_at: expireAt,
        })

        try {
            await docRef.create(firestoreData)
        } catch (error) {
            if (isAlreadyExistsError(error)) {
                throw new DuplicateEventError(data.event_id)
            }
            logger.error({
                event: 'webhook_event:create_failed',
                collection: 'webhook_events',
                doc_id: docId,
                data: firestoreData,
                error,
            }, 'failed to write webhook event to firestore')
            throw error
        }
    }
}

export const createDefaultWebhookEventFn = (): CreateWebhookEventFn =>
    createWebhookEventFn(getFirestoreClient())
