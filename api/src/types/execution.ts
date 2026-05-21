import type { BrokerName, OrderSide } from './order.js'

/**
 * ブローカーで約定が確定した1注文の記録。
 * execution_price は常に確定済みの数値（null を持たない）。
 *
 * - provider_order_id あり かつ entry_id なし → IFDOCO エントリー（エグジット約定待ち）
 * - entry_id あり                            → IFDOCO エグジット（マッチング可能）
 * - どちらもなし                             → マーケット注文
 */
export type OrderExecution = {
    id: string
    strategy: string
    symbol: string
    interval: string
    broker: BrokerName
    side: OrderSide
    size: number
    /** 確定済み約定価格（null は持たない） */
    price: number
    executed_at: Date
    /** IFDOCO エントリー専用: 決済子注文の約定確認に使用 */
    provider_order_id?: string
    /** IFDOCO エグジット専用: 対応するエントリーの id */
    entry_id?: string
}

export type AddOrderExecutionFn = (execution: OrderExecution) => Promise<void>
export type GetMarketOrderExecutionsFn = () => Promise<OrderExecution[]>
export type GetIfdocoEntriesFn = () => Promise<OrderExecution[]>
export type GetIfdocoExitsFn = () => Promise<OrderExecution[]>
export type DeleteOrderExecutionFn = (id: string) => Promise<void>
