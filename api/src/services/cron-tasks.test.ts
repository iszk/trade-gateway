import assert from 'node:assert/strict'
import test from 'node:test'

import { applyOrderExecutionSyncResult, executeHourlyTask, executeTenMinutelyTask } from './cron-tasks.js'
import type { CronContext } from './cron-tasks.js'

const makeLogger = () => {
    const logs: Record<string, unknown>[] = []
    return {
        logger: {
            info: (obj: Record<string, unknown>, msg?: string) => logs.push({ ...obj, message: msg }),
            warn: (obj: Record<string, unknown>, msg?: string) => logs.push({ ...obj, message: msg }),
        },
        logs,
    } as const
}

const makePositionFetcherStub = () => ({
    fetchAllPositions: async () => [],
})

const makeBaseCtx = (overrides: Partial<CronContext> = {}): CronContext => ({
    logger: makeLogger().logger,
    positionFetcher: makePositionFetcherStub(),
    ...overrides,
})

const makeLegacySaxoIfdoco = (
    id: string,
    overrides: Record<string, unknown> = {},
): any => ({
    id,
    strategy: 'legacy-ifdoco',
    broker: 'saxo',
    ticker: 'FxSpot:21',
    side: 'BUY',
    order_type: 'IFDOCO',
    status: 'PENDING',
    exit_sync_status: 'MONITORING',
    provider_order_ids: [`ENTRY-${id}`],
    requested_size: 1,
    executed_size: 0,
    executed_price: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
})

const makeRecoveredSaxoIfdocoMetadata = (id: string): any => ({
    kind: 'saxo_order_v1',
    order_id: `ENTRY-${id}`,
    entry: {
        expected: { side: 'BUY', order_type: 'Market', size: 1 },
        resolved: { order_id: `ENTRY-${id}` },
    },
    exits: [
        {
            expected: { role: 'STOP_LOSS', side: 'SELL', order_type: 'StopIfTraded', size: 1, price: 98 },
            resolved: { order_id: `STOP-${id}` },
        },
        {
            expected: { role: 'TAKE_PROFIT', side: 'SELL', order_type: 'Limit', size: 1, price: 103 },
            resolved: { order_id: `LIMIT-${id}` },
        },
    ],
})

const makeAtomicState = (orders: any[]) => {
    const state = new Map(orders.map((order) => [order.id, order]))
    return {
        state,
        updateOrderV2Atomically: async (
            id: string,
            mutate: (current: any) => Record<string, unknown> | null,
        ) => {
            const current = state.get(id)
            if (!current) return false
            const updates = mutate(current)
            if (!updates || Object.keys(updates).length === 0) return false
            Object.assign(current, updates, { updated_at: new Date() })
            return true
        },
    }
}

test('executeTenMinutelyTask: 完全復元した Saxo IFDOCO を保存して同一 cron の通常同期へ戻す', async () => {
    const order = makeLegacySaxoIfdoco('recover-success')
    const atomic = makeAtomicState([order])
    let executionSyncCalls = 0
    let atomicCalls = 0

    await executeTenMinutelyTask(makeBaseCtx({
        getPendingOrdersV2: async () => [order],
        updateOrderV2: async () => {},
        updateOrderV2Atomically: (async (...args: Parameters<typeof atomic.updateOrderV2Atomically>) => {
            atomicCalls += 1
            return atomic.updateOrderV2Atomically(...args)
        }) as any,
        executionPriceFetchers: {
            saxo: {
                recoverIfdocoOrderMetadata: async () => ({
                    kind: 'SUCCESS',
                    retryable: false,
                    metadata: makeRecoveredSaxoIfdocoMetadata(order.id),
                }),
                getExecutionPriceForOrderV2: async (syncOrder) => {
                    executionSyncCalls += 1
                    assert.equal(syncOrder.broker_order_metadata?.kind, 'saxo_order_v1')
                    return { execution: { price: 101, size: 1 } }
                },
            },
        },
    }))

    const stored = atomic.state.get(order.id)
    assert.equal(executionSyncCalls, 1)
    assert.equal(atomicCalls, 1)
    assert.equal(stored.status, 'EXECUTED')
    assert.equal(stored.executed_price, 101)
    assert.equal(stored.broker_order_metadata.exits.length, 2)
    assert.equal(stored.saxo_ifdoco_recovery.status, 'COMPLETED')
    assert.equal(stored.saxo_ifdoco_recovery.attempt_count, 1)
})

test('executeTenMinutelyTask: 復旧 fetcher 不在時は retry 状態を消費せず当該 run をスキップする', async () => {
    const order = makeLegacySaxoIfdoco('missing-recovery-fetcher')
    const atomic = makeAtomicState([order])
    const { logger, logs } = makeLogger()

    await executeTenMinutelyTask(makeBaseCtx({
        logger,
        getPendingOrdersV2: async () => [order],
        updateOrderV2: async () => {},
        updateOrderV2Atomically: atomic.updateOrderV2Atomically as any,
        executionPriceFetchers: {},
    }))

    assert.equal(order.status, 'PENDING')
    assert.equal(order.saxo_ifdoco_recovery, undefined)
    assert.deepEqual(logs.find((log) => log.event === 'cron:saxo_ifdoco_metadata_recovery_unavailable'), {
        event: 'cron:saxo_ifdoco_metadata_recovery_unavailable',
        count: 1,
        reason: 'RECOVERY_FETCHER_MISSING',
        message: 'Saxo IFDOCO metadata recovery fetcher is unavailable; skipping this run',
    })
})

test('executeTenMinutelyTask: retry backoff を永続化し、5回目で PENDING の手動確認へ固定する', async () => {
    const order = makeLegacySaxoIfdoco('retry-limit')
    const atomic = makeAtomicState([order])
    let recoveryCalls = 0
    const { logger, logs } = makeLogger()
    const ctx = makeBaseCtx({
        logger,
        getPendingOrdersV2: async () => [order],
        updateOrderV2: async () => {},
        updateOrderV2Atomically: atomic.updateOrderV2Atomically as any,
        executionPriceFetchers: {
            saxo: {
                recoverIfdocoOrderMetadata: async () => {
                    recoveryCalls += 1
                    return {
                        kind: 'INSUFFICIENT_HISTORY' as const,
                        retryable: true as const,
                        reason: 'EXIT_HISTORY_MISSING' as const,
                    }
                },
                getExecutionPriceForOrderV2: async () => ({ execution: null }),
            },
        },
    })

    const firstStartedAt = Date.now()
    await executeTenMinutelyTask(ctx)
    assert.equal(recoveryCalls, 1)
    assert.equal(order.status, 'PENDING')
    assert.equal(order.saxo_ifdoco_recovery.status, 'RETRY_PENDING')
    assert.equal(order.saxo_ifdoco_recovery.attempt_count, 1)
    assert.ok(order.saxo_ifdoco_recovery.next_attempt_at.getTime() >= firstStartedAt + 10 * 60 * 1000)

    await executeTenMinutelyTask(ctx)
    assert.equal(recoveryCalls, 1)

    order.saxo_ifdoco_recovery = {
        ...order.saxo_ifdoco_recovery,
        attempt_count: 4,
        next_attempt_at: new Date(0),
    }
    await executeTenMinutelyTask(ctx)
    assert.equal(recoveryCalls, 2)
    assert.equal(order.status, 'PENDING')
    assert.equal(order.saxo_ifdoco_recovery.status, 'MANUAL_REVIEW')
    assert.equal(order.saxo_ifdoco_recovery.attempt_count, 5)
    assert.equal(order.saxo_ifdoco_recovery.next_attempt_at, undefined)

    await executeTenMinutelyTask(ctx)
    assert.equal(recoveryCalls, 2)
    const summaries = logs.filter((log) => log.event === 'cron:saxo_ifdoco_metadata_recovery_summary')
    assert.ok(summaries.some((log) => log.manualReviewTransitions === 1))
})

