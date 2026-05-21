import { createRoute } from 'honox/factory'
import type { GroupStats, TradeStatsResponse, TradesResponse } from '@trade-gateway/api'
import { fetchApiJson } from '../lib/api'

const fmt = (n: number | null | undefined, digits = 2): string => {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`

const toDateInputValue = (d: Date): string =>
  d.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })

export default createRoute(async (c) => {
  const now = new Date()
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  const fromParam = c.req.query('from') || toDateInputValue(defaultFrom)
  const toParam = c.req.query('to') || toDateInputValue(now)
  const strategyParam = c.req.query('strategy') || ''
  const intervalParam = c.req.query('interval') || ''
  const tickerParam = c.req.query('ticker') || ''
  const brokerParam = c.req.query('broker') || ''
  const pageParam = c.req.query('page') || '1'

  const buildQuery = (extra?: Record<string, string>): Record<string, string> => {
    const q: Record<string, string> = { from: fromParam, to: toParam }
    if (strategyParam) q.strategy = strategyParam
    if (intervalParam) q.interval = intervalParam
    if (tickerParam) q.ticker = tickerParam
    if (brokerParam) q.broker = brokerParam
    return { ...q, ...extra }
  }

  let statsError = ''
  let statsData: TradeStatsResponse | null = null
  let recordsError = ''
  let recordsData: TradesResponse | null = null

  try {
    statsData = await fetchApiJson<TradeStatsResponse>('/api/trade-records/stats', buildQuery())
  } catch (e) {
    statsError = e instanceof Error ? e.message : 'Unknown error'
  }

  try {
    recordsData = await fetchApiJson<TradesResponse>('/api/trade-records', buildQuery({ page: pageParam }))
  } catch (e) {
    recordsError = e instanceof Error ? e.message : 'Unknown error'
  }

  const buildPageUrl = (page: number): string => {
    const params = new URLSearchParams(buildQuery({ page: String(page) }))
    return `/trade-records?${params.toString()}`
  }

  return c.render(
    <div class="max-w-7xl mx-auto p-4">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-3xl font-bold">Trade Records</h1>
        <a href="/" class="text-blue-500 hover:underline">Back to Home</a>
      </div>

      {/* フィルターフォーム */}
      <form method="get" action="/trade-records" class="bg-white shadow rounded-lg p-4 mb-6">
        <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">From</label>
            <input
              type="date"
              name="from"
              value={fromParam}
              class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">To</label>
            <input
              type="date"
              name="to"
              value={toParam}
              class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Strategy</label>
            <input
              type="text"
              name="strategy"
              value={strategyParam}
              placeholder="all"
              class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Interval</label>
            <input
              type="text"
              name="interval"
              value={intervalParam}
              placeholder="all"
              class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Ticker</label>
            <input
              type="text"
              name="ticker"
              value={tickerParam}
              placeholder="all"
              class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Broker</label>
            <input
              type="text"
              name="broker"
              value={brokerParam}
              placeholder="all"
              class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
        <div class="mt-3 flex justify-end">
          <button
            type="submit"
            class="bg-blue-500 hover:bg-blue-600 text-white font-semibold py-2 px-6 rounded shadow text-sm"
          >
            Apply
          </button>
        </div>
      </form>

      {/* 統計セクション */}
      <section class="mb-8">
        <h2 class="text-xl font-semibold mb-3">Statistics by Group</h2>

        {statsError && (
          <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
            {statsError}
          </div>
        )}

        {statsData && statsData.groups.length === 0 && (
          <p class="text-gray-500">No data found for the selected period.</p>
        )}

        {statsData && statsData.groups.length > 0 && (
          <div class="bg-white shadow rounded-lg overflow-x-auto">
            <table class="min-w-full text-left text-sm whitespace-nowrap">
              <thead class="uppercase tracking-wider border-b-2 text-gray-600 bg-gray-50">
                <tr>
                  <th class="px-4 py-3">Strategy</th>
                  <th class="px-4 py-3">Interval</th>
                  <th class="px-4 py-3">Ticker</th>
                  <th class="px-4 py-3">Broker</th>
                  <th class="px-4 py-3 text-right">Total</th>
                  <th class="px-4 py-3 text-right">Win</th>
                  <th class="px-4 py-3 text-right">Loss</th>
                  <th class="px-4 py-3 text-right">Win Rate</th>
                  <th class="px-4 py-3 text-right">Total PnL</th>
                  <th class="px-4 py-3 text-right">Avg PnL</th>
                  <th class="px-4 py-3 text-right">Avg Win</th>
                  <th class="px-4 py-3 text-right">Avg Loss</th>
                  <th class="px-4 py-3 text-right">PF</th>
                  <th class="px-4 py-3 text-right">Max DD</th>
                  <th class="px-4 py-3 text-right">Sharpe</th>
                </tr>
              </thead>
              <tbody>
                {statsData.groups.map((g: GroupStats, i: number) => (
                  <tr key={i} class="border-b hover:bg-gray-50">
                    <td class="px-4 py-3 font-medium">{g.strategy}</td>
                    <td class="px-4 py-3">{g.interval}</td>
                    <td class="px-4 py-3">{g.symbol}</td>
                    <td class="px-4 py-3 capitalize">{g.broker}</td>
                    <td class="px-4 py-3 text-right">{g.total}</td>
                    <td class="px-4 py-3 text-right text-green-600">{g.win_count}</td>
                    <td class="px-4 py-3 text-right text-red-600">{g.loss_count}</td>
                    <td class="px-4 py-3 text-right">{pct(g.win_rate)}</td>
                    <td class={`px-4 py-3 text-right font-medium ${g.total_pnl > 0 ? 'text-green-600' : g.total_pnl < 0 ? 'text-red-600' : ''}`}>
                      {fmt(g.total_pnl)}
                    </td>
                    <td class={`px-4 py-3 text-right ${g.avg_pnl > 0 ? 'text-green-600' : g.avg_pnl < 0 ? 'text-red-600' : ''}`}>
                      {fmt(g.avg_pnl)}
                    </td>
                    <td class="px-4 py-3 text-right text-green-600">{fmt(g.avg_win)}</td>
                    <td class="px-4 py-3 text-right text-red-600">{fmt(g.avg_loss)}</td>
                    <td class="px-4 py-3 text-right">{fmt(g.profit_factor)}</td>
                    <td class="px-4 py-3 text-right text-red-600">{fmt(g.max_drawdown)}</td>
                    <td class="px-4 py-3 text-right">{fmt(g.sharpe_ratio)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* トレード一覧セクション */}
      <section>
        <h2 class="text-xl font-semibold mb-3">Trade List</h2>

        {recordsError && (
          <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
            {recordsError}
          </div>
        )}

        {recordsData && (
          <div>
            <p class="text-sm text-gray-500 mb-2">
              {recordsData.total} trades found — page {recordsData.page} / {recordsData.total_pages}
            </p>

            <div class="bg-white shadow rounded-lg overflow-x-auto mb-4">
              {recordsData.records.length === 0 ? (
                <p class="text-gray-500 p-4">No trades found.</p>
              ) : (
                <table class="min-w-full text-left text-sm whitespace-nowrap">
                  <thead class="uppercase tracking-wider border-b-2 text-gray-600 bg-gray-50">
                    <tr>
                      <th class="px-4 py-3">Opened At</th>
                      <th class="px-4 py-3">Closed At</th>
                      <th class="px-4 py-3">Strategy</th>
                      <th class="px-4 py-3">Interval</th>
                      <th class="px-4 py-3">Ticker</th>
                      <th class="px-4 py-3">Broker</th>
                      <th class="px-4 py-3">Side</th>
                      <th class="px-4 py-3 text-right">Entry</th>
                      <th class="px-4 py-3 text-right">Exit</th>
                      <th class="px-4 py-3 text-right">Size</th>
                      <th class="px-4 py-3 text-right">PnL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recordsData.records.map((r, i) => (
                      <tr key={i} class="border-b hover:bg-gray-50">
                        <td class="px-4 py-3 text-xs">{new Date(r.opened_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</td>
                        <td class="px-4 py-3 text-xs">{new Date(r.closed_at).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}</td>
                        <td class="px-4 py-3">{r.strategy}</td>
                        <td class="px-4 py-3">{r.interval}</td>
                        <td class="px-4 py-3">{r.symbol}</td>
                        <td class="px-4 py-3 capitalize">{r.broker}</td>
                        <td class="px-4 py-3">
                          <span class={`px-2 py-0.5 rounded text-xs font-bold ${r.entry_side === 'BUY' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                            {r.entry_side}
                          </span>
                        </td>
                        <td class="px-4 py-3 text-right">{r.entry_price.toLocaleString('ja-JP')}</td>
                        <td class="px-4 py-3 text-right">{r.exit_price.toLocaleString('ja-JP')}</td>
                        <td class="px-4 py-3 text-right">{r.size}</td>
                        <td class={`px-4 py-3 text-right font-medium ${r.pnl > 0 ? 'text-green-600' : r.pnl < 0 ? 'text-red-600' : ''}`}>
                          {r.pnl.toLocaleString('ja-JP')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* ページネーション */}
            <div class="flex justify-between items-center">
              <div>
                {recordsData.page > 1 && (
                  <a
                    href={buildPageUrl(recordsData.page - 1)}
                    class="inline-block bg-gray-200 hover:bg-gray-300 text-gray-800 font-semibold py-2 px-4 rounded"
                  >
                    ← Prev
                  </a>
                )}
              </div>
              <span class="text-sm text-gray-500">
                {recordsData.page} / {recordsData.total_pages}
              </span>
              <div>
                {recordsData.page < recordsData.total_pages && (
                  <a
                    href={buildPageUrl(recordsData.page + 1)}
                    class="inline-block bg-gray-200 hover:bg-gray-300 text-gray-800 font-semibold py-2 px-4 rounded"
                  >
                    Next →
                  </a>
                )}
              </div>
            </div>
          </div>
        )}
      </section>
    </div>
  )
})
