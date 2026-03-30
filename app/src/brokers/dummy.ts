import type { OrderDispatchFailure, OrderDispatchResult, OrderRequest } from '../types/order.js'

const buildFailure = (
    code: OrderDispatchFailure['code'],
    message: string,
): OrderDispatchFailure => ({
    ok: false,
    broker: 'dummy',
    code,
    message,
})

export class DummyClient {
    async sendMarketOrder(order: OrderRequest): Promise<OrderDispatchResult> {
        return {
            ok: true,
            broker: 'dummy',
            providerOrderId: `dummy-${order.requestId}`,
        }
    }
}
