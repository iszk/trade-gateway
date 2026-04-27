import type { CreateTradeRecordFn, GetOpenTradesFn, DeleteOpenTradeFn, GetPendingExecutionOpenTradesFn, UpdateOpenTradeExecutionPriceFn } from './trade-records.js'
import { pairLogs } from './trade-records.js'

type Logger = {
    info(obj: Record<string, unknown>, msg?: string): void
}

type PositionFetcherLike = {
    fetchAllPositions(broker?: string): Promise<unknown[]>
}

export type ExecutionPriceFetcherLike = {
    getExecutionPrice(providerOrderId: string, ticker: string): Promise<number | null>
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
                    { event: 'cron:open_trades_execution_price_not_found', broker: trade.broker, eventId: trade.event_id },
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
