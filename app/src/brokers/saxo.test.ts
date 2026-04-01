import assert from 'node:assert/strict'
import test from 'node:test'
import type { Firestore } from 'firebase-admin/firestore'

import { SaxoClient } from './saxo.js'

const mockFirestore = (data: Record<string, any> = {}) => {
    const store = { ...data }
    return {
        collection: (collectionPath: string) => ({
            doc: (docPath: string) => ({
                get: async () => ({
                    exists: store[`${collectionPath}/${docPath}`] !== undefined,
                    data: () => store[`${collectionPath}/${docPath}`],
                }),
                set: async (newData: any) => {
                    store[`${collectionPath}/${docPath}`] = newData
                },
            }),
        }),
    } as unknown as Firestore
}

test('SaxoClient.getLoginUrl returns correct URL', () => {
    const client = new SaxoClient({
        appKey: 'test-app-key',
        redirectUri: 'http://localhost/callback',
        authBaseUrl: 'https://auth.example.com',
    })

    const url = client.getLoginUrl('test-state')
    assert.equal(
        url,
        'https://auth.example.com/authorize?response_type=code&client_id=test-app-key&state=test-state&redirect_uri=http%3A%2F%2Flocalhost%2Fcallback',
    )
})

test('SaxoClient.exchangeCodeForToken exchanges code and saves to firestore', async () => {
    const db = mockFirestore()
    let capturedBody = ''

    const client = new SaxoClient({
        appKey: 'test-key',
        appSecret: 'test-secret',
        redirectUri: 'http://localhost/callback',
        authBaseUrl: 'https://auth.example.com',
        db,
        fetchImpl: async (url, init) => {
            capturedBody = String(init?.body)
            return new Response(
                JSON.stringify({
                    access_token: 'new-access-token',
                    refresh_token: 'new-refresh-token',
                    expires_in: 1200,
                    refresh_token_expires_in: 86400,
                }),
                { status: 200 },
            )
        },
    })

    await client.exchangeCodeForToken('test-code')

    assert.ok(capturedBody.includes('code=test-code'))
    assert.ok(capturedBody.includes('grant_type=authorization_code'))

    const auth = await client.getAuth()
    assert.equal(auth?.accessToken, 'new-access-token')
    assert.equal(auth?.refreshToken, 'new-refresh-token')
})

test('SaxoClient.getValidAccessToken refreshes if expired', async () => {
    const initialAuth = {
        accessToken: 'old-token',
        refreshToken: 'refresh-token',
        accessTokenExpiresAt: Date.now() - 1000, // Expired
        refreshTokenExpiresAt: Date.now() + 86400000,
    }
    const db = mockFirestore({ 'settings/saxo_auth': initialAuth })

    const client = new SaxoClient({
        appKey: 'test-key',
        appSecret: 'test-secret',
        authBaseUrl: 'https://auth.example.com',
        db,
        fetchImpl: async () => {
            return new Response(
                JSON.stringify({
                    access_token: 'refreshed-token',
                    refresh_token: 'new-refresh-token',
                    expires_in: 1200,
                    refresh_token_expires_in: 86400,
                }),
                { status: 200 },
            )
        },
    })

    const token = await client.getValidAccessToken()
    assert.equal(token, 'refreshed-token')

    const auth = await client.getAuth()
    assert.equal(auth?.accessToken, 'refreshed-token')
})
