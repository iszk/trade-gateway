import type { Firestore } from 'firebase-admin/firestore'

import { setFirestoreDocument, updateFirestoreDocument } from '../firestore.js'
import type { Logger } from '../logger.js'
import { omitUndefinedFields } from '../omit-undefined-fields.js'
import { createTokenEncryptionCodec, type TokenEncryptionCodec } from '../security/token-encryption.js'
import {
    createSaxoSnapshotDiagnosticError,
    SaxoSnapshotDiagnosticError,
    toSaxoSnapshotDiagnosticError,
} from './saxo-diagnostics.js'

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

const invalidAuthDocument = (fieldPath?: string, expectedType?: string): SaxoSnapshotDiagnosticError =>
    createSaxoSnapshotDiagnosticError({
        stage: 'auth_read',
        reason: 'invalid_auth_document',
        description: 'Invalid Saxo auth document',
        operation: 'validate_auth_document',
        ...(fieldPath ? { field_path: fieldPath } : {}),
        ...(expectedType ? { expected_type: expectedType } : {}),
    })

const parseAccounts = (value: unknown): SaxoAccountInfo[] | undefined => {
    if (value === undefined) return undefined
    if (!Array.isArray(value)) throw invalidAuthDocument('accounts', 'array')

    return value.map((account, index) => {
        const basePath = `accounts[${index}]`
        if (!isRecord(account)) throw invalidAuthDocument(basePath, 'object')
        if (typeof account.accountKey !== 'string') throw invalidAuthDocument(`${basePath}.accountKey`, 'string')
        if (typeof account.clientKey !== 'string') throw invalidAuthDocument(`${basePath}.clientKey`, 'string')
        if (!Array.isArray(account.legalAssetTypes) ||
            !account.legalAssetTypes.every((assetType) => typeof assetType === 'string')) {
            throw invalidAuthDocument(`${basePath}.legalAssetTypes`, 'string[]')
        }
        if (typeof account.currency !== 'string') throw invalidAuthDocument(`${basePath}.currency`, 'string')
        if (typeof account.displayName !== 'string') throw invalidAuthDocument(`${basePath}.displayName`, 'string')

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

    if (accessTokenExpiresAt === null) throw invalidAuthDocument('accessTokenExpiresAt', 'finite number')
    if (refreshTokenExpiresAt === null) throw invalidAuthDocument('refreshTokenExpiresAt', 'finite number')
    if (refreshingUntil === null) throw invalidAuthDocument('refreshingUntil', 'finite number')

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
            throw invalidAuthDocument('accessToken/refreshToken', 'absent for encrypted document')
        }

        const metadata = parseMetadata(document)
        let tokens: Pick<SaxoAuthData, 'accessToken' | 'refreshToken'>
        try {
            tokens = this.codec.decrypt(document.encryptedTokens)
        } catch (error) {
            throw createSaxoSnapshotDiagnosticError({
                stage: 'auth_read',
                reason: 'decrypt_failed',
                description: 'Failed to decrypt Saxo auth document',
                operation: 'decrypt_auth_tokens',
                cause: error,
            })
        }
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
            throw invalidAuthDocument('accessToken/refreshToken', 'string pair for legacy document')
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
        let encryptedTokens: unknown
        try {
            encryptedTokens = this.codec.encrypt({
                accessToken: data.accessToken,
                refreshToken: data.refreshToken,
            })
        } catch (error) {
            throw createSaxoSnapshotDiagnosticError({
                stage: 'auth_read',
                reason: 'encrypt_failed',
                description: 'Failed to encrypt Saxo auth document',
                operation: 'encrypt_auth_tokens',
                cause: error,
            })
        }
        return omitUndefinedFields({
            encryptedTokens,
            accessTokenExpiresAt: data.accessTokenExpiresAt,
            refreshTokenExpiresAt: data.refreshTokenExpiresAt,
            accounts: data.accounts,
            refreshingUntil,
        })
    }

    private logSafeFailure(
        event: string,
        diagnostic: SaxoSnapshotDiagnosticError,
        message: string,
    ): void {
        const { stage, reason, operation, upstream_path, upstream_status, field_path, expected_type, cause_summary } =
            diagnostic.diagnostic
        this.logger?.error({
            event,
            stage,
            reason,
            operation,
            upstream_path,
            upstream_status,
            field_path,
            expected_type,
            error_name: cause_summary?.name,
            error_code: cause_summary?.error_code,
            collection: FIRESTORE_COLLECTION,
            doc_id: FIRESTORE_DOC,
        }, message)
    }

    async getAuth(): Promise<SaxoAuthData | null> {
        const reference = this.db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC)
        let snapshot
        try {
            snapshot = await reference.get()
        } catch (error) {
            const diagnostic = createSaxoSnapshotDiagnosticError({
                stage: 'auth_read',
                reason: 'firestore_error',
                description: 'Failed to read Saxo auth document',
                operation: 'read_auth_document',
                cause: error,
            })
            this.logSafeFailure('saxo_auth:read_failed', diagnostic, 'failed to read Saxo auth document')
            throw diagnostic
        }
        if (!snapshot.exists) return null

        let document: unknown
        try {
            document = snapshot.data()
        } catch (error) {
            const diagnostic = createSaxoSnapshotDiagnosticError({
                stage: 'auth_read',
                reason: 'firestore_error',
                description: 'Failed to read Saxo auth document',
                operation: 'read_auth_document',
                cause: error,
            })
            this.logSafeFailure('saxo_auth:read_failed', diagnostic, 'failed to read Saxo auth document')
            throw diagnostic
        }
        if (!isRecord(document)) {
            const diagnostic = invalidAuthDocument('document', 'object')
            this.logSafeFailure('saxo_auth:read_failed', diagnostic, 'invalid Saxo auth document')
            throw diagnostic
        }

        if ('encryptedTokens' in document) {
            try {
                return this.parseEncryptedDocument(document).auth
            } catch (error) {
                const diagnostic = toSaxoSnapshotDiagnosticError(error, {
                    stage: 'auth_read',
                    reason: 'decrypt_failed',
                    description: 'Failed to decrypt Saxo auth document',
                    operation: 'decrypt_auth_tokens',
                })
                this.logSafeFailure('saxo_auth:read_failed', diagnostic, 'failed to read Saxo auth document')
                throw diagnostic
            }
        }

        try {
            this.parseLegacyDocument(document)
        } catch (error) {
            const diagnostic = toSaxoSnapshotDiagnosticError(error, {
                stage: 'auth_read',
                reason: 'invalid_auth_document',
                description: 'Invalid Saxo auth document',
                operation: 'validate_legacy_auth_document',
            })
            this.logSafeFailure('saxo_auth:read_failed', diagnostic, 'invalid Saxo auth document')
            throw diagnostic
        }
        try {
            return await this.db.runTransaction(async (transaction) => {
                const latestSnapshot = await transaction.get(reference)
                if (!latestSnapshot.exists) return null

                const latestDocument = latestSnapshot.data()
                if (!isRecord(latestDocument)) {
                    throw invalidAuthDocument('document', 'object')
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
        } catch (error) {
            const diagnostic = toSaxoSnapshotDiagnosticError(error, {
                stage: 'auth_read',
                reason: 'migration_failed',
                description: 'Failed to migrate legacy Saxo auth document',
                operation: 'migrate_legacy_auth_document',
            })
            this.logSafeFailure('saxo_auth:migration_failed', diagnostic, 'failed to migrate legacy Saxo auth document')
            throw diagnostic
        }
    }

    async acquireRefreshLease(): Promise<RefreshLeaseResult> {
        try {
            const reference = this.db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC)
            return await this.db.runTransaction(async (transaction) => {
                const snapshot = await transaction.get(reference)
                if (!snapshot.exists) return { status: 'missing' }

                const document = snapshot.data()
                if (!isRecord(document)) {
                    throw invalidAuthDocument('document', 'object')
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
        } catch (error) {
            const diagnostic = toSaxoSnapshotDiagnosticError(error, {
                stage: 'auth_refresh',
                reason: 'firestore_error',
                description: 'Failed to acquire Saxo refresh lease',
                operation: 'acquire_refresh_lease',
            })
            this.logSafeFailure('saxo_auth:refresh_lease_failed', diagnostic, 'failed to acquire Saxo refresh lease')
            throw diagnostic
        }
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
                    isExpectedError: () => true,
                },
            )
        } catch (error) {
            const diagnostic = createSaxoSnapshotDiagnosticError({
                stage: 'auth_refresh',
                reason: 'firestore_error',
                description: 'Failed to release Saxo refresh lease',
                operation: 'release_refresh_lease',
                cause: error,
            })
            this.logSafeFailure('saxo_auth:refresh_lease_failed', diagnostic, 'failed to release Saxo refresh lease')
            throw diagnostic
        }
    }

    async saveAuth(data: SaxoAuthData): Promise<void> {
        let encryptedDocument: Record<string, unknown>
        try {
            encryptedDocument = this.createEncryptedDocument(data)
        } catch (error) {
            const diagnostic = createSaxoSnapshotDiagnosticError({
                stage: 'auth_read',
                reason: 'encrypt_failed',
                description: 'Failed to encrypt Saxo auth document',
                operation: 'encrypt_auth_tokens',
                cause: error,
            })
            this.logSafeFailure('saxo_auth:save_failed', diagnostic, 'failed to save Saxo auth document')
            throw diagnostic
        }

        try {
            await setFirestoreDocument(
                this.db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC),
                encryptedDocument,
                {
                    collection: FIRESTORE_COLLECTION,
                    docId: FIRESTORE_DOC,
                    logger: this.logger,
                    redactWriteDetails: true,
                    isExpectedError: () => true,
                },
            )
        } catch (error) {
            const diagnostic = createSaxoSnapshotDiagnosticError({
                stage: 'auth_read',
                reason: 'firestore_error',
                description: 'Failed to save Saxo auth document',
                operation: 'save_auth_document',
                cause: error,
            })
            this.logSafeFailure('saxo_auth:save_failed', diagnostic, 'failed to save Saxo auth document')
            throw diagnostic
        }
    }
}
