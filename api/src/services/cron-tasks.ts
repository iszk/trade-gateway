import { isDeepStrictEqual } from 'node:util'

import type { GetPendingOrdersV2Fn, UpdateOrderV2Fn, UpdateOrderV2AtomicallyFn, AddOrderV2Fn, GetOrderV2Fn, GetActiveIfdOrdersV2Fn } from './orders-v2.js'
import type { OrderV2, SaxoIfdocoRecoveryState } from '../types/order-v2.js'
import type { BrokerOrderMetadata } from '../types/broker-order-metadata.js'
import type {
    BulkExecutionPriceFetcherLike,
    ExecutionReconciliationFetcherLike,
    ExecutionReconciliationRange,
    ExecutionSyncInfo,
    ExecutionTerminalStatus,
    OrderExecutionSyncResult,
} from '../types/execution-sync.js'
import { classifySaxoOrderMetadata } from '../brokers/saxo-order-metadata.js'
import type { SaxoIfdocoMetadataRecoveryResult } from '../brokers/saxo-ifdoco-metadata-recovery.js'

type Logger = {
    info(obj: Record<string, unknown>, msg?: string): void
    warn(obj: Record<string, unknown>, msg?: string): void
}

type PositionFetcherLike = {
    fetchAllPositions(broker?: string): Promise<unknown[]>
}

const EPSILON = 0.00000001
const SAXO_IFDOCO_RECOVERY_MAX_ATTEMPTS = 5
const SAXO_IFDOCO_RECOVERY_MAX_ORDERS_PER_RUN = 2
const SAXO_IFDOCO_RECOVERY_BACKOFF_BASE_MS = 10 * 60 * 1000

export type ExecutionPriceFetcherLike = BulkExecutionPriceFetcherLike & {
    getExecutionPriceForOrderV2(order: OrderV2): Promise<OrderExecutionSyncResult>
    recoverIfdocoOrderMetadata?(order: OrderV2): Promise<SaxoIfdocoMetadataRecoveryResult>
}

export type ClosingExecutionFetcherLike = {
    getClosingExecutionForOrderV2(order: OrderV2): Promise<OrderExecutionSyncResult>
}

export type CronContext = {
    logger: Logger
    positionFetcher: PositionFetcherLike
    executionPriceFetchers?: Partial<Record<string, ExecutionPriceFetcherLike>>
    executionReconciliationFetchers?: Partial<Record<string, ExecutionReconciliationFetcherLike>>
    closingExecutionFetchers?: Partial<Record<string, ClosingExecutionFetcherLike>>
    /** Phase 3: orders_v2 のステータス同期用 */
    getPendingOrdersV2?: GetPendingOrdersV2Fn
    updateOrderV2?: UpdateOrderV2Fn
    updateOrderV2Atomically?: UpdateOrderV2AtomicallyFn
    addOrderV2?: AddOrderV2Fn
    getOrderV2?: GetOrderV2Fn
    getActiveIfdOrdersV2?: GetActiveIfdOrdersV2Fn
}

const resolveExecutedAt = (order: Pick<OrderV2, 'created_at' | 'executed_at'>, execution: ExecutionSyncInfo): Date => (
    execution.executed_at ?? order.executed_at ?? order.created_at
)

const areSameNumber = (
    left: number | null | undefined,
    right: number | null | undefined,
): boolean => {
    if (left === null || left === undefined || right === null || right === undefined) return left === right
    return Math.abs(left - right) < EPSILON
}

const areSameDate = (left: Date | undefined, right: Date): boolean => (
    left !== undefined && left.getTime() === right.getTime()
)

const hasSameCommission = (order: Pick<OrderV2, 'execution_costs'>, commission: number | undefined): boolean => (
    commission === undefined
        ? order.execution_costs?.commission === undefined
        : order.execution_costs?.commission !== undefined && areSameNumber(order.execution_costs.commission, commission)
)

const areSameBrokerOrderMetadata = (
    left: BrokerOrderMetadata | undefined,
    right: BrokerOrderMetadata | undefined,
): boolean => isDeepStrictEqual(left, right)

const isSameRecoveryState = (
    left: SaxoIfdocoRecoveryState | undefined,
    right: SaxoIfdocoRecoveryState | undefined,
): boolean => {
    if (left === undefined || right === undefined) return left === right
    return left.status === right.status &&
        left.attempt_count === right.attempt_count &&
        left.last_attempt_at.getTime() === right.last_attempt_at.getTime() &&
        (left.next_attempt_at?.getTime() ?? null) === (right.next_attempt_at?.getTime() ?? null) &&
        left.result_kind === right.result_kind &&
        left.reason === right.reason
}

const isCompleteRecoveredIfdocoMetadata = (order: OrderV2, metadata: BrokerOrderMetadata): boolean => {
    const classification = classifySaxoOrderMetadata({
        ...order,
        broker_order_metadata: metadata,
    })
    return classification.kind === 'VALID' &&
        classification.metadata.exits.length === 2 &&
        classification.metadata.exits.every(({ resolved }) => resolved.order_id !== null)
}

