import { BrokerName, OrderSide } from './order.js'
import type { BrokerOrderMetadata } from './broker-order-metadata.js'

type OrderStatusV2 = 'PENDING' | 'EXECUTED' | 'FAILED' | 'CANCELED'

type OrderTypeV2 = 'MARKET' | 'IFDOCO' | 'LIMIT' | 'STOP'

type ExitSyncStatus = 'MONITORING' | 'COMPLETED'

type OrderV2ExecutionCosts = {
    /** Broker が報告した execution commission。未設定は unknown を表す */
    commission?: number
}

export type SaxoIfdocoRecoveryState = {
    /** cron 内部だけで使う復旧状態。注文 lifecycle の status とは独立して管理する */
    status: 'RETRY_PENDING' | 'MANUAL_REVIEW' | 'COMPLETED'
    attempt_count: number
    last_attempt_at: Date
    next_attempt_at?: Date
    result_kind: string
    reason?: string
}

type BaseOrderV2 = {
    /** 注文のユニークID（WebhookのeventIdなど） */
    id: string
    /** 既存画面・統計へ表示する legacy 戦略値 */
    strategy: string
    /**
     * policy/reservation が使用した正規化済み strategy ID。
     * legacy 注文では欠落するため optional とし、表示用の strategy は変更しない。
     */
    effective_strategy_id?: string
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
    /** 約定に紐づく broker execution costs */
    execution_costs?: OrderV2ExecutionCosts
    /** IFDOCO 親注文の exit 監視状態 */
    exit_sync_status?: ExitSyncStatus
    /** Broker側で発行された注文ID。IFD-OCO等の複数IDに対応するため配列 */
    provider_order_ids: string[]
    /** Broker固有の注文追跡メタデータ */
    broker_order_metadata?: BrokerOrderMetadata
    /** metadata 欠落 Saxo IFDOCO の内部復旧状態。外部 API へは公開しない */
    saxo_ifdoco_recovery?: SaxoIfdocoRecoveryState
    /** レコード作成日時 (Webhook受付時刻など) */
    created_at: Date
    /** 最終更新日時 */
    updated_at: Date
}

export type ExecutedOrderV2 = BaseOrderV2 & {
    /** 実約定価格 */
    executed_price: number
    /** 実約定時刻。EXECUTED 注文では必須 */
    executed_at: Date
    /** 注文の現在のステータス */
    status: 'EXECUTED'
}

type NonExecutedOrderV2 = BaseOrderV2 & {
    /** 実約定価格 */
    executed_price: number | null
    /** 実約定時刻。EXECUTED 以外では未設定を許可する */
    executed_at?: Date
    /** 注文の現在のステータス */
    status: Exclude<OrderStatusV2, 'EXECUTED'>
}

export type OrderV2 = ExecutedOrderV2 | NonExecutedOrderV2

export const isExecutedOrderV2 = (order: OrderV2): order is ExecutedOrderV2 => (
    order.status === 'EXECUTED' && order.executed_at !== undefined && order.executed_price !== null
)
