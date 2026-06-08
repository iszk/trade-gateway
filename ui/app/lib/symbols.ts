import type { SymbolsResponse, TradableSymbol } from '@trade-gateway/api'
import { fetchApiJson } from './api'

export const buildSymbolId = (broker: string, ticker: string): string => `${broker}:${ticker}`

export const buildSymbolDetailPath = (symbolId: string): string =>
  `/symbols/${encodeURIComponent(symbolId)}`

export const buildApiSymbolPath = (symbolId: string): string =>
  `/api/symbols/${encodeURIComponent(symbolId)}`

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