const recoverySortTime = (order: OrderV2): number => (
    order.saxo_ifdoco_recovery?.next_attempt_at?.getTime()
    ?? order.saxo_ifdoco_recovery?.last_attempt_at.getTime()
    ?? order.created_at.getTime()
)

type SaxoIfdocoRecoverySummary = {
    candidates: number
    eligible: number
    attempted: number
    recovered: number
    retries: number
    manualReviewTransitions: number
    deferred: number
    skippedConcurrentUpdates: number
    reasons: Record<string, number>
}

const incrementReason = (summary: SaxoIfdocoRecoverySummary, reason: string): void => {
    summary.reasons[reason] = (summary.reasons[reason] ?? 0) + 1
}

const getRecoveryAttemptCount = (order: OrderV2): number => (
    order.saxo_ifdoco_recovery?.attempt_count ?? 0
)

const buildFailedRecoveryState = (
    order: OrderV2,
    result: Exclude<SaxoIfdocoMetadataRecoveryResult, { kind: 'SUCCESS' }>,
    now: Date,
): SaxoIfdocoRecoveryState => {
    const attemptCount = getRecoveryAttemptCount(order) + 1
    const manualReview = !result.retryable || attemptCount >= SAXO_IFDOCO_RECOVERY_MAX_ATTEMPTS
    return {
        status: manualReview ? 'MANUAL_REVIEW' : 'RETRY_PENDING',
        attempt_count: attemptCount,
        last_attempt_at: now,
        ...(!manualReview
            ? {
                next_attempt_at: new Date(
                    now.getTime() +
                    SAXO_IFDOCO_RECOVERY_BACKOFF_BASE_MS * (2 ** (attemptCount - 1)),
                ),
            }
            : {}),
        result_kind: result.kind,
        reason: result.reason,
    }
}

const markUnrecoverableIfdocoForManualReview = async (
    order: OrderV2,
    reason: string,
    now: Date,
    updateOrderV2Atomically: UpdateOrderV2AtomicallyFn,
): Promise<boolean> => updateOrderV2Atomically(order.id, (current) => {
    if (
        current.status !== 'PENDING' ||
        current.broker !== 'saxo' ||
        current.order_type !== 'IFDOCO' ||
        current.saxo_ifdoco_recovery?.status === 'MANUAL_REVIEW'
    ) {
        return null
    }
    const classification = classifySaxoOrderMetadata(current)
    if (classification.kind !== 'UNRECOVERABLE') return null
    return {
        saxo_ifdoco_recovery: {
            status: 'MANUAL_REVIEW',
            attempt_count: getRecoveryAttemptCount(current),
            last_attempt_at: now,
            result_kind: 'UNRECOVERABLE',
            reason,
        },
    }
})

