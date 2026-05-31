import assert from 'node:assert/strict'
import test from 'node:test'

import { serializeLogDetails } from './logger.js'

test('serializeLogDetails: error フィールドの Error を JSON 化できる形にする', () => {
    const error = new Error('firestore failed') as Error & { code?: string }
    error.code = 'invalid-argument'

    const details = serializeLogDetails({ event: 'cron:test', error })

    assert.equal(details.event, 'cron:test')
    assert.deepEqual(details.error, {
        name: 'Error',
        message: 'firestore failed',
        stack: error.stack,
        code: 'invalid-argument',
    })
})

test('serializeLogDetails: 非 Error の error フィールドはそのまま残す', () => {
    const details = serializeLogDetails({ error: { code: 'FORBIDDEN', message: 'denied' } })

    assert.deepEqual(details, {
        error: { code: 'FORBIDDEN', message: 'denied' },
    })
})
