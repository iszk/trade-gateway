import type { SaxoOrderMetadata } from '../types/broker-order-metadata.js'
import type { SaxoIfdocoMetadataRecoveryCandidate } from './saxo-order-metadata.js'
import type { SaxoOrderActivity } from './saxo-order-activities.js'

const EPSILON = 0.00000001

type SaxoRelatedOpenOrderEvidence = {
    OrderId: string
    Amount: number
    OpenOrderType: string
    OrderPrice: number
}

export type SaxoOpenOrderEvidence = {
    OrderId: string
    BuySell: string
    Amount: number
    AssetType: string
    Uic: number
    OpenOrderType: string
    Price?: number
    ExternalReference?: string
    RelatedOpenOrders: SaxoRelatedOpenOrderEvidence[]
}

export type SaxoIfdocoRecoveryEvidence = {
    entryActivities: SaxoOrderActivity[]
    exitActivities: Record<string, SaxoOrderActivity[] | undefined>
    openOrders: SaxoOpenOrderEvidence[]
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
)

const isNonEmptyString = (value: unknown): value is string => (
    typeof value === 'string' && value.trim().length > 0
)

const isFiniteNumber = (value: unknown): value is number => (
    typeof value === 'number' && Number.isFinite(value)
)

const isRelatedOpenOrderEvidence = (value: unknown): value is SaxoRelatedOpenOrderEvidence => (
    isRecord(value) &&
    isNonEmptyString(value.OrderId) &&
    isFiniteNumber(value.Amount) &&
    value.Amount > 0 &&
    isNonEmptyString(value.OpenOrderType) &&
    isFiniteNumber(value.OrderPrice)
)

export const parseSaxoOpenOrderEvidence = (value: unknown): SaxoOpenOrderEvidence | null => {
    if (!isRecord(value)) return null
    if (
        !isNonEmptyString(value.OrderId) ||
        !isNonEmptyString(value.BuySell) ||
        !isFiniteNumber(value.Amount) ||
        value.Amount <= 0 ||
        !isNonEmptyString(value.AssetType) ||
        !isFiniteNumber(value.Uic) ||
        !isNonEmptyString(value.OpenOrderType) ||
        !(value.Price === undefined || isFiniteNumber(value.Price)) ||
        !(value.ExternalReference === undefined || isNonEmptyString(value.ExternalReference)) ||
        !Array.isArray(value.RelatedOpenOrders) ||
        !value.RelatedOpenOrders.every(isRelatedOpenOrderEvidence)
    ) {
        return null
    }
    return value as SaxoOpenOrderEvidence
}

export type SaxoIfdocoTemporaryFailureReason =
    | 'RATE_LIMITED'
    | 'AUTH_UNAVAILABLE'
    | 'NETWORK_ERROR'
    | 'HTTP_ERROR'
    | 'OPEN_ORDER_NOT_FOUND'
    | 'PARSE_ERROR'
    | 'PAGE_LIMIT'
    | 'REQUEST_BUDGET_EXHAUSTED'

export type SaxoIfdocoMetadataRecoveryResult =
    | { kind: 'SUCCESS', retryable: false, metadata: SaxoOrderMetadata }
    | {
        kind: 'TEMPORARY_FAILURE'
        retryable: true
        reason: SaxoIfdocoTemporaryFailureReason
    }
    | {
        kind: 'INSUFFICIENT_HISTORY'
        retryable: true
        reason:
            | 'ENTRY_HISTORY_MISSING'
            | 'RELATED_ORDER_IDS_MISSING'
            | 'EXIT_HISTORY_MISSING'
            | 'ORDER_FIELDS_MISSING'
    }
    | {
        kind: 'CONFLICT'
        retryable: false
        reason:
            | 'ENTRY_MISMATCH'
            | 'RELATED_ORDER_SET_MISMATCH'
            | 'EXIT_FIELDS_MISMATCH'
            | 'OPEN_ORDER_MISMATCH'
            | 'EXTERNAL_REFERENCE_MISMATCH'
    }
    | {
        kind: 'MANUAL_REVIEW'
        retryable: false
        reason:
            | 'AMBIGUOUS_RELATED_ORDERS'
            | 'AMBIGUOUS_EXIT_ROLE'
            | 'UNSUPPORTED_ORDER_SHAPE'
    }

