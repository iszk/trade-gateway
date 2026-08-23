import { BitflyerClient } from '../brokers/bitflyer.js'
import { DummyClient } from '../brokers/dummy.js'
import { SaxoClient } from '../brokers/saxo.js'
import { config } from '../config.js'
import { defaultLogger } from '../logger.js'
import type { BrokerName } from '../types/order.js'
import type { Position } from '../types/position.js'
import { createDefaultListTradableSymbolsFn, type ListTradableSymbolsFn } from './tradable-symbols.js'

type BitflyerPositionClientLike = {
    getPositions(productCodes?: string[]): Promise<Position[]>
    getPositionsStrict?(productCodes?: string[]): Promise<Position[]>
    getPositionsForReconciliation?(productCodes?: string[]): Promise<Position[]>
}

type SaxoPositionClientLike = {
    getPositions(): Promise<Position[]>
    getPositionsStrict?(): Promise<Position[]>
    getPositionsForReconciliation?(): Promise<Position[]>
}

type DummyPositionClientLike = {
    getPositions(): Promise<Position[]>
    getPositionsStrict?(): Promise<Position[]>
    getPositionsForReconciliation?(): Promise<Position[]>
}

type PositionFetcherOptions = {
    bitflyerClient?: BitflyerPositionClientLike
    dummyClient?: DummyPositionClientLike
    saxoClient?: SaxoPositionClientLike
    listTradableSymbols?: ListTradableSymbolsFn
}

export class PositionFetcher {
    private readonly bitflyerClient: BitflyerPositionClientLike
    private readonly dummyClient: DummyPositionClientLike
    private readonly saxoClient: SaxoPositionClientLike
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
                tokenEncryptionKey: config.saxo.tokenEncryptionKey,
            })
        this.listTradableSymbols = options.listTradableSymbols ?? createDefaultListTradableSymbolsFn()
    }

    private async getBitflyerPositionTickers(strict = false): Promise<string[]> {
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
            if (tickers.length === 0) {
                defaultLogger.warn(
                    { event: 'position_fetcher:no_bitflyer_tradable_symbols' },
                    'no tradable symbols configured for bitflyer positions',
                )
            }
            return tickers
        } catch (error) {
            if (strict) throw error
            defaultLogger.warn(
                { event: 'position_fetcher:list_tradable_symbols_failed', error },
                'failed to list tradable symbols for bitflyer positions',
            )
            return []
        }
    }

    async fetchAllPositions(broker?: BrokerName): Promise<Position[]> {
        const brokersToFetch: BrokerName[] = broker ? [broker] : ['bitflyer', 'saxo', 'dummy']

        const fetchPromises = brokersToFetch.map(async (b) => {
            try {
                switch (b) {
                    case 'bitflyer': {
                        const tickers = await this.getBitflyerPositionTickers()
                        if (tickers.length === 0) return []
                        return await this.bitflyerClient.getPositions(tickers)
                    }
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

    /**
     * Fetch an all-or-nothing broker snapshot for aggregate reconciliation.
     * Unlike `fetchAllPositions`, errors are deliberately propagated so that
     * callers cannot mistake an unavailable account for zero exposure.
     */
    async fetchPositionsForReconciliation(broker: BrokerName): Promise<Position[]> {
        switch (broker) {
            case 'bitflyer': {
                const tickers = await this.getBitflyerPositionTickers(true)
                if (tickers.length === 0) return []
                if (this.bitflyerClient.getPositionsForReconciliation) {
                    return this.bitflyerClient.getPositionsForReconciliation(tickers)
                }
                if (this.bitflyerClient.getPositionsStrict) {
                    return this.bitflyerClient.getPositionsStrict(tickers)
                }
                throw new Error('bitflyer reconciliation strict position seam is unavailable')
            }
            case 'saxo':
                if (this.saxoClient.getPositionsForReconciliation) {
                    return this.saxoClient.getPositionsForReconciliation()
                }
                if (this.saxoClient.getPositionsStrict) {
                    return this.saxoClient.getPositionsStrict()
                }
                throw new Error('saxo reconciliation strict position seam is unavailable')
            case 'dummy':
                if (this.dummyClient.getPositionsForReconciliation) {
                    return this.dummyClient.getPositionsForReconciliation()
                }
                if (this.dummyClient.getPositionsStrict) {
                    return this.dummyClient.getPositionsStrict()
                }
                // DummyClient is an in-memory deterministic broker whose
                // existing getPositions method is itself the complete
                // snapshot contract.  Bitflyer/Saxo deliberately do not
                // have this fallback because their legacy methods are
                // best-effort.
                return this.dummyClient.getPositions()
            default:
                throw new Error(`unsupported broker: ${broker}`)
        }
    }
}
