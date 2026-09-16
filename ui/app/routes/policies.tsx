import { createRoute } from 'honox/factory'
import type { Context } from 'hono'
import type {
  StrategySymbolPolicyDashboardEntry,
  StrategySymbolPolicyDashboardResponse,
  SymbolsResponse,
  TradableSymbol,
} from '@trade-gateway/api'

import { fetchApiJson, sendApiJson } from '../lib/api'
import { getSymbolDisplayName } from '../lib/symbols'
import {
  buildFreshStartPath,
  buildPolicyDeletePath,
  getEffectivePosition,
  isValidStrategyId,
  ledgerHealthLabel,
  parseFreshStartForm,
  sortPolicyEntries,
} from '../lib/policies'

const formatNumber = (value: number | undefined): string => (
  value === undefined || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString('en-US', { maximumFractionDigits: 12 })
)

const formatDate = (value: string | Date | undefined): string => {
  if (value === undefined) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date)
}

const healthClass = (health: StrategySymbolPolicyDashboardEntry['ledger_health']): string => (
  health === 'READY'
    ? 'bg-green-100 text-green-800'
    : 'bg-red-100 text-red-800'
)

const statusClass = (status: 'READY' | 'MANUAL_REVIEW' | 'MISMATCH' | undefined): string => {
  if (status === 'READY') return 'bg-green-100 text-green-800'
  if (status === undefined) return 'bg-gray-100 text-gray-800'
  return 'bg-yellow-100 text-yellow-800'
}

const textValue = (value: unknown): string => (
  typeof value === 'string' ? value : ''
)

const symbolDisplayName = (
  symbols: Map<string, TradableSymbol>,
  symbolId: string | undefined,
): string => {
  if (!symbolId) return '—'
  const separator = symbolId.indexOf(':')
  if (separator <= 0 || separator === symbolId.length - 1) return symbolId
  return getSymbolDisplayName(symbols, symbolId.slice(0, separator), symbolId.slice(separator + 1))
}

type OperationStep = 'validate' | 'dry-run' | 'pause' | 'apply' | 'read-back' | 'resume'

class PolicyOperationError extends Error {
  constructor(
    message: string,
    readonly step: OperationStep,
    readonly completed: OperationStep[],
    readonly symbolStatus: 'active' | 'paused' | 'unknown',
  ) {
    super(message)
    this.name = 'PolicyOperationError'
  }
}

const operationErrorRedirect = (
  c: Context,
  error: PolicyOperationError | Error,
  completed: OperationStep[],
  symbolStatus: 'active' | 'paused' | 'unknown',
) => {
  const params = new URLSearchParams({
    error: error.message,
    steps: completed.join(','),
    failed_step: error instanceof PolicyOperationError ? error.step : 'unknown',
    symbol_status: symbolStatus,
  })
  return c.redirect(`/policies?${params.toString()}`)
}

const ensureDryRunSucceeded = (result: unknown): void => {
  if (!result || typeof result !== 'object') throw new Error('dry-run returned an invalid response')
  const response = result as { status?: unknown; mode?: unknown; issues?: unknown }
  if (response.status !== 'CREATE' || response.mode !== 'DRY_RUN') {
    throw new Error('dry-run did not return CREATE/DRY_RUN')
  }
  if (!Array.isArray(response.issues) || response.issues.length > 0) {
    throw new Error('dry-run reported policy creation issues')
  }
}

const ensureReadBackSucceeded = (
  response: StrategySymbolPolicyDashboardResponse,
  strategyId: string,
  symbolId: string,
  maxAbsPosition: number,
  noFlip: boolean,
): void => {
  const entry = response.entries.find((candidate) => (
    candidate.strategy_id === strategyId && candidate.symbol_id === symbolId
  ))
  const policy = entry?.policy
  const position = entry?.position
  if (!entry || entry.ledger_health !== 'READY' || !policy || !position) {
    throw new Error('read-back ledger is missing or unhealthy')
  }
  if (policy.version !== 1 || policy.enabled !== true || policy.sizing_mode !== 'WEBHOOK_CAPPED' ||
      policy.max_abs_position !== maxAbsPosition || policy.no_flip !== noFlip) {
    throw new Error('read-back policy does not match the requested fresh-start')
  }
  if (position.policy_version !== 1 || position.status !== 'READY' ||
      position.confirmed_position !== 0 || position.pending_delta !== 0) {
    throw new Error('read-back position is not a zero READY ledger')
  }
}

