import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import type { Firestore } from 'firebase-admin/firestore'

import type { Logger } from '../logger.js'
import { SaxoAuthStore, type SaxoAuthData } from './saxo-auth-store.js'

const TEST_KEY = randomBytes(32).toString('base64')
const AUTH_PATH = 'saxo_auth_data/saxo_auth'

const createFirestoreMock = (
    initialData?: Record<string, unknown>,
    options: {
        documentSetError?: Error
        transactionCommitError?: Error
        beforeFirstTransactionCommit?: () => Promise<void>
    } = {},
) => {
    let storedData = initialData
    let transactionCount = 0
    let documentVersion = 0

    const documentReference = {
        get: async () => ({
            exists: storedData !== undefined,
            data: () => storedData,
        }),
        set: async (data: Record<string, unknown>) => {
            if (options.documentSetError) throw options.documentSetError
            storedData = structuredClone(data)
            documentVersion++
            return {}
        },
        update: async (updates: Record<string, unknown>) => {
            storedData = { ...storedData, ...structuredClone(updates) }
            documentVersion++
            return {}
        },
    }

    const db = {
        collection: (collectionPath: string) => ({
            doc: (docPath: string) => {
                assert.equal(`${collectionPath}/${docPath}`, AUTH_PATH)
                return documentReference
            },
        }),
        runTransaction: async <T>(updateFunction: (transaction: unknown) => Promise<T>) => {
            while (true) {
                transactionCount++
                const readVersion = documentVersion
                const snapshotData = structuredClone(storedData)
                let pendingData: Record<string, unknown> | undefined
                const transaction = {
                    get: async () => ({
                        exists: snapshotData !== undefined,
                        data: () => snapshotData,
                    }),
                    set: (_reference: unknown, data: Record<string, unknown>) => {
                        pendingData = structuredClone(data)
                        return transaction
                    },
                    update: (_reference: unknown, updates: Record<string, unknown>) => {
                        pendingData = { ...snapshotData, ...structuredClone(updates) }
                        return transaction
                    },
                }
                const result = await updateFunction(transaction)
                if (options.transactionCommitError) throw options.transactionCommitError
                if (transactionCount === 1) {
                    await options.beforeFirstTransactionCommit?.()
                }
                if (documentVersion !== readVersion) continue
                if (pendingData !== undefined) {
                    storedData = pendingData
                    documentVersion++
                }
                return result
            }
        },
    } as unknown as Firestore

    return {
        db,
        getStoredData: () => structuredClone(storedData),
        getTransactionCount: () => transactionCount,
    }
}

const createCapturingLogger = () => {
    const entries: Array<{ obj: Record<string, unknown>, msg?: string }> = []
    const logger: Logger = {
        info: (obj, msg) => entries.push({ obj, msg }),
        warn: (obj, msg) => entries.push({ obj, msg }),
        error: (obj, msg) => entries.push({ obj, msg }),
        child: () => logger,
    }
    return { logger, entries }
}

const stringifyCapturedLogs = (
    entries: Array<{ obj: Record<string, unknown>, msg?: string }>,
): string => JSON.stringify(entries, (_key, value) => value instanceof Error
    ? { name: value.name, message: value.message }
    : value)

const createAuthData = (overrides: Partial<SaxoAuthData> = {}): SaxoAuthData => ({
    accessToken: 'plain-access-token',
    refreshToken: 'plain-refresh-token',
    accessTokenExpiresAt: 1_800_000_000_000,
    refreshTokenExpiresAt: 1_900_000_000_000,
    accounts: [{
        accountKey: 'account-key',
        clientKey: 'client-key',
        legalAssetTypes: ['FxSpot'],
        currency: 'USD',
        displayName: 'Primary',
    }],
    ...overrides,
})

test('SaxoAuthStore.saveAuth は token pair を encryptedTokens として保存する', async () => {
    const firestore = createFirestoreMock()
    const store = new SaxoAuthStore({
        db: firestore.db,
        tokenEncryptionKey: TEST_KEY,
    })
    const auth = createAuthData()

    await store.saveAuth(auth)

    const saved = firestore.getStoredData()
    assert.ok(saved)
    assert.ok('encryptedTokens' in saved)
    assert.ok(!('accessToken' in saved))
    assert.ok(!('refreshToken' in saved))
    assert.equal(JSON.stringify(saved).includes(auth.accessToken), false)
    assert.equal(JSON.stringify(saved).includes(auth.refreshToken), false)
    assert.equal((saved.encryptedTokens as { version?: unknown }).version, 1)
    assert.equal(saved.accessTokenExpiresAt, auth.accessTokenExpiresAt)
    assert.equal(saved.refreshTokenExpiresAt, auth.refreshTokenExpiresAt)
    assert.deepEqual(saved.accounts, auth.accounts)
})

