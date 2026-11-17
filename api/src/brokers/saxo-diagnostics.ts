export type SaxoSnapshotStage =
    | 'auth_read'
    | 'auth_refresh'
    | 'accounts'
    | 'balance'
    | 'net_positions'
    | 'instrument_details'
    | 'snapshot_mapping'

type SaxoSnapshotReason =
    | 'auth_missing'
    | 'refresh_token_expired'
    | 'refresh_wait_timeout'
    | 'refresh_failed'
    | 'http_error'
    | 'network_error'
    | 'invalid_json'
    | 'invalid_response'
    | 'no_accounts'
    | 'firestore_error'
    | 'invalid_auth_document'
    | 'decrypt_failed'
    | 'encrypt_failed'
    | 'migration_failed'
    | 'mapping_failed'
    | 'unexpected_error'

type SaxoDiagnosticErrorSummary = {
    name: string
    stage?: SaxoSnapshotStage
    reason?: SaxoSnapshotReason
    operation?: string
    upstream_status?: number
    error_code?: string | number
}

export type SaxoSnapshotDiagnostic = {
    stage: SaxoSnapshotStage
    reason: SaxoSnapshotReason
    description: string
    operation?: string
    upstream_path?: string
    upstream_status?: number
    error_code?: string | number
    field_path?: string
    expected_type?: string
    cause_summary?: SaxoDiagnosticErrorSummary
    secondary_cause_summary?: SaxoDiagnosticErrorSummary
}

const SAFE_ERROR_CODES = new Set([
    'aborted',
    'already-exists',
    'cancelled',
    'data-loss',
    'deadline-exceeded',
    'failed-precondition',
    'internal',
    'invalid-argument',
    'not-found',
    'out-of-range',
    'permission-denied',
    'resource-exhausted',
    'unauthenticated',
    'unavailable',
    'unimplemented',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'EAI_AGAIN',
    'ENETUNREACH',
    'ENOTFOUND',
    'EPIPE',
    'ETIMEDOUT',
    'ERR_HTTP_INVALID_STATUS_CODE',
    'ERR_INVALID_ARG_TYPE',
    'ERR_NETWORK',
    'ERR_STREAM_PREMATURE_CLOSE',
    'ERR_TLS_CERT_ALTNAME_INVALID',
])
const SAFE_ERROR_NAMES = new Set([
    'AbortError',
    'AggregateError',
    'Error',
    'EvalError',
    'FirebaseError',
    'FirestoreError',
    'RangeError',
    'ReferenceError',
    'SyntaxError',
    'TypeError',
    'URIError',
])

const getSafeErrorName = (error: Error): string => {
    try {
        const name = error.name
        return typeof name === 'string' && SAFE_ERROR_NAMES.has(name) ? name : 'Error'
    } catch {
        return 'Error'
    }
}

const getSafeErrorCode = (error: Error): string | number | undefined => {
    try {
        const value = Reflect.get(error, 'code')
        if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value
        if (typeof value === 'string' && SAFE_ERROR_CODES.has(value)) return value
    } catch {
        // Error properties supplied by an upstream library are not trusted.
    }
    return undefined
}

const summarizeSaxoDiagnosticCause = (error: unknown): SaxoDiagnosticErrorSummary => {
    if (error instanceof SaxoSnapshotDiagnosticError) {
        const { stage, reason, operation, upstream_status, error_code } = error.diagnostic
        return {
            name: error.name,
            stage,
            reason,
            ...(operation ? { operation } : {}),
            ...(upstream_status !== undefined ? { upstream_status } : {}),
            ...(error_code !== undefined ? { error_code } : {}),
        }
    }

    if (error instanceof Error) {
        const errorCode = getSafeErrorCode(error)
        return {
            name: getSafeErrorName(error),
            ...(errorCode !== undefined ? { error_code: errorCode } : {}),
        }
    }

    return { name: error === null ? 'NullThrow' : 'NonErrorThrow' }
}

export class SaxoSnapshotDiagnosticError extends Error {
    readonly diagnostic: SaxoSnapshotDiagnostic

    constructor(diagnostic: SaxoSnapshotDiagnostic) {
        super(diagnostic.description)
        this.name = 'SaxoSnapshotDiagnosticError'
        this.diagnostic = diagnostic
    }
}

export const createSaxoSnapshotDiagnosticError = (
    diagnostic: Omit<SaxoSnapshotDiagnostic, 'cause_summary' | 'secondary_cause_summary'> & {
        cause?: unknown
        secondaryCause?: unknown
    },
): SaxoSnapshotDiagnosticError => {
    const { cause, secondaryCause, ...safeDiagnostic } = diagnostic
    return new SaxoSnapshotDiagnosticError({
        ...safeDiagnostic,
        ...(cause !== undefined ? { cause_summary: summarizeSaxoDiagnosticCause(cause) } : {}),
        ...(secondaryCause !== undefined
            ? { secondary_cause_summary: summarizeSaxoDiagnosticCause(secondaryCause) }
            : {}),
    })
}

export const toSaxoSnapshotDiagnosticError = (
    error: unknown,
    fallback: Omit<SaxoSnapshotDiagnostic, 'cause_summary' | 'secondary_cause_summary'>,
): SaxoSnapshotDiagnosticError => {
    if (error instanceof SaxoSnapshotDiagnosticError) return error
    return createSaxoSnapshotDiagnosticError({ ...fallback, cause: error })
}
