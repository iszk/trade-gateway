import { BrokerName, OrderSide } from './order.js'
import type { BrokerOrderMetadata } from './broker-order-metadata.js'

export type OrderStatusV2 = 'PENDING' | 'EXECUTED' | 'FAILED' | 'CANCELED'

export type OrderTypeV2 = 'MARKET' | 'IFDOCO' | 'LIMIT' | 'STOP'

export type ExitSyncStatus = 'MONITORING' | 'COMPLETED'

export type OrderV2 = {
    /** 注文のユニークID（WebhookのeventIdなど） */
    id: string
    /** 集計の唯一の軸となる戦略名 */
    strategy: string
    /** 取引所名 */
    broker: BrokerName
    /** 取引ペア */
    ticker: string
    /** 売買方向 */
    side: OrderSide
    /** 注文タイプ */
    order_type: OrderTypeV2
    /** 要求数量 */
    requested_size: number
    /** 実約定数量 */
    executed_size: number
    /** 実約定価格 */
    executed_price: number | null
    /** 注文の現在のステータス */
    status: OrderStatusV2
    /** IFDOCO 親注文の exit 監視状態 */
    exit_sync_status?: ExitSyncStatus
    /** Broker側で発行された注文ID。IFD-OCO等の複数IDに対応するため配列 */
    provider_order_ids: string[]
    /** Broker固有の注文追跡メタデータ */
    broker_order_metadata?: BrokerOrderMetadata
    /** レコード作成日時 (Webhook受付時刻など) */
    created_at: Date
    /** 最終更新日時 */
    updated_at: Date
}
