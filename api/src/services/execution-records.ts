import type { Firestore } from 'firebase-admin/firestore'
import { getFirestoreClient } from '../firestore.js'
import type { OrderExecution } from '../types/execution.js'

const COLLECTION = 'execution_records'

export type AddExecutionRecordFn = (execution: OrderExecution) => Promise<void>

const omitUndefined = <T extends Record<string, unknown>>(obj: T): T =>
    Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T

export const addExecutionRecordFn = (db: Firestore): AddExecutionRecordFn => {
    return async (execution) => {
        const createdAt = new Date()
        const expireAt = new Date(createdAt.getTime() + 2 * 365 * 24 * 60 * 60 * 1000)
        await db.collection(COLLECTION).doc(execution.id).set(
            omitUndefined({
                ...execution,
                created_at: createdAt,
                expire_at: expireAt,
            }),
        )
    }
}

export const createDefaultAddExecutionRecordFn = (): AddExecutionRecordFn =>
    addExecutionRecordFn(getFirestoreClient())
