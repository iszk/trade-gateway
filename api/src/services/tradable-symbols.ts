import type { Firestore } from 'firebase-admin/firestore'
import { createFirestoreDocument, getFirestoreClient, setFirestoreDocument } from '../firestore.js'
import type { BrokerName } from '../types/order.js'
import type { OrderConstraints, TradableSymbol, TradeControlStatus } from '../types/tradable-symbol.js'

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

const isFinitePositiveNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0

/** A symbol snapshot is present but its identity or persisted shape is invalid. */
class InvalidStoredTradableSymbolError extends Error {
    readonly code = 'INVALID_STORED_SYMBOL'

    constructor(message: string) {
        super(message)
        this.name = 'InvalidStoredTradableSymbolError'
    }
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
    typeof value === 'object' && value !== null && !Array.isArray(value)
)

const assertValidOrderConstraints = (value: unknown): OrderConstraints | undefined => {
    if (value === undefined) return

    if (!isRecord(value)) {
        throw new Error('invalid order_constraints')
    }

    const constraints = value as Record<string, unknown>
    if (!isFinitePositiveNumber(constraints.quantity_step)) {
        throw new Error('invalid order_constraints.quantity_step')
    }
    if (!isFinitePositiveNumber(constraints.min_order_size)) {
        throw new Error('invalid order_constraints.min_order_size')
    }
    if (constraints.max_order_size !== undefined &&
        (!isFinitePositiveNumber(constraints.max_order_size) || constraints.max_order_size < constraints.min_order_size)) {
        throw new Error('invalid order_constraints.max_order_size')
    }

    return {
        quantity_step: constraints.quantity_step,
        min_order_size: constraints.min_order_size,
        ...(constraints.max_order_size === undefined ? {} : { max_order_size: constraints.max_order_size }),
    }
}

/**
 * Validate the identity and order constraints of a symbol snapshot read by an
 * atomic transaction.  Legacy symbols may omit constraints, so `undefined`
 * is returned for that case and the caller can apply its fail-closed policy.
 */
export const deserializeTradableSymbolOrderConstraints = (
    value: unknown,
    expectedSymbolId: string,
): OrderConstraints | undefined => {
    if (!isRecord(value)) {
        throw new InvalidStoredTradableSymbolError('symbol document is not an object')
    }
    if (value.id !== expectedSymbolId || parseSymbolId(expectedSymbolId) === null) {
        throw new InvalidStoredTradableSymbolError('symbol document identity does not match its document path')
    }
    try {
        return assertValidOrderConstraints(value.order_constraints)
    } catch {
        throw new InvalidStoredTradableSymbolError('symbol order_constraints is invalid')
    }
}

const fromFirestoreTradableSymbol = (data: TradableSymbol): TradableSymbol => {
    assertValidOrderConstraints(data.order_constraints)

    return {
        ...data,
        trade_control: {
            ...data.trade_control,
            updated_at: toDate(data.trade_control.updated_at),
        },
        created_at: toDate(data.created_at),
        updated_at: toDate(data.updated_at),
    }
}

const isAlreadyExistsError = (error: unknown): boolean =>
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 6

export type EnsureTradableSymbolFn = (input: { broker: BrokerName; ticker: string }) => Promise<void>
export type GetTradableSymbolFn = (symbolId: string) => Promise<TradableSymbol | null>
export type ListTradableSymbolsFn = () => Promise<TradableSymbol[]>
type UpsertTradableSymbolInput = {
    id: string
    broker: BrokerName
    ticker: string
    display_name?: string
    currency: string
    note?: string
    order_constraints?: OrderConstraints
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
            await createFirestoreDocument(docRef, {
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
            }, {
                collection: COLLECTION_NAME,
                docId: id,
                isExpectedError: isAlreadyExistsError,
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
        assertValidOrderConstraints(input.order_constraints)

        const now = new Date()
        const docRef = db.collection(COLLECTION_NAME).doc(input.id)
        const current = await docRef.get()
        const currentData = current.exists ? fromFirestoreTradableSymbol(current.data() as TradableSymbol) : null
        const orderConstraints = input.order_constraints ?? currentData?.order_constraints
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
            ...(orderConstraints === undefined ? {} : { order_constraints: orderConstraints }),
            trade_control: tradeControl,
            created_at: currentData?.created_at ?? now,
            updated_at: now,
        }

        await setFirestoreDocument(docRef, data as unknown as Record<string, unknown>, {
            collection: COLLECTION_NAME,
            docId: input.id,
        })
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
            ...(currentData?.order_constraints === undefined ? {} : { order_constraints: currentData.order_constraints }),
            trade_control: {
                status: input.status,
                reason: input.reason,
                updated_at: now,
                updated_by: input.updated_by,
            },
            created_at: currentData?.created_at ?? now,
            updated_at: now,
        }

        await setFirestoreDocument(docRef, data as unknown as Record<string, unknown>, {
            collection: COLLECTION_NAME,
            docId: symbolId,
        })
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
