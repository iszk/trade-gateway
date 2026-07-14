import type { Firestore } from 'firebase-admin/firestore'

import { setFirestoreDocument, updateFirestoreDocument } from '../firestore.js'
import type { Logger } from '../logger.js'
import { omitUndefinedFields } from '../omit-undefined-fields.js'
import { createTokenEncryptionCodec, type TokenEncryptionCodec } from '../security/token-encryption.js'

const FIRESTORE_COLLECTION = 'saxo_auth_data'
const FIRESTORE_DOC = 'saxo_auth'

export type SaxoAccountInfo = {
    accountKey: string
    clientKey: string
    legalAssetTypes: string[]
    currency: string
    displayName: string
}

export type SaxoAuthData = {
    accessToken: string
    refreshToken: string
    accessTokenExpiresAt: number
    refreshTokenExpiresAt: number
    accounts?: SaxoAccountInfo[]
}

type SaxoAuthStoreOptions = {
    db: Firestore
    tokenEncryptionKey?: string
    logger?: Logger
    now?: () => number
}

export type RefreshLeaseResult =
    | { status: 'acquired'; auth: SaxoAuthData }
    | { status: 'already-fresh'; auth: SaxoAuthData }
    | { status: 'already-refreshing' }
    | { status: 'missing' }

type SaxoAuthDocumentMetadata = {
    accessTokenExpiresAt: number
    refreshTokenExpiresAt: number
    accounts?: SaxoAccountInfo[]
    refreshingUntil?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const parseFiniteNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null

const parseAccounts = (value: unknown): SaxoAccountInfo[] | undefined => {
    if (value === undefined) return undefined
    if (!Array.isArray(value)) throw new Error('Invalid Saxo auth document')

    return value.map((account) => {
        if (!isRecord(account) ||
            typeof account.accountKey !== 'string' ||
            typeof account.clientKey !== 'string' ||
            !Array.isArray(account.legalAssetTypes) ||
            !account.legalAssetTypes.every((assetType) => typeof assetType === 'string') ||
            typeof account.currency !== 'string' ||
            typeof account.displayName !== 'string') {
            throw new Error('Invalid Saxo auth document')
        }

        return {
            accountKey: account.accountKey,
            clientKey: account.clientKey,
            legalAssetTypes: account.legalAssetTypes,
            currency: account.currency,
            displayName: account.displayName,
        }
    })
}

const parseMetadata = (document: Record<string, unknown>): SaxoAuthDocumentMetadata => {
    const accessTokenExpiresAt = parseFiniteNumber(document.accessTokenExpiresAt)
    const refreshTokenExpiresAt = parseFiniteNumber(document.refreshTokenExpiresAt)
    const refreshingUntil = document.refreshingUntil === undefined
        ? undefined
        : parseFiniteNumber(document.refreshingUntil)

    if (accessTokenExpiresAt === null ||
        refreshTokenExpiresAt === null ||
        refreshingUntil === null) {
        throw new Error('Invalid Saxo auth document')
    }

    return {
        accessTokenExpiresAt,
        refreshTokenExpiresAt,
        accounts: parseAccounts(document.accounts),
        refreshingUntil,
    }
}

export class SaxoAuthStore {
    private readonly db: Firestore
    private readonly codec: TokenEncryptionCodec
    private readonly logger?: Logger
    private readonly now: () => number

    constructor(options: SaxoAuthStoreOptions) {
        this.db = options.db
        this.codec = createTokenEncryptionCodec(options.tokenEncryptionKey)
        this.logger = options.logger
        this.now = options.now ?? Date.now
    }

    private parseEncryptedDocument(document: Record<string, unknown>): {
        auth: SaxoAuthData
        refreshingUntil?: number
    } {
        if ('accessToken' in document || 'refreshToken' in document) {
            throw new Error('Invalid Saxo auth document')
        }

        const metadata = parseMetadata(document)
        const tokens = this.codec.decrypt(document.encryptedTokens)
        return {
            auth: {
                ...tokens,
                accessTokenExpiresAt: metadata.accessTokenExpiresAt,
                refreshTokenExpiresAt: metadata.refreshTokenExpiresAt,
                accounts: metadata.accounts,
            },
            refreshingUntil: metadata.refreshingUntil,
        }
    }

    private parseLegacyDocument(document: Record<string, unknown>): {
        auth: SaxoAuthData
        refreshingUntil?: number
    } {
        if ('encryptedTokens' in document ||
            typeof document.accessToken !== 'string' ||
            typeof document.refreshToken !== 'string') {
            throw new Error('Invalid Saxo auth document')
        }

        const metadata = parseMetadata(document)
        return {
            auth: {
                accessToken: document.accessToken,
                refreshToken: document.refreshToken,
                accessTokenExpiresAt: metadata.accessTokenExpiresAt,
                refreshTokenExpiresAt: metadata.refreshTokenExpiresAt,
                accounts: metadata.accounts,
            },
            refreshingUntil: metadata.refreshingUntil,
        }
    }

    private createEncryptedDocument(
        data: SaxoAuthData,
        refreshingUntil?: number,
    ): Record<string, unknown> {
        return omitUndefinedFields({
            encryptedTokens: this.codec.encrypt({
                accessToken: data.accessToken,
                refreshToken: data.refreshToken,
            }),
            accessTokenExpiresAt: data.accessTokenExpiresAt,
            refreshTokenExpiresAt: data.refreshTokenExpiresAt,
            accounts: data.accounts,
            refreshingUntil,
        })
    }

    private logSafeFailure(event: string, message: string): void {
        this.logger?.error({
            event,
            collection: FIRESTORE_COLLECTION,
            doc_id: FIRESTORE_DOC,
        }, message)
    }

    async getAuth(): Promise<SaxoAuthData | null> {
        const reference = this.db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC)
        const snapshot = await reference.get()
        if (!snapshot.exists) return null

        const document = snapshot.data()
        if (!isRecord(document)) {
            throw new Error('Invalid Saxo auth document')
        }

        if ('encryptedTokens' in document) {
            return this.parseEncryptedDocument(document).auth
        }

        this.parseLegacyDocument(document)
        try {
            return await this.db.runTransaction(async (transaction) => {
                const latestSnapshot = await transaction.get(reference)
                if (!latestSnapshot.exists) return null

                const latestDocument = latestSnapshot.data()
                if (!isRecord(latestDocument)) {
                    throw new Error('Invalid Saxo auth document')
                }
                if ('encryptedTokens' in latestDocument) {
                    return this.parseEncryptedDocument(latestDocument).auth
                }

                const legacy = this.parseLegacyDocument(latestDocument)
                transaction.set(
                    reference,
                    this.createEncryptedDocument(legacy.auth, legacy.refreshingUntil),
                )
                return legacy.auth
            })
        } catch {
            const message = 'Failed to migrate legacy Saxo auth document'
            this.logSafeFailure('saxo_auth:migration_failed', message)
            throw new Error(message)
        }
    }

    async acquireRefreshLease(): Promise<RefreshLeaseResult> {
        const reference = this.db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC)
        return this.db.runTransaction(async (transaction) => {
            const snapshot = await transaction.get(reference)
            if (!snapshot.exists) return { status: 'missing' }

            const document = snapshot.data()
            if (!isRecord(document)) {
                throw new Error('Invalid Saxo auth document')
            }

            const isLegacy = !('encryptedTokens' in document)
            const parsed = isLegacy
                ? this.parseLegacyDocument(document)
                : this.parseEncryptedDocument(document)
            const now = this.now()

            if (parsed.auth.accessTokenExpiresAt >= now + 60_000) {
                if (isLegacy) {
                    transaction.set(
                        reference,
                        this.createEncryptedDocument(parsed.auth, parsed.refreshingUntil),
                    )
                }
                return { status: 'already-fresh', auth: parsed.auth }
            }

            if (parsed.refreshingUntil !== undefined && parsed.refreshingUntil > now) {
                if (isLegacy) {
                    transaction.set(
                        reference,
                        this.createEncryptedDocument(parsed.auth, parsed.refreshingUntil),
                    )
                }
                return { status: 'already-refreshing' }
            }

            const refreshingUntil = now + 30_000
            if (isLegacy) {
                transaction.set(
                    reference,
                    this.createEncryptedDocument(parsed.auth, refreshingUntil),
                )
            } else {
                transaction.update(reference, { refreshingUntil })
            }
            return { status: 'acquired', auth: parsed.auth }
        })
    }

    async releaseRefreshLease(): Promise<void> {
        try {
            await updateFirestoreDocument(
                this.db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC),
                { refreshingUntil: this.now() - 1_000 },
                {
                    collection: FIRESTORE_COLLECTION,
                    docId: FIRESTORE_DOC,
                    logger: this.logger,
                    redactWriteDetails: true,
                },
            )
        } catch {
            throw new Error('Failed to release Saxo refresh lease')
        }
    }

    async saveAuth(data: SaxoAuthData): Promise<void> {
        try {
            await setFirestoreDocument(
                this.db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC),
                this.createEncryptedDocument(data),
                {
                    collection: FIRESTORE_COLLECTION,
                    docId: FIRESTORE_DOC,
                    logger: this.logger,
                    redactWriteDetails: true,
                },
            )
        } catch {
            throw new Error('Failed to save Saxo auth document')
        }
    }
}
