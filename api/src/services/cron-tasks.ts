import type { GetPendingOrdersV2Fn, UpdateOrderV2Fn, AddOrderV2Fn, GetOrderV2Fn, GetActiveIfdOrdersV2Fn } from './orders-v2.js'
import type { OrderV2 } from '../types/order-v2.js'
import type { BrokerOrderMetadata } from '../types/broker-order-metadata.js'

type Logger = {
    info(obj: Record<string, unknown>, msg?: string): void
    warn(obj: Record<string, unknown>, msg?: string): void
}

type PositionFetcherLike = {
    fetchAllPositions(broker?: string): Promise<unknown[]>
}

const SAXO_PENDING_SYNC_MAX_AGE_MS = 24 * 60 * 60 * 1000
const EPSILON = 0.00000001

type ExecutionInfo = {
    price: number
    size: number
    executed_at?: Date
    commission?: number
}

type OrdersV2ExecutionSyncResult = {
    execution: ExecutionInfo | null
    brokerOrderMetadata?: BrokerOrderMetadata
}

export type ExecutionPriceFetcherLike = {
    getExecutionPriceForOrderV2(order: OrderV2): Promise<OrdersV2ExecutionSyncResult>
}

export type ClosingExecutionFetcherLike = {
    getClosingExecutionForOrderV2(order: OrderV2): Promise<OrdersV2ExecutionSyncResult>
}

export type CronContext = {
    logger: Logger
    positionFetcher: PositionFetcherLike
    executionPriceFetchers?: Partial<Record<string, ExecutionPriceFetcherLike>>
    closingExecutionFetchers?: Partial<Record<string, ClosingExecutionFetcherLike>>
    /** Phase 3: orders_v2 のステータス同期用 */
    getPendingOrdersV2?: GetPendingOrdersV2Fn
    updateOrderV2?: UpdateOrderV2Fn
    addOrderV2?: AddOrderV2Fn
    getOrderV2?: GetOrderV2Fn
    getActiveIfdOrdersV2?: GetActiveIfdOrdersV2Fn
}

const resolveExecutedAt = (order: Pick<OrderV2, 'created_at' | 'executed_at'>, execution: ExecutionInfo): Date => (
    execution.executed_at ?? order.executed_at ?? order.created_at
)

const areSameNumber = (
    left: number | null | undefined,
    right: number | null | undefined,
): boolean => {
    if (left === null || left === undefined || right === null || right === undefined) return left === right
    return Math.abs(left - right) < EPSILON
}

const areSameDate = (left: Date | undefined, right: Date): boolean => (
    left !== undefined && left.getTime() === right.getTime()
)

const hasSameCommission = (order: Pick<OrderV2, 'execution_costs'>, commission: number | undefined): boolean => (
    commission === undefined
        ? order.execution_costs?.commission === undefined
        : order.execution_costs?.commission !== undefined && areSameNumber(order.execution_costs.commission, commission)
)

const areSameBrokerOrderMetadata = (
    left: BrokerOrderMetadata | undefined,
    right: BrokerOrderMetadata | undefined,
): boolean => JSON.stringify(left) === JSON.stringify(right)

const getOrderAgeMs = (order: Pick<OrderV2, 'created_at'>, nowMs: number): number => (
    nowMs - order.created_at.getTime()
)

const shouldSkipStaleSaxoPendingOrder = (order: OrderV2, nowMs: number): boolean => (
    order.broker === 'saxo' && order.order_type === 'MARKET' && getOrderAgeMs(order, nowMs) > SAXO_PENDING_SYNC_MAX_AGE_MS
)

export const executeTenMinutelyTask = async (ctx: CronContext): Promise<void> => {
    ctx.logger.info({ event: 'cron:ten_minutely_task' }, '10-minute task executed')
    const nowMs = Date.now()

    // saxo の oauth token リフレッシュ用
    const broker = 'saxo'
    const positions = await ctx.positionFetcher.fetchAllPositions(broker)
    ctx.logger.info({ event: 'cron:positions_fetched', broker, count: positions.length }, 'cron fetched positions')

    // Phase 3: orders_v2 のステータス同期
    if (ctx.getPendingOrdersV2 && ctx.updateOrderV2 && ctx.executionPriceFetchers) {
        await fetchAndUpdatePendingOrdersV2({
            logger: ctx.logger,
            executionPriceFetchers: ctx.executionPriceFetchers,
            getPendingOrdersV2: ctx.getPendingOrdersV2,
            updateOrderV2: ctx.updateOrderV2,
            nowMs,
        })
    }

    // IFD/IFDOCO 子注文の同期 (V2)
    if (ctx.getActiveIfdOrdersV2 && ctx.addOrderV2 && ctx.updateOrderV2 && ctx.getOrderV2 && ctx.closingExecutionFetchers) {
        await syncExecutionsForExecutedIfdOrders({
            logger: ctx.logger,
            getActiveIfdOrdersV2: ctx.getActiveIfdOrdersV2,
            addOrderV2: ctx.addOrderV2,
            updateOrderV2: ctx.updateOrderV2,
            getOrderV2: ctx.getOrderV2,
            closingExecutionFetchers: ctx.closingExecutionFetchers,
        })
    }
}

