import type { Firestore } from 'firebase-admin/firestore'
import { getFirestoreClient } from '../firestore.js'
import type { OrderDispatchFailure, OrderDispatchResult, OrderRequest } from '../types/order.js'
import type { Position } from '../types/position.js'

type SaxoClientOptions = {
    appKey?: string
    appSecret?: string
    baseUrl?: string
    authBaseUrl?: string
    redirectUri?: string
    fetchImpl?: typeof fetch
    db?: Firestore
}

type SaxoAuthData = {
    accessToken: string
    refreshToken: string
    accessTokenExpiresAt: number // timestamp in ms
    refreshTokenExpiresAt: number // timestamp in ms
}

type SaxoTokenResponse = {
    access_token: string
    refresh_token: string
    expires_in: number // seconds
    refresh_token_expires_in: number // seconds
    token_type: string
}

type SaxoNetPosition = {
    NetPositionId: string
    NetPositionBase: {
        Amount: number
        OpeningDirection: 'Buy' | 'Sell'
    }
    NetPositionView: {
        AverageOpenPrice?: number
        ProfitLossOnTrade?: number
    }
}

type SaxoNetPositionsResponse = {
    Data: SaxoNetPosition[]
}

const FIRESTORE_COLLECTION = 'saxo_auth_data'
const FIRESTORE_DOC = 'saxo_auth'

export class SaxoClient {
    private readonly appKey?: string
    private readonly appSecret?: string
    private readonly baseUrl: string
    private readonly authBaseUrl: string
    private readonly redirectUri?: string
    private readonly fetchImpl: typeof fetch
    private readonly db?: Firestore

    constructor(options: SaxoClientOptions = {}) {
        this.appKey = options.appKey
        this.appSecret = options.appSecret
        this.baseUrl = options.baseUrl ?? 'https://gateway.saxobank.com/sim/openapi'
        this.authBaseUrl = options.authBaseUrl ?? 'https://sim.logonvalidation.net'
        this.redirectUri = options.redirectUri
        this.fetchImpl = options.fetchImpl ?? fetch
        this.db = options.db
    }

    private getFirestore(): Firestore {
        return this.db ?? getFirestoreClient()
    }

    private buildFailure(
        code: OrderDispatchFailure['code'],
        message: string,
    ): OrderDispatchFailure {
        return {
            ok: false,
            broker: 'saxo',
            code,
            message,
        }
    }

    async getAuth(): Promise<SaxoAuthData | null> {
        const db = this.getFirestore()
        const doc = await db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC).get()
        if (!doc.exists) {
            return null
        }
        return doc.data() as SaxoAuthData
    }

    async saveAuth(data: SaxoAuthData): Promise<void> {
        const db = this.getFirestore()
        await db.collection(FIRESTORE_COLLECTION).doc(FIRESTORE_DOC).set(data)
    }

    async refreshAccessToken(refreshToken: string): Promise<SaxoAuthData> {
        if (!this.appKey || !this.appSecret) {
            throw new Error('Saxo app credentials missing')
        }

        const basicAuth = Buffer.from(`${this.appKey}:${this.appSecret}`).toString('base64')
        const response = await this.fetchImpl(`${this.authBaseUrl}/token`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${basicAuth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
            }),
        })

        if (!response.ok) {
            const body = await response.text()
            throw new Error(`Failed to refresh Saxo token: ${response.status} ${body}`)
        }

        const payload = (await response.json()) as SaxoTokenResponse
        const authData: SaxoAuthData = {
            accessToken: payload.access_token,
            refreshToken: payload.refresh_token,
            accessTokenExpiresAt: Date.now() + payload.expires_in * 1000,
            refreshTokenExpiresAt: Date.now() + payload.refresh_token_expires_in * 1000,
        }

        await this.saveAuth(authData)
        return authData
    }

    async exchangeCodeForToken(code: string): Promise<SaxoAuthData> {
        if (!this.appKey || !this.appSecret || !this.redirectUri) {
            throw new Error('Saxo app credentials or redirect URI missing')
        }

        const basicAuth = Buffer.from(`${this.appKey}:${this.appSecret}`).toString('base64')
        const response = await this.fetchImpl(`${this.authBaseUrl}/token`, {
            method: 'POST',
            headers: {
                'Authorization': `Basic ${basicAuth}`,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type: 'authorization_code',
                code,
                redirect_uri: this.redirectUri,
            }),
        })

        if (!response.ok) {
            const body = await response.text()
            throw new Error(`Failed to exchange Saxo code: ${response.status} ${body}`)
        }

        const payload = (await response.json()) as SaxoTokenResponse
        const authData: SaxoAuthData = {
            accessToken: payload.access_token,
            refreshToken: payload.refresh_token,
            accessTokenExpiresAt: Date.now() + payload.expires_in * 1000,
            refreshTokenExpiresAt: Date.now() + payload.refresh_token_expires_in * 1000,
        }

        await this.saveAuth(authData)
        return authData
    }

    async getValidAccessToken(): Promise<string | null> {
        let auth = await this.getAuth()
        if (!auth) return null

        // Refresh if expiring in less than 1 minute
        if (auth.accessTokenExpiresAt < Date.now() + 60 * 1000) {
            if (auth.refreshTokenExpiresAt < Date.now() + 60 * 1000) {
                return null // Refresh token also expired
            }
            try {
                auth = await this.refreshAccessToken(auth.refreshToken)
            } catch (error) {
                console.error('Failed to auto-refresh Saxo token', error)
                return null
            }
        }

        return auth.accessToken
    }

    async sendMarketOrder(order: OrderRequest): Promise<OrderDispatchResult> {
        const accessToken = await this.getValidAccessToken()
        if (!accessToken) {
            return this.buildFailure('BROKER_NOT_CONFIGURED', 'Saxo auth is missing or expired')
        }

        // TODO: Saxo specific market order implementation
        // For now, return a failure or a dummy success to verify connectivity later
        // Real implementation would use: POST /trade/v2/orders

        return this.buildFailure('BROKER_REQUEST_FAILED', 'Saxo order implementation is pending')
    }

    getLoginUrl(state: string): string {
        if (!this.appKey || !this.redirectUri) {
            throw new Error('Saxo app credentials or redirect URI missing')
        }
        const params = new URLSearchParams({
            response_type: 'code',
            client_id: this.appKey,
            state: state,
            redirect_uri: this.redirectUri,
        })
        return `${this.authBaseUrl}/authorize?${params.toString()}`
    }

    async getPositions(): Promise<Position[]> {
        const accessToken = await this.getValidAccessToken()
        if (!accessToken) {
            return []
        }

        const response = await this.fetchImpl(`${this.baseUrl}/port/v1/netpositions/me`, {
            headers: {
                Authorization: `Bearer ${accessToken}`,
            },
        })

        if (!response.ok) {
            const body = await response.text()
            throw new Error(`Failed to fetch Saxo positions: ${response.status} ${body}`)
        }

        const data = (await response.json()) as SaxoNetPositionsResponse
        return data.Data.map((item) => ({
            broker: 'saxo' as const,
            ticker: item.NetPositionId.split('__')[0] ?? item.NetPositionId,
            side: item.NetPositionBase.OpeningDirection === 'Buy' ? 'BUY' : 'SELL',
            size: item.NetPositionBase.Amount,
            price: item.NetPositionView.AverageOpenPrice,
            pnl: item.NetPositionView.ProfitLossOnTrade,
        }))
    }
}
