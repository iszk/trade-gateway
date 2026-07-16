import type { BrokerOrderMetadata } from './broker-order-metadata.js'

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
