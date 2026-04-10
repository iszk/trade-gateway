import assert from 'node:assert/strict'
import test from 'node:test'

import { computeSlotId, createSlotScheduler } from './slot-scheduler.js'
import type { SlotScheduler } from './slot-scheduler.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FirestoreMock = Parameters<typeof createSlotScheduler>[0] & {
    _getStoredData(): Record<string, unknown>
    _getTransactionCount(): number
}

const makeFirestoreMock = (initialData: Record<string, unknown> = {}): FirestoreMock => {
    let storedData = { ...initialData }
    let transactionCount = 0

    const db = {
        collection: (_name: string) => ({
            doc: (_id: string) => ({ _isDocRef: true }),
        }),
        runTransaction: async (fn: (tx: unknown) => Promise<void>) => {
            transactionCount++
            let pendingData: Record<string, unknown> | null = null

            const tx = {
                get: async (_ref: unknown) => ({
                    data: () => Object.keys(storedData).length > 0 ? { ...storedData } : undefined,
                }),
                set: (_ref: unknown, data: Record<string, unknown>, _opts: unknown) => {
                    pendingData = { ...storedData, ...data }
                },
            }

            await fn(tx)

            if (pendingData !== null) {
                storedData = pendingData
            }
        },
        _getStoredData: () => storedData,
        _getTransactionCount: () => transactionCount,
    }

    return db as unknown as FirestoreMock
}

const createLoggerStub = () => {
    const calls: { level: string; obj: Record<string, unknown> }[] = []
    const logger = {
        info: (obj: Record<string, unknown>) => calls.push({ level: 'info', obj }),
        warn: (obj: Record<string, unknown>) => calls.push({ level: 'warn', obj }),
    }
    return { logger, calls }
}

// ---------------------------------------------------------------------------
// computeSlotId
// ---------------------------------------------------------------------------

test('computeSlotId: basic slot calculation with 600s interval', () => {
    // nowSeconds = 1000 → floor((1000 - 30) / 600) = floor(970 / 600) = 1
    assert.equal(computeSlotId(1_000 * 1_000, 600), 1)
})

test('computeSlotId: basic slot calculation with 3600s interval', () => {
    // nowSeconds = 1000 → floor((1000 - 30) / 3600) = floor(970 / 3600) = 0
    assert.equal(computeSlotId(1_000 * 1_000, 3600), 0)
})

test('computeSlotId: stable across ±1s jitter around a nominal cron fire time', () => {
    // Nominal fire at 09:00:00 = 32400s. New 10-min slot becomes active at
    // nowSeconds = 30 + 600k. With k=54: 30 + 32400 = 32430 = 09:00:30.
    // So at 09:00:00, 09:00:01, 08:59:59 we are all still in slot 53.
    const base = 9 * 3600 // 09:00:00
    const slotAtExact  = computeSlotId(base * 1_000, 600)
    const slotAtPlus1  = computeSlotId((base + 1) * 1_000, 600)
    const slotAtMinus1 = computeSlotId((base - 1) * 1_000, 600)
    assert.equal(slotAtExact, slotAtPlus1)
    assert.equal(slotAtExact, slotAtMinus1)
})

test('computeSlotId: increments at the correct boundary', () => {
    const interval = 600
    // Boundary occurs when nowSeconds - 30 crosses a multiple of 600.
    // At nowSeconds = 630: floor((630-30)/600) = floor(600/600) = 1
    // At nowSeconds = 629: floor((629-30)/600) = floor(599/600) = 0
    assert.equal(computeSlotId(629 * 1_000, interval), 0)
    assert.equal(computeSlotId(630 * 1_000, interval), 1)
})

// ---------------------------------------------------------------------------
// createSlotScheduler
// ---------------------------------------------------------------------------

test('runIfNewSlot: runs task and updates Firestore when no previous slot exists', async () => {
    const db = makeFirestoreMock()
    const scheduler: SlotScheduler = createSlotScheduler(db)
    const { logger, calls } = createLoggerStub()

    let taskRan = false
    // nowMs = 1000s → slot 1 for 600s interval
    await scheduler.runIfNewSlot({
        nowMs: 1_000 * 1_000,
        intervalSeconds: 600,
        slotKey: 'last_slot_10m',
        task: async () => { taskRan = true },
        logger,
    })

    assert.ok(taskRan, 'task should have run')
    assert.equal(db._getStoredData()['last_slot_10m'], 1)
    assert.ok(calls.some(c => c.obj['event'] === 'slot_scheduler:task_started'))
    assert.ok(calls.some(c => c.obj['event'] === 'slot_scheduler:task_completed'))
})