const recoverSaxoIfdocoMetadata = async (ctx: {
    logger: Logger
    pendingOrders: OrderV2[]
    fetcher?: ExecutionPriceFetcherLike
    updateOrderV2Atomically?: UpdateOrderV2AtomicallyFn
    now: Date
}): Promise<{ readyOrders: OrderV2[], synchronizedOrderIds: Set<string> }> => {
    const summary: SaxoIfdocoRecoverySummary = {
        candidates: 0,
        eligible: 0,
        attempted: 0,
        recovered: 0,
        retries: 0,
        manualReviewTransitions: 0,
        deferred: 0,
        skippedConcurrentUpdates: 0,
        reasons: {},
    }
    const readyOrders: OrderV2[] = []
    const synchronizedOrderIds = new Set<string>()
    const ifdocoOrders = ctx.pendingOrders.filter((order) => (
        order.broker === 'saxo' && order.order_type === 'IFDOCO'
    ))
    summary.candidates = ifdocoOrders.length

    if (!ctx.updateOrderV2Atomically) {
        if (summary.candidates > 0) {
            ctx.logger.warn(
                {
                    event: 'cron:saxo_ifdoco_metadata_recovery_unavailable',
                    count: summary.candidates,
                },
                'Saxo IFDOCO metadata recovery requires an atomic order updater',
            )
        }
        return { readyOrders, synchronizedOrderIds }
    }

    const eligible: OrderV2[] = []
    for (const order of ifdocoOrders) {
        const state = order.saxo_ifdoco_recovery
        if (state?.status === 'MANUAL_REVIEW') continue

        const classification = classifySaxoOrderMetadata(order)
        if (classification.kind === 'VALID') {
            readyOrders.push(order)
            continue
        }
        if (classification.kind === 'UNRECOVERABLE') {
            const reason = `CLASSIFICATION_${classification.reason}`
            const transitioned = await markUnrecoverableIfdocoForManualReview(
                order,
                reason,
                ctx.now,
                ctx.updateOrderV2Atomically,
            )
            if (transitioned) {
                summary.manualReviewTransitions += 1
                incrementReason(summary, reason)
            } else {
                summary.skippedConcurrentUpdates += 1
            }
            continue
        }
        if (state?.status === 'COMPLETED') {
            const transitioned = await ctx.updateOrderV2Atomically(order.id, (current) => {
                if (
                    current.status !== 'PENDING' ||
                    !isSameRecoveryState(current.saxo_ifdoco_recovery, state) ||
                    classifySaxoOrderMetadata(current).kind !== 'RECOVERABLE_IFDOCO'
                ) {
                    return null
                }
                return {
                    saxo_ifdoco_recovery: {
                        status: 'MANUAL_REVIEW',
                        attempt_count: getRecoveryAttemptCount(current),
                        last_attempt_at: ctx.now,
                        result_kind: 'STATE_CONFLICT',
                        reason: 'COMPLETED_WITHOUT_VALID_METADATA',
                    },
                }
            })
            if (transitioned) {
                summary.manualReviewTransitions += 1
                incrementReason(summary, 'COMPLETED_WITHOUT_VALID_METADATA')
            } else {
                summary.skippedConcurrentUpdates += 1
            }
            continue
        }
        if (state?.next_attempt_at && state.next_attempt_at.getTime() > ctx.now.getTime()) {
            summary.deferred += 1
            continue
        }
        eligible.push(order)
    }

    eligible.sort((left, right) => (
        recoverySortTime(left) - recoverySortTime(right) ||
        left.created_at.getTime() - right.created_at.getTime() ||
        left.id.localeCompare(right.id)
    ))
    summary.eligible = eligible.length
    summary.deferred += Math.max(0, eligible.length - SAXO_IFDOCO_RECOVERY_MAX_ORDERS_PER_RUN)

    for (const order of eligible.slice(0, SAXO_IFDOCO_RECOVERY_MAX_ORDERS_PER_RUN)) {
        summary.attempted += 1
        let result: SaxoIfdocoMetadataRecoveryResult
        try {
            result = ctx.fetcher?.recoverIfdocoOrderMetadata
                ? await ctx.fetcher.recoverIfdocoOrderMetadata(order)
                : {
                    kind: 'TEMPORARY_FAILURE',
                    retryable: true,
                    reason: 'HTTP_ERROR',
                }
        } catch {
            result = {
                kind: 'TEMPORARY_FAILURE',
                retryable: true,
                reason: 'HTTP_ERROR',
            }
        }

        let recoveredExecutionResult: OrderExecutionSyncResult | null = null
        if (
            result.kind === 'SUCCESS' &&
            isCompleteRecoveredIfdocoMetadata(order, result.metadata)
        ) {
            try {
                recoveredExecutionResult = ctx.fetcher
                    ? await ctx.fetcher.getExecutionPriceForOrderV2({
                        ...order,
                        broker_order_metadata: result.metadata,
                    })
                    : { execution: null }
            } catch {
                recoveredExecutionResult = { execution: null }
            }
        }

        const expectedState = order.saxo_ifdoco_recovery
        let latestReadyOrder: OrderV2 | null = null
        let transitionedToManualReview = false
        let scheduledRetry = false
        let savedRecoveredMetadata = false
        const updated = await ctx.updateOrderV2Atomically(order.id, (current) => {
            if (
                current.status !== 'PENDING' ||
                current.broker !== 'saxo' ||
                current.order_type !== 'IFDOCO' ||
                !isSameRecoveryState(current.saxo_ifdoco_recovery, expectedState)
            ) {
                return null
            }

            const currentClassification = classifySaxoOrderMetadata(current)
            if (currentClassification.kind === 'VALID') {
                latestReadyOrder = current
                return null
            }
            if (currentClassification.kind !== 'RECOVERABLE_IFDOCO') return null

            if (result.kind === 'SUCCESS') {
                if (!isCompleteRecoveredIfdocoMetadata(current, result.metadata)) {
                    transitionedToManualReview = true
                    return {
                        saxo_ifdoco_recovery: {
                            status: 'MANUAL_REVIEW',
                            attempt_count: getRecoveryAttemptCount(current) + 1,
                            last_attempt_at: ctx.now,
                            result_kind: 'INVALID_SUCCESS',
                            reason: 'INCOMPLETE_SUCCESS_METADATA',
                        },
                    }
                }
                const recoveryState: SaxoIfdocoRecoveryState = {
                    status: 'COMPLETED',
                    attempt_count: getRecoveryAttemptCount(current) + 1,
                    last_attempt_at: ctx.now,
                    result_kind: 'SUCCESS',
                }
                const confirmedResult = recoveredExecutionResult ?? { execution: null }
                const guardedResult: OrderExecutionSyncResult = (
                    confirmedResult.execution !== null &&
                    confirmedResult.execution.size > current.requested_size + EPSILON
                )
                    ? {
                        execution: null,
                        brokerOrderMetadata: result.metadata,
                        brokerOrderMetadataPolicy: 'SET_IF_UNSET',
                    }
                    : {
                        ...confirmedResult,
                        brokerOrderMetadata: result.metadata,
                        brokerOrderMetadataPolicy: 'SET_IF_UNSET',
                    }
                const executionUpdates = buildOrderExecutionSyncUpdates(current, guardedResult, ctx.logger) ?? {}
                const updates: Partial<OrderV2> = {
                    ...executionUpdates,
                    broker_order_metadata: result.metadata,
                    saxo_ifdoco_recovery: recoveryState,
                }
                savedRecoveredMetadata = true
                latestReadyOrder = { ...current, ...updates } as OrderV2
                return updates
            }

            const recoveryState = buildFailedRecoveryState(current, result, ctx.now)
            transitionedToManualReview = recoveryState.status === 'MANUAL_REVIEW'
            scheduledRetry = recoveryState.status === 'RETRY_PENDING'
            return { saxo_ifdoco_recovery: recoveryState }
        })

        const reason = result.kind === 'SUCCESS' ? 'SUCCESS' : result.reason
        if (updated && result.kind === 'SUCCESS' && savedRecoveredMetadata) {
            summary.recovered += 1
            incrementReason(summary, 'SUCCESS')
            synchronizedOrderIds.add(order.id)
        } else if (updated && transitionedToManualReview) {
            summary.manualReviewTransitions += 1
            incrementReason(
                summary,
                result.kind === 'SUCCESS' ? 'INCOMPLETE_SUCCESS_METADATA' : reason,
            )
        } else if (updated && scheduledRetry) {
            summary.retries += 1
            incrementReason(summary, reason)
        } else {
            if (latestReadyOrder) readyOrders.push(latestReadyOrder)
            summary.skippedConcurrentUpdates += 1
        }
    }

    if (
        summary.attempted > 0 ||
        summary.manualReviewTransitions > 0 ||
        summary.deferred > 0 ||
        summary.skippedConcurrentUpdates > 0
    ) {
        const details = {
            event: 'cron:saxo_ifdoco_metadata_recovery_summary',
            ...summary,
        }
        if (summary.retries > 0 || summary.manualReviewTransitions > 0) {
            ctx.logger.warn(details, 'Saxo IFDOCO metadata recovery run summarized')
        } else {
            ctx.logger.info(details, 'Saxo IFDOCO metadata recovery run summarized')
        }
    }

    return { readyOrders, synchronizedOrderIds }
}

