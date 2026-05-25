import type { CreateTradeRecordFn, GetOpenTradesFn, DeleteOpenTradeFn, GetPendingExecutionOpenTradesFn, UpdateOpenTradeExecutionPriceFn, GetConfirmedIfdOpenTradesFn, ConfirmedIfdOpenTrade } from './trade-records.js'
import { pairLogs } from './trade-records.js'

import type { GetPendingOrdersV2Fn, UpdateOrderV2Fn, AddOrderV2Fn, GetOrderV2Fn, ListOrdersV2ByStrategyFn } from './orders-v2.js'

type Logger = {
    info(obj: Record<string, unknown>, msg?: string): void
    warn(obj: Record<string, unknown>, msg?: string): void
}

type PositionFetcherLike = {
    fetchAllPositions(broker?: string): Promise<unknown[]>
}

export type ExecutionInfo = {
    price: number
    size: number
}

export type ExecutionPriceFetcherLike = {
    getExecutionPrice(providerOrderId: string, ticker: string): Promise<ExecutionInfo | null>
}

export type ClosingExecutionFetcherLike = {
    getClosingExecution(parentOrderId: string, ticker: string): Promise<ExecutionInfo | null>
}

export type CronContext = {
    logger: Logger
    positionFetcher: PositionFetcherLike
    executionPriceFetchers?: Partial<Record<string, ExecutionPriceFetcherLike>>
    getPendingExecutionOpenTrades?: GetPendingExecutionOpenTradesFn
    updateOpenTradeExecutionPrice?: UpdateOpenTradeExecutionPriceFn
    getOpenTrades?: GetOpenTradesFn
    deleteOpenTrade?: DeleteOpenTradeFn
    createTradeRecord?: CreateTradeRecordFn
    /** IFD/IFDOCO フロー用 */
    getConfirmedIfdOpenTrades?: GetConfirmedIfdOpenTradesFn
    closingExecutionFetchers?: Partial<Record<string, ClosingExecutionFetcherLike>>
    /** Phase 3: orders_v2 のステータス同期用 */
    getPendingOrdersV2?: GetPendingOrdersV2Fn
    updateOrderV2?: UpdateOrderV2Fn
    addOrderV2?: AddOrderV2Fn
    getOrderV2?: GetOrderV2Fn
    listOrdersV2ByStrategy?: ListOrdersV2ByStrategyFn
}

const PAIRING_TIMEOUT_MS = 30_000

export const executeTenMinutelyTask = async (ctx: CronContext): Promise<void> => {
    ctx.logger.info({ event: 'cron:ten_minutely_task' }, '10-minute task executed')

    // saxo の oauth token リフレッシュ用
    const broker = 'saxo'
    const positions = await ctx.positionFetcher.fetchAllPositions(broker)
    ctx.logger.info({ event: 'cron:positions_fetched', broker, count: positions.length }, 'cron fetched positions')

    // open_trades の execution_price 照会・更新
    if (ctx.getPendingExecutionOpenTrades && ctx.updateOpenTradeExecutionPrice && ctx.executionPriceFetchers) {
        await fetchAndUpdateExecutionPricesFromOpenTrades({
            logger: ctx.logger,
            executionPriceFetchers: ctx.executionPriceFetchers,
            getPendingExecutionOpenTrades: ctx.getPendingExecutionOpenTrades,
            updateOpenTradeExecutionPrice: ctx.updateOpenTradeExecutionPrice,
        })
    }

    if (ctx.getOpenTrades && ctx.deleteOpenTrade && ctx.createTradeRecord) {
        await matchAndRecordOpenTrades({
            logger: ctx.logger,
            getOpenTrades: ctx.getOpenTrades,
            deleteOpenTrade: ctx.deleteOpenTrade,
            createTradeRecord: ctx.createTradeRecord,
            timeoutMs: PAIRING_TIMEOUT_MS,
        })
    }

    // IFD/IFDOCO フロー: 決済子注文の約定を確認して trade_record を直接生成
    if (ctx.getConfirmedIfdOpenTrades && ctx.closingExecutionFetchers && ctx.deleteOpenTrade && ctx.createTradeRecord) {
        await resolveIfdLikeTrades({
            logger: ctx.logger,
            getConfirmedIfdOpenTrades: ctx.getConfirmedIfdOpenTrades,
            closingExecutionFetchers: ctx.closingExecutionFetchers,
            deleteOpenTrade: ctx.deleteOpenTrade,
            createTradeRecord: ctx.createTradeRecord,
        })
    }

    // Phase 3: orders_v2 のステータス同期
    if (ctx.getPendingOrdersV2 && ctx.updateOrderV2 && ctx.executionPriceFetchers) {
        await fetchAndUpdatePendingOrdersV2({
            logger: ctx.logger,
            executionPriceFetchers: ctx.executionPriceFetchers,
            getPendingOrdersV2: ctx.getPendingOrdersV2,
            updateOrderV2: ctx.updateOrderV2,
        })
    }

    // IFD/IFDOCO 子注文の同期 (V2)
    if (ctx.listOrdersV2ByStrategy && ctx.addOrderV2 && ctx.getOrderV2 && ctx.closingExecutionFetchers) {
        await syncExecutionsForExecutedIfdOrders({
            logger: ctx.logger,
            listOrdersV2ByStrategy: ctx.listOrdersV2ByStrategy,
            addOrderV2: ctx.addOrderV2,
            getOrderV2: ctx.getOrderV2,
            closingExecutionFetchers: ctx.closingExecutionFetchers,
        })
    }
}

