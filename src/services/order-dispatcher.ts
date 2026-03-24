import { BitflyerClient } from '../brokers/bitflyer.js'
import { config } from '../config.js'
import type { DispatchOrderFn, IncomingBroker, OrderRequest } from '../types/order.js'

type OrderDispatcherOptions = {
    bitflyerClient?: BitflyerClient
}

export const resolveBroker = (broker?: IncomingBroker): OrderRequest['broker'] => {
    if (!broker || broker === 'auto') {
        return 'bitflyer'
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

    return async (order) => {
        switch (order.broker) {
            case 'bitflyer':
                return bitflyerClient.sendMarketOrder(order)
            default:
                return {
                    ok: false,
                    broker: order.broker,
                    code: 'BROKER_NOT_SUPPORTED',
                    message: `unsupported broker: ${order.broker}`,
                }
        }
    }
}
