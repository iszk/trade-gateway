import { randomUUID } from 'node:crypto'
import { serve } from '@hono/node-server'
import { pathToFileURL } from 'node:url'
import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { z } from 'zod'

import { createOrderDispatcher } from './services/order-dispatcher.js'
import type { DispatchOrderFn, BrokerName } from './types/order.js'
import type { BrokerBalance } from './types/balance.js'
import type { Position } from './types/position.js'
import { DuplicateEventError, createDefaultWebhookEventFn } from './services/webhook-events.js'
import type { CreateWebhookEventFn } from './services/webhook-events.js'
import { createDefaultOrderDispatchLogFn, createDefaultGetPendingDispatchLogsFn, createDefaultConfirmDispatchLogFn } from './services/order-dispatch-logs.js'
import type { CreateOrderDispatchLogFn, GetPendingDispatchLogsFn, ConfirmDispatchLogFn } from './services/order-dispatch-logs.js'
import { createDefaultAddOrderExecutionFn, createDefaultGetMarketOrderExecutionsFn, createDefaultGetIfdocoEntriesFn, createDefaultGetIfdocoExitsFn, createDefaultDeleteOrderExecutionFn } from './services/order-executions.js'
import type { AddOrderExecutionFn, GetMarketOrderExecutionsFn, GetIfdocoEntriesFn, GetIfdocoExitsFn, DeleteOrderExecutionFn } from './types/execution.js'
import { createDefaultAddTradeFn, createDefaultGetTradesFn, createDefaultGetTradeStatsFn } from './services/trades.js'
import type { AddTradeFn, GetTradesFn, GetTradeStatsFn } from './types/trade.js'
import { BitflyerClient } from './brokers/bitflyer.js'
import { SaxoClient } from './brokers/saxo.js'
import { PositionFetcher } from './services/position-fetcher.js'
import { BalanceFetcher } from './services/balance-fetcher.js'
import { config } from './config.js'
import { createDefaultSlotScheduler } from './services/slot-scheduler.js'
import type { SlotScheduler } from './services/slot-scheduler.js'
import { executeTenMinutelyTask, executeHourlyTask } from './services/cron-tasks.js'
import type { CronContext, ExecutionPriceFetcherLike, ClosingExecutionFetcherLike } from './services/cron-tasks.js'

import { defaultLogger, type Logger } from './logger.js'

const DEFAULT_ALLOWLIST = [
    '52.89.214.238',
    '34.212.75.30',
    '54.218.53.128',
    '52.32.178.7',
]

const baseWebhookSchema = z.object({
    event_id: z.string().min(1).optional(),
    time: z.string().datetime(), // ISO 8601形式
    occurred_at: z.preprocess((val) => {
        if (typeof val === 'string' && isNaN(Number(val))) {
            const d = new Date(val)
            if (!isNaN(d.getTime())) return d.getTime()
        }
        return val
    }, z.number().int().nonnegative()),
    side: z.preprocess((val) => {
        if (typeof val !== 'string') return val
        const upper = val.toUpperCase()
        if (upper === 'LONG') return 'BUY'
        if (upper === 'SHORT') return 'SELL'
        return upper
    }, z.enum(['BUY', 'SELL'])),
    order_type: z.literal('MARKET').optional(),
    size: z.number().positive(),
    price: z.number().optional(),
    interval: z.string().optional(),
    strategy: z.string().optional(),
    note: z.string().optional(),
    dry_run: z.boolean().optional(),
    stop_loss: z.string().optional(),
    take_profit: z.string().optional(),
    symbol: z.string().min(1), // "brokerName:brokerTickerCode" の形式
})

const tradingViewWebhookSchema = baseWebhookSchema.extend({
    webhook_secret: z.string().min(1),
})

const fooWebhookSchema = baseWebhookSchema

const parseIpAllowlist = (): Set<string> => {
    const fromEnv = process.env.TRADINGVIEW_IP_ALLOWLIST
    if (!fromEnv) {
        return new Set(DEFAULT_ALLOWLIST)
    }

    return new Set(
        fromEnv
            .split(',')
            .map((ip) => ip.trim())
            .filter(Boolean),
    )
}