const resolveOrderStatus = (
    currentStatus: OrderV2['status'],
    execution: ExecutionSyncInfo | null,
    terminalStatus: ExecutionTerminalStatus | undefined,
    requestedSize: number,
): OrderV2['status'] => {
    const isCompleted = execution !== null && execution.size >= requestedSize - EPSILON
    if (isCompleted) return 'EXECUTED'
    if (currentStatus !== 'PENDING') return currentStatus
    if (terminalStatus === 'CANCELED') return 'CANCELED'
    if (terminalStatus === 'FAILED' && execution === null) return 'FAILED'
    return 'PENDING'
}

const mergeDefinedValues = (current: unknown, incoming: unknown): unknown => {
    if (current === undefined || current === null) return incoming
    if (incoming === undefined || incoming === null) return current
    if (Array.isArray(current) && Array.isArray(incoming)) {
        const length = Math.max(current.length, incoming.length)
        return Array.from({ length }, (_, index) => mergeDefinedValues(current[index], incoming[index]))
    }
    if (typeof current === 'object' && typeof incoming === 'object' && !Array.isArray(current) && !Array.isArray(incoming)) {
        const currentRecord = current as Record<string, unknown>
        const incomingRecord = incoming as Record<string, unknown>
        const keys = new Set([...Object.keys(currentRecord), ...Object.keys(incomingRecord)])
        return Object.fromEntries([...keys].map((key) => [
            key,
            mergeDefinedValues(currentRecord[key], incomingRecord[key]),
        ]))
    }
    return current
}

const mergeBrokerOrderMetadata = (
    current: BrokerOrderMetadata | undefined,
    incoming: BrokerOrderMetadata | undefined,
): BrokerOrderMetadata | undefined => (
    incoming === undefined
        ? current
        : mergeDefinedValues(current, incoming) as BrokerOrderMetadata
)

export type OrderExecutionSyncApplyOutcome = {
    updated: boolean
    noOpReason?: 'OVERFILL' | 'UNCHANGED' | 'STALE' | 'METADATA_CONFLICT'
}