test('runIfNewSlot: skips task when current slot equals the stored slot', async () => {
    const db = makeFirestoreMock({ last_slot_10m: 1 })
    const scheduler: SlotScheduler = createSlotScheduler(db)
    const { logger } = createLoggerStub()

    let taskRan = false
    // Same slot (1) as stored
    await scheduler.runIfNewSlot({
        nowMs: 1_000 * 1_000,
        intervalSeconds: 600,
        slotKey: 'last_slot_10m',
        task: async () => { taskRan = true },
        logger,
    })

    assert.ok(!taskRan, 'task should not have run')
    assert.equal(db._getStoredData()['last_slot_10m'], 1) // unchanged
})

test('runIfNewSlot: runs task when current slot is newer than stored slot', async () => {
    const db = makeFirestoreMock({ last_slot_10m: 0 })
    const scheduler: SlotScheduler = createSlotScheduler(db)
    const { logger } = createLoggerStub()

    let taskRan = false
    // nowMs = 1000s → slot 1, stored slot = 0 → should run
    await scheduler.runIfNewSlot({
        nowMs: 1_000 * 1_000,
        intervalSeconds: 600,
        slotKey: 'last_slot_10m',
        task: async () => { taskRan = true },
        logger,
    })

    assert.ok(taskRan, 'task should have run')
    assert.equal(db._getStoredData()['last_slot_10m'], 1)
})

test('runIfNewSlot: does not interfere between different slot keys', async () => {
    const db = makeFirestoreMock({ last_slot_10m: 1, last_slot_1h: 0 })
    const scheduler: SlotScheduler = createSlotScheduler(db)
    const { logger } = createLoggerStub()

    let task10mRan = false
    let task1hRan = false

    // slot for 600s @ 1000s = 1 (same as stored) → skip
    await scheduler.runIfNewSlot({
        nowMs: 1_000 * 1_000,
        intervalSeconds: 600,
        slotKey: 'last_slot_10m',
        task: async () => { task10mRan = true },
        logger,
    })

    // slot for 3600s @ 4000s = floor((4000-30)/3600) = floor(3970/3600) = 1 > 0 → run
    await scheduler.runIfNewSlot({
        nowMs: 4_000 * 1_000,
        intervalSeconds: 3600,
        slotKey: 'last_slot_1h',
        task: async () => { task1hRan = true },
        logger,
    })

    assert.ok(!task10mRan, '10m task should have been skipped')
    assert.ok(task1hRan, '1h task should have run')
    assert.equal(db._getStoredData()['last_slot_10m'], 1) // unchanged
    assert.equal(db._getStoredData()['last_slot_1h'], 1)  // updated
})

test('runIfNewSlot: catches Firestore errors and logs a warning without rethrowing', async () => {
    const db = {
        collection: (_name: string) => ({
            doc: (_id: string) => ({ _isDocRef: true }),
        }),
        runTransaction: async (_fn: unknown) => {
            throw new Error('Firestore unavailable')
        },
    } as unknown as Parameters<typeof createSlotScheduler>[0]

    const scheduler: SlotScheduler = createSlotScheduler(db)
    const { logger, calls } = createLoggerStub()

    // Should not throw
    await assert.doesNotReject(() =>
        scheduler.runIfNewSlot({
            nowMs: 1_000 * 1_000,
            intervalSeconds: 600,
            slotKey: 'last_slot_10m',
            task: async () => {},
            logger,
        }),
    )

    const warnCall = calls.find(c => c.level === 'warn' && c.obj['event'] === 'slot_scheduler:error')
    assert.ok(warnCall, 'should log a warning on Firestore error')
    assert.equal(warnCall?.obj['error'], 'Firestore unavailable')
})

test('runIfNewSlot: second concurrent call for the same slot does not run the task again', async () => {
    // Simulate the scenario where a slot update is committed by the first call.
    // A second call with the same nowMs should skip.
    const db = makeFirestoreMock()
    const scheduler: SlotScheduler = createSlotScheduler(db)
    const { logger } = createLoggerStub()

    let runCount = 0
    const task = async () => { runCount++ }

    const nowMs = 1_000 * 1_000 // slot 1

    await scheduler.runIfNewSlot({ nowMs, intervalSeconds: 600, slotKey: 'last_slot_10m', task, logger })
    await scheduler.runIfNewSlot({ nowMs, intervalSeconds: 600, slotKey: 'last_slot_10m', task, logger })

    assert.equal(runCount, 1, 'task should run exactly once')
})