const sourceIpAllowlist = parseIpAllowlist()
const webhookSecret = process.env.WEBHOOK_SECRET ?? 'change_me'

const extractSourceIp = (headers: Headers): string | null => {
    const xForwardedFor = headers.get('x-forwarded-for')
    if (xForwardedFor) {
        const firstIp = xForwardedFor.split(',')[0]?.trim()
        if (firstIp) {
            return firstIp
        }
    }

    const candidates = [
        headers.get('x-real-ip'),
        headers.get('cf-connecting-ip'),
        headers.get('x-client-ip'),
    ]

    for (const candidate of candidates) {
        if (candidate && candidate.trim().length > 0) {
            return candidate.trim()
        }
    }

    return null
}

const getRequestId = (headers: Headers) => headers.get('x-request-id')?.trim() || randomUUID()

const errorBody = (code: string, message: string) => ({
    error: {
        code,
        message,
    },
})

const createApiSecretAuthMiddleware = (secret: string) => {
    return async (c: Context, next: Next) => {
        const authHeader = c.req.header('Authorization')
        if (!authHeader || authHeader !== `Bearer ${secret}`) {
            return c.json(errorBody('UNAUTHORIZED', 'invalid or missing token'), 401)
        }

        return next()
    }
}

const WEBHOOK_SECRET_REDACTION = '[REDACTED]'

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

const redactSecrets = (value: unknown): unknown => {
    if (Array.isArray(value)) {
        return value.map((item) => redactSecrets(item))
    }

    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, entryValue]) => [
                key,
                key === 'webhook_secret' ? WEBHOOK_SECRET_REDACTION : redactSecrets(entryValue),
            ]),
        )
    }

    return value
}

const redactRawBody = (rawBody?: string) => {
    if (!rawBody) {
        return rawBody
    }

    try {
        return JSON.stringify(redactSecrets(JSON.parse(rawBody)))
    } catch {
        return rawBody.replace(
            /("webhook_secret"\s*:\s*")([^"]*)(")/g,
            `$1${WEBHOOK_SECRET_REDACTION}$3`,
        )
    }
}

const extractTraceContext = (headers: Headers): Record<string, unknown> => {
    const projectId = process.env.GOOGLE_CLOUD_PROJECT
    if (!projectId) return {}

    const traceHeader = headers.get('x-cloud-trace-context')
    if (!traceHeader) return {}

    // Format: TRACE_ID/SPAN_ID;o=TRACE_FLAG
    const match = traceHeader.match(/^([^/]+)\/([^;]+)(?:;o=(\d+))?/)
    if (!match) return {}

    const [, traceId, spanId, flag] = match
    return {
        'logging.googleapis.com/trace': `projects/${projectId}/traces/${traceId}`,
        'logging.googleapis.com/spanId': spanId,
        'logging.googleapis.com/trace_sampled': flag === '1',
    }
}

type BalanceFetcherLike = {
    fetchAllBalances(): Promise<BrokerBalance[]>
}

type PositionFetcherLike = {
    fetchAllPositions(broker?: BrokerName): Promise<Position[]>
}

type CreateAppOptions = {
    webhookSecret?: string
    apiSecret?: string
    sourceIpAllowlist?: Set<string>
    dispatchOrder?: DispatchOrderFn
    createWebhookEvent?: CreateWebhookEventFn
    createOrderDispatchLog?: CreateOrderDispatchLogFn
    logger?: Logger
    saxoConfig?: {
        appKey?: string
        appSecret?: string
        authBaseUrl?: string
        baseUrl?: string
        redirectUri?: string
    }
    bitflyerConfig?: {
        apiKey?: string
        apiSecret?: string
        baseUrl?: string
    }
    balanceFetcher?: BalanceFetcherLike
    positionFetcher?: PositionFetcherLike
    slotScheduler?: SlotScheduler
    executionPriceFetchers?: Partial<Record<string, ExecutionPriceFetcherLike>>
    closingExecutionFetchers?: Partial<Record<string, ClosingExecutionFetcherLike>>
    // order_executions
    getPendingDispatchLogs?: GetPendingDispatchLogsFn
    confirmDispatchLog?: ConfirmDispatchLogFn
    addOrderExecution?: AddOrderExecutionFn
    getMarketOrderExecutions?: GetMarketOrderExecutionsFn
    getIfdocoEntries?: GetIfdocoEntriesFn
    getIfdocoExits?: GetIfdocoExitsFn
    deleteOrderExecution?: DeleteOrderExecutionFn
    // trades
    addTrade?: AddTradeFn
    getTrades?: GetTradesFn
    getTradeStats?: GetTradeStatsFn
}

