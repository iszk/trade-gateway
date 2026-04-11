type Logger = {
    info(obj: Record<string, unknown>, msg?: string): void
}

export const executeTenMinutelyTask = async (logger: Logger): Promise<void> => {
    logger.info({ event: 'cron:ten_minutely_task' }, '10-minute task executed')
}

export const executeHourlyTask = async (logger: Logger): Promise<void> => {
    logger.info({ event: 'cron:hourly_task' }, 'hourly task executed')
}
