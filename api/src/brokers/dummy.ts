import type { OrderDispatchResult, OrderRequest } from '../types/order.js'
import type { Position } from '../types/position.js'

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

    /** Dummy positions are already a complete in-memory snapshot. */
    async getPositionsStrict(): Promise<Position[]> {
        return this.getPositions()
    }

    /** Alias used by reconciliation adapters. */
    async getPositionsForReconciliation(): Promise<Position[]> {
        return this.getPositionsStrict()
    }
}