export const createApp = (options: CreateAppOptions = {}) => {
    const app = new Hono()
    const sourceIpAllowlist = options.sourceIpAllowlist ?? parseIpAllowlist()
    const webhookSecret = options.webhookSecret ?? process.env.WEBHOOK_SECRET ?? 'change_me'
    const apiSecret = options.apiSecret ?? process.env.API_SECRET ?? 'change_me'
    const dispatchOrder = options.dispatchOrder ?? createOrderDispatcher()
    const createWebhookEvent = options.createWebhookEvent ?? createDefaultWebhookEventFn()
    const createOrderDispatchLog = options.createOrderDispatchLog ?? createDefaultOrderDispatchLogFn()
    const logger = options.logger ?? defaultLogger

    const saxoConfig = options.saxoConfig ?? config.saxo
    const bitflyerConfig = options.bitflyerConfig ?? config.bitflyer
    const positionFetcher = options.positionFetcher ?? new PositionFetcher()
    const balanceFetcher = options.balanceFetcher ?? new BalanceFetcher()
    const requireApiSecret = createApiSecretAuthMiddleware(apiSecret)
    const slotScheduler = options.slotScheduler ?? createDefaultSlotScheduler()
    const getPendingDispatchLogs = options.getPendingDispatchLogs ?? createDefaultGetPendingDispatchLogsFn()
    const confirmDispatchLog = options.confirmDispatchLog ?? createDefaultConfirmDispatchLogFn()
    const addOrderExecution = options.addOrderExecution ?? createDefaultAddOrderExecutionFn()
    const getMarketOrderExecutions = options.getMarketOrderExecutions ?? createDefaultGetMarketOrderExecutionsFn()
    const getIfdocoEntries = options.getIfdocoEntries ?? createDefaultGetIfdocoEntriesFn()
    const getIfdocoExits = options.getIfdocoExits ?? createDefaultGetIfdocoExitsFn()
    const deleteOrderExecution = options.deleteOrderExecution ?? createDefaultDeleteOrderExecutionFn()
    const addTrade = options.addTrade ?? createDefaultAddTradeFn()
    const getTrades = options.getTrades ?? createDefaultGetTradesFn()
    const getTradeStats = options.getTradeStats ?? createDefaultGetTradeStatsFn()

    const bitflyerClient = new BitflyerClient({
        apiKey: bitflyerConfig.apiKey,
        apiSecret: bitflyerConfig.apiSecret,
        baseUrl: bitflyerConfig.baseUrl,
        logger,
    })

    const saxoClient = new SaxoClient({
        appKey: saxoConfig.appKey,
        appSecret: saxoConfig.appSecret,
        authBaseUrl: saxoConfig.authBaseUrl,
        baseUrl: saxoConfig.baseUrl,
        redirectUri: saxoConfig.redirectUri,
        logger,
    })

    const cronCtx: CronContext = {
        logger,
        positionFetcher,
        executionPriceFetchers: options.executionPriceFetchers ?? { bitflyer: bitflyerClient, saxo: saxoClient },
        closingExecutionFetchers: options.closingExecutionFetchers ?? { bitflyer: bitflyerClient },
        getPendingDispatchLogs,
        confirmDispatchLog,
        addOrderExecution,
        getIfdocoEntries,
        getMarketOrderExecutions,
        getIfdocoExits,
        deleteOrderExecution,
        addTrade,
    }

    const logWebhook = (
        level: 'info' | 'warn',
        event: 'webhook:received' | 'webhook:accepted' | 'webhook:rejected',
        details: Record<string, unknown>,
        reqLogger?: Logger,
    ) => {
        const log = reqLogger ?? logger
        log[level]({
            event,
            logged_at: new Date().toISOString(),
            ...details,
        })
    }

    const logWebhookRejected = ({
        requestId,
        reason,
        sourceIp,
        error,
        contentType,
        rawBody,
        payload,
        eventId,
        parseError,
        reqLogger,
    }: {
        requestId: string
        reason: string
        sourceIp: string | null
        error: { code: string; message: string }
        contentType?: string
        rawBody?: string
        payload?: unknown
        eventId?: string
        parseError?: string
        reqLogger?: Logger
    }) => {
        logWebhook('warn', 'webhook:rejected', {
            request_id: requestId,
            reason,
            sourceIp,
            contentType,
            event_id: eventId,
            error,
            parseError,
            rawBody: redactRawBody(rawBody),
            payload: redactSecrets(payload),
        }, reqLogger)
    }

    type WebhookPayload = z.infer<typeof baseWebhookSchema> & {
        broker: string
        ticker: string
        webhook_secret?: string
    }

    const createWebhookHandler = ({
        schema,
        source,
        checkSourceIp = false,
        checkWebhookSecret = false,
    }: {
        schema: z.ZodTypeAny
        source: string
        checkSourceIp?: boolean
        checkWebhookSecret?: boolean
    }) => async (c: Context) => {
        const requestId = getRequestId(c.req.raw.headers)
        const sourceIp = extractSourceIp(c.req.raw.headers)
        const reqLogger = logger.child(extractTraceContext(c.req.raw.headers))

        c.header('x-request-id', requestId)

        if (checkSourceIp && (!sourceIp || !sourceIpAllowlist.has(sourceIp))) {
            logWebhookRejected({
                requestId,
                reason: 'forbidden_source_ip',
                sourceIp,
                error: errorBody('FORBIDDEN_SOURCE_IP', 'source ip is not allowed').error,
                reqLogger,
            })
            return c.json(errorBody('FORBIDDEN_SOURCE_IP', 'source ip is not allowed'), 403)
        }

        const contentType = c.req.header('content-type')
        if (!contentType || !contentType.includes('application/json')) {
            const rawBody = await c.req.text()
            logWebhookRejected({
                requestId,
                reason: 'invalid_content_type',
                sourceIp,
                contentType,
                rawBody,
                error: errorBody('INVALID_REQUEST', 'content-type must be application/json').error,
                reqLogger,
            })
            return c.json(errorBody('INVALID_REQUEST', 'content-type must be application/json'), 400)
        }

        const rawBody = await c.req.text()
        let jsonPayload: unknown

        try {
            jsonPayload = JSON.parse(rawBody)
        } catch (error) {
            logWebhookRejected({
                requestId,
                reason: 'invalid_json',
                sourceIp,
                contentType,
                rawBody,
                error: errorBody('INVALID_REQUEST', 'invalid JSON body').error,
                parseError: error instanceof Error ? error.message : String(error),
                reqLogger,
            })
            return c.json(errorBody('INVALID_REQUEST', 'invalid JSON body'), 400)
        }

        logWebhook('info', 'webhook:received', {
            request_id: requestId,
            sourceIp,
            contentType,
            payload: redactSecrets(jsonPayload),
        }, reqLogger)

        const parsed = schema.safeParse(jsonPayload)

        if (!parsed.success) {
            const message = parsed.error.issues
                .map((issue: z.ZodIssue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
                .join('; ')

            logWebhookRejected({
                requestId,
                reason: 'validation_error',
                sourceIp,
                contentType,
                rawBody,
                payload: jsonPayload,
                error: errorBody('INVALID_REQUEST', message).error,
                reqLogger,
            })
            return c.json(errorBody('INVALID_REQUEST', message), 400)
        }

        const payload: WebhookPayload = {
            ...(parsed.data as WebhookPayload),
            broker: '',
            ticker: '',
        }

        const [symbolBroker, ...symbolParts] = payload.symbol.split(':')
        const symbolTicker = symbolParts.join(':')
        if (symbolBroker && symbolTicker) {
            payload.broker = symbolBroker.toLowerCase()
            payload.ticker = symbolTicker
        } else {
            logger.warn({ symbol: payload.symbol }, "invalid symbol format, expected 'brokerName:brokerTickerCode'")
            payload.broker = 'unknown'
            payload.ticker = payload.symbol
        }

        const effectiveEventId = payload.event_id ?? [
            String(new Date(payload.time).getTime()),
            payload.symbol,
            payload.interval ?? 'no_interval',
            payload.strategy ? payload.strategy.replace(/\s+/g, '_') : 'no_strategy',
            payload.side,
        ].join('-')
        payload.event_id = effectiveEventId

        if (checkWebhookSecret && payload.webhook_secret !== webhookSecret) {
            logWebhookRejected({
                requestId,
                reason: 'invalid_webhook_secret',
                sourceIp,
                contentType,
                rawBody,
                payload,
                error: errorBody('INVALID_WEBHOOK_SECRET', 'webhook_secret is invalid').error,
                reqLogger,
            })
            return c.json(errorBody('INVALID_WEBHOOK_SECRET', 'webhook_secret is invalid'), 401)
        }

        try {
            await createWebhookEvent({
                event_id: effectiveEventId,
                source,
                broker: payload.broker,
                symbol: payload.ticker,
                side: payload.side,
                order_type: payload.order_type ?? 'MARKET',
                size: payload.size,
                occurred_at: new Date(payload.occurred_at),
                received_at: new Date(),
                status: 'accepted',
            })
        } catch (error) {
            if (error instanceof DuplicateEventError) {
                logWebhookRejected({
                    requestId,
                    reason: 'duplicated_event',
                    sourceIp,
                    contentType,
                    rawBody,
                    payload,
                    eventId: effectiveEventId,
                    error: errorBody('DUPLICATED_EVENT', 'event_id is duplicated').error,
                    reqLogger,
                })
                return c.json(errorBody('DUPLICATED_EVENT', 'event_id is duplicated'), 409)
            }
            throw error
        }

        const orderResult = await dispatchOrder({
            eventId: effectiveEventId,
            broker: payload.broker as BrokerName || undefined,
            ticker: payload.ticker,
            side: payload.side,
            size: payload.size,
            requestId,
            ...(payload.dry_run ? { dryRun: true } : {}),
            ...(payload.price !== undefined ? { price: payload.price } : {}),
            ...(payload.stop_loss ? { stopLoss: payload.stop_loss } : {}),
            ...(payload.take_profit ? { takeProfit: payload.take_profit } : {}),
        })

        if (!orderResult.ok) {
            logWebhook('warn', 'webhook:rejected', {
                request_id: requestId,
                reason: 'broker_dispatch_failed',
                sourceIp,
                event_id: effectiveEventId,
                error: {
                    code: orderResult.code,
                    message: orderResult.message,
                },
                payload: redactSecrets(payload),
            }, reqLogger)
        }

        // dispatch 成功 & strategy/interval あり時に execution_status='pending' を設定
        // cron が broker API で約定価格を確認して order_executions に昇格させる
        const isTracked = orderResult.ok && payload.strategy !== undefined && payload.interval !== undefined
        const dispatchLogData = {
            event_id: effectiveEventId,
            broker: payload.broker,
            ticker: payload.ticker,
            side: payload.side,
            size: payload.size,
            provider_order_id: orderResult.ok ? orderResult.providerOrderId : undefined,
            request_payload: {
                eventId: effectiveEventId,
                broker: payload.broker,
                ticker: payload.ticker,
                side: payload.side,
                size: payload.size,
                requestId,
            },
            response_payload: orderResult.ok
                ? { providerOrderId: orderResult.providerOrderId }
                : undefined,
            result: (orderResult.ok ? 'success' : 'failure') as 'success' | 'failure',
            error_code: orderResult.ok ? undefined : orderResult.code,
            execution_status: isTracked ? 'pending' as const : 'not_tracked' as const,
            ...(isTracked ? { strategy: payload.strategy, interval: payload.interval } : {}),
        }
        createOrderDispatchLog(dispatchLogData).catch((err) => {
            reqLogger.warn({ event: 'dispatch_log:failed', error: err, data: dispatchLogData }, 'failed to write order dispatch log')
        })

        const { webhook_secret: _secret, ...safePayload } = payload
        logWebhook('info', 'webhook:accepted', {
            request_id: requestId,
            sourceIp,
            payload: {
                ...safePayload,
                dispatch_result: orderResult.ok
                    ? {
                        status: 'success',
                        broker: orderResult.broker,
                        provider_order_id: orderResult.providerOrderId,
                    }
                    : {
                        status: 'failed',
                        broker: orderResult.broker,
                        code: orderResult.code,
                    },
            },
        }, reqLogger)

        return c.json({ status: 'accepted', event_id: effectiveEventId }, 202)
    }

    app.get('/', (c) => c.json({ hello: 'world' }))
    app.get('/api/health', (c) => c.json({ status: 'ok' }))
    app.get('/favicon.ico', (c) => c.body(null, 204))

    app.get('/api/balances', requireApiSecret, async (c) => {
        try {
            const balances = await balanceFetcher.fetchAllBalances()
            return c.json({
                balances,
                updated_at: Date.now(),
            })
        } catch (err) {
            logger.warn({ event: 'balances:fetch_failed', error: err }, 'failed to fetch balances')
            return c.json(errorBody('INTERNAL_ERROR', 'failed to fetch balances'), 500)
        }
    })

    app.get('/api/positions', requireApiSecret, async (c) => {
        const broker = c.req.query('broker') as BrokerName | undefined
        try {
            const positions = await positionFetcher.fetchAllPositions(broker)
            return c.json({
                positions,
                updated_at: Date.now(),
            })
        } catch (err) {
            logger.warn({ event: 'positions:fetch_failed', error: err }, 'failed to fetch positions')
            return c.json(errorBody('INTERNAL_ERROR', 'failed to fetch positions'), 500)
        }
    })

    app.get('/api/cron', requireApiSecret, async (c) => {
        const nowMs = Date.now()
        try {
            await Promise.all([
                slotScheduler.runIfNewSlot({
                    nowMs,
                    intervalSeconds: 600,
                    slotKey: 'last_slot_10m',
                    task: () => executeTenMinutelyTask(cronCtx),
                    logger,
                }),
                slotScheduler.runIfNewSlot({
                    nowMs,
                    intervalSeconds: 3600,
                    slotKey: 'last_slot_1h',
                    task: () => executeHourlyTask(cronCtx),
                    logger,
                }),
            ])
        } catch (slotErr) {
            logger.warn({ event: 'cron:slot_scheduler_error', error: slotErr }, 'slot scheduler error, continuing')
        }

        return c.json({ status: 'ok' })
    })

    app.get('/api/auth/saxo/login', (c) => {
        const state = randomUUID()
        const loginUrl = saxoClient.getLoginUrl(state)
        return c.redirect(loginUrl)
    })

    app.get('/api/auth/saxo/callback', async (c) => {
        const code = c.req.query('code')
        const error = c.req.query('error')

        if (error) {
            return c.json({ error }, 400)
        }

        if (!code) {
            return c.json({ error: 'code is missing' }, 400)
        }

        try {
            await saxoClient.exchangeCodeForToken(code)
            return c.json({ status: 'success', message: 'Saxo authentication successful' })
        } catch (err) {
            logger.warn({ event: 'saxo_auth:failed', error: err }, 'Saxo authentication failed')
            return c.json({ error: 'Authentication failed' }, 500)
        }
    })

    app.get('/api/saxo/instruments', requireApiSecret, async (c) => {
        const keyword = c.req.query('keyword')
        if (!keyword) {
            return c.json(errorBody('INVALID_REQUEST', 'keyword is required'), 400)
        }
        try {
            const instruments = await saxoClient.searchInstruments(keyword)
            return c.json({ instruments })
        } catch (err) {
            logger.warn({ event: 'saxo_instruments:search_failed', error: err }, 'failed to search Saxo instruments')
            return c.json(errorBody('INTERNAL_ERROR', 'failed to search instruments'), 500)
        }
    })

    const parseFilterDates = (
        fromStr: string | undefined,
        toStr: string | undefined,
    ): { from: Date; to: Date } | { error: string } => {
        const now = new Date()
        const toJSTDateStr = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })
        const defaultFromStr = toJSTDateStr(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000))
        const defaultToStr = toJSTDateStr(now)

        const fromDateStr = fromStr ?? defaultFromStr
        const toDateStr = toStr ?? defaultToStr

        // 日付文字列を JST 00:00 として解釈する
        const from = new Date(`${fromDateStr}T00:00:00+09:00`)
        // to は「指定日の翌日 00:00 JST」を排他的上限とする
        const toMidnight = new Date(`${toDateStr}T00:00:00+09:00`)
        const to = new Date(toMidnight.getTime() + 24 * 60 * 60 * 1000)

        if (isNaN(from.getTime())) return { error: `invalid 'from' date: ${fromStr}` }
        if (isNaN(to.getTime())) return { error: `invalid 'to' date: ${toStr}` }
        if (from >= to) return { error: "'from' must be before 'to'" }
        return { from, to }
    }

    app.get('/api/trade-records/stats', requireApiSecret, async (c) => {
        const dates = parseFilterDates(c.req.query('from'), c.req.query('to'))
        if ('error' in dates) {
            return c.json(errorBody('INVALID_REQUEST', dates.error), 400)
        }
        try {
            const result = await getTradeStats({
                from: dates.from,
                to: dates.to,
                strategy: c.req.query('strategy'),
                interval: c.req.query('interval'),
                symbol: c.req.query('ticker') ?? c.req.query('symbol'),
                broker: c.req.query('broker'),
            })
            return c.json(result)
        } catch (err) {
            logger.warn({ event: 'trade_records:stats_failed', error: err }, 'failed to fetch trade stats')
            return c.json(errorBody('INTERNAL_ERROR', 'failed to fetch trade stats'), 500)
        }
    })

    app.get('/api/trade-records', requireApiSecret, async (c) => {
        const dates = parseFilterDates(c.req.query('from'), c.req.query('to'))
        if ('error' in dates) {
            return c.json(errorBody('INVALID_REQUEST', dates.error), 400)
        }

        const rawLimit = Number(c.req.query('limit') ?? 50)
        const rawPage = Number(c.req.query('page') ?? 1)
        const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 50 : rawLimit), 200)
        const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage)

        try {
            const allTrades = await getTrades({
                from: dates.from,
                to: dates.to,
                strategy: c.req.query('strategy'),
                interval: c.req.query('interval'),
                symbol: c.req.query('ticker') ?? c.req.query('symbol'),
                broker: c.req.query('broker'),
            })

            const total = allTrades.length
            const total_pages = Math.max(1, Math.ceil(total / limit))
            const offset = (page - 1) * limit
            const records = allTrades.slice(offset, offset + limit)

            return c.json({
                records,
                total,
                page,
                limit,
                total_pages,
                from: dates.from.toISOString(),
                to: dates.to.toISOString(),
            })
        } catch (err) {
            logger.warn({ event: 'trade_records:fetch_failed', error: err }, 'failed to fetch trade records')
            return c.json(errorBody('INTERNAL_ERROR', 'failed to fetch trade records'), 500)
        }
    })

    app.post('/api/webhooks/tradingview', createWebhookHandler({
        schema: tradingViewWebhookSchema,
        source: 'tradingview',
        checkSourceIp: true,
        checkWebhookSecret: true,
    }))

    app.post('/api/webhooks/foo', requireApiSecret, createWebhookHandler({
        schema: fooWebhookSchema,
        source: 'foo',
    }))

    return app
}

export const app = createApp()

const port = Number(process.env.PORT ?? 3000)
const isMainModule = process.argv[1]
    ? import.meta.url === pathToFileURL(process.argv[1]).href
    : false

if (isMainModule) {
    defaultLogger.info({ port }, 'trade-gateway listening')

    serve({
        fetch: app.fetch,
        port,
    })
}

export type AppType = typeof app
export type { BrokerBalance } from './types/balance.js'
export type { Position } from './types/position.js'
export type { SaxoInstrument } from './brokers/saxo.js'
export type { GroupStats, TradeStatsResponse, TradesResponse } from './types/trade.js'