type NormalizedOrderEvidence = {
    orderId: string
    side: string
    size: number
    assetType: string
    uic: number
    orderType: string
    price?: number
    relatedOrderIds: string[]
    externalReference?: string
}

type NormalizationResult =
    | { kind: 'OK', evidence: NormalizedOrderEvidence }
    | { kind: 'MISSING' }
    | { kind: 'FIELDS_MISSING' }
    | { kind: 'FIELDS_CONFLICT' }
    | { kind: 'RELATED_CONFLICT' }
    | { kind: 'EXTERNAL_REFERENCE_CONFLICT' }

const areSameNumber = (left: number, right: number): boolean => Math.abs(left - right) < EPSILON

const collectUnique = <T>(
    activities: SaxoOrderActivity[],
    select: (activity: SaxoOrderActivity) => T | undefined,
    equal: (left: T, right: T) => boolean = Object.is,
): { kind: 'MISSING' } | { kind: 'CONFLICT' } | { kind: 'OK', value: T } => {
    const values = activities.flatMap((activity) => {
        const value = select(activity)
        return value === undefined ? [] : [value]
    })
    if (values.length === 0) return { kind: 'MISSING' }
    const first = values[0] as T
    return values.every((value) => equal(first, value))
        ? { kind: 'OK', value: first }
        : { kind: 'CONFLICT' }
}

const areSameStringArray = (left: string[], right: string[]): boolean => (
    left.length === right.length && left.every((value, index) => value === right[index])
)

const normalizeOrderHistory = (
    expectedOrderId: string,
    activities: SaxoOrderActivity[],
    requirePrice: boolean,
): NormalizationResult => {
    if (activities.length === 0) return { kind: 'MISSING' }
    if (activities.some(({ OrderId }) => OrderId !== expectedOrderId)) return { kind: 'FIELDS_CONFLICT' }

    const side = collectUnique(activities, ({ BuySell }) => BuySell)
    const size = collectUnique(activities, ({ Amount }) => Amount, areSameNumber)
    const assetType = collectUnique(activities, ({ AssetType }) => AssetType)
    const uic = collectUnique(activities, ({ Uic }) => Uic, areSameNumber)
    const orderType = collectUnique(activities, ({ OrderType }) => OrderType)
    const price = collectUnique(activities, ({ Price }) => Price, areSameNumber)
    const relatedOrderIds = collectUnique(
        activities,
        ({ RelatedOrders }) => RelatedOrders && RelatedOrders.length > 0
            ? RelatedOrders.map((orderId) => orderId.trim()).sort()
            : undefined,
        areSameStringArray,
    )
    const externalReference = collectUnique(
        activities,
        ({ ExternalReference }) => ExternalReference?.trim() || undefined,
    )

    if (
        side.kind === 'CONFLICT' ||
        size.kind === 'CONFLICT' ||
        assetType.kind === 'CONFLICT' ||
        uic.kind === 'CONFLICT' ||
        orderType.kind === 'CONFLICT' ||
        price.kind === 'CONFLICT'
    ) {
        return { kind: 'FIELDS_CONFLICT' }
    }
    if (relatedOrderIds.kind === 'CONFLICT') return { kind: 'RELATED_CONFLICT' }
    if (externalReference.kind === 'CONFLICT') return { kind: 'EXTERNAL_REFERENCE_CONFLICT' }
    if (
        side.kind === 'MISSING' ||
        size.kind === 'MISSING' ||
        assetType.kind === 'MISSING' ||
        uic.kind === 'MISSING' ||
        orderType.kind === 'MISSING' ||
        relatedOrderIds.kind === 'MISSING' ||
        (requirePrice && price.kind === 'MISSING')
    ) {
        return { kind: 'FIELDS_MISSING' }
    }

    return {
        kind: 'OK',
        evidence: {
            orderId: expectedOrderId,
            side: side.value,
            size: size.value,
            assetType: assetType.value,
            uic: uic.value,
            orderType: orderType.value,
            ...(price.kind === 'OK' ? { price: price.value } : {}),
            relatedOrderIds: relatedOrderIds.value,
            ...(externalReference.kind === 'OK' ? { externalReference: externalReference.value } : {}),
        },
    }
}

