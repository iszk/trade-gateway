import assert from 'node:assert/strict'
import test from 'node:test'

import { PositionFetcher } from './position-fetcher.js'
import type { Position } from '../types/position.js'
import type { TradableSymbol } from '../types/tradable-symbol.js'

const makeSymbol = (ticker: string, broker: TradableSymbol['broker'] = 'bitflyer'): TradableSymbol => ({
    id: `${broker}:${ticker}`,
    broker,
    ticker,
    currency: 'JPY',
    trade_control: {
        status: 'active',
        updated_at: new Date('2026-01-01T00:00:00Z'),
    },
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
})

test('PositionFetcher passes bitflyer tradable symbol tickers to BitflyerClient', async () => {
    const requestedProductCodes: string[][] = []
    const bitflyerPositions: Position[] = [
        {
            broker: 'bitflyer',
            ticker: 'FX_BTC_JPY',
            side: 'BUY',
            size: 0.01,
            price: 10000000,
        },
    ]

    const fetcher = new PositionFetcher({
        bitflyerClient: {
            getPositions: async (productCodes?: string[]) => {
                requestedProductCodes.push(productCodes ?? [])
                return bitflyerPositions
            },
        } as any,
        dummyClient: { getPositions: async () => [] } as any,
        saxoClient: { getPositions: async () => [] } as any,
        listTradableSymbols: async () => [
            makeSymbol('FX_BTC_JPY'),
            makeSymbol('BTC_JPY'),
            makeSymbol('FxSpot:21', 'saxo'),
        ],
    })

    const positions = await fetcher.fetchAllPositions('bitflyer')

    assert.deepEqual(requestedProductCodes, [['FX_BTC_JPY', 'BTC_JPY']])
    assert.deepEqual(positions, bitflyerPositions)
})

test('PositionFetcher skips bitflyer positions when bitflyer symbols are unavailable', async () => {
    const requestedProductCodes: string[][] = []
    const fetcher = new PositionFetcher({
        bitflyerClient: {
            getPositions: async (productCodes?: string[]) => {
                requestedProductCodes.push(productCodes ?? [])
                return []
            },
        } as any,
        dummyClient: { getPositions: async () => [] } as any,
        saxoClient: { getPositions: async () => [] } as any,
        listTradableSymbols: async () => {
            throw new Error('firestore unavailable')
        },
    })

    const positions = await fetcher.fetchAllPositions('bitflyer')

    assert.deepEqual(requestedProductCodes, [])
    assert.deepEqual(positions, [])
})

test('PositionFetcher skips bitflyer positions when no bitflyer symbols are configured', async () => {
    const requestedProductCodes: string[][] = []
    const fetcher = new PositionFetcher({
        bitflyerClient: {
            getPositions: async (productCodes?: string[]) => {
                requestedProductCodes.push(productCodes ?? [])
                return []
            },
        } as any,
        dummyClient: { getPositions: async () => [] } as any,
        saxoClient: { getPositions: async () => [] } as any,
        listTradableSymbols: async () => [
            makeSymbol('FxSpot:21', 'saxo'),
            makeSymbol('   '),
        ],
    })

    const positions = await fetcher.fetchAllPositions('bitflyer')

    assert.deepEqual(requestedProductCodes, [])
    assert.deepEqual(positions, [])
})

test('PositionFetcher reconciliation path propagates Bitflyer strict snapshot failures', async () => {
    const fetcher = new PositionFetcher({
        bitflyerClient: {
            getPositions: async () => [],
            getPositionsForReconciliation: async () => { throw new Error('second ticker failed') },
        },
        dummyClient: { getPositions: async () => [] },
        saxoClient: { getPositions: async () => [] },
        listTradableSymbols: async () => [makeSymbol('BTC_JPY')],
    })

    await assert.rejects(
        fetcher.fetchPositionsForReconciliation('bitflyer'),
        /second ticker failed/,
    )
})

test('PositionFetcher reconciliation path does not turn symbol-list failure into an empty snapshot', async () => {
    const fetcher = new PositionFetcher({
        bitflyerClient: {
            getPositions: async () => [],
        },
        dummyClient: { getPositions: async () => [] },
        saxoClient: { getPositions: async () => [] },
        listTradableSymbols: async () => { throw new Error('firestore unavailable') },
    })

    await assert.rejects(
        fetcher.fetchPositionsForReconciliation('bitflyer'),
        /firestore unavailable/,
    )
})

test('PositionFetcher does not fallback to Bitflyer best-effort positions without a strict seam', async () => {
    const fetcher = new PositionFetcher({
        bitflyerClient: { getPositions: async () => [{ broker: 'bitflyer', ticker: 'BTC_JPY', side: 'BUY', size: 1 }] },
        dummyClient: { getPositions: async () => [] },
        saxoClient: { getPositions: async () => [] },
        listTradableSymbols: async () => [makeSymbol('BTC_JPY')],
    })

    await assert.rejects(
        fetcher.fetchPositionsForReconciliation('bitflyer'),
        /bitflyer reconciliation strict position seam is unavailable/,
    )
})

test('PositionFetcher does not fallback to Saxo best-effort positions without a strict seam', async () => {
    const fetcher = new PositionFetcher({
        bitflyerClient: { getPositions: async () => [] },
        dummyClient: { getPositions: async () => [] },
        saxoClient: { getPositions: async () => [{ broker: 'saxo', ticker: 'EURUSD', side: 'BUY', size: 1 }] },
        listTradableSymbols: async () => [makeSymbol('EURUSD', 'saxo')],
    })

    await assert.rejects(
        fetcher.fetchPositionsForReconciliation('saxo'),
        /saxo reconciliation strict position seam is unavailable/,
    )
})