export const executeHourlyTask = async (ctx: CronContext): Promise<void> => {
    ctx.logger.info({ event: 'cron:hourly_task' }, 'hourly task executed')
}

/** 新フロー: open_trades から execution_price 未確定のものを取得し broker API で更新する */
const fetchAndUpdateExecutionPricesFromOpenTrades = async (ctx: {
    logger: Logger
    executionPriceFetchers: Partial<Record<string, ExecutionPriceFetcherLike>>
    getPendingExecutionOpenTrades: GetPendingExecutionOpenTradesFn
    updateOpenTradeExecutionPrice: UpdateOpenTradeExecutionPriceFn
}): Promise<void> => {
    const pendingTrades = await ctx.getPendingExecutionOpenTrades()
    ctx.logger.info(
        { event: 'cron:open_trades_execution_price_fetch_start', count: pendingTrades.length },
        'fetching execution prices from open_trades',
    )

    for (const trade of pendingTrades) {
        const fetcher = ctx.executionPriceFetchers[trade.broker]
        if (!fetcher) {
            ctx.logger.info(
                { event: 'cron:execution_price_fetcher_missing', broker: trade.broker },
                'no execution price fetcher for broker',
            )
            continue
        }

        try {
            const info = await fetcher.getExecutionPrice(trade.provider_order_id, trade.ticker)
            if (info !== null) {
                await ctx.updateOpenTradeExecutionPrice(trade.event_id, info.price)
                ctx.logger.info(
                    { event: 'cron:open_trades_execution_price_updated', broker: trade.broker, eventId: trade.event_id, price: info.price },
                    'open_trades execution price updated',
                )
            } else {
                ctx.logger.info(
                    {
                        event: 'cron:open_trades_execution_price_not_found',
                        broker: trade.broker, eventId: trade.event_id,
                        provider_order_id: trade.provider_order_id,
                        ticker: trade.ticker,
                    },
                    'open_trades execution price not found',
                )
            }
        } catch (error) {
            ctx.logger.info(
                { event: 'cron:open_trades_execution_price_fetch_failed', broker: trade.broker, eventId: trade.event_id, error },
                'failed to fetch execution price for open_trade',
            )
        }
    }
}

const matchAndRecordOpenTrades = async (ctx: {
    logger: Logger
    getOpenTrades: GetOpenTradesFn
    deleteOpenTrade: DeleteOpenTradeFn
    createTradeRecord: CreateTradeRecordFn
    timeoutMs: number
}): Promise<void> => {
    const deadline = Date.now() + ctx.timeoutMs

    const openTrades = await ctx.getOpenTrades()
    const paired = pairLogs(openTrades)

    ctx.logger.info(
        { event: 'cron:trade_matching_start', openCount: openTrades.length, pairedCount: paired.length },
        'trade matching started',
    )

    for (const { record, entryEventId, exitEventId } of paired) {
        if (Date.now() >= deadline) {
            ctx.logger.info(
                { event: 'cron:trade_matching_timeout' },
                'trade matching timed out, will resume next cron',
            )
            break
        }

        try {
            await ctx.createTradeRecord(record)
            await ctx.deleteOpenTrade(entryEventId)
            await ctx.deleteOpenTrade(exitEventId)

            ctx.logger.info(
                {
                    event: 'cron:trade_record_created',
                    strategy: record.strategy,
                    interval: record.interval,
                    ticker: record.ticker,
                    pnl: record.pnl,
                },
                'trade record created',
            )
        } catch (error) {
            ctx.logger.info(
                { event: 'cron:trade_record_create_failed', error },
                'failed to create trade record',
            )
        }
    }
}

