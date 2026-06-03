import test from 'node:test'
import assert from 'node:assert/strict'

import { createEnsureTradableSymbolFn, createGetTradableSymbolFn, createListTradableSymbolsFn, createSymbolId, createUpdateTradeControlFn, createUpsertTradableSymbolFn, parseSymbolId } from './tradable-symbols.js'

const makeFirestoreMock = () => {
    const docs: Record<string, any> = {}

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
    }

    return db as unknown as Parameters<typeof createEnsureTradableSymbolFn>[0] & { docs: Record<string, any> }
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

test('listTradableSymbols returns symbols sorted by id', async () => {
    const db = makeFirestoreMock()
    const upsertTradableSymbol = createUpsertTradableSymbolFn(db)
    const listTradableSymbols = createListTradableSymbolsFn(db)

    await upsertTradableSymbol({ id: 'saxo:FX:NAS100', broker: 'saxo', ticker: 'FX:NAS100', currency: 'USD' })
    await upsertTradableSymbol({ id: 'bitflyer:BTC_JPY', broker: 'bitflyer', ticker: 'BTC_JPY', currency: 'JPY' })

    const symbols = await listTradableSymbols()

    assert.deepEqual(symbols.map((symbol) => symbol.id), ['bitflyer:BTC_JPY', 'saxo:FX:NAS100'])
})