const sameOrderIdSet = (left: string[], right: string[]): boolean => (
    left.length === right.length &&
    left.slice().sort().every((value, index) => value === right.slice().sort()[index])
)

const toExpectedSide = (side: SaxoIfdocoMetadataRecoveryCandidate['side']): 'Buy' | 'Sell' => (
    side === 'BUY' ? 'Buy' : 'Sell'
)

const toClosingSide = (side: SaxoIfdocoMetadataRecoveryCandidate['side']): 'Buy' | 'Sell' => (
    side === 'BUY' ? 'Sell' : 'Buy'
)

const matchesCandidateInstrument = (
    evidence: NormalizedOrderEvidence,
    candidate: SaxoIfdocoMetadataRecoveryCandidate,
): boolean => (
    evidence.assetType === candidate.assetType &&
    evidence.uic === candidate.uic
)

const getOpenOrderMap = (
    openOrders: SaxoOpenOrderEvidence[],
): Map<string, SaxoOpenOrderEvidence> | null => {
    const map = new Map<string, SaxoOpenOrderEvidence>()
    for (const order of openOrders) {
        if (map.has(order.OrderId)) return null
        map.set(order.OrderId, order)
    }
    return map
}

const matchesOpenOrder = (
    openOrder: SaxoOpenOrderEvidence,
    history: NormalizedOrderEvidence,
    graphOrderIds: Set<string>,
    histories: Map<string, NormalizedOrderEvidence>,
): boolean => {
    if (
        openOrder.OrderId !== history.orderId ||
        openOrder.BuySell !== history.side ||
        !areSameNumber(openOrder.Amount, history.size) ||
        openOrder.AssetType !== history.assetType ||
        openOrder.Uic !== history.uic ||
        openOrder.OpenOrderType !== history.orderType ||
        (history.price !== undefined &&
            (openOrder.Price === undefined || !areSameNumber(openOrder.Price, history.price))) ||
        (openOrder.ExternalReference !== undefined &&
            history.externalReference !== undefined &&
            openOrder.ExternalReference.trim() !== history.externalReference)
    ) {
        return false
    }

    for (const related of openOrder.RelatedOpenOrders) {
        if (!graphOrderIds.has(related.OrderId) || related.OrderId === openOrder.OrderId) return false
        const relatedHistory = histories.get(related.OrderId)
        if (!relatedHistory) continue
        if (
            !areSameNumber(related.Amount, relatedHistory.size) ||
            related.OpenOrderType !== relatedHistory.orderType ||
            relatedHistory.price === undefined ||
            !areSameNumber(related.OrderPrice, relatedHistory.price)
        ) {
            return false
        }
    }
    return true
}

const getExternalReferenceResult = (
    histories: NormalizedOrderEvidence[],
    openOrders: SaxoOpenOrderEvidence[],
): { kind: 'OK', value?: string } | { kind: 'CONFLICT' } => {
    const references = [
        ...histories.flatMap(({ externalReference }) => externalReference ? [externalReference] : []),
        ...openOrders.flatMap(({ ExternalReference }) => ExternalReference?.trim() ? [ExternalReference.trim()] : []),
    ]
    if (references.length === 0) return { kind: 'OK' }
    const first = references[0] as string
    return references.every((value) => value === first)
        ? { kind: 'OK', value: first }
        : { kind: 'CONFLICT' }
}

