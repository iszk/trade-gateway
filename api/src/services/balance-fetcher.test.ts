import assert from 'node:assert/strict'
import test from 'node:test'
import { BalanceFetcher } from './balance-fetcher.js'
import { BitflyerClient } from '../brokers/bitflyer.js'
import { SaxoClient } from '../brokers/saxo.js'

test('BalanceFetcher fetches and filters balances correctly', async () => {
    const mockBitflyerClient = {
        getBalances: async () => [
            { currency_code: 'JPY', amount: 100, available: 100 },
            { currency_code: 'BTC', amount: 0, available: 0 },
            { currency_code: 'ETH', amount: 1.5, available: 1.5 },
        ],
        getCollateral: async () => ({
            collateral: 50000,
            open_pnl: 100,
            keep_rate: 2.5
        })
    } as unknown as BitflyerClient

    let capturedDocId = ''
    let capturedData: any = null

    const mockFirestore = {
        collection: (_col: string) => ({
            doc: (docId: string) => ({
                set: async (data: any) => {
                    capturedDocId = docId
                    capturedData = data
                }
            })
        })
    } as any

    const fetcher = new BalanceFetcher({
        db: mockFirestore,
        bitflyerClient: mockBitflyerClient
    })

    const result = await fetcher.fetchAndStoreBitflyerBalances()

    assert.equal(result.broker, 'bitflyer')
    assert.equal(result.balances.length, 3) // JPY, ETH, CFD_JPY
    assert.deepEqual(result.balances.find(b => b.asset === 'JPY'), { asset: 'JPY', amount: 100 })
    assert.deepEqual(result.balances.find(b => b.asset === 'ETH'), { asset: 'ETH', amount: 1.5 })
    assert.deepEqual(result.balances.find(b => b.asset === 'CFD_JPY'), { asset: 'CFD_JPY', amount: 50000 })
    assert.ok(result.balances.every(b => b.amount !== 0))

    assert.ok(capturedDocId.endsWith('_bitflyer'))
    assert.deepEqual(capturedData.balances, result.balances)
})

test('BalanceFetcher fetches and stores Saxo balances', async () => {
    const mockSaxoClient = {
        getBalances: async () => [
            { asset: 'USD', amount: 1000 },
            { asset: 'USD_TOTAL_VALUE', amount: 1250 },
        ],
    } as unknown as SaxoClient

    let capturedDocId = ''
    let capturedData: any = null

    const mockFirestore = {
        collection: (_col: string) => ({
            doc: (docId: string) => ({
                set: async (data: any) => {
                    capturedDocId = docId
                    capturedData = data
                }
            })
        })
    } as any

    const fetcher = new BalanceFetcher({
        db: mockFirestore,
        saxoClient: mockSaxoClient
    })

    const result = await fetcher.fetchAndStoreSaxoBalances()

    assert.equal(result.broker, 'saxo')
    assert.deepEqual(result.balances, [
        { asset: 'USD', amount: 1000 },
        { asset: 'USD_TOTAL_VALUE', amount: 1250 },
    ])
    assert.ok(capturedDocId.endsWith('_saxo'))
    assert.deepEqual(capturedData.balances, result.balances)
})

test('BalanceFetcher fetches all implemented broker balances', async () => {
    const mockBitflyerClient = {
        getBalances: async () => [
            { currency_code: 'JPY', amount: 100, available: 100 },
        ],
        getCollateral: async () => null,
    } as unknown as BitflyerClient
    const mockSaxoClient = {
        getBalances: async () => [
            { asset: 'USD', amount: 1000 },
        ],
    } as unknown as SaxoClient

    const capturedDocIds: string[] = []

    const mockFirestore = {
        collection: (_col: string) => ({
            doc: (docId: string) => ({
                set: async () => {
                    capturedDocIds.push(docId)
                }
            })
        })
    } as any

    const fetcher = new BalanceFetcher({
        db: mockFirestore,
        bitflyerClient: mockBitflyerClient,
        saxoClient: mockSaxoClient,
    })

    const result = await fetcher.fetchAllBalances()

    assert.deepEqual(result.map(b => b.broker), ['bitflyer', 'saxo'])
    assert.equal(capturedDocIds.length, 2)
    assert.ok(capturedDocIds.some(id => id.endsWith('_bitflyer')))
    assert.ok(capturedDocIds.some(id => id.endsWith('_saxo')))
})
