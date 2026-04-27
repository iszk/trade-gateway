import type { Firestore } from 'firebase-admin/firestore'
import { getFirestoreClient } from '../firestore.js'

const CRON_METADATA_COLLECTION = 'cron_metadata'
const TASK_STATUS_DOCUMENT = 'task_status'

export type SlotKey = 'last_slot_10m' | 'last_slot_1h'

type Logger = {
    info(obj: Record<string, unknown>, msg?: string): void
    warn(obj: Record<string, unknown>, msg?: string): void
}

/**
 * Computes the slot ID from the current timestamp.
 * Subtracts 30 seconds before dividing to absorb Cloud Scheduler jitter of up to ±30s.
 *
 * slot_id = floor((nowSeconds - 30) / intervalSeconds)
 */
export const computeSlotId = (nowMs: number, intervalSeconds: number): number => {
    const nowSeconds = Math.floor(nowMs / 1000)
    return Math.floor((nowSeconds - 30) / intervalSeconds)
}

export type RunIfNewSlotParams = {
    nowMs: number
    intervalSeconds: number
    slotKey: SlotKey
    task: () => Promise<void>
    logger: Logger
}

export type SlotScheduler = {
    runIfNewSlot(params: RunIfNewSlotParams): Promise<void>
}

/**
 * Creates a SlotScheduler backed by Firestore.
 *
 * On each call to runIfNewSlot, a Firestore transaction atomically checks
 * whether the current slot is newer than the last recorded slot. If so, it
 * updates the stored slot and runs the task exactly once. This prevents
 * duplicate execution even when Cloud Scheduler triggers the Cloud Run
 * instance more than once per period.
 */
export const createSlotScheduler = (db: Firestore): SlotScheduler => {
    const docRef = db.collection(CRON_METADATA_COLLECTION).doc(TASK_STATUS_DOCUMENT)

    return {
        runIfNewSlot: async ({ nowMs, intervalSeconds, slotKey, task, logger }) => {
            const currentSlot = computeSlotId(nowMs, intervalSeconds)

            try {
                let shouldRun = false

                await db.runTransaction(async (tx) => {
                    const doc = await tx.get(docRef)
                    const data = doc.data() ?? {}
                    const lastSlot = (data[slotKey] as number | undefined) ?? -1

                    if (currentSlot > lastSlot) {
                        tx.set(docRef, { [slotKey]: currentSlot }, { merge: true })
                        shouldRun = true
                    }
                })

                if (shouldRun) {
                    logger.info({ event: 'slot_scheduler:task_started', slotKey, currentSlot })
                    await task()
                    logger.info({ event: 'slot_scheduler:task_completed', slotKey, currentSlot })
                }
            } catch (err) {
                logger.warn({
                    event: 'slot_scheduler:error',
                    slotKey,
                    currentSlot,
                    error: err instanceof Error ? err.message : String(err),
                })
            }
        },
    }
}

export const createDefaultSlotScheduler = (): SlotScheduler =>
    createSlotScheduler(getFirestoreClient())
