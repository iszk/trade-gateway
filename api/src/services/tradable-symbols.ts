import type { Firestore } from 'firebase-admin/firestore'
import { getFirestoreClient } from '../firestore.js'
import { omitUndefinedFields } from '../omit-undefined-fields.js'
import type { BrokerName } from '../types/order.js'
import type { TradableSymbol, TradeControlStatus } from '../types/tradable-symbol.js'

const COLLECTION_NAME = 'tradable_symbols'
const DEFAULT_CURRENCY = 'JPY'

export const createSymbolId = (broker: string, ticker: string): string => `${broker}:${ticker}`

export const parseSymbolId = (symbolId: string): { broker: string; ticker: string } | null => {
    if (symbolId.includes('/')) return null

    const separatorIndex = symbolId.indexOf(':')
    if (separatorIndex <= 0 || separatorIndex === symbolId.length - 1) {
        return null
    }

    return {
        broker: symbolId.slice(0, separatorIndex),
        ticker: symbolId.slice(separatorIndex + 1),
    }
}

const toDate = (value: unknown): Date => {
    if (value instanceof Date) return value
    if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
        return value.toDate()
    }
    return new Date(String(value))
}

const fromFirestoreTradableSymbol = (data: TradableSymbol): TradableSymbol => ({
    ...data,
    trade_control: {
        ...data.trade_control,
        updated_at: toDate(data.trade_control.updated_at),
    },
    created_at: toDate(data.created_at),
    updated_at: toDate(data.updated_at),
})

const isAlreadyExistsError = (error: unknown): boolean =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 6

export type EnsureTradableSymbolFn = (input: { broker: BrokerName; ticker: string }) => Promise<void>
export type GetTradableSymbolFn = (symbolId: string) => Promise<TradableSymbol | null>
export type ListTradableSymbolsFn = () => Promise<TradableSymbol[]>
export type UpsertTradableSymbolInput = {
    id: string
    broker: BrokerName
    ticker: string
    display_name?: string
    currency: string
    note?: string
    trade_control?: {
        status?: TradeControlStatus
        reason?: string
        updated_by?: string
    }
}
export type UpsertTradableSymbolFn = (input: UpsertTradableSymbolInput) => Promise<TradableSymbol>
export type UpdateTradeControlFn = (
    symbolId: string,
    input: { status: TradeControlStatus; reason?: string; updated_by?: string },
) => Promise<TradableSymbol>

export const createEnsureTradableSymbolFn = (db: Firestore = getFirestoreClient()): EnsureTradableSymbolFn => {
    return async ({ broker, ticker }) => {
        const now = new Date()
        const id = createSymbolId(broker, ticker)
        const docRef = db.collection(COLLECTION_NAME).doc(id)

        try {
            await docRef.create({
                id,
                broker,
                ticker,
                currency: DEFAULT_CURRENCY,
                trade_control: {
                    status: 'active',
                    updated_at: now,
                    updated_by: 'system',
                },
                created_at: now,
                updated_at: now,
            })
        } catch (error) {
            if (isAlreadyExistsError(error)) return
            throw error
        }
    }
}

export const createGetTradableSymbolFn = (db: Firestore = getFirestoreClient()): GetTradableSymbolFn => {
    return async (symbolId) => {
        const doc = await db.collection(COLLECTION_NAME).doc(symbolId).get()
        if (!doc.exists) return null
        return fromFirestoreTradableSymbol(doc.data() as TradableSymbol)
    }
}

export const createListTradableSymbolsFn = (db: Firestore = getFirestoreClient()): ListTradableSymbolsFn => {
    return async () => {
        const snapshot = await db.collection(COLLECTION_NAME).orderBy('id', 'asc').get()
        return snapshot.docs.map((doc) => fromFirestoreTradableSymbol(doc.data() as TradableSymbol))
    }
}

export const createUpsertTradableSymbolFn = (db: Firestore = getFirestoreClient()): UpsertTradableSymbolFn => {
    return async (input) => {
        const now = new Date()
        const docRef = db.collection(COLLECTION_NAME).doc(input.id)
        const current = await docRef.get()
        const currentData = current.exists ? fromFirestoreTradableSymbol(current.data() as TradableSymbol) : null
        const tradeControl = {
            status: input.trade_control?.status ?? currentData?.trade_control.status ?? 'active',
            reason: input.trade_control?.reason ?? currentData?.trade_control.reason,
            updated_at: input.trade_control?.status
                ? now
                : currentData?.trade_control.updated_at ?? now,
            updated_by: input.trade_control?.updated_by ?? currentData?.trade_control.updated_by,
        }
        const data: TradableSymbol = {
            id: input.id,
            broker: input.broker,
            ticker: input.ticker,
            display_name: input.display_name,
            currency: input.currency,
            note: input.note,
            trade_control: tradeControl,
            created_at: currentData?.created_at ?? now,
            updated_at: now,
        }

        await docRef.set(omitUndefinedFields(data))
        return data
    }
}

export const createUpdateTradeControlFn = (db: Firestore = getFirestoreClient()): UpdateTradeControlFn => {
    return async (symbolId, input) => {
        const parsed = parseSymbolId(symbolId)
        if (!parsed) {
            throw new Error(`invalid symbol_id: ${symbolId}`)
        }

        const now = new Date()
        const docRef = db.collection(COLLECTION_NAME).doc(symbolId)
        const current = await docRef.get()
        const currentData = current.exists ? fromFirestoreTradableSymbol(current.data() as TradableSymbol) : null
        const data: TradableSymbol = {
            id: symbolId,
            broker: parsed.broker as BrokerName,
            ticker: parsed.ticker,
            display_name: currentData?.display_name,
            currency: currentData?.currency ?? DEFAULT_CURRENCY,
            note: currentData?.note,
            trade_control: {
                status: input.status,
                reason: input.reason,
                updated_at: now,
                updated_by: input.updated_by,
            },
            created_at: currentData?.created_at ?? now,
            updated_at: now,
        }

        await docRef.set(omitUndefinedFields(data))
        return data
    }
}

export const createDefaultEnsureTradableSymbolFn = (): EnsureTradableSymbolFn =>
    createEnsureTradableSymbolFn(getFirestoreClient())
export const createDefaultGetTradableSymbolFn = (): GetTradableSymbolFn =>
    createGetTradableSymbolFn(getFirestoreClient())
export const createDefaultListTradableSymbolsFn = (): ListTradableSymbolsFn =>
    createListTradableSymbolsFn(getFirestoreClient())
export const createDefaultUpsertTradableSymbolFn = (): UpsertTradableSymbolFn =>
    createUpsertTradableSymbolFn(getFirestoreClient())
export const createDefaultUpdateTradeControlFn = (): UpdateTradeControlFn =>
    createUpdateTradeControlFn(getFirestoreClient())