const buildOrderExecutionSyncUpdates = (
    current: OrderV2,
    result: OrderExecutionSyncResult,
    logger?: Logger,
): Partial<OrderV2> | null => {
    if (result.brokerOrderMetadataPolicy === 'SET_IF_UNSET') {
        const incomingMetadata = result.brokerOrderMetadata
        if (incomingMetadata === undefined) return null
        if (
            current.broker_order_metadata !== undefined &&
            !areSameBrokerOrderMetadata(current.broker_order_metadata, incomingMetadata)
        ) {
            logger?.warn(
                {
                    event: 'cron:orders_v2_metadata_recovery_conflict',
                    orderId: current.id,
                },
                'preserving concurrently written broker metadata and execution state',
            )
            return null
        }
    }

    const info = result.execution
    const updates: Partial<OrderV2> = {}
    const nextStatus = resolveOrderStatus(current.status, info, result.terminalStatus, current.requested_size)
    if (current.status !== nextStatus) updates.status = nextStatus

    const mergedMetadata = mergeBrokerOrderMetadata(current.broker_order_metadata, result.brokerOrderMetadata)
    if (!areSameBrokerOrderMetadata(current.broker_order_metadata, mergedMetadata)) {
        updates.broker_order_metadata = mergedMetadata
    }

    if (info !== null) {
        const currentExecutedSize = current.executed_size ?? 0
        const isLargerSnapshot = info.size > currentExecutedSize + EPSILON
        const isSameSnapshotSize = areSameNumber(currentExecutedSize, info.size)
        const executedAt = resolveExecutedAt(current, info)

        if (isLargerSnapshot) {
            updates.executed_size = info.size
            updates.executed_price = info.price
            updates.executed_at = executedAt
            if (info.commission !== undefined) {
                updates.execution_costs = { commission: info.commission }
            }
        } else if (isSameSnapshotSize) {
            if (current.executed_price == null) updates.executed_price = info.price
            if (current.executed_at === undefined) updates.executed_at = executedAt
            if (current.execution_costs?.commission === undefined && info.commission !== undefined) {
                updates.execution_costs = { commission: info.commission }
            }
        }

        if (
            nextStatus === 'EXECUTED' &&
            current.status !== 'EXECUTED' &&
            current.order_type === 'IFDOCO' &&
            current.exit_sync_status === undefined
        ) {
            updates.exit_sync_status = 'MONITORING'
        }
    }

    return Object.keys(updates).length === 0 ? null : updates
}

/** execution snapshot と broker の終端判定を最新注文へ冪等に適用する。 */
export const applyOrderExecutionSyncResult = async (
    order: OrderV2,
    result: OrderExecutionSyncResult,
    updateOrderV2Atomically: UpdateOrderV2AtomicallyFn,
    logger?: Logger,
): Promise<OrderExecutionSyncApplyOutcome> => {
    const info = result.execution
    if (info !== null && info.size > order.requested_size + EPSILON) {
        return { updated: false, noOpReason: 'OVERFILL' }
    }

    if (
        info !== null &&
        areSameNumber(order.executed_size, info.size) &&
        ((order.executed_price !== null && !areSameNumber(order.executed_price, info.price)) ||
            (order.executed_at !== undefined && info.executed_at !== undefined && !areSameDate(order.executed_at, info.executed_at)) ||
            (order.execution_costs?.commission !== undefined && info.commission !== undefined &&
                !areSameNumber(order.execution_costs.commission, info.commission)) ||
            (order.broker_order_metadata !== undefined && result.brokerOrderMetadata !== undefined &&
                !areSameBrokerOrderMetadata(order.broker_order_metadata, result.brokerOrderMetadata)))
    ) {
        logger?.warn(
            {
                event: 'cron:orders_v2_execution_snapshot_conflict',
                orderId: order.id,
                executionSize: info.size,
            },
            'same-size execution snapshot contains conflicting resolved fields; preserving existing values',
        )
    }

    let metadataConflict = false
    let transactionUpdates: Partial<OrderV2> | null = null
    const updated = await updateOrderV2Atomically(
        order.id,
        (current) => {
            metadataConflict = result.brokerOrderMetadataPolicy === 'SET_IF_UNSET' &&
                current.broker_order_metadata !== undefined &&
                result.brokerOrderMetadata !== undefined &&
                !areSameBrokerOrderMetadata(current.broker_order_metadata, result.brokerOrderMetadata)
            transactionUpdates = buildOrderExecutionSyncUpdates(current, result, logger)
            return transactionUpdates
        },
    )

    return updated
        ? { updated: true }
        : {
            updated: false,
            noOpReason: metadataConflict
                ? 'METADATA_CONFLICT'
                : transactionUpdates ? 'STALE' : 'UNCHANGED',
        }
}

const createLegacyAtomicUpdater = (
    order: OrderV2,
    updateOrderV2: UpdateOrderV2Fn,
): UpdateOrderV2AtomicallyFn => async (id, mutate) => {
    const updates = mutate(order)
    if (!updates || Object.keys(updates).length === 0) return false
    await updateOrderV2(id, updates)
    return true
}

