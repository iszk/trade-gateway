import { BitflyerClient } from '../brokers/bitflyer.js'
import { DummyClient } from '../brokers/dummy.js'
import { SaxoClient } from '../brokers/saxo.js'
import { config } from '../config.js'
import type { DispatchOrderFn, OrderRequest } from '../types/order.js'

type OrderDispatcherOptions = {
    bitflyerClient?: BitflyerClient
    dummyClient?: DummyClient
    saxoClient?: SaxoClient
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
    const saxoClient =
        options.saxoClient ??
        new SaxoClient({
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
                return saxoClient.sendMarketOrder(order)
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