export const executeHourlyTask = async (ctx: CronContext): Promise<void> => {
    ctx.logger.info({ event: 'cron:hourly_task' }, 'hourly task executed')
}

/** Phase 3: orders_v2 の PENDING を確定させる */
const fetchAndUpdatePendingOrdersV2 = async (ctx: {
    logger: Logger
    executionPriceFetchers: Partial<Record<string, ExecutionPriceFetcherLike>>
    getPendingOrdersV2: GetPendingOrdersV2Fn
    updateOrderV2: UpdateOrderV2Fn
    nowMs: number
}): Promise<void> => {
    const pendingOrders = await ctx.getPendingOrdersV2()
    ctx.logger.info(
        { event: 'cron:orders_v2_sync_start', count: pendingOrders.length },
        'syncing pending orders_v2',
    )

    for (const order of pendingOrders) {
        if (shouldSkipStaleSaxoPendingOrder(order, ctx.nowMs)) {
            ctx.logger.info(
                {
                    event: 'cron:saxo_pending_order_sync_skipped_stale',
                    orderId: order.id,
                    created_at: order.created_at.toISOString(),
                    maxAgeMs: SAXO_PENDING_SYNC_MAX_AGE_MS,
                },
                'skipping stale Saxo pending order execution sync',
            )
            continue
        }

        const fetcher = ctx.executionPriceFetchers[order.broker]
        if (!fetcher) {
            ctx.logger.info(
                { event: 'cron:execution_price_fetcher_missing', broker: order.broker },
                'no execution price fetcher for broker (orders_v2)',
            )
            continue
        }

        try {
            // 親注文（1つ目）のステータスを確認
            const providerOrderId = order.provider_order_ids[0]
            if (!providerOrderId) continue

            const syncResult = await fetcher.getExecutionPriceForOrderV2(order)

            const info = syncResult.execution
            if (info !== null && info.size > order.requested_size + EPSILON) {
                ctx.logger.warn(
                    {
                        event: 'cron:orders_v2_sync_invalid_size',
                        orderId: order.id,
                        requestedSize: order.requested_size,
                        executionSize: info.size,
                    },
                    'execution size exceeded requested_size; skipping orders_v2 sync update',
                )
                continue
            }

            if (info !== null || syncResult.brokerOrderMetadata !== undefined) {
                const updates: Partial<OrderV2> = {}
                if (
                    syncResult.brokerOrderMetadata !== undefined &&
                    !areSameBrokerOrderMetadata(order.broker_order_metadata, syncResult.brokerOrderMetadata)
                ) {
                    updates.broker_order_metadata = syncResult.brokerOrderMetadata
                }
                if (info !== null) {
                    const isCompleted = info.size >= order.requested_size - EPSILON
                    const executedAt = resolveExecutedAt(order, info)
                    if (order.status !== (isCompleted ? 'EXECUTED' : 'PENDING')) {
                        updates.status = isCompleted ? 'EXECUTED' : 'PENDING'
                    }
                    if (!areSameNumber(order.executed_price, info.price)) {
                        updates.executed_price = info.price
                    }
                    if (!areSameNumber(order.executed_size, info.size)) {
                        updates.executed_size = info.size
                    }
                    if (!areSameDate(order.executed_at, executedAt)) {
                        updates.executed_at = executedAt
                    }
                    if (!hasSameCommission(order, info.commission)) {
                        updates.execution_costs = info.commission === undefined
                            ? {}
                            : { commission: info.commission }
                    }
                    if (isCompleted && order.order_type === 'IFDOCO' && order.exit_sync_status === undefined) {
                        updates.exit_sync_status = 'MONITORING'
                    }
                }

                if (Object.keys(updates).length > 0) {
                    await ctx.updateOrderV2(order.id, updates)
                }
            }

            if (info !== null) {
                ctx.logger.info(
                    {
                        event: 'cron:orders_v2_synced',
                        broker: order.broker,
                        orderId: order.id,
                        price: info.price,
                        size: info.size,
                    },
                    info.size >= order.requested_size - EPSILON
                        ? 'orders_v2 status updated to EXECUTED'
                        : 'orders_v2 partial execution progress synchronized',
                )
            } else {
                ctx.logger.info(
                    {
                        event: 'cron:orders_v2_execution_not_found',
                        broker: order.broker, orderId: order.id,
                        provider_order_id: providerOrderId,
                    },
                    'orders_v2 execution not yet confirmed',
                )
            }
        } catch (error) {
            ctx.logger.info(
                { event: 'cron:orders_v2_sync_failed', broker: order.broker, orderId: order.id, error },
                'failed to sync orders_v2',
            )
        }
    }
}

