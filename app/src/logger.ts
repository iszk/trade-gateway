import { Logger as TSLogger, type ILogObj } from 'tslog'

export type Logger = {
    info(obj: Record<string, unknown>, msg?: string): void
    warn(obj: Record<string, unknown>, msg?: string): void
    child(bindings: Record<string, unknown>): Logger
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

export const createLogger = (
    tsLogger: TSLogger<ILogObj>,
    additionalFields: Record<string, unknown> = {},
): Logger => ({
    info: (obj, msg) => {
        if (msg) {
            tsLogger.info(msg, { ...additionalFields, ...obj })
        } else {
            tsLogger.info({ ...additionalFields, ...obj })
        }
    },
    warn: (obj, msg) => {
        if (msg) {
            tsLogger.warn(msg, { ...additionalFields, ...obj })
        } else {
            tsLogger.warn({ ...additionalFields, ...obj })
        }
    },
    child: (bindings) => createLogger(tsLogger, { ...additionalFields, ...bindings }),
})

export const defaultLogger: Logger = (() => {
    const isCloudRun = !!process.env.K_SERVICE
    const tsLogger = new TSLogger<ILogObj>({
        type: isCloudRun ? 'hidden' : 'pretty',
    })

    if (isCloudRun) {
        tsLogger.attachTransport((logObj) => {
            const severityMap: Record<string, string> = {
                silly: 'DEBUG',
                trace: 'DEBUG',
                debug: 'DEBUG',
                info: 'INFO',
                warn: 'WARNING',
                error: 'ERROR',
                fatal: 'CRITICAL',
            }

            const meta = logObj._meta
            const level = meta?.logLevelName?.toLowerCase() || 'info'
            const { _meta: _, ...rest } = logObj
            const firstArg: unknown = rest[0]
            const secondArg: unknown = rest[1]

            let message = ''
            let details: Record<string, unknown> = {}

            if (typeof firstArg === 'string') {
                message = firstArg
                details = isRecord(secondArg) ? secondArg : {}
            } else if (isRecord(firstArg)) {
                details = firstArg
                message = (details.message as string) || (details.event as string) || ''
            } else {
                details = rest
                message = (details.message as string) || (details.event as string) || ''
            }

            const output = {
                severity: severityMap[level] || 'DEFAULT',
                message: message,
                ...details,
                'logging.googleapis.com/sourceLocation': {
                    file: meta?.path?.filePath,
                    line: meta?.path?.fileLine,
                    function: meta?.path?.method,
                },
            }

            process.stdout.write(JSON.stringify(output) + '\n')
        })
    }

    return createLogger(tsLogger)
})()