export const executeTenMinutelyTask = async (ctx: CronContext): Promise<void> => {
    ctx.logger.info({ event: 'cron:ten_minutely_task' }, '10-minute task executed')
    const nowMs = Date.now()

    // saxo の oauth token リフレッシュ用
    const broker = 'saxo'
    const positions = await ctx.positionFetcher.fetchAllPositions(broker)
    ctx.logger.info({ event: 'cron:positions_fetched', broker, count: positions.length }, 'cron fetched positions')

    // Phase 3: orders_v2 のステータス同期
    if (ctx.getPendingOrdersV2 && ctx.updateOrderV2 && ctx.executionPriceFetchers) {
        await fetchAndUpdatePendingOrdersV2({
            logger: ctx.logger,
            executionPriceFetchers: ctx.executionPriceFetchers,
            getPendingOrdersV2: ctx.getPendingOrdersV2,
            updateOrderV2: ctx.updateOrderV2,
            updateOrderV2Atomically: ctx.updateOrderV2Atomically,
            nowMs,
        })
    }

    // IFD/IFDOCO 子注文の同期 (V2)
    if (ctx.getActiveIfdOrdersV2 && ctx.addOrderV2 && ctx.updateOrderV2 && ctx.getOrderV2 && ctx.closingExecutionFetchers) {
        await syncExecutionsForExecutedIfdOrders({
            logger: ctx.logger,
            getActiveIfdOrdersV2: ctx.getActiveIfdOrdersV2,
            addOrderV2: ctx.addOrderV2,
            updateOrderV2: ctx.updateOrderV2,
            getOrderV2: ctx.getOrderV2,
            closingExecutionFetchers: ctx.closingExecutionFetchers,
        })
    }
}

export const executeHourlyTask = async (ctx: CronContext): Promise<void> => {
    ctx.logger.info({ event: 'cron:hourly_task' }, 'hourly task executed')

    if (!ctx.getPendingOrdersV2 || !ctx.updateOrderV2 || !ctx.executionReconciliationFetchers) return

    const pendingOrders = await ctx.getPendingOrdersV2()
    const saxoOrders = pendingOrders.filter((order) => (
        classifySaxoOrderMetadata(order).kind === 'VALID'
    ))
    if (saxoOrders.length === 0) return

    const fetcher = ctx.executionReconciliationFetchers.saxo
    if (!fetcher) return

    const now = new Date()
    const range: ExecutionReconciliationRange = {
        from: new Date(now.getTime() - 48 * 60 * 60 * 1000),
        to: now,
    }

    try {
        const results = await fetcher.reconcileExecutionPricesForOrdersV2(saxoOrders, range)
        // Incomplete reconciliation returns no results, so partial activity is never applied.
        for (const order of saxoOrders) {
            const result = results.get(order.id)
            if (result) {
                await applyOrderExecutionSyncResult(
                    order,
                    result,
                    ctx.updateOrderV2Atomically ?? createLegacyAtomicUpdater(order, ctx.updateOrderV2),
                    ctx.logger,
                )
            }
        }
    } catch (error) {
        ctx.logger.warn(
            { event: 'cron:saxo_execution_reconciliation_failed', error },
            'failed to reconcile Saxo execution prices',
        )
    }
}

const applyPendingOrderSyncResult = async (
    ctx: {
        logger: Logger
        updateOrderV2: UpdateOrderV2Fn
        updateOrderV2Atomically?: UpdateOrderV2AtomicallyFn
    },
    order: OrderV2,
    syncResult: OrderExecutionSyncResult,
    logNotFound: boolean,
): Promise<void> => {
    const providerOrderId = order.provider_order_ids[0]
    const info = syncResult.execution
    if (info !== null && info.size > order.requested_size + EPSILON) {
        ctx.logger.warn(
            {
                event: 'cron:orders_v2_sync_invalid_size',
                orderId: order.id,
                requestedSize: order.requested_size,
                executionSize: info.size,
            },
            'execution size exceeded requested_size; skipping orders_v2 sync update',
        )
        return
    }

    const applyOutcome = await applyOrderExecutionSyncResult(
        order,
        syncResult,
        ctx.updateOrderV2Atomically ?? createLegacyAtomicUpdater(order, ctx.updateOrderV2),
        ctx.logger,
    )

    if (syncResult.brokerOrderMetadataPolicy === 'SET_IF_UNSET' && info === null && syncResult.terminalStatus === undefined) {
        ctx.logger.info(
            {
                event: 'cron:orders_v2_metadata_recovered',
                broker: order.broker,
                orderId: order.id,
                metadataOnly: true,
                updated: applyOutcome.updated,
                noOpReason: applyOutcome.noOpReason,
            },
            'orders_v2 Saxo legacy metadata recovery attempted without confirmed execution',
        )
    }

    const isCompleted = info !== null && info.size >= order.requested_size - EPSILON
    if (info !== null && (isCompleted || syncResult.terminalStatus !== 'CANCELED')) {
        ctx.logger.info(
            {
                event: 'cron:orders_v2_synced',
                broker: order.broker,
                orderId: order.id,
                price: info.price,
                size: info.size,
                updated: applyOutcome.updated,
                noOpReason: applyOutcome.noOpReason,
            },
            isCompleted
                ? 'orders_v2 execution synchronized as EXECUTED'
                : 'orders_v2 partial execution progress synchronized',
        )
    } else if (syncResult.terminalStatus !== undefined) {
        ctx.logger.info(
            {
                event: 'cron:orders_v2_terminal_status_synced',
                broker: order.broker,
                orderId: order.id,
                status: syncResult.terminalStatus,
                reason: syncResult.terminalReason,
                updated: applyOutcome.updated,
                noOpReason: applyOutcome.noOpReason,
            },
            `orders_v2 terminal status synchronized as ${syncResult.terminalStatus}`,
        )
    } else if (logNotFound) {
        ctx.logger.info(
            {
                event: 'cron:orders_v2_execution_not_found',
                broker: order.broker,
                orderId: order.id,
                provider_order_id: providerOrderId,
            },
            'orders_v2 execution not yet confirmed',
        )
    }
}

