import { serve } from '@hono/node-server'
import { pathToFileURL } from 'node:url'
import { Hono } from 'hono'
import { z } from 'zod'

const DEFAULT_ALLOWLIST = [
    '52.89.214.238',
    '34.212.75.30',
    '54.218.53.128',
    '52.32.178.7',
]

const RFC3339_REGEX =
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/

const tradingViewWebhookSchema = z.object({
    event_id: z.string().min(1),
    occurred_at: z
        .string()
        .refine((value) => RFC3339_REGEX.test(value), 'must be RFC3339 format')
        .refine((value) => !Number.isNaN(Date.parse(value)), 'must be valid datetime'),
    symbol: z.literal('BTC_JPY'),
    side: z.enum(['BUY', 'SELL']),
    order_type: z.literal('MARKET'),
    size: z.number().positive(),
    webhook_secret: z.string().min(1),
    broker: z.literal('bitflyer').optional(),
    strategy: z.string().optional(),
    note: z.string().optional(),
})

const seenEventIds = new Set<string>()

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
const webhookSecret = process.env.WEBHOOK_SECRET ?? 'changeme'

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

const errorBody = (code: string, message: string) => ({
    error: {
        code,
        message,
    },
})

type CreateAppOptions = {
    webhookSecret?: string
    sourceIpAllowlist?: Set<string>
}

export const createApp = (options: CreateAppOptions = {}) => {
    const app = new Hono()
    const sourceIpAllowlist = options.sourceIpAllowlist ?? parseIpAllowlist()
    const webhookSecret = options.webhookSecret ?? process.env.WEBHOOK_SECRET ?? 'changeme'
    const seenEventIds = new Set<string>()

    app.get('/api/health', (c) => c.json({ status: 'ok' }))

    app.post('/api/webhooks/tradingview', async (c) => {
        const sourceIp = extractSourceIp(c.req.raw.headers)

        if (!sourceIp || !sourceIpAllowlist.has(sourceIp)) {
            console.warn('[webhook:rejected]', {
                reason: 'forbidden_source_ip',
                sourceIp,
            })
            return c.json(
                errorBody('FORBIDDEN_SOURCE_IP', 'source ip is not allowed'),
                403,
            )
        }

        const contentType = c.req.header('content-type')
        if (!contentType || !contentType.includes('application/json')) {
            console.warn('[webhook:rejected]', {
                reason: 'invalid_content_type',
                sourceIp,
                contentType,
            })
            return c.json(
                errorBody('INVALID_REQUEST', 'content-type must be application/json'),
                400,
            )
        }

        let jsonPayload: unknown

        try {
            jsonPayload = await c.req.json()
        } catch {
            console.warn('[webhook:rejected]', {
                reason: 'invalid_json',
                sourceIp,
            })
            return c.json(errorBody('INVALID_REQUEST', 'invalid JSON body'), 400)
        }

        const parsed = tradingViewWebhookSchema.safeParse(jsonPayload)

        if (!parsed.success) {
            const message = parsed.error.issues
                .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
                .join('; ')

            console.warn('[webhook:rejected]', {
                reason: 'validation_error',
                sourceIp,
                message,
            })

            return c.json(errorBody('INVALID_REQUEST', message), 400)
        }

        const payload = {
            ...parsed.data,
            broker: parsed.data.broker ?? 'bitflyer',
        }

        if (payload.webhook_secret !== webhookSecret) {
            console.warn('[webhook:rejected]', {
                reason: 'invalid_webhook_secret',
                sourceIp,
                event_id: payload.event_id,
            })
            return c.json(
                errorBody('INVALID_WEBHOOK_SECRET', 'webhook_secret is invalid'),
                401,
            )
        }

        if (seenEventIds.has(payload.event_id)) {
            console.warn('[webhook:rejected]', {
                reason: 'duplicated_event',
                sourceIp,
                event_id: payload.event_id,
            })
            return c.json(errorBody('DUPLICATED_EVENT', 'event_id is duplicated'), 409)
        }

        seenEventIds.add(payload.event_id)

        const { webhook_secret: _, ...safePayload } = payload
        console.info('[webhook:accepted]', {
            sourceIp,
            payload: safePayload,
            received_at: new Date().toISOString(),
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
    console.info(`trade-gateway listening on :${port}`)

    serve({
        fetch: app.fetch,
        port,
    })
}
