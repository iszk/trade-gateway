import { BitflyerClient } from '../brokers/bitflyer.js'
import { DummyClient } from '../brokers/dummy.js'
import { SaxoClient } from '../brokers/saxo.js'
import { config } from '../config.js'
import type { BrokerName } from '../types/order.js'
import type { Position } from '../types/position.js'

type PositionFetcherOptions = {
    bitflyerClient?: BitflyerClient
    dummyClient?: DummyClient
    saxoClient?: SaxoClient
}

export class PositionFetcher {
    private readonly bitflyerClient: BitflyerClient
    private readonly dummyClient: DummyClient
    private readonly saxoClient: SaxoClient

    constructor(options: PositionFetcherOptions = {}) {
        this.bitflyerClient =
            options.bitflyerClient ??
            new BitflyerClient({
                apiKey: config.bitflyer.apiKey,
                apiSecret: config.bitflyer.apiSecret,
                baseUrl: config.bitflyer.baseUrl,
            })
        this.dummyClient = options.dummyClient ?? new DummyClient()
        this.saxoClient =
            options.saxoClient ??
            new SaxoClient({
                appKey: config.saxo.appKey,
                appSecret: config.saxo.appSecret,
                baseUrl: config.saxo.baseUrl,
                authBaseUrl: config.saxo.authBaseUrl,
                redirectUri: config.saxo.redirectUri,
            })
    }

    async fetchAllPositions(broker?: BrokerName): Promise<Position[]> {
        const brokersToFetch: BrokerName[] = broker ? [broker] : ['bitflyer', 'saxo', 'dummy']
        const allPositions: Position[] = []

        const fetchPromises = brokersToFetch.map(async (b) => {
            try {
                switch (b) {
                    case 'bitflyer':
                        return await this.bitflyerClient.getPositions()
                    case 'dummy':
                        return await this.dummyClient.getPositions()
                    case 'saxo':
                        return await this.saxoClient.getPositions()
                    default:
                        return []
                }
            } catch (error) {
                console.error(`Failed to fetch positions for ${b}`, error)
                return []
            }
        })

        const results = await Promise.all(fetchPromises)
        return results.flat()
    }
}