export const POST = createRoute(async (c) => {
  const completed: OperationStep[] = []
  let symbolStatus: 'active' | 'paused' | 'unknown' = 'unknown'
  let currentStep: OperationStep = 'validate'

  try {
    const body = await c.req.parseBody()
    const values = body as Record<string, unknown>
    const strategyId = textValue(values.strategy_id)
    const symbolId = textValue(values.symbol_id)
    if (!isValidStrategyId(strategyId)) throw new Error('strategy_id is invalid')
    if (symbolId.length === 0) throw new Error('symbol_id is required')

    const freshStart = parseFreshStartForm(values)

    let symbolsResponse: SymbolsResponse
    try {
      symbolsResponse = await fetchApiJson<SymbolsResponse>('/api/symbols')
    } catch (error) {
      throw new Error(`symbol validation failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
    const symbol = symbolsResponse.symbols.find((candidate) => candidate.id === symbolId)
    if (!symbol) throw new Error('symbol_id is not a registered symbol')
    symbolStatus = symbol.trade_control.status
    completed.push('validate')

    currentStep = 'dry-run'
    const freshStartPath = buildFreshStartPath(strategyId, symbolId)
    const dryRun = await sendApiJson<unknown>(freshStartPath, 'POST', {
      sizing_mode: freshStart.sizing_mode,
      max_abs_position: freshStart.max_abs_position,
      no_flip: freshStart.no_flip,
    })
    ensureDryRunSucceeded(dryRun)
    completed.push('dry-run')

    if (symbolStatus === 'active') {
      currentStep = 'pause'
      try {
        await sendApiJson(`/api/symbols/${encodeURIComponent(symbolId)}/trade-control`, 'PATCH', {
          status: 'paused',
          reason: `policy fresh-start: ${strategyId}`,
        })
      } catch (error) {
        // A transport error after the server accepted the PATCH leaves the
        // actual state uncertain. Keep the UI fail-closed instead of claiming
        // that the symbol is still active or safely paused.
        symbolStatus = 'unknown'
        throw error
      }
      symbolStatus = 'paused'
      completed.push('pause')
    }

    currentStep = 'apply'
    await sendApiJson(freshStartPath, 'POST', {
      sizing_mode: freshStart.sizing_mode,
      max_abs_position: freshStart.max_abs_position,
      no_flip: freshStart.no_flip,
    }, {
      query: { apply: 'true' },
    })
    completed.push('apply')

    currentStep = 'read-back'
    const readBack = await fetchApiJson<StrategySymbolPolicyDashboardResponse>('/api/strategy-symbol-policies')
    ensureReadBackSucceeded(readBack, strategyId, symbolId, freshStart.max_abs_position, freshStart.no_flip)
    completed.push('read-back')

    if (symbol.trade_control.status === 'active') {
      currentStep = 'resume'
      try {
        await sendApiJson(`/api/symbols/${encodeURIComponent(symbolId)}/trade-control`, 'PATCH', {
          status: 'active',
          reason: `policy fresh-start completed: ${strategyId}`,
        })
      } catch (error) {
        // The PATCH may have committed before a response/transport failure.
        // Do not retry or roll back a destructive multi-step operation; the
        // actual symbol state must be checked manually.
        symbolStatus = 'unknown'
        throw error
      }
      symbolStatus = 'active'
      completed.push('resume')
    }

    const params = new URLSearchParams({
      created: '1',
      steps: completed.join(','),
      symbol_status: symbolStatus,
    })
    return c.redirect(`/policies?${params.toString()}`)
  } catch (error) {
    const wrapped = error instanceof PolicyOperationError
      ? error
      : new PolicyOperationError(
        error instanceof Error ? error.message : 'Unknown error',
        currentStep,
        completed,
        symbolStatus,
      )
    return operationErrorRedirect(c, wrapped, completed, symbolStatus)
  }
})

export default createRoute(async (c) => {
  const errorMsg = c.req.query('error') || ''
  const created = c.req.query('created') === '1'
  const deleted = c.req.query('deleted') === '1'
  const steps = (c.req.query('steps') || '').split(',').filter(Boolean)
  const failedStep = c.req.query('failed_step') || ''
  const operationSymbolStatus = c.req.query('symbol_status') || ''
  let entries: StrategySymbolPolicyDashboardEntry[] = []
  let symbols: TradableSymbol[] = []
  let policyError = ''
  let symbolError = ''

  const [policyResult, symbolResult] = await Promise.allSettled([
    fetchApiJson<StrategySymbolPolicyDashboardResponse>('/api/strategy-symbol-policies'),
    fetchApiJson<SymbolsResponse>('/api/symbols'),
  ])
  if (policyResult.status === 'fulfilled') {
    entries = sortPolicyEntries(policyResult.value.entries)
  } else {
    policyError = policyResult.reason instanceof Error ? policyResult.reason.message : 'Unknown policy API error'
  }
  if (symbolResult.status === 'fulfilled') {
    symbols = symbolResult.value.symbols
  } else {
    symbolError = symbolResult.reason instanceof Error ? symbolResult.reason.message : 'Unknown symbol API error'
  }
  const symbolsById = new Map(symbols.map((symbol) => [symbol.id, symbol]))

  const policyCount = entries.filter((entry) => entry.policy !== undefined).length
  const enabledCount = entries.filter((entry) => entry.policy?.enabled === true).length
  const anomalyCount = entries.filter((entry) => entry.ledger_health !== 'READY').length
  const nonZeroPositionCount = entries.filter((entry) => {
    const effective = getEffectivePosition(entry.position)
    return effective !== undefined && effective !== 0
  }).length

  return c.render(
    <div class="max-w-7xl mx-auto p-4">
      <div class="flex justify-between items-center mb-6">
        <div>
          <h1 class="text-3xl font-bold">Policies</h1>
          <p class="text-sm text-gray-500 mt-1">Strategy × symbol policies and virtual positions</p>
        </div>
        <a href="/" class="text-blue-500 hover:underline">Back to Home</a>
      </div>

      {errorMsg && (
        <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          <div>{errorMsg}</div>
          {steps.length > 0 && <div class="text-sm mt-2">Completed steps: {steps.join(' → ')}</div>}
          {failedStep && <div class="text-sm">Failed step: {failedStep}</div>}
          {operationSymbolStatus && <div class="text-sm">Symbol status at failure: {operationSymbolStatus}</div>}
          <div class="text-sm mt-2">途中で失敗した場合は symbol を自動再開しません。API の状態を確認し、必要なら手動で復旧してください。</div>
        </div>
      )}
      {created && (
        <div class="bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded mb-4">
          Policy and virtual position created. Steps: {steps.join(' → ')}. Symbol status: {operationSymbolStatus || 'unknown'}.
        </div>
      )}
      {deleted && (
        <div class="bg-yellow-100 border border-yellow-400 text-yellow-800 px-4 py-3 rounded mb-4">
          Policy and virtual position deleted. The symbol remains paused; orders and reservations were retained.
        </div>
      )}
      {policyError && (
        <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">{policyError}</div>
      )}
      {symbolError && (
        <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">{symbolError}</div>
      )}

      <section class="grid grid-cols-2 gap-3 sm:grid-cols-4 mb-6">
        <div class="bg-white shadow rounded-lg p-4"><div class="text-xs uppercase text-gray-500">Policies</div><div class="text-2xl font-semibold">{policyCount}</div></div>
        <div class="bg-white shadow rounded-lg p-4"><div class="text-xs uppercase text-gray-500">Enabled</div><div class="text-2xl font-semibold">{enabledCount}</div></div>
        <div class="bg-white shadow rounded-lg p-4"><div class="text-xs uppercase text-gray-500">Ledger anomalies</div><div class="text-2xl font-semibold text-red-600">{anomalyCount}</div></div>
        <div class="bg-white shadow rounded-lg p-4"><div class="text-xs uppercase text-gray-500">Non-zero effective</div><div class="text-2xl font-semibold">{nonZeroPositionCount}</div></div>
      </section>

      <section class="bg-white shadow rounded-lg p-4 mb-8">
        <h2 class="text-xl font-semibold mb-2">Add policy (fresh-start)</h2>
        <p class="text-sm text-gray-600 mb-3">
          The operation runs dry-run → pause (if active) → apply → read-back verification → resume (only when originally active). A shared symbol is paused for other strategies during this operation too.
        </p>
        <p class="text-sm text-red-700 mb-4">
          If any step fails, the symbol is not resumed automatically. Check the API state and recover it manually.
        </p>
        <form method="post" action="/policies" class="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Strategy ID</label>
            <input name="strategy_id" required pattern="[A-Za-z0-9_-]+" class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Symbol</label>
            <select name="symbol_id" required class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm">
              <option value="">Select a registered symbol</option>
              {symbols.map((symbol) => (
                <option key={symbol.id} value={symbol.id}>{symbol.display_name || symbol.id} ({symbol.id}) — {symbol.trade_control.status}</option>
              ))}
            </select>
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Sizing mode</label>
            <input name="sizing_mode" value="WEBHOOK_CAPPED" readonly class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm bg-gray-100" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Max absolute position</label>
            <input name="max_abs_position" type="number" min="0" step="any" required class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm" />
          </div>
          <div class="flex items-end gap-3">
            <label class="flex items-center gap-2 text-sm"><input type="checkbox" name="no_flip" value="on" checked /> No flip</label>
            <button type="submit" class="bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded shadow text-sm">Create</button>
          </div>
        </form>
      </section>

      <section>
        <h2 class="text-xl font-semibold mb-3">Policy / virtual position ledger</h2>
        <div class="bg-white shadow rounded-lg overflow-x-auto">
          {entries.length === 0 ? (
            <p class="text-gray-500 p-4">No policy or virtual position ledger found.</p>
          ) : (
            <table class="min-w-full text-left text-sm whitespace-nowrap">
              <thead class="uppercase tracking-wider border-b-2 text-gray-600 bg-gray-50">
                <tr>
                  <th class="px-4 py-3">Strategy</th>
                  <th class="px-4 py-3">Symbol</th>
                  <th class="px-4 py-3">Policy</th>
                  <th class="px-4 py-3">Position</th>
                  <th class="px-4 py-3">Versions / updated</th>
                  <th class="px-4 py-3">Ledger</th>
                  <th class="px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => {
                  const effective = getEffectivePosition(entry.position)
                  return (
                    <tr key={entry.id} class="border-b hover:bg-gray-50 align-top">
                      <td class="px-4 py-3 font-medium">{entry.strategy_id || '—'}</td>
                      <td class="px-4 py-3">
                        <div>{symbolDisplayName(symbolsById, entry.symbol_id)}</div>
                        <div class="text-xs text-gray-500">{entry.symbol_id || entry.document_id || entry.id}</div>
                      </td>
                      <td class="px-4 py-3">
                        {entry.policy ? (
                          <div class="space-y-1">
                            <div><span class={`px-2 py-0.5 rounded text-xs font-bold ${entry.policy.enabled ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'}`}>{entry.policy.enabled ? 'enabled' : 'disabled'}</span> {entry.policy.sizing_mode}</div>
                            <div>max ±{formatNumber(entry.policy.max_abs_position)} / no-flip {entry.policy.no_flip ? 'yes' : 'no'}</div>
                            {entry.policy.sizing_mode === 'MANAGED' && <div class="text-xs text-gray-600">base {formatNumber(entry.policy.base_order_size)} / taper {formatNumber(entry.policy.taper_strength)}</div>}
                          </div>
                        ) : <span class="text-red-700">{entry.issue || 'policy missing or invalid'}</span>}
                      </td>
                      <td class="px-4 py-3">
                        {entry.position ? (
                          <div class="space-y-1">
                            <div>confirmed {formatNumber(entry.position.confirmed_position)}</div>
                            <div>pending {formatNumber(entry.position.pending_delta)}</div>
                            <div class="font-semibold">effective {formatNumber(effective)}</div>
                            <span class={`px-2 py-0.5 rounded text-xs font-bold ${statusClass(entry.position.status)}`}>{entry.position.status}</span>
                          </div>
                        ) : <span class="text-red-700">position missing or invalid</span>}
                      </td>
                      <td class="px-4 py-3 text-xs">
                        <div>policy v{entry.policy?.version ?? '—'} / position v{entry.position?.policy_version ?? '—'}</div>
                        <div>{formatDate(entry.policy?.updated_at || entry.position?.updated_at)}</div>
                      </td>
                      <td class="px-4 py-3">
                        <span class={`px-2 py-0.5 rounded text-xs font-bold ${healthClass(entry.ledger_health)}`}>{ledgerHealthLabel(entry.ledger_health)}</span>
                        {entry.issue && <div class="text-xs text-red-700 mt-1 max-w-xs whitespace-normal">{entry.issue}</div>}
                      </td>
                      <td class="px-4 py-3">
                        {entry.strategy_id && entry.symbol_id && (
                          <a href={buildPolicyDeletePath(entry.strategy_id, entry.symbol_id)} class="text-red-600 hover:underline">Force delete</a>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
        <p class="text-sm text-red-700 mt-3">
          Force deletion pauses the symbol and leaves it paused. Orders and reservations are retained. With the current unregistered-policy fallback, resuming after deletion can allow unconstrained webhook orders, so verify the replacement policy before any manual resume.
        </p>
      </section>
    </div>,
  )
})