/** Phase 3: orders_v2 の PENDING を確定させる */
const fetchAndUpdatePendingOrdersV2 = async (ctx: {
    logger: Logger
    executionPriceFetchers: Partial<Record<string, ExecutionPriceFetcherLike>>
    getPendingOrdersV2: GetPendingOrdersV2Fn
    updateOrderV2: UpdateOrderV2Fn
    updateOrderV2Atomically?: UpdateOrderV2AtomicallyFn
    nowMs: number
}): Promise<void> => {
    const pendingOrders = await ctx.getPendingOrdersV2()
    ctx.logger.info(
        { event: 'cron:orders_v2_sync_start', count: pendingOrders.length },
        'syncing pending orders_v2',
    )

    const recovery = await recoverSaxoIfdocoMetadata({
        logger: ctx.logger,
        pendingOrders,
        fetcher: ctx.executionPriceFetchers.saxo,
        updateOrderV2Atomically: ctx.updateOrderV2Atomically,
        now: new Date(ctx.nowMs),
    })
    const syncableOrders = pendingOrders.filter((order) => (
        !recovery.synchronizedOrderIds.has(order.id) &&
        (
            order.broker !== 'saxo' ||
            order.order_type !== 'IFDOCO' ||
            classifySaxoOrderMetadata(order).kind === 'VALID'
        )
    ))
    const syncableOrderIds = new Set(syncableOrders.map(({ id }) => id))
    for (const order of recovery.readyOrders) {
        if (!syncableOrderIds.has(order.id)) {
            syncableOrders.push(order)
            syncableOrderIds.add(order.id)
        }
    }

    const ordersByBroker = new Map<string, OrderV2[]>()
    for (const order of syncableOrders) {
        const orders = ordersByBroker.get(order.broker) ?? []
        orders.push(order)
        ordersByBroker.set(order.broker, orders)
    }

    for (const [broker, orders] of ordersByBroker) {
        const fetcher = ctx.executionPriceFetchers[broker]
        if (!fetcher) {
            ctx.logger.info(
                { event: 'cron:execution_price_fetcher_missing', broker },
                'no execution price fetcher for broker (orders_v2)',
            )
            continue
        }

        const syncSingleOrder = async (order: OrderV2, logNotFound: boolean): Promise<void> => {
            try {
                const providerOrderId = order.provider_order_ids[0]
                if (!providerOrderId) return
                const syncResult = await fetcher.getExecutionPriceForOrderV2(order)
                await applyPendingOrderSyncResult(ctx, order, syncResult, logNotFound)
            } catch (error) {
                ctx.logger.info(
                    { event: 'cron:orders_v2_sync_failed', broker, orderId: order.id, error },
                    'failed to sync orders_v2',
                )
            }
        }

        if (fetcher.getExecutionPricesForOrdersV2) {
            try {
                const results = await fetcher.getExecutionPricesForOrdersV2(orders, { now: new Date(ctx.nowMs) })
                for (const order of orders) {
                    const result = results.get(order.id)
                    if (result) await applyPendingOrderSyncResult(ctx, order, result, false)
                }
                const missingOrders = orders.filter((order) => !results.has(order.id))
                if (missingOrders.length > 0) {
                    ctx.logger.warn(
                        {
                            event: 'cron:orders_v2_bulk_result_missing',
                            broker,
                            count: missingOrders.length,
                            orderIds: missingOrders.slice(0, 5).map((order) => order.id),
                        },
                        'bulk execution sync returned no result; falling back to single-order sync',
                    )
                    for (const order of missingOrders) await syncSingleOrder(order, false)
                }
            } catch (error) {
                ctx.logger.info(
                    { event: 'cron:orders_v2_bulk_sync_failed', broker, count: orders.length, error },
                    'failed to bulk sync orders_v2',
                )
                for (const order of orders) await syncSingleOrder(order, false)
            }
            continue
        }

        for (const order of orders) {
            await syncSingleOrder(order, true)
        }
    }
}

