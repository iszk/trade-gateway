import assert from 'node:assert/strict'
import test from 'node:test'
import { BalanceFetcher } from './balance-fetcher.js'
import { BitflyerClient } from '../brokers/bitflyer.js'

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
        collection: (col: string) => ({
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