export const recoverSaxoIfdocoMetadataFromEvidence = (
    candidate: SaxoIfdocoMetadataRecoveryCandidate,
    rawEvidence: SaxoIfdocoRecoveryEvidence,
): SaxoIfdocoMetadataRecoveryResult => {
    const entryResult = normalizeOrderHistory(candidate.entryOrderId, rawEvidence.entryActivities, false)
    if (entryResult.kind === 'MISSING') {
        return { kind: 'INSUFFICIENT_HISTORY', retryable: true, reason: 'ENTRY_HISTORY_MISSING' }
    }
    if (entryResult.kind === 'FIELDS_MISSING') {
        const hasRelatedOrderIds = rawEvidence.entryActivities.some(
            ({ RelatedOrders }) => RelatedOrders !== undefined && RelatedOrders.length > 0,
        )
        return {
            kind: 'INSUFFICIENT_HISTORY',
            retryable: true,
            reason: hasRelatedOrderIds ? 'ORDER_FIELDS_MISSING' : 'RELATED_ORDER_IDS_MISSING',
        }
    }
    if (entryResult.kind === 'RELATED_CONFLICT') {
        return { kind: 'CONFLICT', retryable: false, reason: 'RELATED_ORDER_SET_MISMATCH' }
    }
    if (entryResult.kind === 'EXTERNAL_REFERENCE_CONFLICT') {
        return { kind: 'CONFLICT', retryable: false, reason: 'EXTERNAL_REFERENCE_MISMATCH' }
    }
    if (entryResult.kind === 'FIELDS_CONFLICT') {
        return { kind: 'CONFLICT', retryable: false, reason: 'ENTRY_MISMATCH' }
    }

    const entry = entryResult.evidence
    if (
        entry.orderType !== 'Market' ||
        entry.side !== toExpectedSide(candidate.side) ||
        !areSameNumber(entry.size, candidate.size) ||
        !matchesCandidateInstrument(entry, candidate)
    ) {
        return { kind: 'CONFLICT', retryable: false, reason: 'ENTRY_MISMATCH' }
    }

    const relatedOrderIds = entry.relatedOrderIds
    if (relatedOrderIds.length !== 2 || new Set(relatedOrderIds).size !== 2) {
        return { kind: 'MANUAL_REVIEW', retryable: false, reason: 'AMBIGUOUS_RELATED_ORDERS' }
    }

    const exits: NormalizedOrderEvidence[] = []
    for (const exitOrderId of relatedOrderIds) {
        const activities = rawEvidence.exitActivities[exitOrderId]
        if (!activities || activities.length === 0) {
            return { kind: 'INSUFFICIENT_HISTORY', retryable: true, reason: 'EXIT_HISTORY_MISSING' }
        }
        const exitResult = normalizeOrderHistory(exitOrderId, activities, true)
        if (exitResult.kind === 'MISSING') {
            return { kind: 'INSUFFICIENT_HISTORY', retryable: true, reason: 'EXIT_HISTORY_MISSING' }
        }
        if (exitResult.kind === 'FIELDS_MISSING') {
            return { kind: 'INSUFFICIENT_HISTORY', retryable: true, reason: 'ORDER_FIELDS_MISSING' }
        }
        if (exitResult.kind === 'RELATED_CONFLICT') {
            return { kind: 'CONFLICT', retryable: false, reason: 'RELATED_ORDER_SET_MISMATCH' }
        }
        if (exitResult.kind === 'EXTERNAL_REFERENCE_CONFLICT') {
            return { kind: 'CONFLICT', retryable: false, reason: 'EXTERNAL_REFERENCE_MISMATCH' }
        }
        if (exitResult.kind === 'FIELDS_CONFLICT') {
            return { kind: 'CONFLICT', retryable: false, reason: 'EXIT_FIELDS_MISMATCH' }
        }
        exits.push(exitResult.evidence)
    }

    const closingSide = toClosingSide(candidate.side)
    if (exits.some((exit) => (
        exit.side !== closingSide ||
        !areSameNumber(exit.size, candidate.size) ||
        !matchesCandidateInstrument(exit, candidate) ||
        exit.price === undefined ||
        !Number.isFinite(exit.price) ||
        exit.price <= 0
    ))) {
        return { kind: 'CONFLICT', retryable: false, reason: 'EXIT_FIELDS_MISMATCH' }
    }

    const expectedGraph = new Set([candidate.entryOrderId, ...relatedOrderIds])
    for (const [index, exit] of exits.entries()) {
        const otherExit = exits[index === 0 ? 1 : 0]
        if (!otherExit || !sameOrderIdSet(exit.relatedOrderIds, [candidate.entryOrderId, otherExit.orderId])) {
            return { kind: 'CONFLICT', retryable: false, reason: 'RELATED_ORDER_SET_MISMATCH' }
        }
    }

    const stopOrders = exits.filter(({ orderType }) => orderType === 'StopIfTraded')
    const limitOrders = exits.filter(({ orderType }) => orderType === 'Limit')
    if (stopOrders.length + limitOrders.length !== exits.length) {
        return { kind: 'MANUAL_REVIEW', retryable: false, reason: 'UNSUPPORTED_ORDER_SHAPE' }
    }
    if (stopOrders.length !== 1 || limitOrders.length !== 1) {
        return { kind: 'MANUAL_REVIEW', retryable: false, reason: 'AMBIGUOUS_EXIT_ROLE' }
    }

    const externalReference = getExternalReferenceResult([entry, ...exits], rawEvidence.openOrders)
    if (externalReference.kind === 'CONFLICT') {
        return { kind: 'CONFLICT', retryable: false, reason: 'EXTERNAL_REFERENCE_MISMATCH' }
    }

    const histories = new Map(
        [entry, ...exits].map((history) => [history.orderId, history]),
    )
    const openOrderMap = getOpenOrderMap(rawEvidence.openOrders)
    if (
        openOrderMap === null ||
        [...openOrderMap.values()].some((openOrder) => {
            const history = histories.get(openOrder.OrderId)
            return !history || !matchesOpenOrder(openOrder, history, expectedGraph, histories)
        })
    ) {
        return { kind: 'CONFLICT', retryable: false, reason: 'OPEN_ORDER_MISMATCH' }
    }

    const orderedExits = [stopOrders[0] as NormalizedOrderEvidence, limitOrders[0] as NormalizedOrderEvidence]

    return {
        kind: 'SUCCESS',
        retryable: false,
        metadata: {
            kind: 'saxo_order_v1',
            order_id: entry.orderId,
            ...(externalReference.value ? { external_reference: externalReference.value } : {}),
            entry: {
                expected: {
                    side: candidate.side,
                    order_type: 'Market',
                    size: candidate.size,
                },
                resolved: {
                    order_id: entry.orderId,
                    ...(entry.externalReference ? { external_reference: entry.externalReference } : {}),
                },
            },
            exits: orderedExits.map((exit) => ({
                expected: {
                    role: exit.orderType === 'Limit' ? 'TAKE_PROFIT' : 'STOP_LOSS',
                    side: candidate.side === 'BUY' ? 'SELL' : 'BUY',
                    order_type: exit.orderType as 'Limit' | 'StopIfTraded',
                    size: exit.size,
                    price: exit.price as number,
                },
                resolved: {
                    order_id: exit.orderId,
                    ...(exit.externalReference ? { external_reference: exit.externalReference } : {}),
                },
            })),
        },
    }
}
