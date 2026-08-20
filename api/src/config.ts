const DEFAULT_BITFLYER_BASE_URL = 'https://api.bitflyer.jp'

const readRequired = (name: string): string | undefined => {
    const value = process.env[name]?.trim()
    return value && value.length > 0 ? value : undefined
}

const readStrictBoolean = (name: string, defaultValue: boolean): boolean => {
    const rawValue = process.env[name]
    if (rawValue === undefined) return defaultValue

    if (rawValue === 'true') return true
    if (rawValue === 'false') return false

    throw new Error(`${name} must be exactly "true" or "false"`)
}

export const config = {
    bitflyer: {
        apiKey: readRequired('BITFLYER_API_KEY'),
        apiSecret: readRequired('BITFLYER_API_SECRET'),
        baseUrl: process.env.BITFLYER_API_BASE_URL?.trim() || DEFAULT_BITFLYER_BASE_URL,
    },
    saxo: {
        appKey: readRequired('SAXO_APP_KEY'),
        appSecret: readRequired('SAXO_APP_SECRET'),
        tokenEncryptionKey: readRequired('SAXO_TOKEN_ENCRYPTION_KEY'),
        redirectUri: process.env.SAXO_REDIRECT_URI?.trim(),
        baseUrl: process.env.SAXO_API_BASE_URL?.trim() || 'https://gateway.saxobank.com/sim/openapi',
        authBaseUrl: process.env.SAXO_AUTH_BASE_URL?.trim() || 'https://sim.logonvalidation.net',
    },
    webhook: {
        allowUnregisteredStrategyPolicyFallback: readStrictBoolean(
            'ALLOW_UNREGISTERED_STRATEGY_POLICY_FALLBACK',
            true,
        ),
    },
}
