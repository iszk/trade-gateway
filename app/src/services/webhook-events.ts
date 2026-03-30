import type { Firestore } from 'firebase-admin/firestore'
import { getFirestoreClient } from '../firestore.js'

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
    status: 'accepted' | 'rejected'
    rejection_reason?: string
}

export class DuplicateEventError extends Error {
    constructor(eventId: string) {
        super(`event_id already exists: ${eventId}`)
        this.name = 'DuplicateEventError'
    }
}

export type CreateWebhookEventFn = (data: WebhookEventInput) => Promise<void>

const isAlreadyExistsError = (error: unknown): boolean =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 6

export const createWebhookEventFn = (db: Firestore): CreateWebhookEventFn => {
    return async (data) => {
        const docRef = db.collection('webhook_events').doc(data.event_id)
        const expireAt = new Date(data.received_at.getTime() + 90 * 24 * 60 * 60 * 1000)

        try {
            await docRef.create({
                ...data,
                expire_at: expireAt,
            })
        } catch (error) {
            if (isAlreadyExistsError(error)) {
                throw new DuplicateEventError(data.event_id)
            }
            throw error
        }
    }
}

export const createDefaultWebhookEventFn = (): CreateWebhookEventFn =>
    createWebhookEventFn(getFirestoreClient())
