import { randomUUID } from 'node:crypto'
import type { GetPendingDispatchLogsFn, ConfirmDispatchLogFn } from './order-dispatch-logs.js'
import type { AddOrderExecutionFn, GetMarketOrderExecutionsFn, GetIfdocoEntriesFn, GetIfdocoExitsFn, DeleteOrderExecutionFn } from '../types/execution.js'
import type { AddTradeFn } from '../types/trade.js'
import { matchMarketExecutions, matchIfdocoExecutions, buildTrade } from './trade-matcher.js'

type Logger = {
    info(obj: Record<string, unknown>, msg?: string): void
    warn(obj: Record<string, unknown>, msg?: string): void
}

type PositionFetcherLike = {
    fetchAllPositions(broker?: string): Promise<unknown[]>
}

export type ExecutionPriceFetcherLike = {
    getExecutionPrice(providerOrderId: string, ticker: string): Promise<{ price: number; executed_at: Date } | null>
}

export type ClosingExecutionFetcherLike = {
    getClosingExecution(parentOrderId: string, ticker: string): Promise<{ price: number; executed_at: Date } | null>
}

export type CronContext = {
    logger: Logger
    positionFetcher: PositionFetcherLike
    /** Step 1: dispatch_logs[pending] → broker 約定確認 → order_executions 作成 */
    getPendingDispatchLogs?: GetPendingDispatchLogsFn
    confirmDispatchLog?: ConfirmDispatchLogFn
    addOrderExecution?: AddOrderExecutionFn
    executionPriceFetchers?: Partial<Record<string, ExecutionPriceFetcherLike>>
    /** Step 2: IFDOCO エントリー → 決済子注文の約定確認 → order_executions に exit を追加 */
    getIfdocoEntries?: GetIfdocoEntriesFn
    closingExecutionFetchers?: Partial<Record<string, ClosingExecutionFetcherLike>>
    /** Step 3: order_executions → マッチング → trades 作成 */
    getMarketOrderExecutions?: GetMarketOrderExecutionsFn
    getIfdocoExits?: GetIfdocoExitsFn
    deleteOrderExecution?: DeleteOrderExecutionFn
    addTrade?: AddTradeFn
}

export const executeTenMinutelyTask = async (ctx: CronContext): Promise<void> => {
    ctx.logger.info({ event: 'cron:ten_minutely_task' }, '10-minute task executed')

    // Saxo の oauth token リフレッシュ用
    const positions = await ctx.positionFetcher.fetchAllPositions('saxo')
    ctx.logger.info({ event: 'cron:positions_fetched', broker: 'saxo', count: positions.length }, 'cron fetched positions')

    // Step 1: pending dispatch_logs → broker 約定確認 → order_executions 作成
    if (ctx.getPendingDispatchLogs && ctx.confirmDispatchLog && ctx.addOrderExecution && ctx.executionPriceFetchers) {
        await confirmPendingExecutions({
            logger: ctx.logger,
            getPendingDispatchLogs: ctx.getPendingDispatchLogs,
            confirmDispatchLog: ctx.confirmDispatchLog,
            addOrderExecution: ctx.addOrderExecution,
            executionPriceFetchers: ctx.executionPriceFetchers,
        })
    }

    // Step 2: IFDOCO エントリー → 決済子注文の約定確認 → order_executions に exit 追加
    if (ctx.getIfdocoEntries && ctx.addOrderExecution && ctx.closingExecutionFetchers) {
        await confirmIfdocoExits({
            logger: ctx.logger,
            getIfdocoEntries: ctx.getIfdocoEntries,
            addOrderExecution: ctx.addOrderExecution,
            closingExecutionFetchers: ctx.closingExecutionFetchers,
        })
    }

    // Step 3: order_executions → マッチング → trades 作成・約定削除
    if (ctx.getMarketOrderExecutions && ctx.getIfdocoEntries && ctx.getIfdocoExits && ctx.deleteOrderExecution && ctx.addTrade) {
        await matchAndSaveTrades({
            logger: ctx.logger,
            getMarketOrderExecutions: ctx.getMarketOrderExecutions,
            getIfdocoEntries: ctx.getIfdocoEntries,
            getIfdocoExits: ctx.getIfdocoExits,
            deleteOrderExecution: ctx.deleteOrderExecution,
            addTrade: ctx.addTrade,
        })
    }
}

export const executeHourlyTask = async (ctx: CronContext): Promise<void> => {
    ctx.logger.info({ event: 'cron:hourly_task' }, 'hourly task executed')
}

// ─────────────── Step 1: pending dispatch_logs の約定確認 ───────────────

const confirmPendingExecutions = async (ctx: {
    logger: Logger
    getPendingDispatchLogs: GetPendingDispatchLogsFn
    confirmDispatchLog: ConfirmDispatchLogFn
    addOrderExecution: AddOrderExecutionFn
    executionPriceFetchers: Partial<Record<string, ExecutionPriceFetcherLike>>
}): Promise<void> => {
    const pending = await ctx.getPendingDispatchLogs()
    ctx.logger.info(
        { event: 'cron:confirm_pending_start', count: pending.length },
        'confirming pending executions',
    )

    for (const log of pending) {
        const fetcher = ctx.executionPriceFetchers[log.broker]
        if (!fetcher) {
            ctx.logger.warn(
                { event: 'cron:execution_price_fetcher_missing', broker: log.broker },
                'no execution price fetcher for broker',
            )
            continue
        }

        try {
            const result = await fetcher.getExecutionPrice(log.provider_order_id, log.ticker)
            if (result === null) {
                ctx.logger.info(
                    { event: 'cron:execution_price_not_found', broker: log.broker, event_id: log.event_id },
                    'execution price not yet available',
                )
                continue
            }

            await ctx.addOrderExecution({
                id: log.event_id,
                strategy: log.strategy,
                symbol: log.ticker,
                interval: log.interval,
                broker: log.broker as Parameters<typeof ctx.addOrderExecution>[0]['broker'],
                side: log.side,
                size: log.size,
                price: result.price,
                executed_at: result.executed_at,
                provider_order_id: log.provider_order_id,
            })
            await ctx.confirmDispatchLog(log.docId)

            ctx.logger.info(
                { event: 'cron:execution_confirmed', broker: log.broker, event_id: log.event_id, price: result.price },
                'order execution confirmed',
            )
        } catch (error) {
            ctx.logger.warn(
                { event: 'cron:confirm_execution_failed', broker: log.broker, event_id: log.event_id, error },
                'failed to confirm execution',
            )
        }
    }
}

