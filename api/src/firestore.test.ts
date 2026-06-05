import assert from 'node:assert/strict'
import test from 'node:test'

import {
    createFirestoreDocument,
    setFirestoreDocument,
    updateFirestoreDocument,
} from './firestore.js'
import type { Logger } from './logger.js'

const createLoggerStub = () => {
    const errors: { obj: Record<string, unknown>; msg?: string }[] = []
    const logger: Logger = {
        info: () => {},
        warn: () => {},
        error: (obj, msg) => {
            errors.push({ obj, msg })
        },
        child: () => logger,
    }

    return { logger, errors }
}

test('setFirestoreDocument removes undefined values before writing', async () => {
    const written: Record<string, unknown>[] = []
    const date = new Date('2026-01-01T00:00:00Z')
    const docRef = {
        set: async (data: Record<string, unknown>) => {
            written.push(data)
            return {}
        },
    }

    await setFirestoreDocument(docRef as any, {
        id: 'doc-1',
        optional: undefined,
        nested: {
            kept: 'value',
            omitted: undefined,
        },
        list: [
            { kept: true, omitted: undefined },
            undefined,
            'last',
        ],
        date,
    }, {
        collection: 'test_collection',
        docId: 'doc-1',
    })

    assert.equal(written.length, 1)
    assert.deepEqual(written[0], {
        id: 'doc-1',
        nested: { kept: 'value' },
        list: [{ kept: true }, 'last'],
        date,
    })
})

test('updateFirestoreDocument logs write data and rethrows on write failure', async () => {
    const { logger, errors } = createLoggerStub()
    const firestoreError = new Error('Firestore unavailable')
    const docRef = {
        update: async () => {
            throw firestoreError
        },
    }

    await assert.rejects(
        updateFirestoreDocument(docRef as any, {
            status: 'EXECUTED',
            skipped: undefined,
        }, {
            collection: 'orders_v2',
            docId: 'order-1',
            logger,
        }),
        firestoreError,
    )

    assert.equal(errors.length, 1)
    assert.equal(errors[0]?.msg, 'failed to write firestore document')
    assert.equal(errors[0]?.obj.event, 'firestore:write_failed')
    assert.equal(errors[0]?.obj.operation, 'update')
    assert.equal(errors[0]?.obj.collection, 'orders_v2')
    assert.equal(errors[0]?.obj.doc_id, 'order-1')
    assert.deepEqual(errors[0]?.obj.data, { status: 'EXECUTED' })
    assert.equal(errors[0]?.obj.error, firestoreError)
})

test('createFirestoreDocument skips logging expected write errors', async () => {
    const { logger, errors } = createLoggerStub()
    const alreadyExistsError = new Error('already exists') as Error & { code: number }
    alreadyExistsError.code = 6
    const docRef = {
        create: async () => {
            throw alreadyExistsError
        },
    }

    await assert.rejects(
        createFirestoreDocument(docRef as any, {
            id: 'doc-1',
        }, {
            collection: 'test_collection',
            docId: 'doc-1',
            logger,
            isExpectedError: (error) =>
                typeof error === 'object' &&
                error !== null &&
                'code' in error &&
                (error as { code: unknown }).code === 6,
        }),
        alreadyExistsError,
    )

    assert.equal(errors.length, 0)
})
