/**
 * Strategy identity compatibility rules shared by webhook, migration, and
 * execution reconciliation.
 *
 * `orders_v2.strategy` remains the legacy display value.  A policy/reservation
 * must instead use the canonical ID returned by this module.  Legacy values
 * are intentionally normalized only by trimming and replacing consecutive
 * whitespace; no fuzzy mapping or case conversion is performed.
 */

export const STRATEGY_ID_PATTERN = /^[A-Za-z0-9_-]+$/

export type StrategyIdResolutionReason =
    | 'VALID'
    | 'MISSING'
    | 'BLANK'
    | 'LITERAL_UNKNOWN'
    | 'INVALID'

export type StrategyIdResolution = {
    effectiveStrategyId?: string
    reason: StrategyIdResolutionReason
    source?: 'EXPLICIT' | 'EFFECTIVE' | 'LEGACY'
}

export type ResolveEffectiveStrategyIdInput = {
    /** A persisted effective ID, when one is already available. */
    effectiveStrategyId?: unknown
    /** A webhook/persisted explicit strategy_id. */
    explicitStrategyId?: unknown
    /** The legacy display strategy. */
    legacyStrategy?: unknown
}

const isValidCanonicalStrategyId = (value: unknown): value is string => (
    typeof value === 'string' &&
    value.length > 0 &&
    value === value.trim() &&
    STRATEGY_ID_PATTERN.test(value)
)

/** Normalize a legacy display value using the webhook compatibility rule. */
export const normalizeLegacyStrategyId = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined
    const trimmed = value.trim()
    if (trimmed.length === 0) return ''
    return trimmed.replace(/\s+/g, '_')
}

/** Resolve a legacy display strategy without silently mapping invalid values. */
export const resolveLegacyStrategyId = (value: unknown): StrategyIdResolution => {
    if (value === undefined) return { reason: 'MISSING' }
    if (typeof value !== 'string') return { reason: 'INVALID' }

    const normalized = normalizeLegacyStrategyId(value)
    if (normalized === '') return { reason: 'BLANK' }
    if (normalized === undefined || !isValidCanonicalStrategyId(normalized)) {
        return { reason: 'INVALID' }
    }
    if (normalized === 'unknown') return { reason: 'LITERAL_UNKNOWN' }
    return {
        effectiveStrategyId: normalized,
        reason: 'VALID',
        source: 'LEGACY',
    }
}

const resolveExplicitStrategyId = (
    value: unknown,
    source: 'EXPLICIT' | 'EFFECTIVE',
): StrategyIdResolution => {
    if (value === undefined) return { reason: 'MISSING' }
    if (typeof value !== 'string') return { reason: 'INVALID' }
    if (value.length === 0) return { reason: 'BLANK' }
    if (!isValidCanonicalStrategyId(value)) return { reason: 'INVALID' }
    if (value === 'unknown') return { reason: 'LITERAL_UNKNOWN' }
    return {
        effectiveStrategyId: value,
        reason: 'VALID',
        source,
    }
}

/**
 * Resolve the identity used by policies and reservations.
 *
 * The object form is the preferred API.  The positional overload is kept for
 * small callers/tests that only have a legacy value and optional explicit ID.
 */
export function resolveEffectiveStrategyId(
    input: ResolveEffectiveStrategyIdInput,
): StrategyIdResolution
export function resolveEffectiveStrategyId(
    legacyStrategy: unknown,
    explicitStrategyId?: unknown,
): StrategyIdResolution
export function resolveEffectiveStrategyId(
    inputOrLegacy: ResolveEffectiveStrategyIdInput | unknown,
    positionalExplicitStrategyId?: unknown,
): StrategyIdResolution {
    const input: ResolveEffectiveStrategyIdInput = (
        typeof inputOrLegacy === 'object' &&
        inputOrLegacy !== null &&
        !Array.isArray(inputOrLegacy) &&
        ('legacyStrategy' in inputOrLegacy ||
            'explicitStrategyId' in inputOrLegacy ||
            'effectiveStrategyId' in inputOrLegacy)
    )
        ? inputOrLegacy as ResolveEffectiveStrategyIdInput
        : {
            legacyStrategy: inputOrLegacy,
            explicitStrategyId: positionalExplicitStrategyId,
        }

    if (input.effectiveStrategyId !== undefined) {
        return resolveExplicitStrategyId(input.effectiveStrategyId, 'EFFECTIVE')
    }
    if (input.explicitStrategyId !== undefined) {
        return resolveExplicitStrategyId(input.explicitStrategyId, 'EXPLICIT')
    }
    return resolveLegacyStrategyId(input.legacyStrategy)
}

/** Validate an already canonical strategy ID without applying legacy rules. */
export const isCanonicalStrategyId = isValidCanonicalStrategyId