/** IFD/IFDOCO の子注文（決済）を同期して新しい orders_v2 レコードを作る */

const syncExecutionsForExecutedIfdOrders = async (ctx: {
    logger: Logger
    getActiveIfdOrdersV2: GetActiveIfdOrdersV2Fn
    addOrderV2: AddOrderV2Fn
    updateOrderV2: UpdateOrderV2Fn
    getOrderV2: GetOrderV2Fn
    closingExecutionFetchers: Partial<Record<string, ClosingExecutionFetcherLike>>
}): Promise<void> => {
    const activeIfdos = await ctx.getActiveIfdOrdersV2()
    ctx.logger.info({
        event: 'cron:ifd_exit_sync_start',
        ids: activeIfdos.map((o) => o.id),
    }, 'syncing exits for executed IFD/IFDOCO orders, count: ' + activeIfdos.length)

    for (const order of activeIfdos) {
        const exitId = `${order.id}-exit`

        // 既存の exit レコードを取得
        const existingExit = await ctx.getOrderV2(exitId)

        const fetcher = ctx.closingExecutionFetchers[order.broker]
        if (!fetcher) continue

        try {
            const providerOrderId = order.provider_order_ids[0]
            if (!providerOrderId) continue

            const syncResult = await fetcher.getClosingExecutionForOrderV2(order)

            const closing = syncResult.execution

            if (closing && closing.size > order.requested_size + EPSILON) {
                ctx.logger.warn(
                    {
                        event: 'cron:orders_v2_exit_sync_invalid_size',
                        orderId: order.id,
                        requestedSize: order.requested_size,
                        closingSize: closing.size,
                    },
                    'closing execution size exceeded requested_size; skipping exit sync update',
                )
                continue
            }

            if (
                syncResult.brokerOrderMetadata !== undefined &&
                !areSameBrokerOrderMetadata(order.broker_order_metadata, syncResult.brokerOrderMetadata)
            ) {
                await ctx.updateOrderV2(order.id, {
                    broker_order_metadata: syncResult.brokerOrderMetadata,
                })
            }

            if (!closing) continue

            const isExitCompleted = closing.size >= order.requested_size - EPSILON
            const executedAt = resolveExecutedAt(order, closing)

            const isSameSnapshot = existingExit !== null &&
                areSameNumber(existingExit.executed_size, closing.size) &&
                areSameNumber(existingExit.executed_price, closing.price) &&
                areSameDate(existingExit.executed_at, executedAt) &&
                hasSameCommission(existingExit, closing.commission)

            if (isSameSnapshot) {
                if (isExitCompleted && order.exit_sync_status !== 'COMPLETED') {
                    await ctx.updateOrderV2(order.id, { exit_sync_status: 'COMPLETED' })
                }
                continue
            }

            if (!existingExit) {
                // 新規作成
                await ctx.addOrderV2({
                    id: exitId,
                    strategy: order.strategy,
                    broker: order.broker,
                    ticker: order.ticker,
                    side: order.side === 'BUY' ? 'SELL' : 'BUY',
                    order_type: 'MARKET',
                    requested_size: order.requested_size,
                    executed_size: closing.size,
                    executed_price: closing.price,
                    executed_at: executedAt,
                    status: 'EXECUTED',
                    provider_order_ids: [providerOrderId + ':closing'],
                    created_at: new Date(),
                    updated_at: new Date(),
                    ...(closing.commission !== undefined
                        ? { execution_costs: { commission: closing.commission } }
                        : {}),
                })
                if (isExitCompleted) {
                    await ctx.updateOrderV2(order.id, { exit_sync_status: 'COMPLETED' })
                }
                ctx.logger.info(
                    { event: 'cron:orders_v2_exit_recorded', originalId: order.id, price: closing.price, size: closing.size },
                    'orders_v2 exit recorded (initial)',
                )
            } else {
                // 更新（部分約定の進展）
                const updates: Partial<OrderV2> = {
                    executed_size: closing.size,
                    executed_price: closing.price,
                    executed_at: executedAt,
                }
                if (!hasSameCommission(existingExit, closing.commission)) {
                    updates.execution_costs = closing.commission === undefined
                        ? {}
                        : { commission: closing.commission }
                }
                if (Object.keys(updates).length > 0) {
                    await ctx.updateOrderV2(exitId, updates)
                }
                if (isExitCompleted) {
                    await ctx.updateOrderV2(order.id, { exit_sync_status: 'COMPLETED' })
                }
                ctx.logger.info(
                    { event: 'cron:orders_v2_exit_updated', originalId: order.id, price: closing.price, size: closing.size },
                    'orders_v2 exit updated (partial fill progress)',
                )
            }
        } catch (error) {
            ctx.logger.warn({ event: 'cron:orders_v2_exit_sync_failed', orderId: order.id, error }, 'failed to sync exit execution')
        }
    }
}
