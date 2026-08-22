import type { OrderConstraints, SymbolsResponse, TradableSymbol } from '@trade-gateway/api'
import { fetchApiJson } from './api'

export const buildSymbolId = (broker: string, ticker: string): string => `${broker}:${ticker}`

export const buildSymbolDetailPath = (symbolId: string): string =>
  `/symbols/${encodeURIComponent(symbolId)}`

export const buildApiSymbolPath = (symbolId: string): string =>
  `/api/symbols/${encodeURIComponent(symbolId)}`

type OrderConstraintsFormValues = Record<string, unknown>
type OrderConstraintField = 'quantity_step' | 'min_order_size' | 'max_order_size'

const parsePositiveFormNumber = (
  values: OrderConstraintsFormValues,
  field: OrderConstraintField,
  required: boolean,
): number | undefined => {
  const rawValue = values[field]

  if (rawValue === undefined && !required) {
    return undefined
  }

  if (rawValue === undefined && required) {
    throw new Error(`${field} is required`)
  }

  if (typeof rawValue !== 'string') {
    throw new Error(`${field} must be a string`)
  }

  const normalizedValue = rawValue.trim()
  if (normalizedValue.length === 0) {
    if (!required) return undefined
    throw new Error(`${field} is required`)
  }

  const value = Number(normalizedValue)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a finite positive number`)
  }

  return value
}

/**
 * Parse and validate order constraint values submitted by the detail form.
 * Form values are intentionally required to be strings so malformed multipart
 * or repeated fields cannot be silently coerced into a valid number.
 */
export const parseOrderConstraintsForm = (
  values: OrderConstraintsFormValues,
): OrderConstraints => {
  const quantityStep = parsePositiveFormNumber(values, 'quantity_step', true)
  const minOrderSize = parsePositiveFormNumber(values, 'min_order_size', true)
  const maxOrderSize = parsePositiveFormNumber(values, 'max_order_size', false)

  // The required parser branches throw for undefined, but keep this guard so
  // the returned type remains safe if that helper is changed later.
  if (quantityStep === undefined || minOrderSize === undefined) {
    throw new Error('quantity_step and min_order_size are required')
  }

  if (maxOrderSize !== undefined && maxOrderSize < minOrderSize) {
    throw new Error('max_order_size must be greater than or equal to min_order_size')
  }

  return {
    quantity_step: quantityStep,
    min_order_size: minOrderSize,
    ...(maxOrderSize === undefined ? {} : { max_order_size: maxOrderSize }),
  }
}

export const buildSymbolOrderConstraintsPayload = (
  symbol: TradableSymbol,
  orderConstraints: OrderConstraints,
): {
  display_name?: string
  currency: string
  note?: string
  order_constraints: OrderConstraints
} => ({
  display_name: symbol.display_name,
  currency: symbol.currency,
  note: symbol.note,
  order_constraints: orderConstraints,
})

export const getSymbolDisplayName = (
  symbols: Map<string, TradableSymbol>,
  broker: string,
  ticker: string,
): string => {
  const symbolId = buildSymbolId(broker, ticker)
  return symbols.get(symbolId)?.display_name || symbolId
}

export const fetchSymbolMap = async (): Promise<Map<string, TradableSymbol>> => {
  const data = await fetchApiJson<SymbolsResponse>('/api/symbols')
  return new Map(data.symbols.map((symbol) => [symbol.id, symbol]))
}
