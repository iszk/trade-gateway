import type { GetPendingExecutionLogsFn, UpdateExecutionPriceFn } from './order-dispatch-logs.js'
import type { GetUnpairedLogsFn, CreateTradeRecordFn, MarkLogPairedFn } from './trade-records.js'
import { pairLogs } from './trade-records.js'

type Logger = {
    info(obj: Record<string, unknown>, msg?: string): void
}

type PositionFetcherLike = {
    fetchAllPositions(broker?: string): Promise<unknown[]>
}

export type ExecutionPriceFetcherLike = {
    getExecutionPrice(providerOrderId: string): Promise<number | null>
}

export type CronContext = {
    logger: Logger
    positionFetcher: PositionFetcherLike
    executionPriceFetchers?: Partial<Record<string, ExecutionPriceFetcherLike>>
    getPendingExecutionLogs?: GetPendingExecutionLogsFn
    updateExecutionPrice?: UpdateExecutionPriceFn
    getUnpairedLogs?: GetUnpairedLogsFn
    createTradeRecord?: CreateTradeRecordFn
    markLogPaired?: MarkLogPairedFn
}

const PAIRING_TIMEOUT_MS = 30_000

export const executeTenMinutelyTask = async (ctx: CronContext): Promise<void> => {
    ctx.logger.info({ event: 'cron:ten_minutely_task' }, '10-minute task executed')

    // saxo の oauth token リフレッシュ用
    const broker = 'saxo'
    const positions = await ctx.positionFetcher.fetchAllPositions(broker)
    ctx.logger.info({ event: 'cron:positions_fetched', broker, count: positions.length }, 'cron fetched positions')

    // 約定価格の照会・更新
    if (ctx.getPendingExecutionLogs && ctx.updateExecutionPrice && ctx.executionPriceFetchers) {
        await fetchAndUpdateExecutionPrices({
            logger: ctx.logger,
            executionPriceFetchers: ctx.executionPriceFetchers,
            getPendingExecutionLogs: ctx.getPendingExecutionLogs,
            updateExecutionPrice: ctx.updateExecutionPrice,
        })
    }

    // 取引ペアリング
    if (ctx.getUnpairedLogs && ctx.createTradeRecord && ctx.markLogPaired) {
        await pairAndRecordTrades({
            logger: ctx.logger,
            getUnpairedLogs: ctx.getUnpairedLogs,
            createTradeRecord: ctx.createTradeRecord,
            markLogPaired: ctx.markLogPaired,
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
            const price = await fetcher.getExecutionPrice(log.provider_order_id)
            if (price !== null) {
                await ctx.updateExecutionPrice(log.docId, price)
                ctx.logger.info(
                    { event: 'cron:execution_price_updated', broker: log.broker, docId: log.docId, eventId: log.event_id, price },
                    'execution price updated',
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

const pairAndRecordTrades = async (ctx: {
    logger: Logger
    getUnpairedLogs: GetUnpairedLogsFn
    createTradeRecord: CreateTradeRecordFn
    markLogPaired: MarkLogPairedFn
    timeoutMs: number
}): Promise<void> => {
    const deadline = Date.now() + ctx.timeoutMs

    const unpairedLogs = await ctx.getUnpairedLogs()
    const paired = pairLogs(unpairedLogs)

    ctx.logger.info(
        { event: 'cron:trade_pairing_start', unpairedCount: unpairedLogs.length, pairedCount: paired.length },
        'trade pairing started',
    )

    for (const { record, entryDocId, exitDocId } of paired) {
        if (Date.now() >= deadline) {
            ctx.logger.info(
                { event: 'cron:trade_pairing_timeout' },
                'trade pairing timed out, will resume next cron',
            )
            break
        }

        try {
            await ctx.createTradeRecord(record)
            await ctx.markLogPaired(entryDocId)
            await ctx.markLogPaired(exitDocId)

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