test('SaxoAuthStore.saveAuth の Firestore write failure ログに token と暗号鍵を含めない', async () => {
    const accessToken = 'sensitive-write-access-token'
    const refreshToken = 'sensitive-write-refresh-token'
    const encryptionKey = Buffer.alloc(32, 19).toString('base64')
    const firestore = createFirestoreMock(undefined, {
        documentSetError: new Error(
            `write rejected: ${accessToken} ${refreshToken} ${encryptionKey}`,
        ),
    })
    const { logger, entries } = createCapturingLogger()
    const store = new SaxoAuthStore({
        db: firestore.db,
        tokenEncryptionKey: encryptionKey,
        logger,
    })

    await assert.rejects(
        store.saveAuth(createAuthData({ accessToken, refreshToken })),
        /Failed to save Saxo auth document/,
    )

    const captured = stringifyCapturedLogs(entries)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.obj.event, 'firestore:write_failed')
    assert.equal('data' in (entries[0]?.obj ?? {}), false)
    assert.equal('error' in (entries[0]?.obj ?? {}), false)
    for (const secret of [accessToken, refreshToken, encryptionKey]) {
        assert.equal(captured.includes(secret), false)
    }
})

test('SaxoAuthStore.getAuth は encrypted v1 document を domain model に復元する', async () => {
    const firestore = createFirestoreMock()
    const store = new SaxoAuthStore({
        db: firestore.db,
        tokenEncryptionKey: TEST_KEY,
    })
    const auth = createAuthData()
    await store.saveAuth(auth)

    const restored = await store.getAuth()

    assert.deepEqual(restored, auth)
})

test('SaxoAuthStore.getAuth は document が存在しない場合 null を返す', async () => {
    const firestore = createFirestoreMock()
    const store = new SaxoAuthStore({
        db: firestore.db,
        tokenEncryptionKey: TEST_KEY,
    })

    assert.equal(await store.getAuth(), null)
})

test('SaxoAuthStore.getAuth は legacy plaintext document を transaction で暗号化置換する', async () => {
    const auth = createAuthData()
    const legacyDocument = { ...auth, refreshingUntil: 1_700_000_000_000 }
    const firestore = createFirestoreMock(legacyDocument)
    const store = new SaxoAuthStore({
        db: firestore.db,
        tokenEncryptionKey: TEST_KEY,
    })

    const restored = await store.getAuth()

    assert.deepEqual(restored, auth)
    assert.equal(firestore.getTransactionCount(), 1)
    const migrated = firestore.getStoredData()
    assert.ok(migrated)
    assert.ok('encryptedTokens' in migrated)
    assert.ok(!('accessToken' in migrated))
    assert.ok(!('refreshToken' in migrated))
    assert.equal(migrated.refreshingUntil, legacyDocument.refreshingUntil)
    assert.equal(JSON.stringify(migrated).includes(auth.accessToken), false)
    assert.equal(JSON.stringify(migrated).includes(auth.refreshToken), false)
})

test('SaxoAuthStore.getAuth は legacy migration document に undefined field を含めない', async () => {
    const { accounts: _accounts, ...legacyDocument } = createAuthData()
    const firestore = createFirestoreMock(legacyDocument)
    const store = new SaxoAuthStore({
        db: firestore.db,
        tokenEncryptionKey: TEST_KEY,
    })

    await store.getAuth()

    const migrated = firestore.getStoredData()
    assert.ok(migrated)
    assert.equal('accounts' in migrated, false)
    assert.equal('refreshingUntil' in migrated, false)
})

