import { createRoute } from 'honox/factory'
import type {
  StrategySymbolPolicyDashboardEntry,
  StrategySymbolPolicyDashboardResponse,
  SymbolsResponse,
} from '@trade-gateway/api'

import { fetchApiJson, sendApiJson } from '../../../../lib/api'
import {
  buildPolicyDeleteApiPath,
  buildPolicyDeletePath,
  getEffectivePosition,
} from '../../../../lib/policies'

const decodeParam = (value: string | undefined): string => {
  try {
    return decodeURIComponent(value || '')
  } catch {
    return value || ''
  }
}

const textValue = (value: unknown): string => (
  typeof value === 'string' ? value : ''
)

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

const targetEntry = async (
  strategyId: string,
  symbolId: string,
): Promise<{ entry?: StrategySymbolPolicyDashboardEntry; symbolStatus?: string; apiError?: string }> => {
  const [policyResult, symbolsResult] = await Promise.allSettled([
    fetchApiJson<StrategySymbolPolicyDashboardResponse>('/api/strategy-symbol-policies'),
    fetchApiJson<SymbolsResponse>('/api/symbols'),
  ])
  const entry = policyResult.status === 'fulfilled'
    ? policyResult.value.entries.find((candidate) => (
      candidate.strategy_id === strategyId && candidate.symbol_id === symbolId
    ))
    : undefined
  const symbolStatus = symbolsResult.status === 'fulfilled'
    ? symbolsResult.value.symbols.find((symbol) => symbol.id === symbolId)?.trade_control.status
    : undefined
  const errors = [policyResult, symbolsResult]
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason instanceof Error ? result.reason.message : 'Unknown API error')
  return {
    ...(entry === undefined ? {} : { entry }),
    ...(symbolStatus === undefined ? {} : { symbolStatus }),
    ...(errors.length === 0 ? {} : { apiError: errors.join('; ') }),
  }
}

export const POST = createRoute(async (c) => {
  const strategyId = decodeParam(c.req.param('strategy_id'))
  const symbolId = decodeParam(c.req.param('symbol_id'))
  const pagePath = buildPolicyDeletePath(strategyId, symbolId)
  const body = await c.req.parseBody()
  const values = body as Record<string, unknown>
  const targetConfirmation = textValue(values.target_confirmation)
  const expectedTarget = `${strategyId}:${symbolId}`

  let error = ''
  if (targetConfirmation !== expectedTarget) {
    error = 'Target confirmation must exactly match strategy_id:symbol_id'
  } else {
    try {
      await sendApiJson(buildPolicyDeleteApiPath(strategyId, symbolId), 'DELETE', {
        confirmation: targetConfirmation,
      }, {
        query: { force: 'true' },
      })
      return c.redirect(`/policies?deleted=1&symbol_status=paused`)
    } catch (requestError) {
      error = requestError instanceof Error ? requestError.message : 'Unknown deletion error'
    }
  }

  return c.redirect(`${pagePath}?error=${encodeURIComponent(error)}`)
})

export default createRoute(async (c) => {
  const strategyId = decodeParam(c.req.param('strategy_id'))
  const symbolId = decodeParam(c.req.param('symbol_id'))
  const pagePath = buildPolicyDeletePath(strategyId, symbolId)
  const errorMsg = c.req.query('error') || ''
  const target = await targetEntry(strategyId, symbolId)
  const entry = target.entry
  const position = entry?.position
  const hasTarget = entry !== undefined

  return c.render(
    <div class="max-w-4xl mx-auto p-4">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-3xl font-bold">Force delete policy</h1>
        <a href="/policies" class="text-blue-500 hover:underline">Back to Policies</a>
      </div>

      {errorMsg && <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">{errorMsg}</div>}
      {target.apiError && <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">{target.apiError}</div>}
      {!hasTarget && !target.apiError && <div class="bg-yellow-100 border border-yellow-400 text-yellow-800 px-4 py-3 rounded mb-4">The policy/virtual position target was not found.</div>}

      <section class="bg-red-50 border border-red-300 rounded-lg p-4 mb-6">
        <h2 class="text-xl font-semibold text-red-800 mb-2">Destructive operation</h2>
        <p class="text-red-800">
          This permanently deletes the policy and its virtual position. Orders and strategy-symbol reservations are retained. The symbol is paused before deletion and is never resumed automatically.
        </p>
        <p class="text-red-800 mt-2">
          The current unregistered-policy fallback can allow unconstrained webhook orders if this symbol is resumed after deletion. Keep it paused until a replacement policy and ledger are verified.
        </p>
      </section>

      <section class="bg-white shadow rounded-lg p-4 mb-6">
        <h2 class="text-xl font-semibold mb-4">Target</h2>
        <dl class="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div><dt class="text-xs uppercase text-gray-500">Strategy ID</dt><dd class="font-medium">{strategyId || '—'}</dd></div>
          <div><dt class="text-xs uppercase text-gray-500">Symbol ID</dt><dd class="font-medium">{symbolId || '—'}</dd></div>
          <div><dt class="text-xs uppercase text-gray-500">Symbol status</dt><dd>{target.symbolStatus || 'unknown'}</dd></div>
          <div><dt class="text-xs uppercase text-gray-500">Ledger health</dt><dd>{entry?.ledger_health || 'unknown'}</dd></div>
          <div><dt class="text-xs uppercase text-gray-500">Confirmed position</dt><dd>{formatNumber(position?.confirmed_position)}</dd></div>
          <div><dt class="text-xs uppercase text-gray-500">Pending delta</dt><dd>{formatNumber(position?.pending_delta)}</dd></div>
          <div><dt class="text-xs uppercase text-gray-500">Effective position</dt><dd>{formatNumber(getEffectivePosition(position))}</dd></div>
          <div><dt class="text-xs uppercase text-gray-500">Position status</dt><dd>{position?.status || '—'}</dd></div>
          <div><dt class="text-xs uppercase text-gray-500">Policy version</dt><dd>{entry?.policy?.version ?? '—'}</dd></div>
          <div><dt class="text-xs uppercase text-gray-500">Position policy version</dt><dd>{position?.policy_version ?? '—'}</dd></div>
          <div><dt class="text-xs uppercase text-gray-500">Updated</dt><dd>{formatDate(entry?.policy?.updated_at || position?.updated_at)}</dd></div>
        </dl>
      </section>

      <section class="bg-white shadow rounded-lg p-4">
        <h2 class="text-xl font-semibold mb-2">Type the target confirmation</h2>
        <p class="text-sm text-gray-600 mb-4">The complete strategy_id:symbol_id value is checked by the server. API_SECRET Bearer authentication and this SSR confirmation page are the safety controls; JavaScript dialogs are not used.</p>
        <form method="post" action={pagePath} class="space-y-4">
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Target confirmation: {`${strategyId}:${symbolId}`}</label>
            <input name="target_confirmation" required autocomplete="off" class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm" />
          </div>
          <div class="flex justify-end gap-3">
            <a href="/policies" class="border border-gray-300 text-gray-700 font-semibold py-2 px-4 rounded text-sm">Cancel</a>
            <button type="submit" disabled={!hasTarget} class="bg-red-600 hover:bg-red-700 disabled:bg-gray-400 text-white font-semibold py-2 px-4 rounded shadow text-sm">Force delete</button>
          </div>
        </form>
      </section>
    </div>,
  )
})
