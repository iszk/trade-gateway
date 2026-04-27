import type { GetPendingExecutionLogsFn, UpdateExecutionPriceFn, GetConfirmedUnpromotedLogsFn, MarkOpenTradesWrittenFn } from './order-dispatch-logs.js'
import type { CreateTradeRecordFn, AddOpenTradeFn, GetOpenTradesFn, DeleteOpenTradeFn } from './trade-records.js'
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
    getPendingExecutionLogs?: GetPendingExecutionLogsFn
    updateExecutionPrice?: UpdateExecutionPriceFn
    getConfirmedUnpromotedLogs?: GetConfirmedUnpromotedLogsFn
    markOpenTradesWritten?: MarkOpenTradesWrittenFn
    getOpenTrades?: GetOpenTradesFn
    addOpenTrade?: AddOpenTradeFn
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

    // 約定価格の照会・更新（open_trades フローより先に実行し、migration 時に price 確定済みの状態を保証する）
    if (ctx.getPendingExecutionLogs && ctx.updateExecutionPrice && ctx.executionPriceFetchers) {
        await fetchAndUpdateExecutionPrices({
            logger: ctx.logger,
            executionPriceFetchers: ctx.executionPriceFetchers,
            getPendingExecutionLogs: ctx.getPendingExecutionLogs,
            updateExecutionPrice: ctx.updateExecutionPrice,
        })
    }

    // open_trades フロー（execution_price 確定後に実行）
    if (
        ctx.getConfirmedUnpromotedLogs &&
        ctx.markOpenTradesWritten &&
        ctx.getOpenTrades &&
        ctx.addOpenTrade &&
        ctx.deleteOpenTrade &&
        ctx.createTradeRecord
    ) {
        await promoteConfirmedLogsToOpenTrades({
            logger: ctx.logger,
            getConfirmedUnpromotedLogs: ctx.getConfirmedUnpromotedLogs,
            markOpenTradesWritten: ctx.markOpenTradesWritten,
            addOpenTrade: ctx.addOpenTrade,
        })
        await matchAndRecordOpenTrades({
            logger: ctx.logger,
            getOpenTrades: ctx.getOpenTrades,
            deleteOpenTrade: ctx.deleteOpenTrade,
            createTradeRecord: ctx.createTradeRecord,
            timeoutMs: PAIRING_TIMEOUT_MS,
        })
    }
}

const fetchAndUpdateExecutionPrices = async (ctx: {
    logger: Logger
    executionPriceFetchers: Partial<Record<string, ExecutionPriceFetcherLike>>
    getPendingExecutionLogs: GetPendingExecutionLogsFn
    updateExecutionPrice: UpdateExecutionPriceFn
}): Promise<void> => {
    const pendingLogs = await ctx.getPendingExecutionLogs()
    ctx.logger.info(
        { event: 'cron:execution_price_fetch_start', count: pendingLogs.length },
        'fetching execution prices',
    )

    for (const log of pendingLogs) {
        const fetcher = ctx.executionPriceFetchers[log.broker]
        if (!fetcher) {
            ctx.logger.info(
                { event: 'cron:execution_price_fetcher_missing', broker: log.broker },
                'no execution price fetcher for broker',
            )
            continue
        }

        try {
            const price = await fetcher.getExecutionPrice(log.provider_order_id, log.ticker)
            if (price !== null) {
                await ctx.updateExecutionPrice(log.docId, price)
                ctx.logger.info(
                    { event: 'cron:execution_price_updated', broker: log.broker, docId: log.docId, eventId: log.event_id, price },
                    'execution price updated',
                )
            } else {
                ctx.logger.info(
                    { event: 'cron:execution_price_not_found', broker: log.broker, docId: log.docId, eventId: log.event_id },
                    'execution price not found',
                )
            }
        } catch (error) {
            ctx.logger.info(
                { event: 'cron:execution_price_fetch_failed', broker: log.broker, docId: log.docId, eventId: log.event_id, error },
                'failed to fetch execution price',
            )
        }
    }
}

export const executeHourlyTask = async (ctx: CronContext): Promise<void> => {
    ctx.logger.info({ event: 'cron:hourly_task' }, 'hourly task executed')
}

const promoteConfirmedLogsToOpenTrades = async (ctx: {
    logger: Logger
    getConfirmedUnpromotedLogs: GetConfirmedUnpromotedLogsFn
    markOpenTradesWritten: MarkOpenTradesWrittenFn
    addOpenTrade: AddOpenTradeFn
}): Promise<void> => {
    const logs = await ctx.getConfirmedUnpromotedLogs()
    if (logs.length === 0) return

    ctx.logger.info({ event: 'cron:open_trades_promote_start', count: logs.length }, 'promoting logs to open_trades')

    for (const log of logs) {
        await ctx.addOpenTrade({
            event_id: log.event_id,
            broker: log.broker,
            ticker: log.ticker,
            side: log.side,
            size: log.size,
            strategy: log.strategy,
            interval: log.interval,
            execution_price: log.execution_price,
            created_at: log.created_at,
            order_dispatch_log_id: log.docId,
        })
        await ctx.markOpenTradesWritten(log.docId)
    }

    ctx.logger.info({ event: 'cron:open_trades_promote_done', count: logs.length }, 'promotion complete')
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