test('SaxoAuthStore.getAuth は migration failure を安全にログ出力して legacy document を変更しない', async () => {
    const accessToken = 'sensitive-migration-access-token'
    const refreshToken = 'sensitive-migration-refresh-token'
    const encryptionKey = Buffer.alloc(32, 23).toString('base64')
    const legacyDocument = {
        ...createAuthData({ accessToken, refreshToken }),
        refreshingUntil: 1_700_000_000_000,
    }
    const firestore = createFirestoreMock(legacyDocument, {
        transactionCommitError: new Error(
            `transaction rejected: ${accessToken} ${refreshToken} ${encryptionKey}`,
        ),
    })
    const { logger, entries } = createCapturingLogger()
    const store = new SaxoAuthStore({
        db: firestore.db,
        tokenEncryptionKey: encryptionKey,
        logger,
    })

    await assert.rejects(store.getAuth(), /Failed to migrate legacy Saxo auth document/)

    assert.deepEqual(firestore.getStoredData(), legacyDocument)
    const captured = stringifyCapturedLogs(entries)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]?.obj.event, 'saxo_auth:migration_failed')
    for (const secret of [accessToken, refreshToken, encryptionKey]) {
        assert.equal(captured.includes(secret), false)
    }
})

test('SaxoAuthStore は missing または不正な暗号鍵を fail-closed にする', () => {
    const firestore = createFirestoreMock()

    assert.throws(
        () => new SaxoAuthStore({ db: firestore.db }),
        /SAXO_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32 byte key/,
    )
    assert.throws(
        () => new SaxoAuthStore({ db: firestore.db, tokenEncryptionKey: 'invalid' }),
        /SAXO_TOKEN_ENCRYPTION_KEY must be a base64-encoded 32 byte key/,
    )
})

test('SaxoAuthStore.getAuth は wrong key と改ざんされた authTag を拒否する', async () => {
    const firestore = createFirestoreMock()
    const writer = new SaxoAuthStore({ db: firestore.db, tokenEncryptionKey: TEST_KEY })
    await writer.saveAuth(createAuthData())

    const wrongKeyReader = new SaxoAuthStore({
        db: firestore.db,
        tokenEncryptionKey: randomBytes(32).toString('base64'),
    })
    await assert.rejects(wrongKeyReader.getAuth(), /Failed to decrypt token payload/)

    const saved = firestore.getStoredData() as Record<string, unknown>
    const envelope = saved.encryptedTokens as Record<string, unknown>
    const authTag = Buffer.from(envelope.authTag as string, 'base64')
    authTag[0] ^= 1
    envelope.authTag = authTag.toString('base64')
    const tamperedFirestore = createFirestoreMock({ ...saved, encryptedTokens: envelope })
    const reader = new SaxoAuthStore({ db: tamperedFirestore.db, tokenEncryptionKey: TEST_KEY })

    await assert.rejects(reader.getAuth(), /Failed to decrypt token payload/)
})

test('SaxoAuthStore.getAuth は encrypted と plaintext が混在しても plaintext fallback しない', async () => {
    const firestore = createFirestoreMock()
    const store = new SaxoAuthStore({ db: firestore.db, tokenEncryptionKey: TEST_KEY })
    const auth = createAuthData()
    await store.saveAuth(auth)
    const encrypted = firestore.getStoredData() as Record<string, unknown>
    const mixedFirestore = createFirestoreMock({
        ...encrypted,
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
    })
    const mixedStore = new SaxoAuthStore({ db: mixedFirestore.db, tokenEncryptionKey: TEST_KEY })

    await assert.rejects(mixedStore.getAuth(), /Invalid Saxo auth document/)
    assert.deepEqual(mixedFirestore.getStoredData(), {
        ...encrypted,
        accessToken: auth.accessToken,
        refreshToken: auth.refreshToken,
    })
})

test('SaxoAuthStore.getAuth は malformed legacy document を移行しない', async () => {
    const malformed = {
        accessToken: 'plain-access-token',
        accessTokenExpiresAt: 1_800_000_000_000,
        refreshTokenExpiresAt: 1_900_000_000_000,
    }
    const firestore = createFirestoreMock(malformed)
    const store = new SaxoAuthStore({ db: firestore.db, tokenEncryptionKey: TEST_KEY })

    await assert.rejects(store.getAuth(), /Invalid Saxo auth document/)

    assert.equal(firestore.getTransactionCount(), 0)
    assert.deepEqual(firestore.getStoredData(), malformed)
})

