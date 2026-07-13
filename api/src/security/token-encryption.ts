import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const ENVELOPE_VERSION = 1
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16
const KEY_LENGTH = 32
const AAD = Buffer.from('saxo_auth_data/saxo_auth:v1', 'utf8')

export type SaxoTokenPair = {
    accessToken: string
    refreshToken: string
}

export type TokenEncryptionEnvelope = {
    version: typeof ENVELOPE_VERSION
    algorithm: typeof ALGORITHM
    iv: string
    ciphertext: string
    authTag: string
}

export type TokenEncryptionCodec = {
    encrypt: (tokens: SaxoTokenPair) => TokenEncryptionEnvelope
    decrypt: (envelope: unknown) => SaxoTokenPair
}

const decodeCanonicalBase64 = (value: unknown, fieldName: string): Buffer => {
    if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
        throw new Error(`Invalid token encryption ${fieldName}`)
    }

    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
        throw new Error(`Invalid token encryption ${fieldName}`)
    }

    const decoded = Buffer.from(value, 'base64')
    if (decoded.toString('base64') !== value) {
        throw new Error(`Invalid token encryption ${fieldName}`)
    }

    return decoded
}

const parseEncryptionKey = (encodedKey: string | undefined): Buffer => {
    if (encodedKey === undefined || !/^[A-Za-z0-9+/]{43}=$/.test(encodedKey)) {
        throw new Error('SAXO_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32 byte key')
    }

    const key = Buffer.from(encodedKey, 'base64')
    if (key.length !== KEY_LENGTH || key.toString('base64') !== encodedKey) {
        throw new Error('SAXO_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32 byte key')
    }

    return key
}

const parseEnvelope = (value: unknown): {
    iv: Buffer
    ciphertext: Buffer
    authTag: Buffer
} => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Invalid token encryption envelope')
    }

    const envelope = value as Record<string, unknown>
    if (envelope.version !== ENVELOPE_VERSION || envelope.algorithm !== ALGORITHM) {
        throw new Error('Unsupported token encryption envelope')
    }

    const iv = decodeCanonicalBase64(envelope.iv, 'iv')
    const ciphertext = decodeCanonicalBase64(envelope.ciphertext, 'ciphertext')
    const authTag = decodeCanonicalBase64(envelope.authTag, 'authTag')

    if (iv.length !== IV_LENGTH || authTag.length !== AUTH_TAG_LENGTH) {
        throw new Error('Invalid token encryption envelope')
    }

    return { iv, ciphertext, authTag }
}

const parseTokenPair = (value: unknown): SaxoTokenPair => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new Error('Invalid decrypted token payload')
    }

    const payload = value as Record<string, unknown>
    if (typeof payload.accessToken !== 'string' || typeof payload.refreshToken !== 'string') {
        throw new Error('Invalid decrypted token payload')
    }

    return {
        accessToken: payload.accessToken,
        refreshToken: payload.refreshToken,
    }
}

export const createTokenEncryptionCodec = (encodedKey: string | undefined): TokenEncryptionCodec => {
    const key = parseEncryptionKey(encodedKey)

    return {
        encrypt: (tokens) => {
            const iv = randomBytes(IV_LENGTH)
            const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
            cipher.setAAD(AAD)

            const plaintext = Buffer.from(JSON.stringify(tokens), 'utf8')
            const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])

            return {
                version: ENVELOPE_VERSION,
                algorithm: ALGORITHM,
                iv: iv.toString('base64'),
                ciphertext: ciphertext.toString('base64'),
                authTag: cipher.getAuthTag().toString('base64'),
            }
        },
        decrypt: (envelope) => {
            const { iv, ciphertext, authTag } = parseEnvelope(envelope)

            try {
                const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
                decipher.setAAD(AAD)
                decipher.setAuthTag(authTag)

                const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
                return parseTokenPair(JSON.parse(plaintext.toString('utf8')))
            } catch {
                throw new Error('Failed to decrypt token payload')
            }
        },
    }
}
