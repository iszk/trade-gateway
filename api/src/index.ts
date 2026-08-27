import { randomUUID } from 'node:crypto'
import { serve } from '@hono/node-server'
import { pathToFileURL } from 'node:url'
import { Hono } from 'hono'
import type { Context, Next } from 'hono'
import { z } from 'zod'

import { createOrderDispatcher } from './services/order-dispatcher.js'
import type { DispatchOrderFn, BrokerName } from './types/order.js'
import type { OrderV2 } from './types/order-v2.js'
import type { Position } from './types/position.js'
import type { TradableSymbol } from './types/tradable-symbol.js'
import { DuplicateEventError, createDefaultWebhookEventFn } from './services/webhook-events.js'
import type { CreateWebhookEventFn } from './services/webhook-events.js'
import { createDefaultOrderDispatchLogFn } from './services/order-dispatch-logs.js'
import type { CreateOrderDispatchLogFn } from './services/order-dispatch-logs.js'
import { createDefaultEnsureTradableSymbolFn, createDefaultGetTradableSymbolFn, createDefaultListTradableSymbolsFn, createDefaultUpdateTradeControlFn, createDefaultUpsertTradableSymbolFn, createSymbolId, InvalidStoredTradableSymbolError, parseSymbolId } from './services/tradable-symbols.js'
import type { EnsureTradableSymbolFn, GetTradableSymbolFn, ListTradableSymbolsFn, UpdateTradeControlFn, UpsertTradableSymbolFn } from './services/tradable-symbols.js'
import { createDefaultGetStrategySymbolPolicyFn, createDefaultPutStrategySymbolPolicyFn, InvalidStoredStrategySymbolPolicyError, InvalidStrategySymbolPolicyError, StrategySymbolPolicyNotFoundError, SymbolConstraintsRequiredError, SymbolNotFoundError, isValidStrategyId } from './services/strategy-symbol-policies.js'
import type { GetStrategySymbolPolicyFn, PutStrategySymbolPolicyFn } from './services/strategy-symbol-policies.js'
import {
    createDefaultFreshStartStrategySymbolFn,
    FreshStartAlreadyExistsError,
    FreshStartConflictError,
    FreshStartProjectConfirmationError,
    FreshStartSymbolNotFoundError,
    FreshStartSymbolNotPausedError,
    InvalidFreshStartPolicyError,
    InvalidFreshStartStrategySymbolInputError,
} from './services/strategy-symbol-fresh-start.js'
import type {
    FreshStartStrategySymbolFn,
} from './services/strategy-symbol-fresh-start.js'
import { createDefaultApplyStrategySymbolDispatchOutcomeFn, createDefaultReserveStrategySymbolOrderFn } from './services/strategy-symbol-reservation-service.js'
import type { ApplyStrategySymbolDispatchOutcomeFn, ReserveStrategySymbolOrderFn, ReserveStrategySymbolOrderResult } from './services/strategy-symbol-reservation-service.js'
import { createDefaultGetTradeRecordsFn, createDefaultGetTradeStatsFn } from './services/trade-records-v2.js'
import type { GetTradeRecordsFn, GetTradeStatsFn } from './services/trade-records-v2.js'
import { createDefaultAddOrderV2Fn, createDefaultGetPendingOrdersV2Fn, createDefaultUpdateOrderV2Fn, createDefaultUpdateOrderV2AtomicallyFn, createDefaultGetOrderV2Fn, createDefaultGetActiveIfdOrdersV2Fn, createDefaultListOrdersV2ByDateRangeFn, createDefaultListOrderUpdatesFn } from './services/orders-v2.js'
import type { AddOrderV2Fn, GetPendingOrdersV2Fn, UpdateOrderV2Fn, UpdateOrderV2AtomicallyFn, GetOrderV2Fn, GetActiveIfdOrdersV2Fn, ListOrdersV2ByDateRangeFn, ListOrderUpdatesFn, OrderUpdate } from './services/orders-v2.js'
import { computeStatsV2 } from './services/stats-v2.js'
import type { StatsV2 } from './services/stats-v2.js'
import { BitflyerClient } from './brokers/bitflyer.js'
import { SaxoClient } from './brokers/saxo.js'
import { PositionFetcher } from './services/position-fetcher.js'
import { config } from './config.js'
import { createDefaultSlotScheduler } from './services/slot-scheduler.js'
import type { SlotScheduler } from './services/slot-scheduler.js'
import { executeTenMinutelyTask, executeHourlyTask } from './services/cron-tasks.js'
import type { CronContext, ExecutionPriceFetcherLike, ClosingExecutionFetcherLike } from './services/cron-tasks.js'
import type { ExecutionReconciliationFetcherLike } from './types/execution-sync.js'
import {
    createDefaultApplyStrategySymbolExecutionSyncFn,
} from './services/strategy-symbol-execution-sync.js'
import type {
    ApplyStrategySymbolExecutionSyncFn,
} from './services/strategy-symbol-execution-sync.js'
import {
    createDefaultRunStrategySymbolReconciliationFn,
} from './services/strategy-symbol-reconciliation.js'
import type {
    RunStrategySymbolReconciliationFn,
} from './services/strategy-symbol-reconciliation.js'
import { resolveEffectiveStrategyId } from './services/strategy-ids.js'

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
    size: z.number().optional(),
    price: z.number().optional(),
    interval: z.string().optional(),
    strategy: z.string().optional(),
    strategy_id: z.string().optional(),
    note: z.string().optional(),
    dry_run: z.boolean().optional(),
    stop_loss: z.string().optional(),
    take_profit: z.string().optional(),
    stop_loss_pct: z.union([z.string().min(1), z.number().positive()]).optional(),
    take_profit_pct: z.union([z.string().min(1), z.number().positive()]).optional(),
    symbol: z.string().min(1), // "brokerName:brokerTickerCode" の形式
})

const tradingViewWebhookSchema = baseWebhookSchema.extend({
    webhook_secret: z.string().min(1),
})

const fooWebhookSchema = baseWebhookSchema

const orderUpdatesQuerySchema = z.object({
    updated_from: z.string().datetime({ offset: true }).optional(),
    updated_to: z.string().datetime({ offset: true }).optional(),
    limit: z.string()
        .regex(/^[1-9]\d*$/)
        .transform(Number)
        .pipe(z.number().int().max(200))
        .optional(),
    page: z.string()
        .regex(/^[1-9]\d*$/)
        .transform(Number)
        .pipe(z.number().int())
        .optional(),
})

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

const brokerNames = ['bitflyer', 'dummy', 'saxo'] as const
const isBrokerName = (value: string): value is BrokerName =>
    brokerNames.includes(value as BrokerName)

const toPublicOrderV2 = (order: OrderV2): Omit<OrderV2, 'saxo_ifdoco_recovery'> => {
    const { saxo_ifdoco_recovery: _internalRecovery, ...publicOrder } = order
    return publicOrder
}

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

type PositionFetcherLike = {
    fetchAllPositions(broker?: BrokerName): Promise<Position[]>
    fetchPositionsForReconciliation?(broker: BrokerName): Promise<Position[]>
}

