import assert from 'node:assert/strict'
import test from 'node:test'

import {
    createGetStrategySymbolPolicyFn,
    createPutStrategySymbolPolicyFn,
    createStrategySymbolPolicyId,
    InvalidStoredStrategySymbolPolicyError,
    InvalidStrategySymbolPolicyError,
    SymbolConstraintsRequiredError,
    SymbolNotFoundError,
    validateStrategySymbolPolicyInput,
} from './strategy-symbol-policies.js'

const makeFirestoreMock = () => {
    const collections: Record<string, Record<string, Record<string, unknown>>> = {}
    const writes: { collection: string; id: string; data: Record<string, unknown> }[] = []

    const ref = (collection: string, id: string) => ({ collection, id })
    const snapshot = (collection: string, id: string) => {
        const data = collections[collection]?.[id]
        return {
            id,
            exists: data !== undefined,
            data: () => data,
        }
    }
    const db = {
        collection: (collection: string) => ({
            doc: (id: string) => ({
                ...ref(collection, id),
                get: async () => snapshot(collection, id),
            }),
        }),
        runTransaction: async <T>(callback: (transaction: unknown) => Promise<T>) => callback({
            get: async (documentRef: { collection: string; id: string }) => snapshot(documentRef.collection, documentRef.id),
            set: (documentRef: { collection: string; id: string }, data: Record<string, unknown>) => {
                collections[documentRef.collection] ??= {}
                collections[documentRef.collection]![documentRef.id] = data
                writes.push({ collection: documentRef.collection, id: documentRef.id, data })
            },
        }),
        collections,
        writes,
    }

    return db as unknown as Parameters<typeof createGetStrategySymbolPolicyFn>[0] & {
        collections: typeof collections
        writes: typeof writes
    }
}

const symbolId = 'bitflyer:BTC_JPY'
const constraints = {
    quantity_step: 0.1,
    min_order_size: 0.1,
    max_order_size: 1,
}

const putInput = {
    strategy_id: 'strategy-1',
    symbol_id: symbolId,
    sizing_mode: 'MANAGED' as const,
    enabled: true,
    max_abs_position: 1,
    no_flip: true,
    base_order_size: 0.3,
    taper_strength: 0.5,
}

const seedSymbol = (
    db: ReturnType<typeof makeFirestoreMock>,
    orderConstraints: { quantity_step: number; min_order_size: number; max_order_size?: number } = constraints,
) => {
    db.collections.tradable_symbols ??= {}
    db.collections.tradable_symbols[symbolId] = {
        id: symbolId,
        order_constraints: orderConstraints,
    }
}

test('createStrategySymbolPolicyId validates strategy and symbol IDs', () => {
    assert.equal(createStrategySymbolPolicyId('strategy-1', 'saxo:FX:NAS100'), 'strategy-1:saxo:FX:NAS100')
    assert.throws(() => createStrategySymbolPolicyId('strategy/1', symbolId), InvalidStrategySymbolPolicyError)
    assert.throws(() => createStrategySymbolPolicyId(' strategy-1', symbolId), InvalidStrategySymbolPolicyError)
    assert.throws(() => createStrategySymbolPolicyId('strategy-1', 'bitflyer:BTC/JPY'), InvalidStrategySymbolPolicyError)
})

test('PUT/GET persists a managed policy with version and Date fields', async () => {
    const db = makeFirestoreMock()
    seedSymbol(db)
    const put = createPutStrategySymbolPolicyFn(db)
    const get = createGetStrategySymbolPolicyFn(db)

    const first = await put(putInput)
    assert.equal(first.version, 1)
    assert.ok(first.created_at instanceof Date)
    assert.ok(first.updated_at instanceof Date)
    assert.deepEqual(await get('strategy-1', symbolId), first)

    const second = await put({ ...putInput, base_order_size: 0.4 })
    assert.equal(second.version, 2)
    assert.equal(second.created_at.getTime(), first.created_at.getTime())
    assert.ok(second.updated_at.getTime() > first.updated_at.getTime())
    assert.equal(db.writes.length, 2)
})

test('WEBHOOK_CAPPED rejects managed-only fields and MANAGED requires them', () => {
    assert.doesNotThrow(() => validateStrategySymbolPolicyInput({
        strategy_id: 'strategy-1',
        symbol_id: symbolId,
        sizing_mode: 'WEBHOOK_CAPPED',
        enabled: false,
        max_abs_position: 1,
        no_flip: false,
    }, constraints))
    assert.throws(() => validateStrategySymbolPolicyInput({
        strategy_id: 'strategy-1',
        symbol_id: symbolId,
        sizing_mode: 'WEBHOOK_CAPPED',
        enabled: true,
        max_abs_position: 1,
        no_flip: false,
        base_order_size: 0.1,
    } as never, constraints), InvalidStrategySymbolPolicyError)
    assert.throws(() => validateStrategySymbolPolicyInput({
        strategy_id: 'strategy-1',
        symbol_id: symbolId,
        sizing_mode: 'MANAGED',
        enabled: true,
        max_abs_position: 1,
        no_flip: false,
    } as never, constraints), InvalidStrategySymbolPolicyError)
})