test('executeTenMinutelyTask: 復旧対象を永続時刻順に公平選択し run 上限を守る', async () => {
    const orders = [
        makeLegacySaxoIfdoco('fair-later', {
            saxo_ifdoco_recovery: {
                status: 'RETRY_PENDING',
                attempt_count: 1,
                last_attempt_at: new Date('2026-01-01T01:00:00Z'),
                next_attempt_at: new Date('2026-01-01T02:00:00Z'),
                result_kind: 'INSUFFICIENT_HISTORY',
                reason: 'EXIT_HISTORY_MISSING',
            },
        }),
        makeLegacySaxoIfdoco('fair-first', {
            saxo_ifdoco_recovery: {
                status: 'RETRY_PENDING',
                attempt_count: 1,
                last_attempt_at: new Date('2026-01-01T00:00:00Z'),
                next_attempt_at: new Date('2026-01-01T00:30:00Z'),
                result_kind: 'INSUFFICIENT_HISTORY',
                reason: 'EXIT_HISTORY_MISSING',
            },
        }),
        makeLegacySaxoIfdoco('fair-second', {
            saxo_ifdoco_recovery: {
                status: 'RETRY_PENDING',
                attempt_count: 1,
                last_attempt_at: new Date('2026-01-01T00:30:00Z'),
                next_attempt_at: new Date('2026-01-01T01:00:00Z'),
                result_kind: 'INSUFFICIENT_HISTORY',
                reason: 'EXIT_HISTORY_MISSING',
            },
        }),
        makeLegacySaxoIfdoco('fair-same-next-older-last', {
            saxo_ifdoco_recovery: {
                status: 'RETRY_PENDING',
                attempt_count: 1,
                last_attempt_at: new Date('2026-01-01T00:15:00Z'),
                next_attempt_at: new Date('2026-01-01T01:00:00Z'),
                result_kind: 'INSUFFICIENT_HISTORY',
                reason: 'EXIT_HISTORY_MISSING',
            },
        }),
    ]
    const atomic = makeAtomicState(orders)
    const attemptedIds: string[] = []
    const { logger, logs } = makeLogger()

    await executeTenMinutelyTask(makeBaseCtx({
        logger,
        getPendingOrdersV2: async () => orders,
        updateOrderV2: async () => {},
        updateOrderV2Atomically: atomic.updateOrderV2Atomically as any,
        executionPriceFetchers: {
            saxo: {
                recoverIfdocoOrderMetadata: async (candidate) => {
                    attemptedIds.push(candidate.id)
                    return {
                        kind: 'TEMPORARY_FAILURE',
                        retryable: true,
                        reason: 'RATE_LIMITED',
                    }
                },
                getExecutionPriceForOrderV2: async () => ({ execution: null }),
            },
        },
    }))

    assert.deepEqual(attemptedIds, ['fair-first', 'fair-same-next-older-last'])
    assert.equal(orders[0]?.saxo_ifdoco_recovery.attempt_count, 1)
    assert.equal(orders.find((order) => order.id === 'fair-second')?.saxo_ifdoco_recovery.attempt_count, 1)
    const summary = logs.find((log) => log.event === 'cron:saxo_ifdoco_metadata_recovery_summary')
    assert.equal(summary?.eligible, 4)
    assert.equal(summary?.deferred, 2)
})

test('executeTenMinutelyTask: 不完全な SUCCESS metadata は保存せず手動確認へ移す', async () => {
    const order = makeLegacySaxoIfdoco('incomplete-success')
    const atomic = makeAtomicState([order])

    await executeTenMinutelyTask(makeBaseCtx({
        getPendingOrdersV2: async () => [order],
        updateOrderV2: async () => {},
        updateOrderV2Atomically: atomic.updateOrderV2Atomically as any,
        executionPriceFetchers: {
            saxo: {
                recoverIfdocoOrderMetadata: async () => ({
                    kind: 'SUCCESS',
                    retryable: false,
                    metadata: {
                        ...makeRecoveredSaxoIfdocoMetadata(order.id),
                        exits: [],
                    },
                }),
                getExecutionPriceForOrderV2: async () => {
                    assert.fail('incomplete metadata must not enter normal sync')
                },
            },
        },
    }))

    assert.equal(order.broker_order_metadata, undefined)
    assert.equal(order.status, 'PENDING')
    assert.equal(order.saxo_ifdoco_recovery.status, 'MANUAL_REVIEW')
    assert.equal(order.saxo_ifdoco_recovery.reason, 'INCOMPLETE_SUCCESS_METADATA')
})

test('executeTenMinutelyTask: 重複した exit role の SUCCESS metadata は保存しない', async () => {
    const order = makeLegacySaxoIfdoco('duplicate-exit-role')
    const atomic = makeAtomicState([order])
    const metadata = makeRecoveredSaxoIfdocoMetadata(order.id)
    metadata.exits[1] = {
        ...metadata.exits[1],
        expected: { ...metadata.exits[1].expected, role: 'STOP_LOSS' },
    }

    await executeTenMinutelyTask(makeBaseCtx({
        getPendingOrdersV2: async () => [order],
        updateOrderV2: async () => {},
        updateOrderV2Atomically: atomic.updateOrderV2Atomically as any,
        executionPriceFetchers: {
            saxo: {
                recoverIfdocoOrderMetadata: async () => ({
                    kind: 'SUCCESS',
                    retryable: false,
                    metadata,
                }),
                getExecutionPriceForOrderV2: async () => {
                    assert.fail('duplicate exit roles must not enter normal sync')
                },
            },
        },
    }))

    assert.equal(order.broker_order_metadata, undefined)
    assert.equal(order.status, 'PENDING')
    assert.equal(order.saxo_ifdoco_recovery.status, 'MANUAL_REVIEW')
    assert.equal(order.saxo_ifdoco_recovery.reason, 'INCOMPLETE_SUCCESS_METADATA')
})

test('executeTenMinutelyTask: 復旧中の metadata 競合と終端更新を上書きしない', async () => {
    for (const concurrentUpdate of ['metadata', 'terminal'] as const) {
        const order = makeLegacySaxoIfdoco(`concurrent-${concurrentUpdate}`)
        const recovered = makeRecoveredSaxoIfdocoMetadata(order.id)
        const concurrentMetadata = {
            ...makeRecoveredSaxoIfdocoMetadata(order.id),
            exits: makeRecoveredSaxoIfdocoMetadata(order.id).exits.map((exit: any, index: number) => ({
                ...exit,
                resolved: { order_id: `${index === 0 ? 'OTHER-STOP' : 'OTHER-LIMIT'}-${order.id}` },
            })),
        }
        const { logger, logs } = makeLogger()
        let atomicCall = 0
        const updateOrderV2Atomically = async (
            _id: string,
            mutate: (current: any) => Record<string, unknown> | null,
        ) => {
            atomicCall += 1
            if (atomicCall === 1) {
                if (concurrentUpdate === 'metadata') order.broker_order_metadata = concurrentMetadata
                if (concurrentUpdate === 'terminal') order.status = 'CANCELED'
            }
            const updates = mutate(order)
            if (!updates) return false
            Object.assign(order, updates)
            return true
        }

        await executeTenMinutelyTask(makeBaseCtx({
            logger,
            getPendingOrdersV2: async () => [order],
            updateOrderV2: async () => {},
            updateOrderV2Atomically: updateOrderV2Atomically as any,
            executionPriceFetchers: {
                saxo: {
                    recoverIfdocoOrderMetadata: async () => ({
                        kind: 'SUCCESS',
                        retryable: false,
                        metadata: recovered,
                    }),
                    getExecutionPriceForOrderV2: async () => ({ execution: null }),
                },
            },
        }))

        if (concurrentUpdate === 'metadata') {
            assert.deepEqual(order.broker_order_metadata, concurrentMetadata)
            assert.equal(
                logs.find((log) => log.event === 'cron:saxo_ifdoco_metadata_recovery_summary')?.skippedConcurrentUpdates,
                0,
            )
        } else {
            assert.equal(order.status, 'CANCELED')
            assert.equal(order.broker_order_metadata, undefined)
            assert.equal(
                logs.find((log) => log.event === 'cron:saxo_ifdoco_metadata_recovery_summary')?.skippedConcurrentUpdates,
                1,
            )
        }
        assert.equal(order.saxo_ifdoco_recovery, undefined)
    }
})

