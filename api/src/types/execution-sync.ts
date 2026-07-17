import type { BrokerOrderMetadata } from './broker-order-metadata.js'
import type { OrderV2 } from './order-v2.js'

export type ExecutionTerminalStatus = 'CANCELED' | 'FAILED'

export type ExecutionSyncTerminal =
    | { terminalStatus: ExecutionTerminalStatus, terminalReason: string }
    | { terminalStatus?: never, terminalReason?: never }

export type ExecutionSyncInfo = {
    price: number
    size: number
    executed_at?: Date
    commission?: number
}

export type OrderExecutionSyncResult = {
    execution: ExecutionSyncInfo | null
    brokerOrderMetadata?: BrokerOrderMetadata
} & ExecutionSyncTerminal

export type ExecutionSyncOptions = {
    now: Date
}

export type BulkExecutionPriceFetcherLike = {
    getExecutionPricesForOrdersV2?(
        orders: OrderV2[],
        options: ExecutionSyncOptions,
    ): Promise<Map<string, OrderExecutionSyncResult>>
}
