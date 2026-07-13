import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'

test('config: Saxo token encryption key を trim して読み込む', async () => {
    const encodedKey = randomBytes(32).toString('base64')
    const previousValue = process.env.SAXO_TOKEN_ENCRYPTION_KEY
    process.env.SAXO_TOKEN_ENCRYPTION_KEY = ` \t${encodedKey}\n`

    try {
        const { config } = await import(`./config.js?config-test=${Date.now()}`)
        assert.equal(config.saxo.tokenEncryptionKey, encodedKey)
    } finally {
        if (previousValue === undefined) {
            delete process.env.SAXO_TOKEN_ENCRYPTION_KEY
        } else {
            process.env.SAXO_TOKEN_ENCRYPTION_KEY = previousValue
        }
    }
})
