import type { SaxoOrderMetadata } from '../types/broker-order-metadata.js'
import type { OrderV2 } from '../types/order-v2.js'

export type SaxoMetadataClassification =
    | { kind: 'VALID', metadata: SaxoOrderMetadata }
    | { kind: 'RECOVERABLE_MARKET', metadata: SaxoOrderMetadata }
    | { kind: 'RECOVERABLE_IFDOCO', candidate: SaxoIfdocoMetadataRecoveryCandidate }
    | {
        kind: 'UNRECOVERABLE'
        reason:
            | 'BROKER_MISMATCH'
            | 'ORDER_TYPE_UNSUPPORTED'
            | 'PROVIDER_ORDER_ID_MISSING'
            | 'DRY_RUN'
            | 'TICKER_INVALID'
            | 'METADATA_KIND_CONFLICT'
            | 'METADATA_INVALID'
            | 'METADATA_CONFLICT'
    }

type SaxoOrderMetadataOrder = Pick<
    OrderV2,
    'broker' | 'ticker' | 'order_type' | 'side' | 'requested_size' | 'provider_order_ids' | 'broker_order_metadata'
>

export type SaxoIfdocoMetadataRecoveryCandidate = {
    entryOrderId: string
    side: 'BUY' | 'SELL'
    size: number
    assetType: string
    uic: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isNonEmptyString = (value: unknown): value is string => (
    typeof value === 'string' && value.trim().length > 0
)

const normalizeProviderOrderId = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    const normalized = value.trim()
    return normalized.length > 0 ? normalized : null
}

const isPositiveFiniteNumber = (value: unknown): value is number => (
    typeof value === 'number' && Number.isFinite(value) && value > 0
)

const isOrderSide = (value: unknown): value is 'BUY' | 'SELL' => value === 'BUY' || value === 'SELL'

const isOptionalExternalReference = (value: unknown): boolean => (
    value === undefined || isNonEmptyString(value)
)

const areSameNumber = (left: number, right: number): boolean => Math.abs(left - right) < 0.00000001

const parseSaxoTicker = (ticker: string): Pick<SaxoIfdocoMetadataRecoveryCandidate, 'assetType' | 'uic'> | null => {
    const match = ticker.trim().match(/^([^:\s]+):(\d+)$/)
    if (!match?.[1] || !match[2]) return null
    const uic = Number(match[2])
    if (!Number.isSafeInteger(uic) || uic <= 0) return null
    return { assetType: match[1], uic }
}

type SaxoOrderMetadataKind = Pick<SaxoOrderMetadata, 'kind'>

const isSaxoOrderMetadataKind = (value: unknown): value is SaxoOrderMetadataKind => (
    isRecord(value) && value.kind === 'saxo_order_v1'
)

const isValidSaxoMetadataShape = (value: unknown): value is SaxoOrderMetadata => {
    if (!isSaxoOrderMetadataKind(value) || !isRecord(value)) return false
    const metadata = value as Record<string, unknown>
    if (!isNonEmptyString(metadata.order_id) || !isOptionalExternalReference(metadata.external_reference)) return false
    const entry = metadata.entry
    if (!isRecord(entry) || !isRecord(entry.expected) || !isRecord(entry.resolved)) return false

    const expected = entry.expected
    const resolved = entry.resolved
    if (!isOrderSide(expected.side) || expected.order_type !== 'Market' || !isPositiveFiniteNumber(expected.size)) {
        return false
    }
    if (!isNonEmptyString(resolved.order_id) || !isOptionalExternalReference(resolved.external_reference)) return false
    if (!Array.isArray(metadata.exits)) return false

    for (const exit of metadata.exits) {
        if (!isRecord(exit) || !isRecord(exit.expected) || !isRecord(exit.resolved)) return false
        const expectedExit = exit.expected
        const resolvedExit = exit.resolved
        if (
            (expectedExit.role !== 'TAKE_PROFIT' && expectedExit.role !== 'STOP_LOSS') ||
            !isOrderSide(expectedExit.side) ||
            (expectedExit.order_type !== 'Limit' && expectedExit.order_type !== 'StopIfTraded') ||
            !isPositiveFiniteNumber(expectedExit.size) ||
            typeof expectedExit.price !== 'number' || !Number.isFinite(expectedExit.price) ||
            !(resolvedExit.order_id === null || isNonEmptyString(resolvedExit.order_id))
            || !isOptionalExternalReference(resolvedExit.external_reference)
        ) {
            return false
        }
    }

    return true
}

