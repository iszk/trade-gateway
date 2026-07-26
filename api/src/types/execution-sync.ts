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

type ExecutionSyncResultBase = {
    execution: ExecutionSyncInfo | null
}

type ExecutionSyncResultMetadata =
    | {
        brokerOrderMetadata: BrokerOrderMetadata
        /** 合成 metadata は transaction 内で未設定時だけ保存する。 */
        brokerOrderMetadataPolicy: 'SET_IF_UNSET'
    }
    | {
        brokerOrderMetadata?: BrokerOrderMetadata
        brokerOrderMetadataPolicy?: never
    }

export type OrderExecutionSyncResult = ExecutionSyncResultBase & ExecutionSyncResultMetadata & ExecutionSyncTerminal

export type ExecutionSyncOptions = {
    now: Date
}

export type ExecutionReconciliationRange = {
    from: Date
    to: Date
}

export type BulkExecutionPriceFetcherLike = {
    getExecutionPricesForOrdersV2?(
        orders: OrderV2[],
        options: ExecutionSyncOptions,
    ): Promise<Map<string, OrderExecutionSyncResult>>
}

export type ExecutionReconciliationFetcherLike = {
    reconcileExecutionPricesForOrdersV2(
        orders: OrderV2[],
        range: ExecutionReconciliationRange,
    ): Promise<Map<string, OrderExecutionSyncResult>>
}
