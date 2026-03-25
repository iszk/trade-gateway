const DEFAULT_BITFLYER_BASE_URL = 'https://api.bitflyer.jp'

const readRequired = (name: string): string | undefined => {
    const value = process.env[name]?.trim()
    return value && value.length > 0 ? value : undefined
}

export const config = {
    bitflyer: {
        apiKey: readRequired('BITFLYER_API_KEY'),
        apiSecret: readRequired('BITFLYER_API_SECRET'),
        baseUrl: process.env.BITFLYER_API_BASE_URL?.trim() || DEFAULT_BITFLYER_BASE_URL,
    },
}