/** IFD/IFDOCO フロー: 決済子注文の約定を確認し、約定済みなら trade_record を直接生成する */
const resolveIfdLikeTrades = async (ctx: {
    logger: Logger
    getConfirmedIfdOpenTrades: GetConfirmedIfdOpenTradesFn
    closingExecutionFetchers: Partial<Record<string, ClosingExecutionFetcherLike>>
    deleteOpenTrade: DeleteOpenTradeFn
    createTradeRecord: CreateTradeRecordFn
}): Promise<void> => {
    const trades = await ctx.getConfirmedIfdOpenTrades()
    ctx.logger.info(
        { event: 'cron:ifd_resolve_start', count: trades.length },
        'resolving IFD/IFDOCO trades',
    )

    for (const trade of trades) {
        const fetcher = ctx.closingExecutionFetchers[trade.broker]
        if (!fetcher) {
            ctx.logger.info(
                { event: 'cron:ifd_closing_fetcher_missing', broker: trade.broker },
                'no closing execution fetcher for broker',
            )
            continue
        }

        try {
            const closing = await fetcher.getClosingExecution(trade.provider_order_id, trade.ticker)
            if (closing === null) {
                ctx.logger.info(
                    { event: 'cron:ifd_closing_not_yet', broker: trade.broker, eventId: trade.event_id },
                    'closing order not yet executed, will retry next cron',
                )
                continue
            }

            const isLong = trade.side === 'BUY'
            const pnl = isLong
                ? (closing.price - trade.execution_price) * trade.size
                : (trade.execution_price - closing.price) * trade.size

            const now = new Date()
            await ctx.createTradeRecord({
                strategy: trade.strategy,
                interval: trade.interval,
                ticker: trade.ticker,
                broker: trade.broker,
                entry_side: trade.side,
                entry_price: trade.execution_price,
                exit_price: closing.price,
                size: trade.size,
                pnl,
                entry_event_id: trade.event_id,
                exit_event_id: trade.event_id + ':closing',
                opened_at: trade.created_at,
                closed_at: now,
            })
            await ctx.deleteOpenTrade(trade.event_id)

            ctx.logger.info(
                {
                    event: 'cron:ifd_trade_record_created',
                    strategy: trade.strategy,
                    interval: trade.interval,
                    ticker: trade.ticker,
                    order_method: trade.order_method,
                    pnl,
                },
                'IFD/IFDOCO trade record created',
            )
        } catch (error) {
            ctx.logger.warn(
                { event: 'cron:ifd_resolve_failed', broker: trade.broker, eventId: trade.event_id, error },
                'failed to resolve IFD/IFDOCO trade',
            )
        }
    }
}

/** Phase 3: orders_v2 の PENDING を確定させる */
const fetchAndUpdatePendingOrdersV2 = async (ctx: {
    logger: Logger
    executionPriceFetchers: Partial<Record<string, ExecutionPriceFetcherLike>>
    getPendingOrdersV2: GetPendingOrdersV2Fn
    updateOrderV2: UpdateOrderV2Fn
}): Promise<void> => {
    const pendingOrders = await ctx.getPendingOrdersV2()
    ctx.logger.info(
        { event: 'cron:orders_v2_sync_start', count: pendingOrders.length },
        'syncing pending orders_v2',
    )

    for (const order of pendingOrders) {
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

            const info = await fetcher.getExecutionPrice(providerOrderId, order.ticker)
            if (info !== null) {
                // 約定確認完了 -> EXECUTED へ
                await ctx.updateOrderV2(order.id, {
                    status: 'EXECUTED',
                    executed_price: info.price,
                    executed_size: info.size || order.requested_size, // broker から size が取れればそれを使う
                })
                ctx.logger.info(
                    { event: 'cron:orders_v2_synced', broker: order.broker, orderId: order.id, price: info.price, size: info.size },
                    'orders_v2 status updated to EXECUTED',
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
    listOrdersV2ByStrategy: ListOrdersV2ByStrategyFn
    addOrderV2: AddOrderV2Fn
    getOrderV2: GetOrderV2Fn
    closingExecutionFetchers: Partial<Record<string, ClosingExecutionFetcherLike>>
}): Promise<void> => {
    // ひとまず、既知の戦略について回す（汎用化が必要）
    // 本来は Firestore で status: 'EXECUTED' AND order_type: 'IFDOCO' なものを引くインデックスを貼るべき
    const strategies = ['FX_BTC_JPY', 'NAS100', 'US30']

    for (const strategy of strategies) {
        const orders = await ctx.listOrdersV2ByStrategy(strategy)
        const activeIfdos = orders.filter(o => o.order_type === 'IFDOCO' && o.status === 'EXECUTED')

        for (const order of activeIfdos) {
            const exitId = `${order.id}-exit`
            
            // 既に exit レコードがあるかチェック
            const existingExit = await ctx.getOrderV2(exitId)
            if (existingExit) continue

            const fetcher = ctx.closingExecutionFetchers[order.broker]
            if (!fetcher) continue

            try {
                const providerOrderId = order.provider_order_ids[0]
                if (!providerOrderId) continue

                const closing = await fetcher.getClosingExecution(providerOrderId, order.ticker)
                if (closing) {
                    // 決済約定発見！ 新しい EXECUTED レコードを作成
                    await ctx.addOrderV2({
                        id: exitId,
                        strategy: order.strategy,
                        broker: order.broker,
                        ticker: order.ticker,
                        side: order.side === 'BUY' ? 'SELL' : 'BUY',
                        order_type: 'MARKET',
                        requested_size: order.requested_size,
                        executed_size: closing.size || order.executed_size,
                        executed_price: closing.price,
                        status: 'EXECUTED',
                        provider_order_ids: [providerOrderId + ':closing'],
                        created_at: new Date(),
                        updated_at: new Date(),
                    })
                    ctx.logger.info(
                        { event: 'cron:orders_v2_exit_recorded', originalId: order.id, price: closing.price },
                        'orders_v2 exit recorded for IFDOCO',
                    )
                }
            } catch (error) {
                ctx.logger.warn({ event: 'cron:orders_v2_exit_sync_failed', orderId: order.id, error }, 'failed to sync exit for IFDOCO')
            }
        }
    }
}
