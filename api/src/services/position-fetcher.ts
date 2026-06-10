import { BitflyerClient } from '../brokers/bitflyer.js'
import { DummyClient } from '../brokers/dummy.js'
import { SaxoClient } from '../brokers/saxo.js'
import { config } from '../config.js'
import type { BrokerName } from '../types/order.js'
import type { Position } from '../types/position.js'
import { createDefaultListTradableSymbolsFn, type ListTradableSymbolsFn } from './tradable-symbols.js'

type PositionFetcherOptions = {
    bitflyerClient?: BitflyerClient
    dummyClient?: DummyClient
    saxoClient?: SaxoClient
    listTradableSymbols?: ListTradableSymbolsFn
}

const DEFAULT_BITFLYER_POSITION_TICKERS = ['FX_BTC_JPY']

export class PositionFetcher {
    private readonly bitflyerClient: BitflyerClient
    private readonly dummyClient: DummyClient
    private readonly saxoClient: SaxoClient
    private readonly listTradableSymbols: ListTradableSymbolsFn

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
        this.listTradableSymbols = options.listTradableSymbols ?? createDefaultListTradableSymbolsFn()
    }

    private async getBitflyerPositionTickers(): Promise<string[]> {
        try {
            const symbols = await this.listTradableSymbols()
            const tickers = [
                ...new Set(
                    symbols
                        .filter((symbol) => symbol.broker === 'bitflyer')
                        .map((symbol) => symbol.ticker.trim())
                        .filter((ticker) => ticker.length > 0),
                ),
            ]
            return tickers.length > 0 ? tickers : DEFAULT_BITFLYER_POSITION_TICKERS
        } catch (error) {
            console.error('Failed to list tradable symbols for bitflyer positions', error)
            return DEFAULT_BITFLYER_POSITION_TICKERS
        }
    }

    async fetchAllPositions(broker?: BrokerName): Promise<Position[]> {
        const brokersToFetch: BrokerName[] = broker ? [broker] : ['bitflyer', 'saxo', 'dummy']

        const fetchPromises = brokersToFetch.map(async (b) => {
            try {
                switch (b) {
                    case 'bitflyer':
                        return await this.bitflyerClient.getPositions(await this.getBitflyerPositionTickers())
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
