import type { CreateTradeRecordFn, GetOpenTradesFn, DeleteOpenTradeFn, GetPendingExecutionOpenTradesFn, UpdateOpenTradeExecutionPriceFn, GetConfirmedIfdOpenTradesFn, ConfirmedIfdOpenTrade } from './trade-records.js'
import { pairLogs } from './trade-records.js'

import type { GetPendingOrdersV2Fn, UpdateOrderV2Fn } from './orders-v2.js'

type Logger = {
    info(obj: Record<string, unknown>, msg?: string): void
    warn(obj: Record<string, unknown>, msg?: string): void
}

type PositionFetcherLike = {
    fetchAllPositions(broker?: string): Promise<unknown[]>
}

export type ExecutionPriceFetcherLike = {
    getExecutionPrice(providerOrderId: string, ticker: string): Promise<number | null>
}

export type ClosingExecutionFetcherLike = {
    getClosingExecution(parentOrderId: string, ticker: string): Promise<{ price: number } | null>
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
            const price = await fetcher.getExecutionPrice(trade.provider_order_id, trade.ticker)
            if (price !== null) {
                await ctx.updateOpenTradeExecutionPrice(trade.event_id, price)
                ctx.logger.info(
                    { event: 'cron:open_trades_execution_price_updated', broker: trade.broker, eventId: trade.event_id, price },
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
            // NOTE: IFD-OCO などの親注文（1つ目）のステータスだけとりあえず見る簡易実装
            const providerOrderId = order.provider_order_ids[0]
            if (!providerOrderId) continue

            const price = await fetcher.getExecutionPrice(providerOrderId, order.ticker)
            if (price !== null) {
                // 約定確認完了 -> EXECUTED へ
                await ctx.updateOrderV2(order.id, {
                    status: 'EXECUTED',
                    executed_price: price,
                    executed_size: order.requested_size, // 簡易的に全量約定とみなす
                })
                ctx.logger.info(
                    { event: 'cron:orders_v2_synced', broker: order.broker, orderId: order.id, price },
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
