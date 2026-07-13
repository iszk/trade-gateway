import assert from 'node:assert/strict'
import { createCipheriv, randomBytes } from 'node:crypto'
import test from 'node:test'

import {
    createTokenEncryptionCodec,
    type SaxoTokenPair,
    type TokenEncryptionEnvelope,
} from './token-encryption.js'

const createKey = (): string => randomBytes(32).toString('base64')

const tokens: SaxoTokenPair = {
    accessToken: 'access-value',
    refreshToken: 'refresh-value',
}

const tamperBase64 = (value: string): string => {
    const bytes = Buffer.from(value, 'base64')
    bytes[0] ^= 1
    return bytes.toString('base64')
}

test('token encryption codec: token pair を round-trip できる', () => {
    const codec = createTokenEncryptionCodec(createKey())

    const envelope = codec.encrypt(tokens)

    assert.deepEqual(codec.decrypt(envelope), tokens)
    assert.equal(envelope.version, 1)
    assert.equal(envelope.algorithm, 'aes-256-gcm')
    assert.equal(Buffer.from(envelope.iv, 'base64').length, 12)
    assert.equal(Buffer.from(envelope.authTag, 'base64').length, 16)
})

test('token encryption codec: 同じ token pair でも IV と ciphertext が毎回異なる', () => {
    const codec = createTokenEncryptionCodec(createKey())

    const first = codec.encrypt(tokens)
    const second = codec.encrypt(tokens)

    assert.notEqual(first.iv, second.iv)
    assert.notEqual(first.ciphertext, second.ciphertext)
})

test('token encryption codec: ciphertext の改ざんを検知する', () => {
    const codec = createTokenEncryptionCodec(createKey())
    const envelope = codec.encrypt(tokens)

    assert.throws(
        () => codec.decrypt({ ...envelope, ciphertext: tamperBase64(envelope.ciphertext) }),
        /Failed to decrypt token payload/,
    )
})

test('token encryption codec: authTag の改ざんを検知する', () => {
    const codec = createTokenEncryptionCodec(createKey())
    const envelope = codec.encrypt(tokens)

    assert.throws(
        () => codec.decrypt({ ...envelope, authTag: tamperBase64(envelope.authTag) }),
        /Failed to decrypt token payload/,
    )
})

test('token encryption codec: 異なる AAD で暗号化された payload を拒否する', () => {
    const encodedKey = createKey()
    const key = Buffer.from(encodedKey, 'base64')
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
    cipher.setAAD(Buffer.from('saxo_auth_data/saxo_auth:v2', 'utf8'))
    const ciphertext = Buffer.concat([
        cipher.update(Buffer.from(JSON.stringify(tokens), 'utf8')),
        cipher.final(),
    ])
    const envelope: TokenEncryptionEnvelope = {
        version: 1,
        algorithm: 'aes-256-gcm',
        iv: iv.toString('base64'),
        ciphertext: ciphertext.toString('base64'),
        authTag: cipher.getAuthTag().toString('base64'),
    }

    assert.throws(
        () => createTokenEncryptionCodec(encodedKey).decrypt(envelope),
        /Failed to decrypt token payload/,
    )
})

test('token encryption codec: 異なる key での復号を拒否する', () => {
    const envelope = createTokenEncryptionCodec(createKey()).encrypt(tokens)

    assert.throws(
        () => createTokenEncryptionCodec(createKey()).decrypt(envelope),
        /Failed to decrypt token payload/,
    )
})

test('token encryption codec: 未設定または不正な key を拒否する', () => {
    const invalidKeys = [
        undefined,
        '',
        'not-base64',
        randomBytes(31).toString('base64'),
        randomBytes(33).toString('base64'),
        `${'A'.repeat(42)}B=`,
        ` ${createKey()}`,
    ]

    for (const invalidKey of invalidKeys) {
        assert.throws(
            () => createTokenEncryptionCodec(invalidKey),
            /SAXO_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32 byte key/,
        )
    }
})

test('token encryption codec: 不正な envelope contract を拒否する', () => {
    const codec = createTokenEncryptionCodec(createKey())
    const envelope = codec.encrypt(tokens)

    assert.throws(() => codec.decrypt({ ...envelope, version: 2 }), /Unsupported token encryption envelope/)
    assert.throws(() => codec.decrypt({ ...envelope, algorithm: 'aes-128-gcm' }), /Unsupported token encryption envelope/)
    assert.throws(() => codec.decrypt({ ...envelope, iv: 'invalid' }), /Invalid token encryption iv/)
})
