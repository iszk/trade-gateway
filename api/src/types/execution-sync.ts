import type { BrokerOrderMetadata } from './broker-order-metadata.js'

export type ExecutionTerminalStatus = 'CANCELED' | 'FAILED'

export type ExecutionSyncInfo = {
    price: number
    size: number
    executed_at?: Date
    commission?: number
}

export type OrderExecutionSyncResult = {
    execution: ExecutionSyncInfo | null
    terminalStatus?: ExecutionTerminalStatus
    /** Broker response の raw message ではなく、固定された安全な分類理由だけを保持する。 */
    terminalReason?: string
    brokerOrderMetadata?: BrokerOrderMetadata
}
