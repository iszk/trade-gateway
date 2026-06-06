import { initializeApp, getApps } from 'firebase-admin/app'
import {
    getFirestore,
    type CollectionReference,
    type DocumentReference,
    type Firestore,
    type SetOptions,
    type WriteResult,
} from 'firebase-admin/firestore'
import { defaultLogger, type Logger } from './logger.js'
import { omitUndefinedFields } from './omit-undefined-fields.js'

type FirestoreWriteData = Record<string, unknown>

type FirestoreWriteContext = {
    collection: string
    docId?: string
    logger?: Logger
    isExpectedError?: (error: unknown) => boolean
}

type FirestoreWriteLogContext = FirestoreWriteContext & {
    operation: 'add' | 'create' | 'set' | 'update'
}

export const getFirestoreClient = (): Firestore => {
    if (getApps().length === 0) {
        initializeApp()
    }
    return getFirestore()
}

const logFirestoreWriteError = (
    error: unknown,
    data: FirestoreWriteData,
    context: FirestoreWriteLogContext,
): void => {
    if (context.isExpectedError?.(error)) {
        return
    }

    const logger = context.logger ?? defaultLogger
    logger.error({
        event: 'firestore:write_failed',
        operation: context.operation,
        collection: context.collection,
        doc_id: context.docId,
        data,
        error,
    }, 'failed to write firestore document')
}

const runFirestoreWrite = async <T>(
    operation: () => Promise<T>,
    data: FirestoreWriteData,
    context: FirestoreWriteLogContext,
): Promise<T> => {
    try {
        return await operation()
    } catch (error) {
        logFirestoreWriteError(error, data, context)
        throw error
    }
}

export const addFirestoreDocument = async <T extends FirestoreWriteData>(
    collectionRef: CollectionReference,
    data: T,
    context: FirestoreWriteContext,
): Promise<DocumentReference> => {
    const firestoreData = omitUndefinedFields(data)
    return runFirestoreWrite(
        () => collectionRef.add(firestoreData),
        firestoreData,
        { ...context, operation: 'add' },
    )
}

export const createFirestoreDocument = async <T extends FirestoreWriteData>(
    docRef: DocumentReference,
    data: T,
    context: FirestoreWriteContext,
): Promise<WriteResult> => {
    const firestoreData = omitUndefinedFields(data)
    return runFirestoreWrite(
        () => docRef.create(firestoreData),
        firestoreData,
        { ...context, operation: 'create' },
    )
}

export const setFirestoreDocument = async <T extends FirestoreWriteData>(
    docRef: DocumentReference,
    data: T,
    context: FirestoreWriteContext,
    options?: SetOptions,
): Promise<WriteResult> => {
    const firestoreData = omitUndefinedFields(data)
    return runFirestoreWrite(
        () => options ? docRef.set(firestoreData, options) : docRef.set(firestoreData),
        firestoreData,
        { ...context, operation: 'set' },
    )
}

export const updateFirestoreDocument = async <T extends FirestoreWriteData>(
    docRef: DocumentReference,
    data: T,
    context: FirestoreWriteContext,
): Promise<WriteResult> => {
    const firestoreData = omitUndefinedFields(data)
    return runFirestoreWrite(
        () => docRef.update(firestoreData),
        firestoreData,
        { ...context, operation: 'update' },
    )
}
