import { randomUUID } from 'node:crypto'
import { serve } from '@hono/node-server'
import { pathToFileURL } from 'node:url'
import { Hono } from 'hono'
import { z } from 'zod'

import { createOrderDispatcher, resolveBroker } from './services/order-dispatcher.js'
import type { DispatchOrderFn, IncomingBroker } from './types/order.js'
import { getFirestoreClient } from './firestore.js'
import { createWebhookEventFn, DuplicateEventError } from './services/webhook-events.js'
import type { CreateWebhookEventFn } from './services/webhook-events.js'
import { createOrderDispatchLogFn } from './services/order-dispatch-logs.js'
import type { CreateOrderDispatchLogFn } from './services/order-dispatch-logs.js'

import pino from 'pino'
import { createGcpLoggingPinoConfig } from '@google-cloud/pino-logging-gcp-config'

const DEFAULT_ALLOWLIST = [
    '52.89.214.238',
    '34.212.75.30',
    '54.218.53.128',
    '52.32.178.7',
]

const tradingViewWebhookSchema = z.object({
    event_id: z.string().min(1),
    occurred_at: z.coerce.number().int().nonnegative(),
    ticker: z.string().min(1),
    side: z.enum(['BUY', 'SELL']),
    order_type: z.literal('MARKET').optional(),
    size: z.number().positive(),
    price: z.number().optional(),
    interval: z.string().optional(),
    webhook_secret: z.string().min(1),
    broker: z.enum(['bitflyer', 'auto']).optional(),
    strategy: z.string().optional(),
    note: z.string().optional(),
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

const WEBHOOK_SECRET_REDACTION = '[REDACTED]'

const logger = (() => {
    try {
        return pino(createGcpLoggingPinoConfig())
    } catch {
        return pino()
    }
})()

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

const logWebhook = (
    level: 'info' | 'warn',
    event: 'webhook:received' | 'webhook:accepted' | 'webhook:rejected',
    details: Record<string, unknown>,
) => {
    logger[level]({
        event,
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
    })
}

type CreateAppOptions = {
    webhookSecret?: string
    sourceIpAllowlist?: Set<string>
    dispatchOrder?: DispatchOrderFn
    createWebhookEvent?: CreateWebhookEventFn
    createOrderDispatchLog?: CreateOrderDispatchLogFn
}

export const createApp = (options: CreateAppOptions = {}) => {
    const app = new Hono()
    const sourceIpAllowlist = options.sourceIpAllowlist ?? parseIpAllowlist()
    const webhookSecret = options.webhookSecret ?? process.env.WEBHOOK_SECRET ?? 'change_me'
    const dispatchOrder = options.dispatchOrder ?? createOrderDispatcher()
    const createWebhookEvent: CreateWebhookEventFn = options.createWebhookEvent ??
        ((data) => createWebhookEventFn(getFirestoreClient())(data))
    const createOrderDispatchLog: CreateOrderDispatchLogFn = options.createOrderDispatchLog ??
        ((data) => createOrderDispatchLogFn(getFirestoreClient())(data))

    app.get('/', (c) => c.json({ hello: 'world' }))
    app.get('/api/health', (c) => c.json({ status: 'ok' }))
    app.get('/favicon.ico', (c) => c.body(null, 204))

    app.post('/api/webhooks/tradingview', async (c) => {
        const requestId = getRequestId(c.req.raw.headers)
        const sourceIp = extractSourceIp(c.req.raw.headers)

        c.header('x-request-id', requestId)

        if (!sourceIp || !sourceIpAllowlist.has(sourceIp)) {
            logWebhookRejected({
                requestId,
                reason: 'forbidden_source_ip',
                sourceIp,
                error: errorBody('FORBIDDEN_SOURCE_IP', 'source ip is not allowed').error,
            })
            return c.json(
                errorBody('FORBIDDEN_SOURCE_IP', 'source ip is not allowed'),
                403,
            )
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
                error: errorBody('INVALID_REQUEST', 'content-type must be application/json')
                    .error,
            })
            return c.json(
                errorBody('INVALID_REQUEST', 'content-type must be application/json'),
                400,
            )
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
            })

            return c.json(errorBody('INVALID_REQUEST', 'invalid JSON body'), 400)
        }

        logWebhook('info', 'webhook:received', {
            request_id: requestId,
            sourceIp,
            contentType,
            payload: redactSecrets(jsonPayload),
        })

        const parsed = tradingViewWebhookSchema.safeParse(jsonPayload)

        if (!parsed.success) {
            const message = parsed.error.issues
                .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
                .join('; ')

            logWebhookRejected({
                requestId,
                reason: 'validation_error',
                sourceIp,
                contentType,
                rawBody,
                payload: jsonPayload,
                error: errorBody('INVALID_REQUEST', message).error,
            })

            return c.json(errorBody('INVALID_REQUEST', message), 400)
        }

        const payload = {
            ...parsed.data,
            broker: resolveBroker(parsed.data.broker as IncomingBroker | undefined, parsed.data.ticker),
        }

        if (payload.webhook_secret !== webhookSecret) {
            logWebhookRejected({
                requestId,
                reason: 'invalid_webhook_secret',
                sourceIp,
                contentType,
                rawBody,
                payload,
                eventId: payload.event_id,
                error: errorBody('INVALID_WEBHOOK_SECRET', 'webhook_secret is invalid').error,
            })
            return c.json(
                errorBody('INVALID_WEBHOOK_SECRET', 'webhook_secret is invalid'),
                401,
            )
        }

        try {
            await createWebhookEvent({
                event_id: payload.event_id,
                source: 'tradingview',
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
                    eventId: payload.event_id,
                    error: errorBody('DUPLICATED_EVENT', 'event_id is duplicated').error,
                })
                return c.json(errorBody('DUPLICATED_EVENT', 'event_id is duplicated'), 409)
            }
            throw error
        }

        const orderResult = await dispatchOrder({
            eventId: payload.event_id,
            broker: payload.broker,
            ticker: payload.ticker,
            side: payload.side,
            size: payload.size,
            requestId,
        })

        if (!orderResult.ok) {
            logWebhook('warn', 'webhook:rejected', {
                request_id: requestId,
                reason: 'broker_dispatch_failed',
                sourceIp,
                event_id: payload.event_id,
                error: {
                    code: orderResult.code,
                    message: orderResult.message,
                },
                payload: redactSecrets(payload),
            })
        }

        createOrderDispatchLog({
            event_id: payload.event_id,
            broker: payload.broker,
            request_payload: {
                eventId: payload.event_id,
                broker: payload.broker,
                ticker: payload.ticker,
                side: payload.side,
                size: payload.size,
                requestId,
            },
            response_payload: orderResult.ok
                ? { providerOrderId: orderResult.providerOrderId }
                : undefined,
            result: orderResult.ok ? 'success' : 'failure',
            error_code: orderResult.ok ? undefined : orderResult.code,
        }).catch((err) => {
            logger.warn({ event: 'dispatch_log:failed', error: err }, 'failed to write order dispatch log')
        })

        const { webhook_secret: _, ...safePayload } = payload
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
        })

        return c.json(
            {
                status: 'accepted',
                event_id: payload.event_id,
            },
            202,
        )
    })

    return app
}

export const app = createApp()

const port = Number(process.env.PORT ?? 3000)
const isMainModule = process.argv[1]
    ? import.meta.url === pathToFileURL(process.argv[1]).href
    : false

if (isMainModule) {
    logger.info({ port }, 'trade-gateway listening')

    serve({
        fetch: app.fetch,
        port,
    })
}
