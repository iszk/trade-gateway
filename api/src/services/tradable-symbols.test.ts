import test from 'node:test'
import assert from 'node:assert/strict'

import { createEnsureTradableSymbolFn, createGetTradableSymbolFn, createListTradableSymbolsFn, createSymbolId, createUpdateTradeControlFn, createUpsertTradableSymbolFn, InvalidStoredTradableSymbolError, parseSymbolId } from './tradable-symbols.js'
import type { OrderConstraints } from '../types/tradable-symbol.js'

const makeFirestoreMock = () => {
    const docs: Record<string, any> = {}
    const writes = { set: 0 }

    const docRef = (id: string) => ({
        create: async (data: unknown) => {
            if (id in docs) {
                const error = new Error('Document already exists') as Error & { code: number }
                error.code = 6
                throw error
            }
            docs[id] = data
        },
        get: async () => ({
            exists: id in docs,
            data: () => docs[id],
        }),
        set: async (data: unknown) => {
            writes.set += 1
            docs[id] = data
        },
    })

    const db = {
        collection: (_name: string) => ({
            doc: (id: string) => docRef(id),
            orderBy: (_field: string, _direction: string) => ({
                get: async () => ({
                    docs: Object.values(docs)
                        .sort((a, b) => String(a.id).localeCompare(String(b.id)))
                        .map((data) => ({
                            data: () => data,
                        })),
                }),
            }),
        }),
        docs,
        writes,
    }

    return db as unknown as Parameters<typeof createEnsureTradableSymbolFn>[0] & {
        docs: Record<string, any>
        writes: typeof writes
    }
}

const baseSymbolInput = {
    id: 'bitflyer:BTC_JPY',
    broker: 'bitflyer' as const,
    ticker: 'BTC_JPY',
    currency: 'JPY',
}

const validOrderConstraints: OrderConstraints = {
    quantity_step: 0.001,
    min_order_size: 0.1,
    max_order_size: 0.25,
}

test('createSymbolId joins broker and ticker', () => {
    assert.equal(createSymbolId('saxo', 'FX:NAS100'), 'saxo:FX:NAS100')
})

test('parseSymbolId splits by first colon', () => {
    assert.deepEqual(parseSymbolId('saxo:FX:NAS100'), {
        broker: 'saxo',
        ticker: 'FX:NAS100',
    })
})

test('parseSymbolId rejects slash', () => {
    assert.equal(parseSymbolId('bitflyer:BTC/JPY'), null)
})

test('ensureTradableSymbol creates default active JPY symbol', async () => {
    const db = makeFirestoreMock()
    const ensureTradableSymbol = createEnsureTradableSymbolFn(db)

    await ensureTradableSymbol({ broker: 'bitflyer', ticker: 'BTC_JPY' })

    const doc = db.docs['bitflyer:BTC_JPY']
    assert.equal(doc.id, 'bitflyer:BTC_JPY')
    assert.equal(doc.currency, 'JPY')
    assert.equal(doc.trade_control.status, 'active')
})

test('getTradableSymbol returns null when document does not exist', async () => {
    const db = makeFirestoreMock()
    const getTradableSymbol = createGetTradableSymbolFn(db)

    assert.equal(await getTradableSymbol('bitflyer:BTC_JPY'), null)
})

test('upsertTradableSymbol saves metadata', async () => {
    const db = makeFirestoreMock()
    const upsertTradableSymbol = createUpsertTradableSymbolFn(db)

    const symbol = await upsertTradableSymbol({
        id: 'bitflyer:BTC_JPY',
        broker: 'bitflyer',
        ticker: 'BTC_JPY',
        display_name: 'BTC/JPY',
        currency: 'JPY',
        note: 'main symbol',
    })

    assert.equal(symbol.display_name, 'BTC/JPY')
    assert.equal(symbol.trade_control.status, 'active')
    assert.equal(db.docs['bitflyer:BTC_JPY'].note, 'main symbol')
})

test('upsertTradableSymbol saves and reads order constraints without changing numeric values', async () => {
    const db = makeFirestoreMock()
    const upsertTradableSymbol = createUpsertTradableSymbolFn(db)
    const getTradableSymbol = createGetTradableSymbolFn(db)
    const listTradableSymbols = createListTradableSymbolsFn(db)

    const symbol = await upsertTradableSymbol({
        ...baseSymbolInput,
        order_constraints: validOrderConstraints,
    })

    assert.deepEqual(db.docs['bitflyer:BTC_JPY'].order_constraints, validOrderConstraints)
    assert.deepEqual(symbol.order_constraints, validOrderConstraints)
    assert.deepEqual((await getTradableSymbol('bitflyer:BTC_JPY'))?.order_constraints, validOrderConstraints)
    assert.deepEqual((await listTradableSymbols())[0]?.order_constraints, validOrderConstraints)
})

test('upsertTradableSymbol accepts equal max and min and omitted max', async () => {
    const db = makeFirestoreMock()
    const upsertTradableSymbol = createUpsertTradableSymbolFn(db)

    const equalBounds = await upsertTradableSymbol({
        ...baseSymbolInput,
        order_constraints: {
            quantity_step: 0.1,
            min_order_size: 1,
            max_order_size: 1,
        },
    })
    assert.equal(equalBounds.order_constraints?.max_order_size, 1)

    const noMax = await upsertTradableSymbol({
        ...baseSymbolInput,
        order_constraints: {
            quantity_step: 0.25,
            min_order_size: 2,
        },
    })
    assert.deepEqual(noMax.order_constraints, {
        quantity_step: 0.25,
        min_order_size: 2,
    })
})