type SaxoPortfolioSnapshotClient = Pick<SaxoClient, 'getPortfolioSnapshot'>

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
        tokenEncryptionKey?: string
    }
    bitflyerConfig?: {
        apiKey?: string
        apiSecret?: string
        baseUrl?: string
    }
    saxoPortfolioSnapshotClient?: SaxoPortfolioSnapshotClient
    positionFetcher?: PositionFetcherLike
    slotScheduler?: SlotScheduler
    executionPriceFetchers?: Partial<Record<string, ExecutionPriceFetcherLike>>
    executionReconciliationFetchers?: Partial<Record<string, ExecutionReconciliationFetcherLike>>
    addOrderV2?: AddOrderV2Fn
    getTradeRecords?: GetTradeRecordsFn
    getTradeStats?: GetTradeStatsFn
    closingExecutionFetchers?: Partial<Record<string, ClosingExecutionFetcherLike>>
    // Phase 3 新フロー
    getPendingOrdersV2?: GetPendingOrdersV2Fn
    updateOrderV2?: UpdateOrderV2Fn
    updateOrderV2Atomically?: UpdateOrderV2AtomicallyFn
    applyStrategySymbolExecutionSync?: ApplyStrategySymbolExecutionSyncFn
    getOrderV2?: GetOrderV2Fn
    getActiveIfdOrdersV2?: GetActiveIfdOrdersV2Fn
    listOrdersV2ByDateRange?: ListOrdersV2ByDateRangeFn
    listOrderUpdates?: ListOrderUpdatesFn
    getTradableSymbol?: GetTradableSymbolFn
    listTradableSymbols?: ListTradableSymbolsFn
    upsertTradableSymbol?: UpsertTradableSymbolFn
    updateTradeControl?: UpdateTradeControlFn
    ensureTradableSymbol?: EnsureTradableSymbolFn
    getStrategySymbolPolicy?: GetStrategySymbolPolicyFn
    putStrategySymbolPolicy?: PutStrategySymbolPolicyFn
    freshStartStrategySymbol?: FreshStartStrategySymbolFn
    reserveStrategySymbolOrder?: ReserveStrategySymbolOrderFn
    applyStrategySymbolDispatchOutcome?: ApplyStrategySymbolDispatchOutcomeFn
    runStrategySymbolReconciliation?: RunStrategySymbolReconciliationFn
    allowUnregisteredStrategyPolicyFallback?: boolean
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
    const requireApiSecret = createApiSecretAuthMiddleware(apiSecret)
    const slotScheduler = options.slotScheduler ?? createDefaultSlotScheduler()
    const addOrderV2 = options.addOrderV2 ?? createDefaultAddOrderV2Fn()
    const getTradeRecords = options.getTradeRecords ?? createDefaultGetTradeRecordsFn()
    const getTradeStats = options.getTradeStats ?? createDefaultGetTradeStatsFn()
    const getPendingOrdersV2 = options.getPendingOrdersV2 ?? createDefaultGetPendingOrdersV2Fn()
    const updateOrderV2 = options.updateOrderV2 ?? createDefaultUpdateOrderV2Fn()
    const updateOrderV2Atomically = options.updateOrderV2Atomically ?? createDefaultUpdateOrderV2AtomicallyFn()
    const applyStrategySymbolExecutionSync = options.applyStrategySymbolExecutionSync
        ?? createDefaultApplyStrategySymbolExecutionSyncFn(logger)
    const getOrderV2 = options.getOrderV2 ?? createDefaultGetOrderV2Fn()
    const getActiveIfdOrdersV2 = options.getActiveIfdOrdersV2 ?? createDefaultGetActiveIfdOrdersV2Fn()
    const listOrdersV2ByDateRange = options.listOrdersV2ByDateRange ?? createDefaultListOrdersV2ByDateRangeFn()
    const listOrderUpdates = options.listOrderUpdates ?? createDefaultListOrderUpdatesFn()
    const getTradableSymbol = options.getTradableSymbol ?? createDefaultGetTradableSymbolFn()
    const listTradableSymbols = options.listTradableSymbols ?? createDefaultListTradableSymbolsFn()
    const upsertTradableSymbol = options.upsertTradableSymbol ?? createDefaultUpsertTradableSymbolFn()
    const updateTradeControl = options.updateTradeControl ?? createDefaultUpdateTradeControlFn()
    const ensureTradableSymbol = options.ensureTradableSymbol ?? createDefaultEnsureTradableSymbolFn()
    const getStrategySymbolPolicy = options.getStrategySymbolPolicy ?? createDefaultGetStrategySymbolPolicyFn()
    const putStrategySymbolPolicy = options.putStrategySymbolPolicy ?? createDefaultPutStrategySymbolPolicyFn()
    const freshStartStrategySymbol = options.freshStartStrategySymbol ?? createDefaultFreshStartStrategySymbolFn()
    const reserveStrategySymbolOrder = options.reserveStrategySymbolOrder ?? createDefaultReserveStrategySymbolOrderFn()
    const applyStrategySymbolDispatchOutcome = options.applyStrategySymbolDispatchOutcome ?? createDefaultApplyStrategySymbolDispatchOutcomeFn()
    const allowUnregisteredStrategyPolicyFallback = options.allowUnregisteredStrategyPolicyFallback
        ?? config.webhook.allowUnregisteredStrategyPolicyFallback
    const runStrategySymbolReconciliation = options.runStrategySymbolReconciliation
        ?? createDefaultRunStrategySymbolReconciliationFn({
            ...(options.listTradableSymbols === undefined ? {} : { listTradableSymbols }),
            ...(positionFetcher.fetchPositionsForReconciliation === undefined
                ? {}
                : { fetchPositionsForReconciliation: positionFetcher.fetchPositionsForReconciliation.bind(positionFetcher) }),
            logger,
        })
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
        tokenEncryptionKey: saxoConfig.tokenEncryptionKey ?? config.saxo.tokenEncryptionKey,
        logger,
    })
    const saxoPortfolioSnapshotClient = options.saxoPortfolioSnapshotClient ?? saxoClient

    const cronCtx: CronContext = {
        logger,
        positionFetcher,
        executionPriceFetchers: options.executionPriceFetchers ?? { bitflyer: bitflyerClient, saxo: saxoClient },
        executionReconciliationFetchers: options.executionReconciliationFetchers ?? { saxo: saxoClient },
        closingExecutionFetchers: options.closingExecutionFetchers ?? { bitflyer: bitflyerClient, saxo: saxoClient },
        getPendingOrdersV2,
        updateOrderV2,
        updateOrderV2Atomically,
        applyStrategySymbolExecutionSync,
        addOrderV2,
        getOrderV2,
        getActiveIfdOrdersV2,
        runStrategySymbolReconciliation,
    }

    const logWebhook = (
        level: 'info' | 'warn',
        event: 'webhook:received' | 'webhook:accepted' | 'webhook:rejected' | 'webhook:suppressed',
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

    const decodeSymbolIdParam = (value: string | undefined): string => {
        if (!value) return ''
        try {
            return decodeURIComponent(value)
        } catch {
            return value
        }
    }

    const parseValidSymbolId = (symbolId: string): { broker: BrokerName; ticker: string } | null => {
        const parsed = parseSymbolId(symbolId)
        if (!parsed || !isBrokerName(parsed.broker)) return null
        return {
            broker: parsed.broker,
            ticker: parsed.ticker,
        }
    }

    const tradableSymbolSchema = z.object({
        display_name: z.string().trim().optional(),
        currency: z.string().trim().min(1).transform((value) => value.toUpperCase()),
        note: z.string().trim().optional(),
        order_constraints: z.object({
            quantity_step: z.number().refine(Number.isFinite, { message: 'must be finite' }).positive(),
            min_order_size: z.number().refine(Number.isFinite, { message: 'must be finite' }).positive(),
            max_order_size: z.number().refine(Number.isFinite, { message: 'must be finite' }).optional(),
        }).superRefine((constraints, ctx) => {
            if (constraints.max_order_size !== undefined && constraints.max_order_size < constraints.min_order_size) {
                ctx.addIssue({
                    code: 'custom',
                    path: ['max_order_size'],
                    message: 'must be greater than or equal to min_order_size',
                })
            }
        }).optional(),
        trade_control: z.object({
            status: z.enum(['active', 'paused']).optional(),
            reason: z.string().trim().optional(),
            updated_by: z.string().trim().optional(),
        }).optional(),
    })

    const finitePositiveNumberSchema = z.number()
        .refine(Number.isFinite, { message: 'must be finite' })
        .positive()
    const taperStrengthSchema = z.number()
        .refine(Number.isFinite, { message: 'must be finite' })
        .min(0)
        .max(1)
    const strategySymbolPolicySchema = z.discriminatedUnion('sizing_mode', [
        z.object({
            sizing_mode: z.literal('WEBHOOK_CAPPED'),
            enabled: z.boolean(),
            max_abs_position: finitePositiveNumberSchema,
            no_flip: z.boolean(),
        }).strict(),
        z.object({
            sizing_mode: z.literal('MANAGED'),
            enabled: z.boolean(),
            max_abs_position: finitePositiveNumberSchema,
            no_flip: z.boolean(),
            base_order_size: finitePositiveNumberSchema,
            taper_strength: taperStrengthSchema,
        }).strict(),
    ])

    const tradeControlSchema = z.object({
        status: z.enum(['active', 'paused']),
        reason: z.string().trim().optional(),
    })

    const freshStartStrategySymbolSchema = z.object({
        sizing_mode: z.literal('WEBHOOK_CAPPED'),
        max_abs_position: finitePositiveNumberSchema,
        no_flip: z.boolean(),
    }).strict()

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

        const symbolId = createSymbolId(payload.broker, payload.ticker)
        let tradableSymbol: Awaited<ReturnType<GetTradableSymbolFn>> = null
        let tradableSymbolStateInvalid = false
        try {
            tradableSymbol = await getTradableSymbol(symbolId)
        } catch (error) {
            if (error instanceof InvalidStoredTradableSymbolError) {
                tradableSymbolStateInvalid = true
            } else {
                logger.warn({
                    event: 'tradable_symbol:webhook_fetch_failed',
                    error,
                    symbol_id: symbolId,
                }, 'failed to resolve tradable symbol for webhook')
                return c.json(errorBody('INTERNAL_ERROR', 'failed to fetch symbol'), 500)
            }
        }
        if (!tradableSymbol && !tradableSymbolStateInvalid && isBrokerName(payload.broker)) {
            ensureTradableSymbol({ broker: payload.broker, ticker: payload.ticker }).catch((err) => {
                reqLogger.warn({ event: 'tradable_symbol:ensure_failed', error: err, symbol_id: symbolId }, 'failed to ensure tradable symbol')
            })
        }

        const symbolPaused = tradableSymbol?.trade_control?.status === 'paused'
        const symbolStateInvalid = tradableSymbolStateInvalid || (tradableSymbol !== null && (
            tradableSymbol.id !== symbolId ||
            tradableSymbol.trade_control === null ||
            typeof tradableSymbol.trade_control !== 'object' ||
            (tradableSymbol.trade_control.status !== 'active' && tradableSymbol.trade_control.status !== 'paused')
        ))

        const createEventOrDuplicate = async (
            event: Parameters<CreateWebhookEventFn>[0],
        ): Promise<Response | null> => {
            try {
                await createWebhookEvent(event)
                return null
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
        }

        type RouteSizingDecision = {
            kind: 'REJECT' | 'SUPPRESS' | 'DISPATCH'
            reason: string
            effectiveSize?: number
            details?: Record<string, unknown>
        }

        const createRouteSizingDecision = (
            kind: RouteSizingDecision['kind'],
            reason: string,
            details: Record<string, unknown> = {},
        ): RouteSizingDecision => ({ kind, reason, details })

        type SizingPolicyContext = {
            sizing_mode: 'WEBHOOK_CAPPED' | 'MANAGED'
            version: number
        }

        const buildSizingDecisionPayload = (
            decision: RouteSizingDecision,
            policy: SizingPolicyContext | null,
        ) => {
            const details = decision.details ?? {}
            const calculatedEffectiveSize = decision.effectiveSize
                ?? (typeof details.effectiveSize === 'number' ? details.effectiveSize : undefined)
            const effectiveSize = calculatedEffectiveSize ?? (decision.kind === 'SUPPRESS' ? 0 : undefined)
            return {
                kind: decision.kind,
                reason: decision.reason,
                ...(policy === null ? {} : {
                    sizing_mode: policy.sizing_mode,
                    policy_version: policy.version,
                }),
                ...(payload.size === undefined ? {} : { input_size: payload.size }),
                ...(effectiveSize === undefined ? {} : { effective_size: effectiveSize }),
                input_size_ignored: policy?.sizing_mode === 'MANAGED' && payload.size !== undefined,
                details,
            }
        }

        const createSizingEvent = async (
            decision: RouteSizingDecision,
            policy: SizingPolicyContext | null,
            effectiveStrategyId?: string,
        ): Promise<Response | null> => {
            const sizingDecision = buildSizingDecisionPayload(decision, policy)
            const eventStatus = decision.kind === 'REJECT'
                ? 'rejected' as const
                : decision.kind === 'SUPPRESS'
                    ? 'suppressed' as const
                    : 'accepted' as const
            const eventResponse = await createEventOrDuplicate({
                event_id: effectiveEventId,
                source,
                broker: payload.broker,
                symbol: payload.ticker,
                side: payload.side,
                order_type: payload.order_type ?? 'MARKET',
                size: payload.size,
                occurred_at: new Date(payload.occurred_at),
                received_at: new Date(),
                status: eventStatus,
                rejection_reason: decision.kind === 'DISPATCH' ? undefined : decision.reason,
                effective_strategy_id: effectiveStrategyId,
                sizing_mode: policy?.sizing_mode,
                input_size: payload.size,
                effective_size: sizingDecision.effective_size,
                decision_kind: decision.kind,
                decision_reason: decision.reason,
                decision_details: sizingDecision.details,
                input_size_ignored: sizingDecision.input_size_ignored,
            })
            return eventResponse
        }

        const respondWithSizingDecision = async (
            decision: RouteSizingDecision,
            policy: SizingPolicyContext | null,
            effectiveStrategyId?: string,
        ): Promise<Response> => {
            const sizingDecision = buildSizingDecisionPayload(decision, policy)
            const eventResponse = await createSizingEvent(decision, policy, effectiveStrategyId)
            if (eventResponse) return eventResponse

            if (decision.kind === 'REJECT') {
                logWebhookRejected({
                    requestId,
                    reason: decision.reason,
                    sourceIp,
                    contentType,
                    rawBody,
                    payload,
                    eventId: effectiveEventId,
                    error: errorBody(decision.reason, `webhook sizing rejected: ${decision.reason}`).error,
                    reqLogger,
                })
                return c.json({
                    ...errorBody(decision.reason, `webhook sizing rejected: ${decision.reason}`),
                    event_id: effectiveEventId,
                    sizing_decision: sizingDecision,
                }, 400)
            }

            if (decision.kind === 'SUPPRESS') {
                logWebhook('info', 'webhook:suppressed', {
                    request_id: requestId,
                    reason: decision.reason,
                    sourceIp,
                    event_id: effectiveEventId,
                    broker: payload.broker,
                    ticker: payload.ticker,
                    symbol_id: symbolId,
                    sizing_decision: sizingDecision,
                    payload: redactSecrets(payload),
                }, reqLogger)
                return c.json({
                    status: 'accepted',
                    dispatch_status: 'suppressed',
                    event_id: effectiveEventId,
                    sizing_decision: sizingDecision,
                }, 202)
            }

            logWebhook('info', 'webhook:accepted', {
                request_id: requestId,
                sourceIp,
                event_id: effectiveEventId,
                sizing_decision: sizingDecision,
                payload: redactSecrets(payload),
            }, reqLogger)
            return c.json({
                status: 'accepted',
                dispatch_status: 'sizing_approved',
                event_id: effectiveEventId,
                sizing_decision: sizingDecision,
            }, 202)
        }

        if (symbolPaused) {
            const duplicateResponse = await createEventOrDuplicate({
                event_id: effectiveEventId,
                source,
                broker: payload.broker,
                symbol: payload.ticker,
                side: payload.side,
                order_type: payload.order_type ?? 'MARKET',
                size: payload.size,
                occurred_at: new Date(payload.occurred_at),
                received_at: new Date(),
                status: 'suppressed',
                rejection_reason: 'symbol_paused',
            })
            if (duplicateResponse) return duplicateResponse

            logWebhook('info', 'webhook:suppressed', {
                request_id: requestId,
                reason: 'symbol_paused',
                sourceIp,
                event_id: effectiveEventId,
                broker: payload.broker,
                ticker: payload.ticker,
                symbol_id: symbolId,
                payload: redactSecrets(payload),
            }, reqLogger)

            if (payload.size !== undefined) {
                const dispatchLogData = {
                    event_id: effectiveEventId,
                    broker: payload.broker,
                    ticker: payload.ticker,
                    side: payload.side,
                    size: payload.size,
                    request_payload: {
                        eventId: effectiveEventId,
                        broker: payload.broker,
                        ticker: payload.ticker,
                        side: payload.side,
                        size: payload.size,
                        requestId,
                    },
                    response_payload: {
                        status: 'suppressed',
                        reason: 'symbol_paused',
                    },
                    result: 'suppressed' as const,
                    error_code: 'SYMBOL_PAUSED',
                }
                try {
                    await createOrderDispatchLog(dispatchLogData)
                } catch (error) {
                    reqLogger.error({
                        event: 'order_dispatch_log:write_failed',
                        error,
                        event_id: effectiveEventId,
                        symbol_id: symbolId,
                        effective_size: payload.size,
                    }, 'suppressed order dispatch log persistence failed')
                }
            }

            return c.json({ status: 'accepted', event_id: effectiveEventId, dispatch_status: 'suppressed' }, 202)
        }

        if (symbolStateInvalid) {
            return respondWithSizingDecision(
                createRouteSizingDecision('REJECT', 'INVALID_STORED_STATE'),
                null,
            )
        }

        const explicitStrategyId = payload.strategy_id !== undefined
        const strategyResolution = resolveEffectiveStrategyId({
            explicitStrategyId: payload.strategy_id,
            legacyStrategy: payload.strategy,
        })
        // Keep the established webhook lookup behavior for a completely
        // missing strategy while the shared resolver still reports MISSING to
        // migration/reconciliation callers.  `unknown` is never synthesized
        // for blank or invalid values.
        const effectiveStrategyId = strategyResolution.effectiveStrategyId
            ?? (strategyResolution.reason === 'MISSING' ? 'unknown' : undefined)

        // Explicit strategy_id is a strict contract.  Only an invalid legacy
        // strategy name may use the migration fallback.
        if (effectiveStrategyId === undefined && (explicitStrategyId || !allowUnregisteredStrategyPolicyFallback)) {
            return respondWithSizingDecision(
                createRouteSizingDecision('REJECT', 'INVALID_STRATEGY_ID'),
                null,
            )
        }

        let policy: Awaited<ReturnType<GetStrategySymbolPolicyFn>> = null
        const hasAttachedOrderInput = payload.stop_loss !== undefined ||
            payload.take_profit !== undefined ||
            payload.stop_loss_pct !== undefined ||
            payload.take_profit_pct !== undefined
        if (effectiveStrategyId !== undefined) {
            try {
                policy = await getStrategySymbolPolicy(effectiveStrategyId, symbolId)
            } catch (error) {
                if (error instanceof InvalidStoredStrategySymbolPolicyError) {
                    return respondWithSizingDecision(
                        createRouteSizingDecision('REJECT', 'INVALID_STORED_STATE'),
                        null,
                        effectiveStrategyId,
                    )
                }
                if (error instanceof SymbolNotFoundError) {
                    return respondWithSizingDecision(
                        createRouteSizingDecision('REJECT', 'SYMBOL_NOT_FOUND'),
                        null,
                        effectiveStrategyId,
                    )
                }
                if (error instanceof SymbolConstraintsRequiredError) {
                    return respondWithSizingDecision(
                        createRouteSizingDecision('REJECT', 'SYMBOL_CONSTRAINTS_REQUIRED'),
                        null,
                        effectiveStrategyId,
                    )
                }
                logger.warn({
                    event: 'strategy_symbol_policy:webhook_fetch_failed',
                    error,
                    strategy_id: effectiveStrategyId,
                    symbol_id: symbolId,
                }, 'failed to resolve strategy-symbol policy for webhook')
                return c.json(errorBody('INTERNAL_ERROR', 'failed to resolve strategy-symbol policy'), 500)
            }
        }

        type DispatchReservationResult = Extract<ReserveStrategySymbolOrderResult, { kind: 'DISPATCH' }>
        let policyReservation: DispatchReservationResult | undefined

        if (policy === null) {
            if (!allowUnregisteredStrategyPolicyFallback || (effectiveStrategyId === undefined && explicitStrategyId)) {
                return respondWithSizingDecision(
                    createRouteSizingDecision('REJECT', 'POLICY_NOT_FOUND'),
                    null,
                    effectiveStrategyId,
                )
            }

            const fallbackSize = payload.size
            if (fallbackSize === undefined) {
                return respondWithSizingDecision(
                    createRouteSizingDecision('REJECT', 'SIZE_REQUIRED'),
                    null,
                    effectiveStrategyId,
                )
            }
            if (!Number.isFinite(fallbackSize) || fallbackSize <= 0) {
                return respondWithSizingDecision(
                    createRouteSizingDecision('REJECT', 'INVALID_SIZE'),
                    null,
                    effectiveStrategyId,
                )
            }

            logger.warn({
                event: 'webhook:unregistered_strategy_policy_fallback',
                request_id: requestId,
                event_id: effectiveEventId,
                strategy_id: effectiveStrategyId,
                symbol_id: symbolId,
            }, 'using unregistered strategy policy fallback')

            const duplicateResponse = await createEventOrDuplicate({
                event_id: effectiveEventId,
                source,
                broker: payload.broker,
                symbol: payload.ticker,
                side: payload.side,
                order_type: payload.order_type ?? 'MARKET',
                size: fallbackSize,
                occurred_at: new Date(payload.occurred_at),
                received_at: new Date(),
                status: 'accepted',
            })
            if (duplicateResponse) return duplicateResponse
        } else {
            if (typeof policy !== 'object' || Array.isArray(policy) ||
                (policy.sizing_mode !== 'WEBHOOK_CAPPED' && policy.sizing_mode !== 'MANAGED') ||
                !Number.isSafeInteger(policy.version) || policy.version <= 0 ||
                policy.id !== `${effectiveStrategyId}:${symbolId}` ||
                policy.strategy_id !== effectiveStrategyId ||
                policy.symbol_id !== symbolId) {
                return respondWithSizingDecision(
                    createRouteSizingDecision('REJECT', 'INVALID_STORED_STATE'),
                    null,
                    effectiveStrategyId,
                )
            }
            if (policy.sizing_mode === 'MANAGED' && hasAttachedOrderInput) {
                return respondWithSizingDecision(
                    createRouteSizingDecision('REJECT', 'MANAGED_ATTACHED_ORDERS_UNSUPPORTED'),
                    policy,
                    effectiveStrategyId,
                )
            }

            let reservationResult: ReserveStrategySymbolOrderResult
            try {
                reservationResult = await reserveStrategySymbolOrder({
                    eventId: effectiveEventId,
                    orderId: effectiveEventId,
                    strategyId: effectiveStrategyId,
                    symbolId,
                    side: payload.side,
                    ...(payload.size === undefined ? {} : { inputSize: payload.size }),
                })
            } catch (error) {
                logger.warn({
                    event: 'strategy_symbol_reservation:webhook_reserve_failed',
                    error,
                    strategy_id: effectiveStrategyId,
                    symbol_id: symbolId,
                    event_id: effectiveEventId,
                }, 'failed to reserve strategy-symbol order for webhook')
                return c.json(errorBody('INTERNAL_ERROR', 'failed to reserve strategy-symbol order'), 500)
            }

            if (reservationResult.kind === 'REJECT') {
                return respondWithSizingDecision(
                    createRouteSizingDecision(
                        'REJECT',
                        reservationResult.reason,
                        reservationResult.decision?.details ?? {},
                    ),
                    policy,
                    effectiveStrategyId,
                )
            }
            if (reservationResult.kind === 'SUPPRESS') {
                const positionDetails = reservationResult.reason === 'POSITION_NOT_READY' && reservationResult.position
                    ? (() => {
                        const effectivePosition = reservationResult.position.confirmed_position + reservationResult.position.pending_delta
                        return Number.isFinite(effectivePosition) ? { effectivePosition } : {}
                    })()
                    : {}
                return respondWithSizingDecision(
                    createRouteSizingDecision(
                        'SUPPRESS',
                        reservationResult.reason,
                        {
                            ...(reservationResult.decision?.details ?? {}),
                            ...positionDetails,
                        },
                    ),
                    policy,
                    effectiveStrategyId,
                )
            }

            policyReservation = reservationResult
        }

        const dispatchSize = policyReservation?.effectiveSize ?? payload.size
        if (dispatchSize === undefined) {
            // The policy-backed branch and the fallback validation above both
            // return before reaching this point. Keep the runtime guard close
            // to the broker call so an invalid future branch cannot dispatch
            // an undefined quantity.
            return respondWithSizingDecision(
                createRouteSizingDecision('REJECT', 'SIZE_REQUIRED'),
                null,
                effectiveStrategyId,
            )
        }

        const policyContext: SizingPolicyContext | null = policyReservation === undefined
            ? null
            : {
                sizing_mode: policyReservation.audit.sizingMode,
                version: policyReservation.audit.policyVersion,
            }
        const policyDispatchDecision = policyReservation === undefined
            ? undefined
            : createRouteSizingDecision(
                'DISPATCH',
                policyReservation.decision.reason,
                {
                    ...policyReservation.decision.details,
                    effectivePosition: policyReservation.audit.positionBefore,
                    positionAfter: policyReservation.audit.positionAfter,
                },
            )
        if (policyReservation !== undefined && policyDispatchDecision !== undefined) {
            policyDispatchDecision.effectiveSize = policyReservation.effectiveSize
        }
        const isPolicyDryRun = policyReservation !== undefined && payload.dry_run === true

        const applyReservationOutcome = async (
            outcome: 'CONFIRMED_SUCCESS' | 'CONFIRMED_FAILURE' | 'UNKNOWN',
            providerOrderId?: string,
        ): Promise<void> => {
            if (policyReservation === undefined || effectiveStrategyId === undefined) return
            const logOutcomeFailure = (details: Record<string, unknown>, message: string) => {
                logger.error({
                    event: 'strategy_symbol_reservation:outcome_apply_failed',
                    outcome,
                    ...details,
                    event_id: effectiveEventId,
                    order_id: effectiveEventId,
                    reservation_id: policyReservation.reservation.id,
                    strategy_id: effectiveStrategyId,
                    symbol_id: symbolId,
                    provider_order_id: providerOrderId,
                    effective_size: policyReservation.effectiveSize,
                    dry_run: isPolicyDryRun,
                }, message)
            }

            const tryUnknownFallback = async (): Promise<void> => {
                try {
                    const fallbackResult = await applyStrategySymbolDispatchOutcome({
                        strategyId: effectiveStrategyId,
                        symbolId,
                        eventId: effectiveEventId,
                        outcome: 'UNKNOWN',
                    })
                    if (fallbackResult.kind === 'REJECT') {
                        logOutcomeFailure(
                            { reason: fallbackResult.reason, fallback_outcome: 'UNKNOWN' },
                            'failed to apply UNKNOWN fallback for strategy-symbol dispatch outcome',
                        )
                    }
                } catch (error) {
                    logOutcomeFailure(
                        { error, fallback_outcome: 'UNKNOWN' },
                        'failed to apply UNKNOWN fallback for strategy-symbol dispatch outcome',
                    )
                }
            }

            let result: Awaited<ReturnType<ApplyStrategySymbolDispatchOutcomeFn>>
            try {
                result = await applyStrategySymbolDispatchOutcome({
                    strategyId: effectiveStrategyId,
                    symbolId,
                    eventId: effectiveEventId,
                    outcome,
                })
            } catch (error) {
                logOutcomeFailure({ error }, 'failed to apply strategy-symbol dispatch outcome')
                if (outcome === 'CONFIRMED_SUCCESS') await tryUnknownFallback()
                return
            }

            if (result.kind !== 'REJECT') return

            logOutcomeFailure({ reason: result.reason }, 'failed to apply strategy-symbol dispatch outcome')

            // The broker and orders_v2 write have already succeeded when this
            // branch handles CONFIRMED_SUCCESS.  Preserve the reservation
            // instead of leaving it looking dispatchable; a best-effort
            // UNKNOWN transition gives operations a manual-review anchor
            // without ever retrying the broker request.
            if (outcome !== 'CONFIRMED_SUCCESS') return
            await tryUnknownFallback()
        }

        // The policy is read once for routing and again atomically by the
        // reservation service.  If it changed to MANAGED between those
        // reads, apply the same attached-order contract before dispatching;
        // release the reservation created by the atomic read first.
        if (
            policyReservation !== undefined &&
            policyReservation.audit.sizingMode === 'MANAGED' &&
            hasAttachedOrderInput
        ) {
            await applyReservationOutcome('CONFIRMED_FAILURE')
            return respondWithSizingDecision(
                createRouteSizingDecision('REJECT', 'MANAGED_ATTACHED_ORDERS_UNSUPPORTED'),
                {
                    sizing_mode: policyReservation.audit.sizingMode,
                    version: policyReservation.audit.policyVersion,
                },
                effectiveStrategyId,
            )
        }

        // Reserve first, then persist the accepted webhook event.  If event
        // persistence fails, the broker must not be called and the reservation
        // is released only when the release itself is a safe confirmed action.
        if (policyReservation !== undefined && policyDispatchDecision !== undefined) {
            try {
                const eventResponse = await createSizingEvent(
                    policyDispatchDecision,
                    policyContext,
                    effectiveStrategyId,
                )
                if (eventResponse) {
                    await applyReservationOutcome('CONFIRMED_FAILURE')
                    return eventResponse
                }
            } catch (error) {
                await applyReservationOutcome('CONFIRMED_FAILURE')
                logger.error({
                    event: 'webhook:event_persist_failed_after_reservation',
                    error,
                    event_id: effectiveEventId,
                    order_id: effectiveEventId,
                    reservation_id: policyReservation.reservation.id,
                    strategy_id: effectiveStrategyId,
                    symbol_id: symbolId,
                }, 'webhook event persistence failed after reservation')
                return c.json(errorBody('INTERNAL_ERROR', 'failed to persist webhook event'), 500)
            }
        }

        const pctToString = (v: string | number): string =>
            typeof v === 'number' ? `${v}%` : v

        const effectiveStopLoss = payload.stop_loss_pct !== undefined
            ? pctToString(payload.stop_loss_pct)
            : payload.stop_loss

        const effectiveTakeProfit = payload.take_profit_pct !== undefined
            ? pctToString(payload.take_profit_pct)
            : payload.take_profit

        let orderResult: Awaited<ReturnType<DispatchOrderFn>>
        try {
            orderResult = await dispatchOrder({
                eventId: effectiveEventId,
                broker: payload.broker as BrokerName || undefined,
                ticker: payload.ticker,
                side: payload.side,
                size: dispatchSize,
                requestId,
                ...(payload.dry_run ? { dryRun: true } : {}),
                ...(payload.price !== undefined ? { price: payload.price } : {}),
                ...(effectiveStopLoss ? { stopLoss: effectiveStopLoss } : {}),
                ...(effectiveTakeProfit ? { takeProfit: effectiveTakeProfit } : {}),
            })
        } catch (error) {
            orderResult = {
                ok: false,
                broker: payload.broker,
                code: 'BROKER_REQUEST_FAILED',
                message: error instanceof Error ? error.message : String(error),
                certainty: 'UNKNOWN',
            }
            logger.error({
                event: 'webhook:broker_dispatch_threw',
                error,
                event_id: effectiveEventId,
                order_id: effectiveEventId,
                reservation_id: policyReservation?.reservation.id,
                strategy_id: effectiveStrategyId,
                symbol_id: symbolId,
            }, 'broker dispatcher threw while handling webhook')
        }

        // Treat a malformed success result as UNKNOWN.  The broker adapters
        // validate this at their boundary too, but keeping the route
        // fail-closed protects injected/legacy dispatchers from creating an
        // orders_v2 record without a provider identifier.
        if (orderResult.ok && (
            typeof orderResult.providerOrderId !== 'string'
            || orderResult.providerOrderId.trim().length === 0
        )) {
            orderResult = {
                ok: false,
                broker: orderResult.broker,
                code: 'BROKER_REQUEST_FAILED',
                message: 'broker dispatch success response is missing provider order id',
                certainty: 'UNKNOWN',
            }
        }

        const brokerOutcome = orderResult.ok
            ? 'CONFIRMED_SUCCESS' as const
            : orderResult.certainty ?? (
                orderResult.code === 'BROKER_NOT_CONFIGURED' || orderResult.code === 'BROKER_NOT_SUPPORTED'
                    ? 'CONFIRMED_FAILURE' as const
                    : 'UNKNOWN' as const
            )
        // A policy-backed dry-run is guaranteed not to submit to a broker.
        // Its reservation must therefore be released even when the dry-run
        // dispatcher reports an otherwise unknown result.
        const outcome = isPolicyDryRun ? 'CONFIRMED_FAILURE' as const : brokerOutcome
        const providerOrderId = isPolicyDryRun
            ? 'DRY_RUN'
            : orderResult.ok
                ? orderResult.providerOrderId
                : undefined

        if (!orderResult.ok) {
            logWebhook('warn', 'webhook:rejected', {
                request_id: requestId,
                reason: 'broker_dispatch_failed',
                sourceIp,
                event_id: effectiveEventId,
                error: {
                    code: orderResult.code,
                    message: orderResult.message,
                    certainty: outcome,
                },
                payload: redactSecrets(payload),
            }, reqLogger)
        }

        const orderMethod =
            effectiveStopLoss && effectiveTakeProfit ? 'IFDOCO' as const :
                effectiveStopLoss || effectiveTakeProfit ? 'IFD' as const :
                    undefined
        let orderPersistenceFailed = false
        let orderPersistenceError: unknown
        if (isPolicyDryRun) {
            // DRY_RUN validates the real dispatch payload but never creates a
            // broker order, so there is no orders_v2 record to persist.
            await applyReservationOutcome('CONFIRMED_FAILURE', providerOrderId)
        } else if (orderResult.ok) {
            try {
                await addOrderV2({
                    id: effectiveEventId,
                    strategy: payload.strategy ?? 'unknown',
                    ...(policyReservation !== undefined && effectiveStrategyId !== undefined
                        ? { effective_strategy_id: effectiveStrategyId }
                        : {}),
                    broker: payload.broker as BrokerName,
                    ticker: payload.ticker,
                    side: payload.side,
                    order_type: (orderMethod === 'IFDOCO' || orderMethod === 'IFD') ? 'IFDOCO' : 'MARKET',
                    requested_size: dispatchSize,
                    executed_size: 0,
                    executed_price: null,
                    status: 'PENDING',
                    exit_sync_status: orderMethod === 'IFDOCO' || orderMethod === 'IFD' ? 'MONITORING' : undefined,
                    provider_order_ids: [orderResult.providerOrderId],
                    broker_order_metadata: orderResult.brokerOrderMetadata,
                    created_at: new Date(),
                    updated_at: new Date(),
                })
            } catch (error) {
                orderPersistenceFailed = true
                orderPersistenceError = error
                await applyReservationOutcome('UNKNOWN', orderResult.providerOrderId)
                logger.error({
                    event: 'orders_v2:write_failed_after_broker_dispatch',
                    error,
                    event_id: effectiveEventId,
                    order_id: effectiveEventId,
                    reservation_id: policyReservation?.reservation.id,
                    strategy_id: effectiveStrategyId,
                    symbol_id: symbolId,
                    provider_order_id: orderResult.providerOrderId,
                    effective_size: dispatchSize,
                }, 'orders_v2 persistence failed after broker dispatch')
            }
            if (!orderPersistenceFailed) {
                await applyReservationOutcome('CONFIRMED_SUCCESS', orderResult.providerOrderId)
            }
        } else {
            await applyReservationOutcome(outcome, providerOrderId)
        }

        const dispatchLogData = {
            event_id: effectiveEventId,
            broker: payload.broker,
            ticker: payload.ticker,
            side: payload.side,
            size: dispatchSize,
            ...(payload.size === undefined ? {} : { input_size: payload.size }),
            effective_size: dispatchSize,
            ...(policyReservation === undefined ? {} : {
                sizing_mode: policyReservation.audit.sizingMode,
                policy_version: policyReservation.audit.policyVersion,
                position_before: policyReservation.audit.positionBefore,
                position_after: policyReservation.audit.positionAfter,
                decision_reason: policyReservation.decision.reason,
            }),
            ...(isPolicyDryRun ? { dry_run: true } : {}),
            certainty: orderPersistenceFailed ? 'UNKNOWN' as const : outcome,
            strategy_id: effectiveStrategyId,
            symbol_id: symbolId,
            order_id: effectiveEventId,
            reservation_id: policyReservation?.reservation.id,
            provider_order_id: providerOrderId,
            request_payload: {
                eventId: effectiveEventId,
                broker: payload.broker,
                ticker: payload.ticker,
                side: payload.side,
                size: dispatchSize,
                requestId,
                ...(isPolicyDryRun ? { dryRun: true } : {}),
            },
            response_payload: orderResult.ok
                ? {
                    providerOrderId,
                    ...(isPolicyDryRun ? { dry_run: true } : {}),
                    ...(orderPersistenceFailed ? { order_persistence: 'failed' } : {}),
                }
                : {
                    code: orderResult.code,
                    certainty: outcome,
                    ...(isPolicyDryRun ? { dry_run: true } : {}),
                },
            result: (orderResult.ok ? 'success' : 'failure') as 'success' | 'failure',
            error_code: orderResult.ok
                ? (orderPersistenceFailed ? 'ORDERS_V2_WRITE_FAILED' : undefined)
                : orderResult.code,
            error_message: orderResult.ok
                ? (orderPersistenceError instanceof Error
                    ? orderPersistenceError.message
                    : orderPersistenceError === undefined
                        ? undefined
                        : String(orderPersistenceError))
                : orderResult.message,
        }
        try {
            await createOrderDispatchLog(dispatchLogData)
        } catch (error) {
            logger.error({
                event: 'order_dispatch_log:write_failed',
                error,
                event_id: effectiveEventId,
                order_id: effectiveEventId,
                reservation_id: policyReservation?.reservation.id,
                strategy_id: effectiveStrategyId,
                symbol_id: symbolId,
                provider_order_id: providerOrderId,
                effective_size: dispatchSize,
            }, 'order dispatch log persistence failed')
        }

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
                        provider_order_id: providerOrderId,
                        certainty: outcome,
                        ...(isPolicyDryRun ? { dry_run: true } : {}),
                    }
                    : {
                        status: 'failed',
                        broker: orderResult.broker,
                        code: orderResult.code,
                        certainty: outcome,
                        ...(isPolicyDryRun ? { dry_run: true } : {}),
                    },
            },
        }, reqLogger)

        if (policyDispatchDecision !== undefined && policyContext !== null) {
            const sizingDecision = buildSizingDecisionPayload(policyDispatchDecision, policyContext)
            return c.json({
                status: 'accepted',
                dispatch_status: 'sizing_approved',
                event_id: effectiveEventId,
                sizing_decision: sizingDecision,
            }, 202)
        }
        return c.json({ status: 'accepted', event_id: effectiveEventId }, 202)
    }

    app.get('/', (c) => c.json({ hello: 'world' }))
    app.get('/api/health', (c) => c.json({ status: 'ok' }))
    app.get('/favicon.ico', (c) => c.body(null, 204))

    app.get('/api/symbols', requireApiSecret, async (c) => {
        try {
            const symbols = await listTradableSymbols()
            return c.json({
                symbols,
                updated_at: Date.now(),
            })
        } catch (err) {
            logger.warn({ event: 'symbols:fetch_failed', error: err }, 'failed to fetch symbols')
            return c.json(errorBody('INTERNAL_ERROR', 'failed to fetch symbols'), 500)
        }
    })

    app.get('/api/symbols/:symbol_id', requireApiSecret, async (c) => {
        const symbolId = decodeSymbolIdParam(c.req.param('symbol_id'))
        if (!parseValidSymbolId(symbolId)) {
            return c.json(errorBody('INVALID_REQUEST', 'symbol_id is invalid'), 400)
        }

        try {
            const symbol = await getTradableSymbol(symbolId)
            if (!symbol) {
                return c.json(errorBody('NOT_FOUND', 'symbol is not found'), 404)
            }
            return c.json({ symbol })
        } catch (err) {
            logger.warn({ event: 'symbol:fetch_failed', error: err, symbol_id: symbolId }, 'failed to fetch symbol')
            return c.json(errorBody('INTERNAL_ERROR', 'failed to fetch symbol'), 500)
        }
    })

    app.put('/api/symbols/:symbol_id', requireApiSecret, async (c) => {
        const symbolId = decodeSymbolIdParam(c.req.param('symbol_id'))
        const parsedSymbolId = parseValidSymbolId(symbolId)
        if (!parsedSymbolId) {
            return c.json(errorBody('INVALID_REQUEST', 'symbol_id is invalid'), 400)
        }

        let body: unknown
        try {
            body = await c.req.json()
        } catch {
            return c.json(errorBody('INVALID_REQUEST', 'invalid JSON body'), 400)
        }

        const parsedBody = tradableSymbolSchema.safeParse(body)
        if (!parsedBody.success) {
            const message = parsedBody.error.issues
                .map((issue: z.ZodIssue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
                .join('; ')
            return c.json(errorBody('INVALID_REQUEST', message), 400)
        }

        try {
            const symbol = await upsertTradableSymbol({
                id: symbolId,
                broker: parsedSymbolId.broker,
                ticker: parsedSymbolId.ticker,
                ...parsedBody.data,
            })
            return c.json({ symbol })
        } catch (err) {
            logger.warn({ event: 'symbol:upsert_failed', error: err, symbol_id: symbolId }, 'failed to upsert symbol')
            return c.json(errorBody('INTERNAL_ERROR', 'failed to upsert symbol'), 500)
        }
    })

    app.patch('/api/symbols/:symbol_id/trade-control', requireApiSecret, async (c) => {
        const symbolId = decodeSymbolIdParam(c.req.param('symbol_id'))
        if (!parseValidSymbolId(symbolId)) {
            return c.json(errorBody('INVALID_REQUEST', 'symbol_id is invalid'), 400)
        }

        let body: unknown
        try {
            body = await c.req.json()
        } catch {
            return c.json(errorBody('INVALID_REQUEST', 'invalid JSON body'), 400)
        }

        const parsedBody = tradeControlSchema.safeParse(body)
        if (!parsedBody.success) {
            const message = parsedBody.error.issues
                .map((issue: z.ZodIssue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
                .join('; ')
            return c.json(errorBody('INVALID_REQUEST', message), 400)
        }

        try {
            const symbol = await updateTradeControl(symbolId, {
                status: parsedBody.data.status,
                reason: parsedBody.data.reason,
                updated_by: 'ui',
            })
            logger.info({
                event: 'symbol_trade_control:updated',
                symbol_id: symbolId,
                broker: symbol.broker,
                ticker: symbol.ticker,
                status: symbol.trade_control.status,
                reason: symbol.trade_control.reason,
                updated_by: symbol.trade_control.updated_by,
            }, 'symbol trade control updated')
            return c.json({ symbol })
        } catch (err) {
            logger.warn({ event: 'symbol_trade_control:update_failed', error: err, symbol_id: symbolId }, 'failed to update symbol trade control')
            return c.json(errorBody('INTERNAL_ERROR', 'failed to update symbol trade control'), 500)
        }
    })

    app.get('/api/strategy-symbol-policies/:strategy_id/:symbol_id', requireApiSecret, async (c) => {
        const strategyId = decodeSymbolIdParam(c.req.param('strategy_id'))
        const symbolId = decodeSymbolIdParam(c.req.param('symbol_id'))
        if (!isValidStrategyId(strategyId) || !parseValidSymbolId(symbolId)) {
            return c.json(errorBody('INVALID_REQUEST', 'strategy_id or symbol_id is invalid'), 400)
        }

        try {
            const policy = await getStrategySymbolPolicy(strategyId, symbolId)
            if (!policy) {
                return c.json(errorBody('POLICY_NOT_FOUND', 'policy is not found'), 404)
            }
            return c.json({ policy })
        } catch (err) {
            logger.warn({
                event: 'strategy_symbol_policy:fetch_failed',
                error: err instanceof InvalidStoredStrategySymbolPolicyError ? err.name : err,
                strategy_id: strategyId,
                symbol_id: symbolId,
            }, 'failed to fetch strategy-symbol policy')
            return c.json(errorBody('INTERNAL_ERROR', 'failed to fetch strategy-symbol policy'), 500)
        }
    })

    app.put('/api/strategy-symbol-policies/:strategy_id/:symbol_id', requireApiSecret, async (c) => {
        const strategyId = decodeSymbolIdParam(c.req.param('strategy_id'))
        const symbolId = decodeSymbolIdParam(c.req.param('symbol_id'))
        if (!isValidStrategyId(strategyId) || !parseValidSymbolId(symbolId)) {
            return c.json(errorBody('INVALID_REQUEST', 'strategy_id or symbol_id is invalid'), 400)
        }

        let body: unknown
        try {
            body = await c.req.json()
        } catch {
            return c.json(errorBody('INVALID_REQUEST', 'invalid JSON body'), 400)
        }

        const parsedBody = strategySymbolPolicySchema.safeParse(body)
        if (!parsedBody.success) {
            const message = parsedBody.error.issues
                .map((issue: z.ZodIssue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
                .join('; ')
            return c.json(errorBody('INVALID_REQUEST', message), 400)
        }

        try {
            const policy = await putStrategySymbolPolicy({
                strategy_id: strategyId,
                symbol_id: symbolId,
                ...parsedBody.data,
            })
            return c.json({ policy })
        } catch (err) {
            if (err instanceof InvalidStrategySymbolPolicyError) {
                return c.json(errorBody('INVALID_REQUEST', err.message), 400)
            }
            if (err instanceof SymbolNotFoundError) {
                return c.json(errorBody('SYMBOL_NOT_FOUND', 'symbol is not found'), 404)
            }
            if (err instanceof SymbolConstraintsRequiredError) {
                return c.json(errorBody('SYMBOL_CONSTRAINTS_REQUIRED', 'symbol order constraints are required'), 409)
            }
            if (err instanceof StrategySymbolPolicyNotFoundError) {
                return c.json(errorBody('POLICY_NOT_FOUND', 'policy is not found'), 404)
            }

            logger.warn({
                event: 'strategy_symbol_policy:upsert_failed',
                error: err instanceof InvalidStoredStrategySymbolPolicyError ? err.name : err,
                strategy_id: strategyId,
                symbol_id: symbolId,
            }, 'failed to upsert strategy-symbol policy')
            return c.json(errorBody('INTERNAL_ERROR', 'failed to upsert strategy-symbol policy'), 500)
        }
    })

    app.post('/api/strategy-symbol-policies/:strategy_id/:symbol_id/fresh-start', requireApiSecret, async (c) => {
        const strategyId = decodeSymbolIdParam(c.req.param('strategy_id'))
        const symbolId = decodeSymbolIdParam(c.req.param('symbol_id'))
        if (!isValidStrategyId(strategyId) || !parseValidSymbolId(symbolId)) {
            return c.json(errorBody('INVALID_REQUEST', 'strategy_id or symbol_id is invalid'), 400)
        }

        let body: unknown
        try {
            body = await c.req.json()
        } catch {
            return c.json(errorBody('INVALID_REQUEST', 'invalid JSON body'), 400)
        }

        const parsedBody = freshStartStrategySymbolSchema.safeParse(body)
        if (!parsedBody.success) {
            const message = parsedBody.error.issues
                .map((issue: z.ZodIssue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
                .join('; ')
            return c.json(errorBody('INVALID_REQUEST', message), 400)
        }

        const apply = c.req.query('apply') === 'true'
        try {
            const result = await freshStartStrategySymbol({
                strategyId,
                symbolId,
                sizingMode: parsedBody.data.sizing_mode,
                maxAbsPosition: parsedBody.data.max_abs_position,
                noFlip: parsedBody.data.no_flip,
                apply,
                ...(apply ? { confirmProject: c.req.header('X-Confirm-Project') } : {}),
            })
            return c.json(result)
        } catch (err) {
            if (err instanceof InvalidFreshStartStrategySymbolInputError) {
                return c.json(errorBody('INVALID_REQUEST', err.message), 400)
            }
            if (err instanceof InvalidFreshStartPolicyError) {
                return c.json(errorBody('INVALID_REQUEST', err.message), 400)
            }
            if (err instanceof FreshStartSymbolNotFoundError) {
                return c.json(errorBody('SYMBOL_NOT_FOUND', 'symbol is not found'), 404)
            }
            if (err instanceof FreshStartProjectConfirmationError) {
                return c.json(errorBody(err.code, err.message), 409)
            }
            if (err instanceof FreshStartSymbolNotPausedError) {
                return c.json(errorBody('SYMBOL_NOT_PAUSED', err.message), 409)
            }
            if (err instanceof FreshStartAlreadyExistsError) {
                return c.json({
                    ...errorBody('ALREADY_EXISTS', err.message),
                    issues: err.issues,
                }, 409)
            }
            if (err instanceof FreshStartConflictError) {
                return c.json({
                    ...errorBody('CONFLICT', err.message),
                    issues: err.issues,
                }, 409)
            }

            logger.warn({
                event: 'strategy_symbol_fresh_start:failed',
                strategy_id: strategyId,
                symbol_id: symbolId,
                mode: apply ? 'APPLY' : 'DRY_RUN',
                result: 'ERROR',
                reason: err instanceof Error ? err.name : 'UNKNOWN_ERROR',
            }, 'failed to fresh-start strategy-symbol sizing ledger')
            return c.json(errorBody('INTERNAL_ERROR', 'failed to fresh-start strategy-symbol sizing ledger'), 500)
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

    app.get('/api/saxo/portfolio-snapshot', requireApiSecret, async (c) => {
        try {
            const snapshot = await saxoPortfolioSnapshotClient.getPortfolioSnapshot()
            return c.json(snapshot)
        } catch (err) {
            logger.warn({ event: 'saxo_portfolio_snapshot:fetch_failed', error: err }, 'failed to fetch Saxo portfolio snapshot')
            return c.json(errorBody('INTERNAL_ERROR', 'failed to fetch Saxo portfolio snapshot'), 500)
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
                ticker: c.req.query('ticker'),
                broker: c.req.query('broker'),
            })
            return c.json(result)
        } catch (err) {
            logger.warn({ event: 'trade_records:stats_failed', error: err }, 'failed to fetch trade stats')
            return c.json(errorBody('INTERNAL_ERROR', 'failed to fetch trade stats'), 500)
        }
    })

    app.get('/api/v2/orders/stats', requireApiSecret, async (c) => {
        const dates = parseFilterDates(c.req.query('from'), c.req.query('to'))
        if ('error' in dates) {
            return c.json(errorBody('INVALID_REQUEST', dates.error), 400)
        }
        try {
            const [executedOrders, pendingOrders] = await Promise.all([
                listOrdersV2ByDateRange(dates.from, dates.to),
                getPendingOrdersV2(),
            ])
            const allOrders = [...executedOrders, ...pendingOrders]

            // strategy ごとにグループ化して集計
            const grouped = new Map<string, OrderV2[]>()
            for (const order of allOrders) {
                const list = grouped.get(order.strategy) ?? []
                list.push(order)
                grouped.set(order.strategy, list)
            }

            const stats: StatsV2[] = Array.from(grouped.entries())
                .map(([strategy, orders]) => computeStatsV2(orders, strategy))
                .sort((a, b) => a.strategy.localeCompare(b.strategy))

            return c.json({
                stats,
                from: dates.from.toISOString(),
                to: dates.to.toISOString(),
            })
        } catch (err) {
            logger.warn({ event: 'v2_orders_stats:fetch_failed', error: err }, 'failed to compute v2 orders stats')
            return c.json(errorBody('INTERNAL_ERROR', 'failed to compute v2 orders stats'), 500)
        }
    })

    app.get('/api/v2/orders', requireApiSecret, async (c) => {
        const dates = parseFilterDates(c.req.query('from'), c.req.query('to'))
        if ('error' in dates) {
            return c.json(errorBody('INVALID_REQUEST', dates.error), 400)
        }

        const strategyFilter = c.req.query('strategy')
        const rawLimit = Number(c.req.query('limit') ?? 50)
        const rawPage = Number(c.req.query('page') ?? 1)
        const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 50 : rawLimit), 200)
        const page = Math.max(1, isNaN(rawPage) ? 1 : rawPage)

        try {
            const allOrders = await listOrdersV2ByDateRange(dates.from, dates.to)
            const filtered = strategyFilter
                ? allOrders.filter((o) => o.strategy === strategyFilter)
                : allOrders

            const total = filtered.length
            const total_pages = Math.max(1, Math.ceil(total / limit))
            const offset = (page - 1) * limit
            const orders = filtered.slice(offset, offset + limit).map(toPublicOrderV2)

            return c.json({
                orders,
                total,
                page,
                limit,
                total_pages,
                from: dates.from.toISOString(),
                to: dates.to.toISOString(),
            })
        } catch (err) {
            logger.warn({ event: 'v2_orders:fetch_failed', error: err }, 'failed to fetch v2 orders')
            return c.json(errorBody('INTERNAL_ERROR', 'failed to fetch v2 orders'), 500)
        }
    })

    app.get('/api/order-updates', requireApiSecret, async (c) => {
        const parsed = orderUpdatesQuerySchema.safeParse({
            updated_from: c.req.query('updated_from'),
            updated_to: c.req.query('updated_to'),
            limit: c.req.query('limit'),
            page: c.req.query('page'),
        })
        if (!parsed.success) {
            return c.json(errorBody('INVALID_REQUEST', 'invalid order updates query'), 400)
        }

        const updatedTo = parsed.data.updated_to
            ? new Date(parsed.data.updated_to)
            : new Date()
        const updatedFrom = parsed.data.updated_from
            ? new Date(parsed.data.updated_from)
            : new Date(updatedTo.getTime() - 30 * 24 * 60 * 60 * 1000)
        if (updatedFrom >= updatedTo) {
            return c.json(errorBody('INVALID_REQUEST', 'updated_from must be before updated_to'), 400)
        }

        const limit = parsed.data.limit ?? 50
        const page = parsed.data.page ?? 1

        try {
            const allOrders = await listOrderUpdates(updatedFrom, updatedTo)
            const total = allOrders.length
            const total_pages = Math.max(1, Math.ceil(total / limit))
            const offset = (page - 1) * limit

            return c.json({
                orders: allOrders.slice(offset, offset + limit),
                total,
                page,
                limit,
                total_pages,
                updated_from: updatedFrom.toISOString(),
                updated_to: updatedTo.toISOString(),
            })
        } catch (err) {
            logger.warn({ event: 'order_updates:fetch_failed', error: err }, 'failed to fetch order updates')
            return c.json(errorBody('INTERNAL_ERROR', 'failed to fetch order updates'), 500)
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
            const allRecords = await getTradeRecords({
                from: dates.from,
                to: dates.to,
                strategy: c.req.query('strategy'),
                ticker: c.req.query('ticker'),
                broker: c.req.query('broker'),
            })

            const total = allRecords.length
            const total_pages = Math.max(1, Math.ceil(total / limit))
            const offset = (page - 1) * limit
            const records = allRecords.slice(offset, offset + limit)

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

    app.post('/api/webhooks/foods', requireApiSecret, createWebhookHandler({
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
export type { Position } from './types/position.js'
export type { SaxoInstrument } from './brokers/saxo.js'
export type { PortfolioSnapshotV1 } from './types/portfolio-snapshot.js'
export type { TradeRecord, TradeRecordWithId, GroupStats, TradeStatsResponse, TradeRecordsResponse } from './services/trade-records-v2.js'
export type { OrderV2 } from './types/order-v2.js'
export type { StatsV2 } from './services/stats-v2.js'
export type { OrderConstraints, TradableSymbol } from './types/tradable-symbol.js'
export type {
    ManagedStrategySymbolPolicy,
    StrategySymbolPolicy,
    StrategySymbolPolicyInput,
    StrategySymbolSizingMode,
    WebhookCappedStrategySymbolPolicy,
} from './types/strategy-symbol-policy.js'
export {
    createFreshStartStrategySymbolFn,
    createDefaultFreshStartStrategySymbolFn,
    FreshStartAlreadyExistsError,
    FreshStartConflictError,
    FreshStartProjectConfirmationError,
    FreshStartSymbolNotFoundError,
    FreshStartSymbolNotPausedError,
    InvalidFreshStartPolicyError,
    InvalidFreshStartStrategySymbolInputError,
} from './services/strategy-symbol-fresh-start.js'
export type {
    FreshStartIssue,
    FreshStartStrategySymbolInput,
    FreshStartStrategySymbolResult,
    FreshStartStrategySymbolFn,
    FreshStartStrategySymbolServiceOptions,
} from './services/strategy-symbol-fresh-start.js'

export type OrdersV2StatsResponse = {
    stats: StatsV2[]
    from: string
    to: string
}

export type OrdersV2Response = {
    orders: OrderV2[]
    total: number
    page: number
    limit: number
    total_pages: number
    from: string
    to: string
}

export type OrderUpdatesResponse = {
    orders: OrderUpdate[]
    total: number
    page: number
    limit: number
    total_pages: number
    updated_from: string
    updated_to: string
}

export type { OrderUpdate } from './services/orders-v2.js'

export {
    reconstructSizingState,
    runSizingMigration,
    createSizingMigrationService,
    validateSizingMigrationManifest,
    SIZING_MIGRATION_MAX_TRANSACTION_WRITES,
} from './services/sizing-migration.js'
export type {
    SizingMigrationManifest,
    SizingMigrationPolicyManifest,
    SizingMigrationSymbolManifest,
    SizingMigrationOrderRecord,
    SizingMigrationIssue,
    SizingMigrationWarning,
    SizingMigrationPendingReservation,
    SizingMigrationAggregate,
    OrderSourceProjection,
    SizingMigrationReconstruction,
    SizingMigrationSymbolStatus,
    SizingMigrationSymbolResult,
    SizingMigrationReport,
    SizingMigrationServiceOptions,
    SizingMigrationService,
} from './services/sizing-migration.js'
export {
    normalizeLegacyStrategyId,
    resolveLegacyStrategyId,
    resolveEffectiveStrategyId,
    isCanonicalStrategyId,
    STRATEGY_ID_PATTERN,
} from './services/strategy-ids.js'
export type {
    StrategyIdResolutionReason,
    StrategyIdResolution,
    ResolveEffectiveStrategyIdInput,
} from './services/strategy-ids.js'

export type SymbolsResponse = {
    symbols: TradableSymbol[]
    updated_at: number
}