const hasValidOrderFields = (order: SaxoOrderMetadataOrder): boolean => (
    isOrderSide(order.side) && isPositiveFiniteNumber(order.requested_size)
)

const classifyExistingMetadata = (
    order: SaxoOrderMetadataOrder,
    providerOrderId: string,
): SaxoMetadataClassification => {
    const metadata = order.broker_order_metadata
    if (!isValidSaxoMetadataShape(metadata)) {
        return { kind: 'UNRECOVERABLE', reason: 'METADATA_INVALID' }
    }

    if (
        metadata.order_id !== providerOrderId ||
        metadata.entry.resolved.order_id !== providerOrderId ||
        metadata.entry.expected.side !== order.side ||
        !areSameNumber(metadata.entry.expected.size, order.requested_size) ||
        (metadata.external_reference !== undefined &&
            metadata.entry.resolved.external_reference !== undefined &&
            metadata.external_reference !== metadata.entry.resolved.external_reference) ||
        metadata.exits.some((exit) => (
            metadata.external_reference !== undefined &&
            exit.resolved.external_reference !== undefined &&
            metadata.external_reference !== exit.resolved.external_reference
        )) ||
        (order.order_type === 'MARKET' && metadata.exits.length > 0) ||
        (order.order_type !== 'MARKET' && metadata.exits.length === 0)
    ) {
        return { kind: 'UNRECOVERABLE', reason: 'METADATA_CONFLICT' }
    }

    return { kind: 'VALID', metadata }
}

/**
 * Saxo orders_v2 の metadata を runtime validation し、同期可否を分類する。
 * 欠落 metadata の自動補完は、単体 MARKET に限定する。
 */
export const classifySaxoOrderMetadata = (order: SaxoOrderMetadataOrder): SaxoMetadataClassification => {
    if (order.broker !== 'saxo') return { kind: 'UNRECOVERABLE', reason: 'BROKER_MISMATCH' }

    const providerOrderId = normalizeProviderOrderId(order.provider_order_ids[0])
    if (providerOrderId === null) {
        return { kind: 'UNRECOVERABLE', reason: 'PROVIDER_ORDER_ID_MISSING' }
    }
    if (providerOrderId === 'DRY_RUN') return { kind: 'UNRECOVERABLE', reason: 'DRY_RUN' }

    const metadata = order.broker_order_metadata as unknown
    if (metadata !== undefined && metadata !== null) {
        if (!isRecord(metadata) || metadata.kind !== 'saxo_order_v1') {
            return { kind: 'UNRECOVERABLE', reason: 'METADATA_KIND_CONFLICT' }
        }
        if (!hasValidOrderFields(order)) return { kind: 'UNRECOVERABLE', reason: 'METADATA_INVALID' }
        return classifyExistingMetadata(order, providerOrderId)
    }

    if (order.order_type !== 'MARKET' && order.order_type !== 'IFDOCO') {
        return { kind: 'UNRECOVERABLE', reason: 'ORDER_TYPE_UNSUPPORTED' }
    }
    if (!hasValidOrderFields(order)) {
        return { kind: 'UNRECOVERABLE', reason: 'METADATA_INVALID' }
    }

    if (order.order_type === 'IFDOCO') {
        const instrument = parseSaxoTicker(order.ticker)
        if (!instrument) return { kind: 'UNRECOVERABLE', reason: 'TICKER_INVALID' }
        return {
            kind: 'RECOVERABLE_IFDOCO',
            candidate: {
                entryOrderId: providerOrderId,
                side: order.side,
                size: order.requested_size,
                ...instrument,
            },
        }
    }

    return {
        kind: 'RECOVERABLE_MARKET',
        metadata: buildSaxoLegacyMarketMetadata(order, providerOrderId),
    }
}

/** 根拠のない external_reference を生成せず、legacy MARKET 用の最小 metadata を作る。 */
export const buildSaxoLegacyMarketMetadata = (
    order: Pick<OrderV2, 'side' | 'requested_size'>,
    providerOrderId: string,
): SaxoOrderMetadata => ({
    kind: 'saxo_order_v1',
    order_id: providerOrderId,
    entry: {
        expected: {
            side: order.side,
            order_type: 'Market',
            size: order.requested_size,
        },
        resolved: { order_id: providerOrderId },
    },
    exits: [],
})