test('upsertTradableSymbol rejects invalid order constraints before writing', async () => {
    const invalidConstraints: unknown[] = [
        { quantity_step: 0, min_order_size: 0.1 },
        { quantity_step: -0.1, min_order_size: 0.1 },
        { quantity_step: 0.1, min_order_size: 0 },
        { quantity_step: 0.1, min_order_size: -1 },
        { quantity_step: Number.NaN, min_order_size: 0.1 },
        { quantity_step: Number.POSITIVE_INFINITY, min_order_size: 0.1 },
        { quantity_step: 0.1, min_order_size: 0.2, max_order_size: 0.1 },
        { quantity_step: 0.1, min_order_size: 0.2, max_order_size: Number.NaN },
    ]

    for (const order_constraints of invalidConstraints) {
        const db = makeFirestoreMock()
        const upsertTradableSymbol = createUpsertTradableSymbolFn(db)

        await assert.rejects(
            upsertTradableSymbol({
                ...baseSymbolInput,
                order_constraints: order_constraints as OrderConstraints,
            }),
            /invalid order_constraints/,
        )
        assert.equal(db.writes.set, 0)
    }
})

test('upsertTradableSymbol preserves existing order constraints when omitted', async () => {
    const db = makeFirestoreMock()
    const upsertTradableSymbol = createUpsertTradableSymbolFn(db)

    await upsertTradableSymbol({
        ...baseSymbolInput,
        order_constraints: validOrderConstraints,
    })
    const updated = await upsertTradableSymbol({
        ...baseSymbolInput,
        display_name: 'BTC/JPY',
    })

    assert.deepEqual(updated.order_constraints, validOrderConstraints)
    assert.deepEqual(db.docs['bitflyer:BTC_JPY'].order_constraints, validOrderConstraints)
})

test('updateTradeControl creates symbol when missing', async () => {
    const db = makeFirestoreMock()
    const updateTradeControl = createUpdateTradeControlFn(db)

    const symbol = await updateTradeControl('saxo:FX:NAS100', {
        status: 'paused',
        reason: 'manual stop',
        updated_by: 'ui',
    })

    assert.equal(symbol.broker, 'saxo')
    assert.equal(symbol.ticker, 'FX:NAS100')
    assert.equal(symbol.currency, 'JPY')
    assert.equal(symbol.trade_control.status, 'paused')
    assert.equal(symbol.trade_control.reason, 'manual stop')
})

test('updateTradeControl preserves existing order constraints', async () => {
    const db = makeFirestoreMock()
    const upsertTradableSymbol = createUpsertTradableSymbolFn(db)
    const updateTradeControl = createUpdateTradeControlFn(db)

    await upsertTradableSymbol({
        ...baseSymbolInput,
        order_constraints: validOrderConstraints,
    })
    const updated = await updateTradeControl('bitflyer:BTC_JPY', {
        status: 'paused',
        reason: 'manual stop',
    })

    assert.deepEqual(updated.order_constraints, validOrderConstraints)
    assert.deepEqual(db.docs['bitflyer:BTC_JPY'].order_constraints, validOrderConstraints)
})

test('get and list accept legacy symbols without order constraints', async () => {
    const db = makeFirestoreMock()
    const upsertTradableSymbol = createUpsertTradableSymbolFn(db)
    const getTradableSymbol = createGetTradableSymbolFn(db)
    const listTradableSymbols = createListTradableSymbolsFn(db)

    await upsertTradableSymbol(baseSymbolInput)

    const symbol = await getTradableSymbol(baseSymbolInput.id)
    const symbols = await listTradableSymbols()
    assert.equal(symbol?.order_constraints, undefined)
    assert.equal(symbols[0]?.order_constraints, undefined)
    assert.equal(Object.hasOwn(symbol ?? {}, 'order_constraints'), false)
    assert.equal(Object.hasOwn(db.docs[baseSymbolInput.id], 'order_constraints'), false)
})

test('get and list reject symbols with invalid stored order constraints', async () => {
    const db = makeFirestoreMock()
    const getTradableSymbol = createGetTradableSymbolFn(db)
    const listTradableSymbols = createListTradableSymbolsFn(db)

    db.docs[baseSymbolInput.id] = {
        ...baseSymbolInput,
        order_constraints: {
            quantity_step: 0,
            min_order_size: 0.1,
        },
        trade_control: {
            status: 'active',
            updated_at: new Date(),
        },
        created_at: new Date(),
        updated_at: new Date(),
    }

    await assert.rejects(
        getTradableSymbol(baseSymbolInput.id),
        (error: unknown) => error instanceof InvalidStoredTradableSymbolError && /invalid order_constraints/.test(String(error)),
    )
    await assert.rejects(
        listTradableSymbols(),
        (error: unknown) => error instanceof InvalidStoredTradableSymbolError && /invalid order_constraints/.test(String(error)),
    )
})

test('listTradableSymbols returns symbols sorted by id', async () => {
    const db = makeFirestoreMock()
    const upsertTradableSymbol = createUpsertTradableSymbolFn(db)
    const listTradableSymbols = createListTradableSymbolsFn(db)

    await upsertTradableSymbol({ id: 'saxo:FX:NAS100', broker: 'saxo', ticker: 'FX:NAS100', currency: 'USD' })
    await upsertTradableSymbol({ id: 'bitflyer:BTC_JPY', broker: 'bitflyer', ticker: 'BTC_JPY', currency: 'JPY' })

    const symbols = await listTradableSymbols()

    assert.deepEqual(symbols.map((symbol) => symbol.id), ['bitflyer:BTC_JPY', 'saxo:FX:NAS100'])
})