test('executeHourlyTask: Saxo reconciliation の fresh 48時間 window と結果適用を行う', async () => {
    const startedAt = Date.now()
    const order: any = {
        id: 'hourly-saxo-order',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'BUY',
        order_type: 'MARKET',
        status: 'PENDING',
        provider_order_ids: ['SAXO-hourly-order'],
        requested_size: 1,
        executed_size: 0,
        executed_price: null,
        created_at: new Date(startedAt - 60 * 60 * 1000),
        updated_at: new Date(startedAt - 60 * 60 * 1000),
        broker_order_metadata: {
            kind: 'saxo_order_v1',
            order_id: 'SAXO-hourly-order',
            entry: {
                expected: { side: 'BUY', order_type: 'Market', size: 1 },
                resolved: { order_id: 'SAXO-hourly-order' },
            },
            exits: [],
        },
    } as const
    const updates: Array<{ id: string, updates: Record<string, unknown> }> = []
    let requestedRange: { from: Date, to: Date } | undefined

    await executeHourlyTask(makeBaseCtx({
        getPendingOrdersV2: async () => [order],
        updateOrderV2: async (id, value) => { updates.push({ id, updates: value as Record<string, unknown> }) },
        executionReconciliationFetchers: {
            saxo: {
                reconcileExecutionPricesForOrdersV2: async (_orders, range) => {
                    requestedRange = range
                    return new Map([[
                        order.id,
                        { execution: { price: 101, size: 1 }, brokerOrderMetadata: order.broker_order_metadata },
                    ]])
                },
            },
        },
    }))
    const completedAt = Date.now()

    assert.ok(requestedRange)
    assert.equal(requestedRange!.to.getTime() - requestedRange!.from.getTime(), 48 * 60 * 60 * 1000)
    assert.ok(requestedRange!.to.getTime() >= startedAt)
    assert.ok(requestedRange!.to.getTime() <= completedAt)
    assert.equal(updates.length, 1)
    assert.equal(updates[0]?.id, order.id)
    assert.equal(updates[0]?.updates.status, 'EXECUTED')
    assert.equal(updates[0]?.updates.executed_price, 101)
    assert.equal(updates[0]?.updates.executed_size, 1)
})

test('executeHourlyTask: reconciliation が空結果の場合は partial update を適用しない', async () => {
    const updates: unknown[] = []
    const order: any = {
        id: 'hourly-saxo-incomplete',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'BUY',
        order_type: 'MARKET',
        status: 'PENDING',
        provider_order_ids: ['SAXO-incomplete'],
        requested_size: 1,
        executed_size: 0,
        executed_price: null,
        created_at: new Date(),
        updated_at: new Date(),
        broker_order_metadata: {
            kind: 'saxo_order_v1',
            order_id: 'SAXO-incomplete',
            entry: {
                expected: { side: 'BUY', order_type: 'Market', size: 1 },
                resolved: { order_id: 'SAXO-incomplete' },
            },
            exits: [],
        } as const,
    } as const

    await executeHourlyTask(makeBaseCtx({
        getPendingOrdersV2: async () => [order],
        updateOrderV2: async (id, value) => { updates.push({ id, value }) },
        executionReconciliationFetchers: {
            saxo: { reconcileExecutionPricesForOrdersV2: async () => new Map() },
        },
    }))

    assert.deepEqual(updates, [])
})

test('executeHourlyTask: Saxo対象のPENDINGがない場合はreconciliationを実行しない', async () => {
    let fetcherCalls = 0

    await executeHourlyTask(makeBaseCtx({
        getPendingOrdersV2: async () => [],
        updateOrderV2: async () => {},
        executionReconciliationFetchers: {
            saxo: {
                reconcileExecutionPricesForOrdersV2: async () => {
                    fetcherCalls += 1
                    return new Map()
                },
            },
        },
    }))

    assert.equal(fetcherCalls, 0)
})

// ─────────────── Phase 3: orders_v2 sync ───────────────

