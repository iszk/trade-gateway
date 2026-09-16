import type {
  StrategySymbolPolicyDashboardEntry,
  StrategySymbolPosition,
} from '@trade-gateway/api'

export const buildFreshStartPath = (strategyId: string, symbolId: string): string =>
  `/api/strategy-symbol-policies/${encodeURIComponent(strategyId)}/${encodeURIComponent(symbolId)}/fresh-start`

export const buildPolicyDeletePath = (strategyId: string, symbolId: string): string =>
  `/policies/${encodeURIComponent(strategyId)}/${encodeURIComponent(symbolId)}/delete`

export const buildPolicyDeleteApiPath = (strategyId: string, symbolId: string): string =>
  `/api/strategy-symbol-policies/${encodeURIComponent(strategyId)}/${encodeURIComponent(symbolId)}`

export const isValidStrategyId = (value: string): boolean => (
  value.length > 0 && value === value.trim() && /^[A-Za-z0-9_-]+$/.test(value)
)

const parsePositiveNumber = (values: Record<string, unknown>, field: string): number => {
  const raw = values[field]
  if (typeof raw !== 'string') throw new Error(`${field} must be a string`)
  const normalized = raw.trim()
  if (normalized.length === 0) throw new Error(`${field} is required`)
  const value = Number(normalized)
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a finite positive number`)
  }
  return value
}

export type FreshStartFormValues = {
  sizing_mode: 'WEBHOOK_CAPPED'
  max_abs_position: number
  no_flip: boolean
}

export const parseFreshStartForm = (values: Record<string, unknown>): FreshStartFormValues => {
  const sizingMode = values.sizing_mode
  if (sizingMode !== 'WEBHOOK_CAPPED') throw new Error('sizing_mode is invalid')

  const noFlipValue = values.no_flip
  if (noFlipValue !== undefined && typeof noFlipValue !== 'string') {
    throw new Error('no_flip must be a string')
  }

  return {
    sizing_mode: 'WEBHOOK_CAPPED',
    max_abs_position: parsePositiveNumber(values, 'max_abs_position'),
    no_flip: noFlipValue === 'on' || noFlipValue === 'true' || noFlipValue === '1',
  }
}

export const getEffectivePosition = (position: StrategySymbolPosition | undefined): number | undefined => {
  if (!position || !Number.isFinite(position.confirmed_position) || !Number.isFinite(position.pending_delta)) {
    return undefined
  }
  const effective = position.confirmed_position + position.pending_delta
  return Number.isFinite(effective) ? effective : undefined
}

export const sortPolicyEntries = (
  entries: StrategySymbolPolicyDashboardEntry[],
): StrategySymbolPolicyDashboardEntry[] => [...entries].sort((left, right) => {
  const leftKey = `${left.strategy_id || '\uffff'}\u0000${left.symbol_id || '\uffff'}\u0000${left.id}`
  const rightKey = `${right.strategy_id || '\uffff'}\u0000${right.symbol_id || '\uffff'}\u0000${right.id}`
  return leftKey.localeCompare(rightKey)
})

export const ledgerHealthLabel = (
  health: StrategySymbolDashboardHealth,
): string => ({
  READY: 'READY',
  MISSING_POSITION: 'Position missing',
  ORPHAN_POSITION: 'Orphan position',
  VERSION_MISMATCH: 'Version mismatch',
  INVALID_POLICY: 'Invalid policy',
  INVALID_POSITION: 'Invalid position',
}[health])

export type StrategySymbolDashboardHealth =
  StrategySymbolPolicyDashboardEntry['ledger_health']
