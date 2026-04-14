import type { OrderDispatchFailure, OrderDispatchResult, OrderRequest } from '../types/order.js'
import type { Position } from '../types/position.js'

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

    async getPositions(): Promise<Position[]> {
        return [
            {
                broker: 'dummy',
                ticker: 'BTC/JPY',
                side: 'BUY',
                size: 1.0,
                price: 10000000,
                pnl: 500000,
            },
        ]
    }
}