test('quantity step validation accepts floating point boundaries and rejects misaligned values', () => {
    assert.doesNotThrow(() => validateStrategySymbolPolicyInput({ ...putInput, max_abs_position: 0.3, base_order_size: 0.3 }, constraints))
    assert.doesNotThrow(() => validateStrategySymbolPolicyInput({ ...putInput, max_abs_position: 0.25, base_order_size: 0.25 }, {
        quantity_step: 0.25,
        min_order_size: 0.25,
    }))
    assert.throws(() => validateStrategySymbolPolicyInput({ ...putInput, max_abs_position: 0.35 }, constraints), InvalidStrategySymbolPolicyError)
    assert.throws(() => validateStrategySymbolPolicyInput({ ...putInput, base_order_size: 1.1 }, constraints), InvalidStrategySymbolPolicyError)
})

test('repository validates 0.001 steps, taper boundaries, numeric ranges, and max-order semantics', async () => {
    const stepConstraints = {
        quantity_step: 0.001,
        min_order_size: 0.01,
        max_order_size: 0.5,
    }
    const db = makeFirestoreMock()
    seedSymbol(db, stepConstraints)
    const put = createPutStrategySymbolPolicyFn(db)
    const validManaged = {
        ...putInput,
        max_abs_position: 1,
        base_order_size: 0.1,
        taper_strength: 0,
    }

    await assert.doesNotReject(put(validManaged))
    await assert.doesNotReject(put({ ...validManaged, taper_strength: 1 }))
    // max_abs_position は累積上限のため max_order_size を超えてよい。
    await assert.doesNotReject(put({ ...validManaged, max_abs_position: 1, base_order_size: 0.5 }))

    const writesBeforeInvalidInputs = db.writes.length
    const invalidInputs = [
        { ...validManaged, max_abs_position: Number.NaN },
        { ...validManaged, max_abs_position: Number.POSITIVE_INFINITY },
        { ...validManaged, max_abs_position: 0 },
        { ...validManaged, max_abs_position: -0.001 },
        { ...validManaged, max_abs_position: 0.0105 },
        { ...validManaged, max_abs_position: 0.009 },
        { ...validManaged, base_order_size: Number.NaN },
        { ...validManaged, base_order_size: Number.NEGATIVE_INFINITY },
        { ...validManaged, base_order_size: 0 },
        { ...validManaged, base_order_size: -0.001 },
        { ...validManaged, base_order_size: 0.009 },
        { ...validManaged, base_order_size: 0.101, max_abs_position: 0.1 },
        { ...validManaged, base_order_size: 1.001, max_abs_position: 1.001 },
        { ...validManaged, base_order_size: 0.501 },
        { ...validManaged, taper_strength: Number.NaN },
        { ...validManaged, taper_strength: Number.POSITIVE_INFINITY },
        { ...validManaged, taper_strength: -Number.EPSILON },
        { ...validManaged, taper_strength: 1 + Number.EPSILON },
    ]
    for (const input of invalidInputs) {
        await assert.rejects(put(input), InvalidStrategySymbolPolicyError)
    }
    assert.equal(db.writes.length, writesBeforeInvalidInputs)

    const disabledInvalid = { ...validManaged, enabled: false, max_abs_position: 0.0105 }
    await assert.rejects(put(disabledInvalid), InvalidStrategySymbolPolicyError)
    assert.equal(db.writes.length, writesBeforeInvalidInputs)
})

test('repository rejects a large step ratio instead of accepting a fractional quantity', async () => {
    const db = makeFirestoreMock()
    seedSymbol(db, {
        quantity_step: 0.001,
        min_order_size: 0.001,
    })
    const put = createPutStrategySymbolPolicyFn(db)

    for (const max_abs_position of [
        1_000_000_000_000.00025,
        1_000_000_000_000.0005,
    ]) {
        await assert.rejects(put({
            ...putInput,
            max_abs_position,
            base_order_size: 0.001,
        }), InvalidStrategySymbolPolicyError)
    }
    assert.equal(db.writes.length, 0)
})

test('PUT fails closed for missing symbols, missing constraints, and invalid policy without writing', async () => {
    const missingSymbolDb = makeFirestoreMock()
    const putMissingSymbol = createPutStrategySymbolPolicyFn(missingSymbolDb)
    await assert.rejects(putMissingSymbol(putInput), SymbolNotFoundError)
    assert.equal(missingSymbolDb.writes.length, 0)

    const missingConstraintsDb = makeFirestoreMock()
    missingConstraintsDb.collections.tradable_symbols = {
        [symbolId]: { id: symbolId },
    }
    await assert.rejects(createPutStrategySymbolPolicyFn(missingConstraintsDb)(putInput), SymbolConstraintsRequiredError)
    assert.equal(missingConstraintsDb.writes.length, 0)

    const invalidPolicyDb = makeFirestoreMock()
    seedSymbol(invalidPolicyDb)
    await assert.rejects(createPutStrategySymbolPolicyFn(invalidPolicyDb)({
        ...putInput,
        max_abs_position: 0.05,
    }), InvalidStrategySymbolPolicyError)
    assert.equal(invalidPolicyDb.writes.length, 0)
})

test('GET rejects a corrupted stored document instead of normalizing it', async () => {
    const db = makeFirestoreMock()
    db.collections.strategy_symbol_policies = {
        [createStrategySymbolPolicyId('strategy-1', symbolId)]: {
            id: 'wrong-id',
            strategy_id: 'strategy-1',
            symbol_id: symbolId,
            sizing_mode: 'WEBHOOK_CAPPED',
            enabled: true,
            max_abs_position: 1,
            no_flip: true,
            version: 1,
            created_at: new Date(),
            updated_at: new Date(),
        },
    }

    await assert.rejects(
        createGetStrategySymbolPolicyFn(db)('strategy-1', symbolId),
        InvalidStoredStrategySymbolPolicyError,
    )
})
