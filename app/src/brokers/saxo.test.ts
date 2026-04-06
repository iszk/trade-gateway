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
        baseUrl: 'https://api.example.com',
        db,
        fetchImpl: async (url) => {
            if (url.toString().endsWith('/token')) {
                return new Response(
                    JSON.stringify({
                        access_token: 'new-access-token',
                        refresh_token: 'new-refresh-token',
                        expires_in: 1200,
                        refresh_token_expires_in: 86400,
                    }),
                    { status: 200 },
                )
            }
            if (url.toString().endsWith('/port/v1/clients/me')) {
                return new Response(JSON.stringify({ ClientKey: 'test-client-key' }), {
                    status: 200,
                })
            }
            if (url.toString().endsWith('/port/v1/accounts/me')) {
                return new Response(
                    JSON.stringify({ Data: [{ AccountKey: 'test-account-key' }] }),
                    { status: 200 },
                )
            }
            return new Response('Not Found', { status: 404 })
        },
    })

    await client.exchangeCodeForToken('test-code')

    const auth = await client.getAuth()
    assert.equal(auth?.accessToken, 'new-access-token')
    assert.equal(auth?.refreshToken, 'new-refresh-token')
    assert.equal(auth?.clientKey, 'test-client-key')
    assert.equal(auth?.accountKey, 'test-account-key')
})

test('SaxoClient.getValidAccessToken refreshes if expired', async () => {
    const initialAuth = {
        accessToken: 'old-token',
        refreshToken: 'refresh-token',
        accessTokenExpiresAt: Date.now() - 1000, // Expired
        refreshTokenExpiresAt: Date.now() + 86400000,
    }
    const db = mockFirestore({ 'saxo_auth_data/saxo_auth': initialAuth })

    const client = new SaxoClient({
        appKey: 'test-key',
        appSecret: 'test-secret',
        authBaseUrl: 'https://auth.example.com',
        baseUrl: 'https://api.example.com',
        db,
        fetchImpl: async (url) => {
            if (url.toString().endsWith('/token')) {
                return new Response(
                    JSON.stringify({
                        access_token: 'refreshed-token',
                        refresh_token: 'new-refresh-token',
                        expires_in: 1200,
                        refresh_token_expires_in: 86400,
                    }),
                    { status: 200 },
                )
            }
            if (url.toString().endsWith('/port/v1/clients/me')) {
                return new Response(JSON.stringify({ ClientKey: 'test-client-key' }), {
                    status: 200,
                })
            }
            if (url.toString().endsWith('/port/v1/accounts/me')) {
                return new Response(
                    JSON.stringify({ Data: [{ AccountKey: 'test-account-key' }] }),
                    { status: 200 },
                )
            }
            return new Response('Not Found', { status: 404 })
        },
    })

    const token = await client.getValidAccessToken()
    assert.equal(token, 'refreshed-token')

    const auth = await client.getAuth()
    assert.equal(auth?.accessToken, 'refreshed-token')
    assert.equal(auth?.clientKey, 'test-client-key')
    assert.equal(auth?.accountKey, 'test-account-key')
})