test('SaxoAuthStore.acquireRefreshLease は期限切れ token の 30 秒 lease を取得する', async () => {
    const now = 1_800_000_000_000
    const auth = createAuthData({
        accessTokenExpiresAt: now - 1,
        refreshTokenExpiresAt: now + 86_400_000,
    })
    const firestore = createFirestoreMock()
    const store = new SaxoAuthStore({
        db: firestore.db,
        tokenEncryptionKey: TEST_KEY,
        now: () => now,
    })
    await store.saveAuth(auth)

    const result = await store.acquireRefreshLease()

    assert.deepEqual(result, { status: 'acquired', auth })
    assert.equal((firestore.getStoredData() as Record<string, unknown>).refreshingUntil, now + 30_000)
})

test('SaxoAuthStore は active lease を拒否し、解放後に再取得できる', async () => {
    const now = 1_800_000_000_000
    const auth = createAuthData({
        accessTokenExpiresAt: now - 1,
        refreshTokenExpiresAt: now + 86_400_000,
    })
    const firestore = createFirestoreMock()
    const store = new SaxoAuthStore({
        db: firestore.db,
        tokenEncryptionKey: TEST_KEY,
        now: () => now,
    })
    await store.saveAuth(auth)
    assert.equal((await store.acquireRefreshLease()).status, 'acquired')

    assert.deepEqual(await store.acquireRefreshLease(), { status: 'already-refreshing' })

    await store.releaseRefreshLease()
    assert.equal((firestore.getStoredData() as Record<string, unknown>).refreshingUntil, now - 1_000)
    assert.equal((await store.acquireRefreshLease()).status, 'acquired')
})

test('SaxoAuthStore.acquireRefreshLease は更新済み token と missing document を識別する', async () => {
    const now = 1_800_000_000_000
    const auth = createAuthData({
        accessTokenExpiresAt: now + 60_000,
        refreshTokenExpiresAt: now + 86_400_000,
    })
    const firestore = createFirestoreMock()
    const store = new SaxoAuthStore({
        db: firestore.db,
        tokenEncryptionKey: TEST_KEY,
        now: () => now,
    })
    await store.saveAuth(auth)

    assert.deepEqual(await store.acquireRefreshLease(), { status: 'already-fresh', auth })

    const emptyFirestore = createFirestoreMock()
    const emptyStore = new SaxoAuthStore({
        db: emptyFirestore.db,
        tokenEncryptionKey: TEST_KEY,
        now: () => now,
    })
    assert.deepEqual(await emptyStore.acquireRefreshLease(), { status: 'missing' })
})

test('SaxoAuthStore.saveAuth は refresh 成功後の全置換で lease を消去する', async () => {
    const now = 1_800_000_000_000
    const firestore = createFirestoreMock()
    const store = new SaxoAuthStore({
        db: firestore.db,
        tokenEncryptionKey: TEST_KEY,
        now: () => now,
    })
    await store.saveAuth(createAuthData({ accessTokenExpiresAt: now - 1 }))
    await store.acquireRefreshLease()

    await store.saveAuth(createAuthData({ accessToken: 'new-access-token' }))

    assert.ok(!('refreshingUntil' in (firestore.getStoredData() as Record<string, unknown>)))
})

test('SaxoAuthStore migration は concurrent refresh の新 token を古い token へ巻き戻さない', async () => {
    const legacyAuth = createAuthData({
        accessToken: 'legacy-access-token',
        refreshToken: 'legacy-refresh-token',
    })
    const refreshedAuth = createAuthData({
        accessToken: 'refreshed-access-token',
        refreshToken: 'refreshed-refresh-token',
        accessTokenExpiresAt: 1_850_000_000_000,
    })
    let refreshStore: SaxoAuthStore
    const firestore = createFirestoreMock(legacyAuth, {
        beforeFirstTransactionCommit: async () => refreshStore.saveAuth(refreshedAuth),
    })
    const migrationStore = new SaxoAuthStore({ db: firestore.db, tokenEncryptionKey: TEST_KEY })
    refreshStore = new SaxoAuthStore({ db: firestore.db, tokenEncryptionKey: TEST_KEY })

    assert.deepEqual(await migrationStore.getAuth(), refreshedAuth)
    assert.ok(firestore.getTransactionCount() >= 2)
    assert.deepEqual(await refreshStore.getAuth(), refreshedAuth)
    const finalDocument = firestore.getStoredData() as Record<string, unknown>
    assert.ok(finalDocument.encryptedTokens)
    assert.equal('accessToken' in finalDocument, false)
    assert.equal('refreshToken' in finalDocument, false)
})