// ─────────────── Step 2: IFDOCO 決済子注文の約定確認 ───────────────

const confirmIfdocoExits = async (ctx: {
    logger: Logger
    getIfdocoEntries: GetIfdocoEntriesFn
    addOrderExecution: AddOrderExecutionFn
    closingExecutionFetchers: Partial<Record<string, ClosingExecutionFetcherLike>>
}): Promise<void> => {
    const entries = await ctx.getIfdocoEntries()
    ctx.logger.info(
        { event: 'cron:ifdoco_exit_check_start', count: entries.length },
        'checking IFDOCO closing executions',
    )

    for (const entry of entries) {
        if (!entry.provider_order_id) continue

        const fetcher = ctx.closingExecutionFetchers[entry.broker]
        if (!fetcher) {
            ctx.logger.warn(
                { event: 'cron:closing_fetcher_missing', broker: entry.broker },
                'no closing execution fetcher for broker',
            )
            continue
        }

        try {
            const closing = await fetcher.getClosingExecution(entry.provider_order_id, entry.symbol)
            if (closing === null) {
                ctx.logger.info(
                    { event: 'cron:ifdoco_exit_not_yet', broker: entry.broker, entry_id: entry.id },
                    'closing order not yet executed',
                )
                continue
            }

            const exitSide = entry.side === 'BUY' ? 'SELL' : 'BUY'
            await ctx.addOrderExecution({
                id: randomUUID(),
                strategy: entry.strategy,
                symbol: entry.symbol,
                interval: entry.interval,
                broker: entry.broker,
                side: exitSide,
                size: entry.size,
                price: closing.price,
                executed_at: closing.executed_at,
                entry_id: entry.id,
            })

            ctx.logger.info(
                { event: 'cron:ifdoco_exit_confirmed', broker: entry.broker, entry_id: entry.id, price: closing.price },
                'IFDOCO closing execution confirmed',
            )
        } catch (error) {
            ctx.logger.warn(
                { event: 'cron:ifdoco_exit_failed', broker: entry.broker, entry_id: entry.id, error },
                'failed to confirm IFDOCO exit',
            )
        }
    }
}

// ─────────────── Step 3: マッチングして trades を保存 ───────────────

const matchAndSaveTrades = async (ctx: {
    logger: Logger
    getMarketOrderExecutions: GetMarketOrderExecutionsFn
    getIfdocoEntries: GetIfdocoEntriesFn
    getIfdocoExits: GetIfdocoExitsFn
    deleteOrderExecution: DeleteOrderExecutionFn
    addTrade: AddTradeFn
}): Promise<void> => {
    // マーケット注文のマッチング
    const marketExecutions = await ctx.getMarketOrderExecutions()
    const marketResult = matchMarketExecutions(marketExecutions)

    ctx.logger.info(
        {
            event: 'cron:market_matching',
            total: marketExecutions.length,
            matched: marketResult.matched.length,
            remaining: marketResult.remaining.length,
        },
        'market order matching completed',
    )

    for (const pair of marketResult.matched) {
        try {
            const trade = buildTrade(pair)
            await ctx.addTrade(trade)
            await ctx.deleteOrderExecution(pair.entry.id)
            await ctx.deleteOrderExecution(pair.exit.id)

            ctx.logger.info(
                { event: 'cron:trade_saved', strategy: trade.strategy, symbol: trade.symbol, interval: trade.interval, pnl: trade.pnl },
                'trade saved',
            )
        } catch (error) {
            ctx.logger.warn(
                { event: 'cron:trade_save_failed', entry_id: pair.entry.id, error },
                'failed to save trade',
            )
        }
    }

    // IFDOCO のマッチング
    const ifdocoEntries = await ctx.getIfdocoEntries()
    const ifdocoExits = await ctx.getIfdocoExits()
    const ifdocoResult = matchIfdocoExecutions(ifdocoEntries, ifdocoExits)

    ctx.logger.info(
        {
            event: 'cron:ifdoco_matching',
            entries: ifdocoEntries.length,
            exits: ifdocoExits.length,
            matched: ifdocoResult.matched.length,
        },
        'IFDOCO matching completed',
    )

    for (const pair of ifdocoResult.matched) {
        try {
            const trade = buildTrade(pair)
            await ctx.addTrade(trade)
            await ctx.deleteOrderExecution(pair.entry.id)
            await ctx.deleteOrderExecution(pair.exit.id)

            ctx.logger.info(
                { event: 'cron:ifdoco_trade_saved', strategy: trade.strategy, symbol: trade.symbol, interval: trade.interval, pnl: trade.pnl },
                'IFDOCO trade saved',
            )
        } catch (error) {
            ctx.logger.warn(
                { event: 'cron:ifdoco_trade_save_failed', entry_id: pair.entry.id, error },
                'failed to save IFDOCO trade',
            )
        }
    }
}