/** IFD/IFDOCO の子注文（決済）を同期して新しい orders_v2 レコードを作る */

const syncExecutionsForExecutedIfdOrders = async (ctx: {
    logger: Logger
    getActiveIfdOrdersV2: GetActiveIfdOrdersV2Fn
    addOrderV2: AddOrderV2Fn
    updateOrderV2: UpdateOrderV2Fn
    getOrderV2: GetOrderV2Fn
    closingExecutionFetchers: Partial<Record<string, ClosingExecutionFetcherLike>>
}): Promise<void> => {
    const activeIfdos = await ctx.getActiveIfdOrdersV2()
    ctx.logger.info({
        event: 'cron:ifd_exit_sync_start',
        ids: activeIfdos.map((o) => o.id),
    }, 'syncing exits for executed IFD/IFDOCO orders, count: ' + activeIfdos.length)

    for (const order of activeIfdos) {
        const exitId = `${order.id}-exit`

        // 既存の exit レコードを取得
        const existingExit = await ctx.getOrderV2(exitId)

        const fetcher = ctx.closingExecutionFetchers[order.broker]
        if (!fetcher) continue

        try {
            const providerOrderId = order.provider_order_ids[0]
            if (!providerOrderId) continue

            const syncResult = await fetcher.getClosingExecutionForOrderV2(order)

            const closing = syncResult.execution

            if (closing && closing.size > order.requested_size + EPSILON) {
                ctx.logger.warn(
                    {
                        event: 'cron:orders_v2_exit_sync_invalid_size',
                        orderId: order.id,
                        requestedSize: order.requested_size,
                        closingSize: closing.size,
                    },
                    'closing execution size exceeded requested_size; skipping exit sync update',
                )
                continue
            }

            if (
                syncResult.brokerOrderMetadata !== undefined &&
                !areSameBrokerOrderMetadata(order.broker_order_metadata, syncResult.brokerOrderMetadata)
            ) {
                await ctx.updateOrderV2(order.id, {
                    broker_order_metadata: syncResult.brokerOrderMetadata,
                })
            }

            if (!closing) continue

            const isExitCompleted = closing.size >= order.requested_size - EPSILON
            const executedAt = closing.executed_at ?? existingExit?.executed_at ?? resolveExecutedAt(order, closing)

            const isSameSnapshot = existingExit !== null &&
                areSameNumber(existingExit.executed_size, closing.size) &&
                areSameNumber(existingExit.executed_price, closing.price) &&
                areSameDate(existingExit.executed_at, executedAt) &&
                hasSameCommission(existingExit, closing.commission)

            if (isSameSnapshot) {
                if (isExitCompleted && order.exit_sync_status !== 'COMPLETED') {
                    await ctx.updateOrderV2(order.id, { exit_sync_status: 'COMPLETED' })
                }
                continue
            }

            if (!existingExit) {
                // 新規作成
                await ctx.addOrderV2({
                    id: exitId,
                    strategy: order.strategy,
                    broker: order.broker,
                    ticker: order.ticker,
                    side: order.side === 'BUY' ? 'SELL' : 'BUY',
                    order_type: 'MARKET',
                    requested_size: order.requested_size,
                    executed_size: closing.size,
                    executed_price: closing.price,
                    executed_at: executedAt,
                    status: 'EXECUTED',
                    provider_order_ids: [providerOrderId + ':closing'],
                    created_at: new Date(),
                    updated_at: new Date(),
                    ...(closing.commission !== undefined
                        ? { execution_costs: { commission: closing.commission } }
                        : {}),
                })
                if (isExitCompleted) {
                    await ctx.updateOrderV2(order.id, { exit_sync_status: 'COMPLETED' })
                }
                ctx.logger.info(
                    { event: 'cron:orders_v2_exit_recorded', originalId: order.id, price: closing.price, size: closing.size },
                    'orders_v2 exit recorded (initial)',
                )
            } else {
                // 更新（部分約定の進展）
                const updates: Partial<OrderV2> = {
                    executed_size: closing.size,
                    executed_price: closing.price,
                    executed_at: executedAt,
                }
                if (!hasSameCommission(existingExit, closing.commission)) {
                    updates.execution_costs = closing.commission === undefined
                        ? {}
                        : { commission: closing.commission }
                }
                if (Object.keys(updates).length > 0) {
                    await ctx.updateOrderV2(exitId, updates)
                }
                if (isExitCompleted) {
                    await ctx.updateOrderV2(order.id, { exit_sync_status: 'COMPLETED' })
                }
                ctx.logger.info(
                    { event: 'cron:orders_v2_exit_updated', originalId: order.id, price: closing.price, size: closing.size },
                    'orders_v2 exit updated (partial fill progress)',
                )
            }
        } catch (error) {
            ctx.logger.warn({ event: 'cron:orders_v2_exit_sync_failed', orderId: order.id, error }, 'failed to sync exit execution')
        }
    }
}
