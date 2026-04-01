import { BitflyerClient } from '../brokers/bitflyer.js'
import { DummyClient } from '../brokers/dummy.js'
import { SaxoBankClient } from '../brokers/saxobank.js'
import { config } from '../config.js'
import type { DispatchOrderFn, IncomingBroker, OrderRequest } from '../types/order.js'

type OrderDispatcherOptions = {
    bitflyerClient?: BitflyerClient
    dummyClient?: DummyClient
    saxoBankClient?: SaxoBankClient
}

// webhook 側の ticker から broker を決定するマッピング
const TICKER_BROKER_MAP: Record<string, OrderRequest['broker']> = {
    'BITFLYER:FXBTCJPY': 'bitflyer',
    'BITFLYER:BTCJPY': 'bitflyer',
}

export const resolveBroker = (broker: IncomingBroker | undefined, ticker: string): OrderRequest['broker'] => {
    if (!broker || broker === 'auto') {
        return TICKER_BROKER_MAP[ticker.toUpperCase()] ?? 'bitflyer'
    }

    return broker
}

export const createOrderDispatcher = (
    options: OrderDispatcherOptions = {},
): DispatchOrderFn => {
    const bitflyerClient =
        options.bitflyerClient ??
        new BitflyerClient({
            apiKey: config.bitflyer.apiKey,
            apiSecret: config.bitflyer.apiSecret,
            baseUrl: config.bitflyer.baseUrl,
        })
    const dummyClient = options.dummyClient ?? new DummyClient()
    const saxoBankClient =
        options.saxoBankClient ??
        new SaxoBankClient({
            appKey: config.saxo.appKey,
            appSecret: config.saxo.appSecret,
            baseUrl: config.saxo.baseUrl,
            authBaseUrl: config.saxo.authBaseUrl,
            redirectUri: config.saxo.redirectUri,
        })

    return async (order) => {
        switch (order.broker) {
            case 'bitflyer':
                return bitflyerClient.sendMarketOrder(order)
            case 'dummy':
                return dummyClient.sendMarketOrder(order)
            case 'saxo':
                return saxoBankClient.sendMarketOrder(order)
            default:
                return {
                    ok: false,
                    broker: order.broker as string,
                    code: 'BROKER_NOT_SUPPORTED',
                    message: `unsupported broker: ${order.broker}`,
                }
        }
    }
}
