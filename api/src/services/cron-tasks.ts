import type { GetPendingExecutionLogsFn, UpdateExecutionPriceFn } from './order-dispatch-logs.js'

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
}

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
                    { event: 'cron:execution_price_updated', docId: log.docId, price },
                    'execution price updated',
                )
            }
        } catch (error) {
            ctx.logger.info(
                { event: 'cron:execution_price_fetch_failed', docId: log.docId, error },
                'failed to fetch execution price',
            )
        }
    }
}

export const executeHourlyTask = async (ctx: CronContext): Promise<void> => {
    ctx.logger.info({ event: 'cron:hourly_task' }, 'hourly task executed')
}
