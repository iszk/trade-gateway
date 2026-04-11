type Logger = {
    info(obj: Record<string, unknown>, msg?: string): void
}

type PositionFetcherLike = {
    fetchAllPositions(broker?: string): Promise<unknown[]>
}

export type CronContext = {
    logger: Logger
    positionFetcher: PositionFetcherLike
}

export const executeTenMinutelyTask = async (ctx: CronContext): Promise<void> => {
    ctx.logger.info({ event: 'cron:ten_minutely_task' }, '10-minute task executed')

    // saxo の oauth token リフレッシュ用
    const broker = 'saxo'
    const positions = await ctx.positionFetcher.fetchAllPositions(broker)
    ctx.logger.info({ event: 'cron:positions_fetched', broker, count: positions.length }, 'cron fetched positions')
}

export const executeHourlyTask = async (ctx: CronContext): Promise<void> => {
    ctx.logger.info({ event: 'cron:hourly_task' }, 'hourly task executed')
}