test('executeTenMinutelyTask: orders_v2 の PENDING を EXECUTED に更新する', async () => {
    const pendingOrder: any = {
        id: 'v2-pending-1',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        status: 'PENDING',
        provider_order_ids: ['JRF-v2-1'],
        requested_size: 0.01,
        created_at: new Date('2026-01-01T00:00:00Z'),
    }
    const updatedOrders: any[] = []

    const ctx = makeBaseCtx({
        getPendingOrdersV2: async () => [pendingOrder],
        updateOrderV2: async (id, updates) => { updatedOrders.push({ id, ...updates }) },
        executionPriceFetchers: {
            bitflyer: { getExecutionPriceForOrderV2: async () => ({ execution: { price: 9800000, size: 0.01 } }) },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(updatedOrders.length, 1)
    assert.equal(updatedOrders[0].status, 'EXECUTED')
    assert.equal(updatedOrders[0].executed_price, 9800000)
    assert.equal(updatedOrders[0].executed_size, 0.01)
    assert.deepEqual(updatedOrders[0].executed_at, new Date('2026-01-01T00:00:00Z'))
})

test('executeTenMinutelyTask: broker単位でbulk fetcherを1回呼び、missing resultは単件fallbackする', async () => {
    const orders: any[] = [
        {
            id: 'bulk-saxo-1', broker: 'saxo', ticker: 'FxSpot:21', side: 'BUY', order_type: 'MARKET',
            status: 'PENDING', provider_order_ids: ['ORD-bulk-1'], requested_size: 1, executed_size: 0,
            executed_price: null, created_at: new Date('2026-01-01T00:00:00Z'),
        },
        {
            id: 'bulk-saxo-2', broker: 'saxo', ticker: 'FxSpot:21', side: 'BUY', order_type: 'MARKET',
            status: 'PENDING', provider_order_ids: ['ORD-bulk-2'], requested_size: 1, executed_size: 0,
            executed_price: null, created_at: new Date('2026-01-01T00:00:00Z'),
        },
    ]
    const updatedOrders: any[] = []
    let bulkCalls = 0
    let singleCalls = 0
    let receivedNow: Date | undefined
    const { logger, logs } = makeLogger()
    const ctx = makeBaseCtx({
        logger,
        getPendingOrdersV2: async () => orders,
        updateOrderV2: async (id, updates) => { updatedOrders.push({ id, ...updates }) },
        executionPriceFetchers: {
            saxo: {
                getExecutionPriceForOrderV2: async () => {
                    singleCalls += 1
                    return { execution: { price: 102, size: 1 } }
                },
                getExecutionPricesForOrdersV2: async (bulkOrders, options) => {
                    bulkCalls += 1
                    receivedNow = options.now
                    return new Map([[bulkOrders[0]?.id as string, {
                        execution: { price: 101, size: 1 },
                    }]])
                },
            },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(bulkCalls, 1)
    assert.equal(singleCalls, 1)
    assert.ok(receivedNow instanceof Date)
    assert.equal(updatedOrders.length, 2)
    assert.deepEqual(updatedOrders.map((order) => order.status), ['EXECUTED', 'EXECUTED'])
    assert.deepEqual(updatedOrders.map((order) => order.executed_price), [101, 102])
    assert.deepEqual(logs.find((log) => log.event === 'cron:orders_v2_bulk_result_missing'), {
        event: 'cron:orders_v2_bulk_result_missing',
        broker: 'saxo',
        count: 1,
        orderIds: ['bulk-saxo-2'],
        message: 'bulk execution sync returned no result; falling back to single-order sync',
    })
})

test('executeTenMinutelyTask: bulk reject 時は全注文を single fallback へ渡す', async () => {
    const order: any = {
        id: 'bulk-rejected-saxo',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'BUY',
        order_type: 'MARKET',
        status: 'PENDING',
        provider_order_ids: ['ORD-bulk-rejected'],
        requested_size: 1,
        executed_size: 0,
        executed_price: null,
        created_at: new Date('2026-01-01T00:00:00Z'),
    }
    const updatedOrders: any[] = []
    let singleCalls = 0

    await executeTenMinutelyTask(makeBaseCtx({
        getPendingOrdersV2: async () => [order],
        updateOrderV2: async (id, updates) => { updatedOrders.push({ id, ...updates }) },
        executionPriceFetchers: {
            saxo: {
                getExecutionPriceForOrderV2: async () => {
                    singleCalls += 1
                    return {
                        execution: null,
                        brokerOrderMetadata: {
                            kind: 'saxo_order_v1',
                            order_id: 'ORD-bulk-rejected',
                            entry: {
                                expected: { side: 'BUY', order_type: 'Market', size: 1 },
                                resolved: { order_id: 'ORD-bulk-rejected' },
                            },
                            exits: [],
                        },
                        brokerOrderMetadataPolicy: 'SET_IF_UNSET' as const,
                    }
                },
                getExecutionPricesForOrdersV2: async () => { throw new Error('bulk unavailable') },
            },
        },
    }))

    assert.equal(singleCalls, 1)
    assert.equal(updatedOrders.length, 1)
    assert.equal(updatedOrders[0].status, undefined)
    assert.equal(updatedOrders[0].broker_order_metadata.order_id, 'ORD-bulk-rejected')
})

test('executeTenMinutelyTask: entry の部分約定を PENDING のまま累積同期し、再取得では no-op にする', async () => {
    const createdAt = new Date('2026-01-01T00:00:00Z')
    const partialAt = new Date('2026-01-01T00:05:00Z')
    const fullAt = new Date('2026-01-01T00:10:00Z')
    const partialOrder: any = {
        id: 'v2-entry-partial',
        broker: 'bitflyer',
        ticker: 'FX_BTC_JPY',
        status: 'PENDING',
        provider_order_ids: ['JRF-entry-partial'],
        requested_size: 0.01,
        executed_size: 0,
        executed_price: null,
        created_at: createdAt,
        updated_at: createdAt,
    }
    const partialUpdates: any[] = []
    const partialCtx = makeBaseCtx({
        getPendingOrdersV2: async () => [partialOrder],
        updateOrderV2: async (id, updates) => { partialUpdates.push({ id, ...updates }) },
        executionPriceFetchers: {
            bitflyer: {
                getExecutionPriceForOrderV2: async () => ({
                    execution: { price: 9800000, size: 0.004, executed_at: partialAt, commission: 0 },
                }),
            },
        },
    })

    await executeTenMinutelyTask(partialCtx)

    assert.deepEqual(partialUpdates, [{
        id: 'v2-entry-partial',
        executed_price: 9800000,
        executed_size: 0.004,
        executed_at: partialAt,
        execution_costs: { commission: 0 },
    }])

    const fullOrder = {
        ...partialOrder,
        executed_size: 0.004,
        executed_price: 9800000,
        executed_at: partialAt,
        execution_costs: { commission: 0 },
    }
    const fullUpdates: any[] = []
    const fullCtx = makeBaseCtx({
        getPendingOrdersV2: async () => [fullOrder],
        updateOrderV2: async (id, updates) => { fullUpdates.push({ id, ...updates }) },
        executionPriceFetchers: {
            bitflyer: {
                getExecutionPriceForOrderV2: async () => ({
                    execution: { price: 9810000, size: 0.01, executed_at: fullAt, commission: -0.0001 },
                }),
            },
        },
    })

    await executeTenMinutelyTask(fullCtx)

    assert.deepEqual(fullUpdates, [{
        id: 'v2-entry-partial',
        status: 'EXECUTED',
        executed_price: 9810000,
        executed_size: 0.01,
        executed_at: fullAt,
        execution_costs: { commission: -0.0001 },
    }])

    const noOpUpdates: any[] = []
    const noOpCtx = makeBaseCtx({
        getPendingOrdersV2: async () => [{
            ...fullOrder,
            status: 'EXECUTED',
            executed_size: 0.01,
            executed_price: 9810000,
            executed_at: fullAt,
            execution_costs: { commission: -0.0001 },
        }],
        updateOrderV2: async (id, updates) => { noOpUpdates.push({ id, ...updates }) },
        executionPriceFetchers: {
            bitflyer: {
                getExecutionPriceForOrderV2: async () => ({
                    execution: { price: 9810000, size: 0.01, executed_at: fullAt, commission: -0.0001 },
                }),
            },
        },
    })

    await executeTenMinutelyTask(noOpCtx)

    assert.equal(noOpUpdates.length, 0)
})

test('executeTenMinutelyTask: entry の overfill は保存しない', async () => {
    const updatedOrders: any[] = []
    const ctx = makeBaseCtx({
        getPendingOrdersV2: async () => [{
            id: 'v2-entry-overfill',
            broker: 'bitflyer',
            ticker: 'FX_BTC_JPY',
            status: 'PENDING',
            provider_order_ids: ['JRF-entry-overfill'],
            requested_size: 0.01,
            executed_size: 0,
            executed_price: null,
            created_at: new Date('2026-01-01T00:00:00Z'),
        } as any],
        updateOrderV2: async (id, updates) => { updatedOrders.push({ id, ...updates }) },
        executionPriceFetchers: {
            bitflyer: {
                getExecutionPriceForOrderV2: async () => ({ execution: { price: 9800000, size: 0.01000002, commission: 0 } }),
            },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(updatedOrders.length, 0)
})

const makeApplyOrder = (overrides: Record<string, unknown> = {}): any => ({
    id: 'v2-apply-order',
    strategy: 'test',
    broker: 'saxo',
    ticker: 'FxSpot:21',
    side: 'BUY',
    order_type: 'MARKET',
    requested_size: 1,
    executed_size: 0,
    executed_price: null,
    status: 'PENDING',
    provider_order_ids: ['ORD-apply-order'],
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
})

test('applyOrderExecutionSyncResult: terminal status と execution snapshot を優先順位どおり適用する', async () => {
    const cases = [
        {
            name: '全量約定',
            result: { execution: { price: 101, size: 1, executed_at: new Date('2026-01-01T00:01:00Z') } },
            expected: { status: 'EXECUTED', executed_price: 101, executed_size: 1, executed_at: new Date('2026-01-01T00:01:00Z') },
        },
        {
            name: '部分約定',
            result: { execution: { price: 100, size: 0.4, commission: 0 } },
            expected: { executed_price: 100, executed_size: 0.4, executed_at: new Date('2026-01-01T00:00:00Z'), execution_costs: { commission: 0 } },
        },
        {
            name: '部分約定後の取消',
            result: { execution: { price: 100, size: 0.4 }, terminalStatus: 'CANCELED' as const, terminalReason: 'test_confirmed_cancel' },
            expected: { status: 'CANCELED', executed_price: 100, executed_size: 0.4, executed_at: new Date('2026-01-01T00:00:00Z') },
        },
        {
            name: '未約定取消',
            result: { execution: null, terminalStatus: 'CANCELED' as const, terminalReason: 'test_confirmed_cancel' },
            expected: { status: 'CANCELED' },
        },
        {
            name: '失効',
            result: { execution: null, terminalStatus: 'CANCELED' as const, terminalReason: 'test_confirmed_expire' },
            expected: { status: 'CANCELED' },
        },
        {
            name: '発注拒否',
            result: { execution: null, terminalStatus: 'FAILED' as const, terminalReason: 'test_placement_rejected' },
            expected: { status: 'FAILED' },
        },
        {
            name: 'cancel rejected は継続',
            result: { execution: null },
            expected: {},
        },
        {
            name: 'DoneForDay は継続',
            result: { execution: null },
            expected: {},
        },
    ]

    for (const testCase of cases) {
        const updates: any[] = []
        const changed = await applyOrderExecutionSyncResult(
            makeApplyOrder(),
            testCase.result,
            async (id, mutate) => {
                const update = mutate(makeApplyOrder())
                if (!update) return false
                updates.push({ id, ...update })
                return true
            },
        )
        assert.equal(changed.updated, Object.keys(testCase.expected).length > 0, testCase.name)
        assert.deepEqual(updates[0], Object.keys(testCase.expected).length > 0
            ? { id: 'v2-apply-order', ...testCase.expected }
            : undefined, testCase.name)
    }
})

test('applyOrderExecutionSyncResult: 同一 snapshot と overfill は no-op にする', async () => {
    const order = makeApplyOrder({
        status: 'EXECUTED',
        executed_size: 1,
        executed_price: 101,
        executed_at: new Date('2026-01-01T00:01:00Z'),
    })
    const updates: any[] = []

    const unchanged = await applyOrderExecutionSyncResult(
        order,
        { execution: { price: 101, size: 1, executed_at: new Date('2026-01-01T00:01:00Z') } },
        async (id, mutate) => {
            const update = mutate(order)
            if (!update) return false
            updates.push({ id, ...update })
            return true
        },
    )
    const overfilled = await applyOrderExecutionSyncResult(
        makeApplyOrder(),
        { execution: { price: 101, size: 1.00000002 } },
        async (id, mutate) => {
            const update = mutate(makeApplyOrder())
            if (!update) return false
            updates.push({ id, ...update })
            return true
        },
    )

    assert.equal(unchanged.updated, false)
    assert.equal(unchanged.noOpReason, 'UNCHANGED')
    assert.equal(overfilled.updated, false)
    assert.equal(overfilled.noOpReason, 'OVERFILL')
    assert.equal(updates.length, 0)
})

test('applyOrderExecutionSyncResult: stale な PENDING 引数を使っても transaction 内の EXECUTED を維持する', async () => {
    const current: any = makeApplyOrder()
    const staleOrder: any = makeApplyOrder()
    const atomicUpdates: any[] = []
    const atomicUpdater = async (id: string, mutate: (order: any) => Record<string, unknown> | null) => {
        const updates = mutate(current)
        if (!updates) return false
        Object.assign(current, updates)
        atomicUpdates.push({ id, updates })
        return true
    }

    const first = await applyOrderExecutionSyncResult(
        staleOrder,
        { execution: { price: 101, size: 1, executed_at: new Date('2026-01-01T00:01:00Z') } },
        atomicUpdater,
    )
    const second = await applyOrderExecutionSyncResult(
        staleOrder,
        { execution: { price: 99, size: 0.4, executed_at: new Date('2026-01-01T00:02:00Z') } },
        atomicUpdater,
    )

    assert.equal(first.updated, true)
    assert.equal(second.updated, false)
    assert.equal(second.noOpReason, 'UNCHANGED')
    assert.equal(current.status, 'EXECUTED')
    assert.equal(current.executed_size, 1)
    assert.equal(current.executed_price, 101)
    assert.deepEqual(current.executed_at, new Date('2026-01-01T00:01:00Z'))
    assert.equal(atomicUpdates.length, 1)
})

test('applyOrderExecutionSyncResult: Saxo legacy metadata-only result は PENDING のまま atomic 保存する', async () => {
    const current = makeApplyOrder()
    const updates: any[] = []
    const metadata: any = {
        kind: 'saxo_order_v1',
        order_id: 'ORD-apply-order',
        entry: {
            expected: { side: 'BUY', order_type: 'Market', size: 1 },
            resolved: { order_id: 'ORD-apply-order' },
        },
        exits: [],
    }

    const outcome = await applyOrderExecutionSyncResult(
        current,
        { execution: null, brokerOrderMetadata: metadata, brokerOrderMetadataPolicy: 'SET_IF_UNSET' },
        async (id, mutate) => {
            const diff = mutate(current)
            if (diff) {
                Object.assign(current, diff)
                updates.push({ id, ...diff })
            }
            return diff !== null
        },
    )

    assert.equal(outcome.updated, true)
    assert.equal(current.status, 'PENDING')
    assert.deepEqual(current.broker_order_metadata, metadata)
    assert.deepEqual(updates[0], { id: current.id, broker_order_metadata: metadata })
})

test('executeTenMinutelyTask: metadata recovery の no-op は recovery attempted と記録する', async () => {
    const { logger, logs } = makeLogger()
    const metadata: any = {
        kind: 'saxo_order_v1',
        order_id: 'ORD-metadata-no-op',
        entry: {
            expected: { side: 'BUY', order_type: 'Market', size: 1 },
            resolved: { order_id: 'ORD-metadata-no-op' },
        },
        exits: [],
    }
    const order: any = {
        id: 'saxo-metadata-no-op',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'BUY',
        order_type: 'MARKET',
        status: 'PENDING',
        provider_order_ids: ['ORD-metadata-no-op'],
        requested_size: 1,
        executed_size: 0,
        executed_price: null,
        created_at: new Date('2026-01-01T00:00:00Z'),
        broker_order_metadata: metadata,
    }

    await executeTenMinutelyTask(makeBaseCtx({
        logger,
        getPendingOrdersV2: async () => [order],
        updateOrderV2: async () => {},
        executionPriceFetchers: {
            saxo: {
                getExecutionPriceForOrderV2: async () => ({
                    execution: null,
                    brokerOrderMetadata: metadata,
                    brokerOrderMetadataPolicy: 'SET_IF_UNSET' as const,
                }),
            },
        },
    }))

    const recoveryLog = logs.find((log) => log.event === 'cron:orders_v2_metadata_recovered')
    assert.equal(recoveryLog?.updated, false)
    assert.equal(recoveryLog?.noOpReason, 'UNCHANGED')
    assert.equal(recoveryLog?.message, 'orders_v2 Saxo legacy metadata recovery attempted without confirmed execution')
})

test('applyOrderExecutionSyncResult: 合成 metadata と confirmed fill を同一 atomic update で適用する', async () => {
    const current = makeApplyOrder()
    const metadata: any = {
        kind: 'saxo_order_v1',
        order_id: 'ORD-apply-order',
        entry: {
            expected: { side: 'BUY', order_type: 'Market', size: 1 },
            resolved: { order_id: 'ORD-apply-order' },
        },
        exits: [],
    }

    const outcome = await applyOrderExecutionSyncResult(
        current,
        {
            execution: { price: 101, size: 1 },
            brokerOrderMetadata: metadata,
            brokerOrderMetadataPolicy: 'SET_IF_UNSET',
        },
        async (_id, mutate) => {
            const diff = mutate(current)
            if (diff) Object.assign(current, diff)
            return diff !== null
        },
    )

    assert.equal(outcome.updated, true)
    assert.equal(current.status, 'EXECUTED')
    assert.equal(current.executed_price, 101)
    assert.deepEqual(current.broker_order_metadata, metadata)
})

test('applyOrderExecutionSyncResult: 競合 metadata が先行保存済みなら execution/status も no-op にする', async () => {
    const current = makeApplyOrder({
        broker_order_metadata: {
            kind: 'saxo_order_v1',
            order_id: 'ORD-other',
            entry: {
                expected: { side: 'BUY', order_type: 'Market', size: 1 },
                resolved: { order_id: 'ORD-other' },
            },
            exits: [],
        },
    })
    const incomingMetadata: any = {
        kind: 'saxo_order_v1',
        order_id: 'ORD-apply-order',
        entry: {
            expected: { side: 'BUY', order_type: 'Market', size: 1 },
            resolved: { order_id: 'ORD-apply-order' },
        },
        exits: [],
    }
    const warnings: unknown[] = []

    const outcome = await applyOrderExecutionSyncResult(
        makeApplyOrder(),
        {
            execution: { price: 101, size: 1 },
            brokerOrderMetadata: incomingMetadata,
            brokerOrderMetadataPolicy: 'SET_IF_UNSET',
        },
        async (_id, mutate) => mutate(current) !== null,
        { warn: (obj) => warnings.push(obj), info: () => {} },
    )

    assert.equal(outcome.updated, false)
    assert.equal(outcome.noOpReason, 'METADATA_CONFLICT')
    assert.equal(current.status, 'PENDING')
    assert.equal(current.executed_size, 0)
    assert.equal(warnings.length, 1)
})

test('applyOrderExecutionSyncResult: 同値snapshotは未設定fieldだけ補完し、既存値を訂正しない', async () => {
    const current: any = makeApplyOrder({
        executed_size: 0.4,
        executed_price: null,
        executed_at: undefined,
        execution_costs: undefined,
    })
    const warnings: unknown[] = []
    const updated = await applyOrderExecutionSyncResult(
        current,
        { execution: { price: 100, size: 0.4, executed_at: new Date('2026-01-01T00:02:00Z'), commission: 0 } },
        async (_id, mutate) => {
            const updates = mutate(current)
            if (updates) Object.assign(current, updates)
            return updates !== null
        },
        { warn: (obj) => warnings.push(obj), info: () => {} },
    )

    assert.equal(updated.updated, true)
    assert.equal(current.executed_size, 0.4)
    assert.equal(current.executed_price, 100)
    assert.deepEqual(current.executed_at, new Date('2026-01-01T00:02:00Z'))
    assert.deepEqual(current.execution_costs, { commission: 0 })
    assert.equal(warnings.length, 0)

    const conflictOrder: any = makeApplyOrder({
        executed_size: 0.4,
        executed_price: 100,
        executed_at: new Date('2026-01-01T00:02:00Z'),
        execution_costs: { commission: 0 },
    })
    const conflictWarnings: unknown[] = []
    const conflict = await applyOrderExecutionSyncResult(
        conflictOrder,
        { execution: { price: 101, size: 0.4, executed_at: new Date('2026-01-01T00:03:00Z'), commission: 1 } },
        async (_id, mutate) => mutate(conflictOrder) === null ? false : false,
        { warn: (obj) => conflictWarnings.push(obj), info: () => {} },
    )
    assert.equal(conflict.updated, false)
    assert.equal(conflictWarnings.length, 1)
    assert.equal(conflictOrder.executed_price, 100)
    assert.equal(conflictOrder.execution_costs.commission, 0)
})

test('applyOrderExecutionSyncResult: partial execution後のterminal-only cancelはsnapshotを保持する', async () => {
    const current: any = makeApplyOrder({
        executed_size: 0.4,
        executed_price: 100,
        executed_at: new Date('2026-01-01T00:01:00Z'),
        execution_costs: { commission: 0 },
    })
    const outcome = await applyOrderExecutionSyncResult(
        current,
        { execution: null, terminalStatus: 'CANCELED', terminalReason: 'confirmed_cancel' },
        async (_id, mutate) => {
            const updates = mutate(current)
            if (updates) Object.assign(current, updates)
            return updates !== null
        },
    )

    assert.equal(outcome.updated, true)
    assert.equal(current.status, 'CANCELED')
    assert.equal(current.executed_size, 0.4)
    assert.equal(current.executed_price, 100)
    assert.deepEqual(current.executed_at, new Date('2026-01-01T00:01:00Z'))
    assert.deepEqual(current.execution_costs, { commission: 0 })
})

test('executeTenMinutelyTask: 部分約定後の confirmed cancel は terminal 同期ログを出す', async () => {
    const { logger, logs } = makeLogger()
    const updatedOrders: any[] = []
    const ctx = makeBaseCtx({
        logger,
        getPendingOrdersV2: async () => [{
            id: 'v2-partial-cancel-log',
            broker: 'saxo',
            ticker: 'FxSpot:21',
            status: 'PENDING',
            provider_order_ids: ['ORD-partial-cancel-log'],
            requested_size: 1,
            executed_size: 0,
            executed_price: null,
            created_at: new Date('2026-01-01T00:00:00Z'),
        } as any],
        updateOrderV2: async (id, updates) => { updatedOrders.push({ id, ...updates }) },
        executionPriceFetchers: {
            saxo: {
                getExecutionPriceForOrderV2: async () => ({
                    execution: { price: 100, size: 0.4 },
                    terminalStatus: 'CANCELED' as const,
                    terminalReason: 'saxo_confirmed_cancel',
                }),
            },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.deepEqual(updatedOrders[0], {
        id: 'v2-partial-cancel-log',
        status: 'CANCELED',
        executed_price: 100,
        executed_size: 0.4,
        executed_at: new Date('2026-01-01T00:00:00Z'),
    })
    assert.ok(logs.some((log) => (
        log.event === 'cron:orders_v2_terminal_status_synced' &&
        log.status === 'CANCELED'
    )))
    assert.equal(logs.some((log) => log.event === 'cron:orders_v2_synced'), false)
})

test('executeTenMinutelyTask: terminal 同期ログは no-op でも更新を断定しない', async () => {
    const { logger, logs } = makeLogger()
    const updatedOrders: any[] = []
    const ctx = makeBaseCtx({
        logger,
        getPendingOrdersV2: async () => [{
            id: 'v2-terminal-no-op-log',
            broker: 'saxo',
            ticker: 'FxSpot:21',
            status: 'CANCELED',
            provider_order_ids: ['ORD-terminal-no-op-log'],
            requested_size: 1,
            executed_size: 0,
            executed_price: null,
            created_at: new Date('2026-01-01T00:00:00Z'),
        } as any],
        updateOrderV2: async (id, updates) => { updatedOrders.push({ id, ...updates }) },
        executionPriceFetchers: {
            saxo: {
                getExecutionPriceForOrderV2: async () => ({
                    execution: null,
                    terminalStatus: 'CANCELED' as const,
                    terminalReason: 'saxo_confirmed_cancel',
                }),
            },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.deepEqual(updatedOrders, [])
    assert.equal(
        logs.find((log) => log.event === 'cron:orders_v2_terminal_status_synced')?.message,
        'orders_v2 terminal status synchronized as CANCELED',
    )
})

test('executeTenMinutelyTask: PENDING の IFDOCO 親注文が EXECUTED になったとき exit_sync_status を MONITORING にする', async () => {
    const pendingOrder: any = {
        id: 'v2-pending-ifd-1',
        broker: 'bitflyer',
        ticker: 'FX_BTC_JPY',
        order_type: 'IFDOCO',
        status: 'PENDING',
        provider_order_ids: ['PAR-pending-ifd-1'],
        requested_size: 0.01,
        created_at: new Date('2026-01-01T00:00:00Z'),
    }

    const updatedOrders: any[] = []
    const ctx = makeBaseCtx({
        getPendingOrdersV2: async () => [pendingOrder],
        updateOrderV2: async (id, u) => { updatedOrders.push({ id, ...u }) },
        executionPriceFetchers: {
            bitflyer: { getExecutionPriceForOrderV2: async () => ({ execution: { price: 9800000, size: 0.01 } }) },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(updatedOrders.length, 1)
    assert.deepEqual(updatedOrders[0], {
        id: 'v2-pending-ifd-1',
        status: 'EXECUTED',
        executed_price: 9800000,
        executed_size: 0.01,
        executed_at: new Date('2026-01-01T00:00:00Z'),
        exit_sync_status: 'MONITORING',
    })
})

test('executeTenMinutelyTask: orders_v2 の実約定時刻を fetcher の値で保存する', async () => {
    const pendingOrder: any = {
        id: 'v2-pending-executed-at-1',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        status: 'PENDING',
        provider_order_ids: ['JRF-v2-executed-at-1'],
        requested_size: 0.01,
        created_at: new Date('2026-01-01T00:00:00Z'),
    }

    const updatedOrders: any[] = []
    const executedAt = new Date('2026-01-01T00:05:00Z')
    const ctx = makeBaseCtx({
        getPendingOrdersV2: async () => [pendingOrder],
        updateOrderV2: async (id, updates) => { updatedOrders.push({ id, ...updates }) },
        executionPriceFetchers: {
            bitflyer: {
                getExecutionPriceForOrderV2: async () => ({
                    execution: { price: 9810000, size: 0.01, executed_at: executedAt },
                }),
            },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(updatedOrders.length, 1)
    assert.deepEqual(updatedOrders[0].executed_at, executedAt)
})

test('executeTenMinutelyTask: orders_v2 の entry metadata 解決結果を保存する', async () => {
    const pendingOrder: any = {
        id: 'v2-pending-meta-1',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        status: 'PENDING',
        provider_order_ids: ['JRF-v2-meta-1'],
        requested_size: 0.01,
        broker_order_metadata: {
            kind: 'bitflyer_parent_order_v1',
            parent_order_acceptance_id: 'JRF-v2-meta-1',
            order_method: 'IFDOCO',
            entry: {
                expected: { role: 'ENTRY', side: 'BUY', condition_type: 'MARKET', size: 0.01 },
                resolved: { acceptance_id: null },
            },
            exits: [],
        },
    }
    const updatedOrders: any[] = []

    const ctx = makeBaseCtx({
        getPendingOrdersV2: async () => [pendingOrder],
        updateOrderV2: async (id, updates) => { updatedOrders.push({ id, ...updates }) },
        executionPriceFetchers: {
            bitflyer: {
                getExecutionPriceForOrderV2: async () => ({
                    execution: null,
                    brokerOrderMetadata: {
                        ...pendingOrder.broker_order_metadata,
                        entry: {
                            ...pendingOrder.broker_order_metadata.entry,
                            resolved: { acceptance_id: 'JRF-child-entry-1' },
                        },
                    },
                }),
            },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(updatedOrders.length, 1)
    assert.deepEqual(updatedOrders[0].broker_order_metadata.entry.resolved, { acceptance_id: 'JRF-child-entry-1' })
    assert.equal(updatedOrders[0].status, undefined)
})

test('executeTenMinutelyTask: entry metadata はキー順だけが異なる場合に no-op にする', async () => {
    const metadata: any = {
        kind: 'bitflyer_parent_order_v1',
        parent_order_acceptance_id: 'JRF-v2-pending-meta-order',
        order_method: 'IFDOCO',
        entry: {
            expected: { role: 'ENTRY', side: 'BUY', condition_type: 'MARKET', size: 0.01 },
            resolved: { acceptance_id: 'JRF-entry-order' },
        },
        exits: [],
    }
    const reorderedMetadata: any = {
        exits: [],
        entry: {
            resolved: { acceptance_id: 'JRF-entry-order' },
            expected: { size: 0.01, condition_type: 'MARKET', side: 'BUY', role: 'ENTRY' },
        },
        order_method: 'IFDOCO',
        parent_order_acceptance_id: 'JRF-v2-pending-meta-order',
        kind: 'bitflyer_parent_order_v1',
    }
    const updatedOrders: any[] = []
    const ctx = makeBaseCtx({
        getPendingOrdersV2: async () => [{
            id: 'v2-pending-meta-order',
            strategy: 'MA',
            broker: 'bitflyer',
            ticker: 'FX_BTC_JPY',
            side: 'BUY',
            order_type: 'IFDOCO',
            requested_size: 0.01,
            executed_size: 0,
            executed_price: null,
            status: 'PENDING',
            provider_order_ids: ['JRF-v2-pending-meta-order'],
            broker_order_metadata: metadata,
            created_at: new Date('2026-01-01T00:00:00Z'),
            updated_at: new Date('2026-01-01T00:00:00Z'),
        }],
        updateOrderV2: async (id, updates) => { updatedOrders.push({ id, ...updates }) },
        executionPriceFetchers: {
            bitflyer: {
                getExecutionPriceForOrderV2: async () => ({
                    execution: null,
                    brokerOrderMetadata: reorderedMetadata,
                }),
            },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(updatedOrders.length, 0)
})

test('executeTenMinutelyTask: 24時間超の Saxo PENDING 注文も同期対象にする', async () => {
    const oldPendingOrder: any = {
        id: 'v2-saxo-stale-pending',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        order_type: 'MARKET',
        status: 'PENDING',
        provider_order_ids: ['ORD-stale-pending'],
        requested_size: 1000,
        created_at: new Date(Date.now() - 25 * 60 * 60 * 1000),
    }
    let fetchCount = 0
    const updatedOrders: any[] = []

    const ctx = makeBaseCtx({
        getPendingOrdersV2: async () => [oldPendingOrder],
        updateOrderV2: async (id, updates) => { updatedOrders.push({ id, ...updates }) },
        executionPriceFetchers: {
            saxo: {
                getExecutionPriceForOrderV2: async () => {
                    fetchCount += 1
                    return { execution: { price: 101.5, size: 1000 } }
                },
            },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(fetchCount, 1)
    assert.equal(updatedOrders[0]?.status, 'EXECUTED')
})

test('executeTenMinutelyTask: Saxo PENDING 注文の約定同期は10件を超えてもスキップしない', async () => {
    const pendingOrders = Array.from({ length: 12 }, (_, index) => ({
        id: `v2-saxo-pending-${index}`,
        broker: 'saxo',
        ticker: 'FxSpot:21',
        order_type: 'MARKET',
        status: 'PENDING',
        provider_order_ids: [`ORD-saxo-pending-${index}`],
        requested_size: 1000,
        created_at: new Date(),
    } as any))
    let fetchCount = 0

    const ctx = makeBaseCtx({
        getPendingOrdersV2: async () => pendingOrders,
        updateOrderV2: async () => { },
        executionPriceFetchers: {
            saxo: {
                getExecutionPriceForOrderV2: async () => {
                    fetchCount += 1
                    return { execution: null }
                },
            },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(fetchCount, 12)
})

test('executeTenMinutelyTask: IFDOCO の決済約定を確認して exit レコードを作成・更新する (部分約定対応)', async () => {
    const order: any = {
        id: 'v2-ifd-partial',
        strategy: 'FX_BTC_JPY',
        broker: 'bitflyer',
        ticker: 'FX_BTC_JPY',
        side: 'BUY',
        order_type: 'IFDOCO',
        status: 'EXECUTED',
        exit_sync_status: 'MONITORING',
        provider_order_ids: ['PAR-ifd-partial'],
        requested_size: 0.01,
        executed_size: 0.01,
        created_at: new Date('2026-01-01T00:00:00Z'),
        executed_at: new Date('2026-01-01T00:01:00Z'),
    }

    // ケース1: 初回作成 (部分約定)
    const addedOrders: any[] = []
    const updatedOrders: any[] = []

    const ctx1 = makeBaseCtx({
        getActiveIfdOrdersV2: async () => [order],
        getOrderV2: async () => null,
        addOrderV2: async (o) => { addedOrders.push(o) },
        updateOrderV2: async (id, u) => { updatedOrders.push({ id, ...u }) },
        closingExecutionFetchers: {
            bitflyer: { getClosingExecutionForOrderV2: async () => ({ execution: { price: 10500000, size: 0.004, commission: 0 } }) },
        },
    })
    await executeTenMinutelyTask(ctx1)
    assert.equal(addedOrders.length, 1)
    assert.equal(addedOrders[0].id, 'v2-ifd-partial-exit')
    assert.equal(addedOrders[0].executed_size, 0.004)
    assert.deepEqual(addedOrders[0].execution_costs, { commission: 0 })
    assert.deepEqual(addedOrders[0].executed_at, new Date('2026-01-01T00:01:00Z'))
    assert.equal('exit_sync_status' in addedOrders[0], false)

    // ケース2: 追加約定
    const existingExit: any = addedOrders[0]
    const addedOrders2: any[] = []
    const updatedOrders2: any[] = []
    const ctx2 = makeBaseCtx({
        getActiveIfdOrdersV2: async () => [order],
        getOrderV2: async (id) => id === 'v2-ifd-partial-exit' ? existingExit : null,
        addOrderV2: async (o) => { addedOrders2.push(o) },
        updateOrderV2: async (id, u) => { updatedOrders2.push({ id, ...u }) },
        closingExecutionFetchers: {
            bitflyer: { getClosingExecutionForOrderV2: async () => ({ execution: { price: 10600000, size: 0.007, commission: 0.0002 } }) },
        },
    })
    await executeTenMinutelyTask(ctx2)
    assert.equal(addedOrders2.length, 0)
    assert.equal(updatedOrders2.length, 1)
    assert.equal(updatedOrders2[0].executed_size, 0.007)
    assert.equal(updatedOrders2[0].executed_price, 10600000)
    assert.deepEqual(updatedOrders2[0].execution_costs, { commission: 0.0002 })
    assert.deepEqual(updatedOrders2[0].executed_at, new Date('2026-01-01T00:01:00Z'))

    // ケース2.5: 同一 snapshot の再取得は no-op
    const noOpUpdates: any[] = []
    const noOpExistingExit = {
        ...existingExit,
        executed_at: new Date('2026-01-01T00:02:00Z'),
    }
    const noOpCtx = makeBaseCtx({
        getActiveIfdOrdersV2: async () => [order],
        getOrderV2: async (id) => id === 'v2-ifd-partial-exit' ? noOpExistingExit : null,
        addOrderV2: async () => { },
        updateOrderV2: async (id, u) => { noOpUpdates.push({ id, ...u }) },
        closingExecutionFetchers: {
            bitflyer: { getClosingExecutionForOrderV2: async () => ({ execution: { price: 10500000, size: 0.004, commission: 0 } }) },
        },
    })
    await executeTenMinutelyTask(noOpCtx)
    assert.equal(noOpUpdates.length, 0)

    // ケース3: full close で親注文の監視状態を COMPLETED にする
    const updatedOrders3: any[] = []
    const ctx3 = makeBaseCtx({
        getActiveIfdOrdersV2: async () => [order],
        getOrderV2: async (id) => id === 'v2-ifd-partial-exit' ? existingExit : null,
        addOrderV2: async () => { },
        updateOrderV2: async (id, u) => { updatedOrders3.push({ id, ...u }) },
        closingExecutionFetchers: {
            bitflyer: { getClosingExecutionForOrderV2: async () => ({ execution: { price: 10700000, size: 0.01, commission: 0.0003 } }) },
        },
    })
    await executeTenMinutelyTask(ctx3)
    assert.equal(updatedOrders3.length, 2)
    assert.deepEqual(updatedOrders3[0], {
        id: 'v2-ifd-partial-exit',
        executed_size: 0.01,
        executed_price: 10700000,
        executed_at: new Date('2026-01-01T00:01:00Z'),
        execution_costs: { commission: 0.0003 },
    })
    assert.deepEqual(updatedOrders3[1], {
        id: 'v2-ifd-partial',
        exit_sync_status: 'COMPLETED',
    })
})

test('executeTenMinutelyTask: IFDOCO の closing.size が requested_size を超えると更新しない', async () => {
    const order: any = {
        id: 'v2-ifd-invalid-size',
        strategy: 'FX_BTC_JPY',
        broker: 'bitflyer',
        ticker: 'FX_BTC_JPY',
        side: 'BUY',
        order_type: 'IFDOCO',
        status: 'EXECUTED',
        exit_sync_status: 'MONITORING',
        provider_order_ids: ['PAR-ifd-invalid-size'],
        requested_size: 0.01,
        executed_size: 0.01,
    }

    const addedOrders: any[] = []
    const updatedOrders: any[] = []

    const ctx = makeBaseCtx({
        getActiveIfdOrdersV2: async () => [order],
        getOrderV2: async () => null,
        addOrderV2: async (o) => { addedOrders.push(o) },
        updateOrderV2: async (id, u) => { updatedOrders.push({ id, ...u }) },
        closingExecutionFetchers: {
            bitflyer: { getClosingExecutionForOrderV2: async () => ({ execution: { price: 10500000, size: 0.02 } }) },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(addedOrders.length, 0)
    assert.equal(updatedOrders.length, 0)
})

test('executeTenMinutelyTask: IFDOCO の close metadata 解決結果を親 orders_v2 に保存する', async () => {
    const order: any = {
        id: 'v2-ifd-meta',
        strategy: 'FX_BTC_JPY',
        broker: 'bitflyer',
        ticker: 'FX_BTC_JPY',
        side: 'BUY',
        order_type: 'IFDOCO',
        status: 'EXECUTED',
        exit_sync_status: 'MONITORING',
        provider_order_ids: ['PAR-ifd-meta'],
        requested_size: 0.01,
        executed_size: 0.01,
        created_at: new Date('2026-01-01T00:00:00Z'),
        executed_at: new Date('2026-01-01T00:01:00Z'),
        broker_order_metadata: {
            kind: 'bitflyer_parent_order_v1',
            parent_order_acceptance_id: 'PAR-ifd-meta',
            order_method: 'IFDOCO',
            entry: {
                expected: { role: 'ENTRY', side: 'BUY', condition_type: 'MARKET', size: 0.01 },
                resolved: { acceptance_id: 'JRF-entry-meta' },
            },
            exits: [
                {
                    expected: { role: 'STOP_LOSS', side: 'SELL', condition_type: 'STOP', size: 0.01, trigger_price: 9500000 },
                    resolved: { acceptance_id: null },
                },
            ],
        },
    }

    const updatedOrders: any[] = []
    const addedOrders: any[] = []

    const ctx = makeBaseCtx({
        getActiveIfdOrdersV2: async () => [order],
        getOrderV2: async () => null,
        addOrderV2: async (o) => { addedOrders.push(o) },
        updateOrderV2: async (id, updates) => { updatedOrders.push({ id, ...updates }) },
        closingExecutionFetchers: {
            bitflyer: {
                getClosingExecutionForOrderV2: async () => ({
                    execution: { price: 10500000, size: 0.01, executed_at: new Date('2026-01-01T00:30:00Z') },
                    brokerOrderMetadata: {
                        ...order.broker_order_metadata,
                        exits: [
                            {
                                ...order.broker_order_metadata.exits[0],
                                resolved: { acceptance_id: 'JRF-stop-meta' },
                            },
                        ],
                    },
                }),
            },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(updatedOrders.length, 2)
    assert.deepEqual(updatedOrders[0].broker_order_metadata.exits[0].resolved, { acceptance_id: 'JRF-stop-meta' })
    assert.deepEqual(updatedOrders[1], { id: 'v2-ifd-meta', exit_sync_status: 'COMPLETED' })
    assert.equal(addedOrders.length, 1)
    assert.deepEqual(addedOrders[0].executed_at, new Date('2026-01-01T00:30:00Z'))
    assert.equal('execution_costs' in addedOrders[0], false)
})

test('executeTenMinutelyTask: Saxo の closingExecutionFetcher で exit レコードを作成する', async () => {
    const order: any = {
        id: 'v2-saxo-ifd',
        strategy: 'saxo-strategy',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'BUY',
        order_type: 'IFDOCO',
        status: 'EXECUTED',
        exit_sync_status: 'MONITORING',
        provider_order_ids: ['ORD-saxo-entry'],
        requested_size: 1,
        executed_size: 1,
        created_at: new Date('2026-01-01T00:00:00Z'),
        executed_at: new Date('2026-01-01T00:01:00Z'),
    }

    const addedOrders: any[] = []
    const updatedOrders: any[] = []

    const ctx = makeBaseCtx({
        getActiveIfdOrdersV2: async () => [order],
        getOrderV2: async () => null,
        addOrderV2: async (o) => { addedOrders.push(o) },
        updateOrderV2: async (id, u) => { updatedOrders.push({ id, ...u }) },
        closingExecutionFetchers: {
            saxo: { getClosingExecutionForOrderV2: async () => ({ execution: { price: 105, size: 1 } }) },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(addedOrders.length, 1)
    assert.equal(addedOrders[0].id, 'v2-saxo-ifd-exit')
    assert.equal(addedOrders[0].broker, 'saxo')
    assert.equal(addedOrders[0].executed_price, 105)
    assert.deepEqual(updatedOrders[0], { id: 'v2-saxo-ifd', exit_sync_status: 'COMPLETED' })
})

test('executeTenMinutelyTask: Saxo exit 同期は10件を超えてもスキップしない', async () => {
    const orders = Array.from({ length: 12 }, (_, index) => ({
        id: `v2-saxo-ifd-limit-${index}`,
        strategy: 'saxo-strategy',
        broker: 'saxo',
        ticker: 'FxSpot:21',
        side: 'BUY',
        order_type: 'IFDOCO',
        status: 'EXECUTED',
        exit_sync_status: 'MONITORING',
        provider_order_ids: [`ORD-saxo-entry-${index}`],
        requested_size: 1,
        executed_size: 1,
        created_at: new Date('2026-01-01T00:00:00Z'),
        executed_at: new Date('2026-01-01T00:01:00Z'),
    } as any))
    let fetchCount = 0

    const ctx = makeBaseCtx({
        getActiveIfdOrdersV2: async () => orders,
        getOrderV2: async () => null,
        addOrderV2: async () => { },
        updateOrderV2: async () => { },
        closingExecutionFetchers: {
            saxo: {
                getClosingExecutionForOrderV2: async () => {
                    fetchCount += 1
                    return { execution: null }
                },
            },
        },
    })

    await executeTenMinutelyTask(ctx)

    assert.equal(fetchCount, 12)
})
