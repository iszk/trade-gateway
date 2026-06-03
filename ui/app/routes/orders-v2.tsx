import { createRoute } from 'honox/factory'
import type { StatsV2, OrdersV2StatsResponse, OrdersV2Response, OrderV2 } from '@trade-gateway/api'
import { fetchApiJson } from '../lib/api'
import { fetchSymbolMap, getSymbolDisplayName } from '../lib/symbols'

const fmt = (n: number | null | undefined, digits = 2): string => {
  if (n === null || n === undefined) return '—'
  if (!isFinite(n)) return n > 0 ? '∞' : '-∞'
  return n.toLocaleString('ja-JP', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`

const toDateInputValue = (d: Date): string =>
  d.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' })

const getEffectiveTime = (order: Pick<OrderV2, 'created_at' | 'executed_at'>): string =>
  String(order.executed_at ?? order.created_at)

const formatJstDateTime = (value: string): string =>
  new Intl.DateTimeFormat('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(value))

const statusBadge = (status: OrderV2['status']) => {
  const map: Record<string, string> = {
    PENDING: 'bg-yellow-100 text-yellow-800',
    EXECUTED: 'bg-green-100 text-green-800',
    FAILED: 'bg-red-100 text-red-800',
    CANCELED: 'bg-gray-100 text-gray-800',
  }
  return map[status] ?? 'bg-gray-100 text-gray-800'
}

export default createRoute(async (c) => {
  const now = new Date()
  const defaultFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  const fromParam = c.req.query('from') || toDateInputValue(defaultFrom)
  const toParam = c.req.query('to') || toDateInputValue(now)
  const strategyParam = c.req.query('strategy') || ''
  const pageParam = c.req.query('page') || '1'

  const buildQuery = (extra?: Record<string, string>): Record<string, string> => {
    const q: Record<string, string> = { from: fromParam, to: toParam }
    if (strategyParam) q.strategy = strategyParam
    return { ...q, ...extra }
  }

  let statsError = ''
  let statsData: OrdersV2StatsResponse | null = null
  let ordersError = ''
  let ordersData: OrdersV2Response | null = null
  const symbols = await fetchSymbolMap().catch(() => new Map())

  try {
    statsData = await fetchApiJson<OrdersV2StatsResponse>('/api/v2/orders/stats', { from: fromParam, to: toParam })
  } catch (e) {
    statsError = e instanceof Error ? e.message : 'Unknown error'
  }

  try {
    ordersData = await fetchApiJson<OrdersV2Response>('/api/v2/orders', buildQuery({ page: pageParam }))
  } catch (e) {
    ordersError = e instanceof Error ? e.message : 'Unknown error'
  }

  const buildPageUrl = (page: number): string => {
    const params = new URLSearchParams(buildQuery({ page: String(page) }))
    return `/orders-v2?${params.toString()}`
  }

  return c.render(
    <div class="max-w-7xl mx-auto p-4">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-3xl font-bold">Orders V2</h1>
        <a href="/" class="text-blue-500 hover:underline">Back to Home</a>
      </div>

      {/* フィルターフォーム */}
      <form method="get" action="/orders-v2" class="bg-white shadow rounded-lg p-4 mb-6">
        <div class="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">From (Executed At)</label>
            <input
              type="date"
              name="from"
              value={fromParam}
              class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">To (Executed At)</label>
            <input
              type="date"
              name="to"
              value={toParam}
              class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Strategy (order list)</label>
            <input
              type="text"
              name="strategy"
              value={strategyParam}
              placeholder="all"
              class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div class="flex items-end">
            <button
              type="submit"
              class="bg-blue-500 hover:bg-blue-600 text-white font-semibold py-1.5 px-6 rounded shadow text-sm w-full"
            >
              Apply
            </button>
          </div>
        </div>
      </form>

      {/* Strategy 別統計 */}
      <section class="mb-8">
        <h2 class="text-xl font-semibold mb-3">Statistics by Strategy</h2>

        {statsError && (
          <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
            {statsError}
          </div>
        )}

        {statsData && statsData.stats.length === 0 && (
          <p class="text-gray-500">No data found for the selected period.</p>
        )}

        {statsData && statsData.stats.length > 0 && (
          <div class="bg-white shadow rounded-lg overflow-x-auto">
            <table class="min-w-full text-left text-sm whitespace-nowrap">
              <thead class="uppercase tracking-wider border-b-2 text-gray-600 bg-gray-50">
                <tr>
                  <th class="px-4 py-3">Strategy</th>
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
                  <th class="px-4 py-3 text-right">Position</th>
                  <th class="px-4 py-3 text-right">Avg Entry</th>
                  <th class="px-4 py-3 text-right">Pending</th>
                </tr>
              </thead>
              <tbody>
                {statsData.stats.map((s: StatsV2, i: number) => (
                  <tr key={i} class="border-b hover:bg-gray-50">
                    <td class="px-4 py-3 font-medium">
                      <a
                        href={`/orders-v2?from=${fromParam}&to=${toParam}&strategy=${encodeURIComponent(s.strategy)}`}
                        class="text-blue-600 hover:underline"
                      >
                        {s.strategy}
                      </a>
                    </td>
                    <td class="px-4 py-3 text-right">{s.total_trades}</td>
                    <td class="px-4 py-3 text-right text-green-600">{s.winning_trades}</td>
                    <td class="px-4 py-3 text-right text-red-600">{s.losing_trades}</td>
                    <td class="px-4 py-3 text-right">{pct(s.win_rate)}</td>
                    <td class={`px-4 py-3 text-right font-medium ${s.realized_pnl > 0 ? 'text-green-600' : s.realized_pnl < 0 ? 'text-red-600' : ''}`}>
                      {fmt(s.realized_pnl)}
                    </td>
                    <td class={`px-4 py-3 text-right ${(s.avg_pnl ?? 0) > 0 ? 'text-green-600' : (s.avg_pnl ?? 0) < 0 ? 'text-red-600' : ''}`}>
                      {fmt(s.avg_pnl)}
                    </td>
                    <td class="px-4 py-3 text-right text-green-600">{fmt(s.avg_win)}</td>
                    <td class="px-4 py-3 text-right text-red-600">{fmt(s.avg_loss)}</td>
                    <td class="px-4 py-3 text-right">{fmt(s.profit_factor)}</td>
                    <td class="px-4 py-3 text-right text-red-600">{fmt(s.max_drawdown)}</td>
                    <td class="px-4 py-3 text-right">{fmt(s.sharpe_ratio)}</td>
                    <td class={`px-4 py-3 text-right font-medium ${s.current_position > 0 ? 'text-green-600' : s.current_position < 0 ? 'text-red-600' : 'text-gray-400'}`}>
                      {fmt(s.current_position, 8)}
                    </td>
                    <td class="px-4 py-3 text-right">{fmt(s.average_entry_price, 0)}</td>
                    <td class="px-4 py-3 text-right">
                      {s.open_orders > 0 ? (
                        <span class="bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded text-xs font-bold">
                          {s.open_orders}
                        </span>
                      ) : (
                        <span class="text-gray-400">0</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* 注文一覧 */}
      <section>
        <h2 class="text-xl font-semibold mb-3">
          Order List
          {strategyParam && <span class="ml-2 text-base font-normal text-gray-500">— {strategyParam}</span>}
        </h2>

        {ordersError && (
          <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
            {ordersError}
          </div>
        )}

        {ordersData && (
          <div>
            <p class="text-sm text-gray-500 mb-2">
              {ordersData.total} orders found — page {ordersData.page} / {ordersData.total_pages}
            </p>

            <div class="bg-white shadow rounded-lg overflow-x-auto mb-4">
              {ordersData.orders.length === 0 ? (
                <p class="text-gray-500 p-4">No orders found.</p>
              ) : (
                <table class="min-w-full text-left text-sm whitespace-nowrap">
                  <thead class="uppercase tracking-wider border-b-2 text-gray-600 bg-gray-50">
                    <tr>
                      <th class="px-4 py-3">Executed At (JST)</th>
                      <th class="px-4 py-3">Strategy</th>
                      <th class="px-4 py-3">Broker</th>
                      <th class="px-4 py-3">Ticker</th>
                      <th class="px-4 py-3">Side</th>
                      <th class="px-4 py-3">Type</th>
                      <th class="px-4 py-3 text-right">Req Size</th>
                      <th class="px-4 py-3 text-right">Exec Size</th>
                      <th class="px-4 py-3 text-right">Exec Price</th>
                      <th class="px-4 py-3">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ordersData.orders.map((o: OrderV2, i: number) => (
                      <tr key={i} class="border-b hover:bg-gray-50">
                        <td class="px-4 py-3 text-xs">{formatJstDateTime(getEffectiveTime(o))}</td>
                        <td class="px-4 py-3">{o.strategy}</td>
                        <td class="px-4 py-3 capitalize">{o.broker}</td>
                        <td class="px-4 py-3">{getSymbolDisplayName(symbols, o.broker, o.ticker)}</td>
                        <td class="px-4 py-3">
                          <span class={`px-2 py-0.5 rounded text-xs font-bold ${o.side === 'BUY' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                            {o.side}
                          </span>
                        </td>
                        <td class="px-4 py-3">{o.order_type}</td>
                        <td class="px-4 py-3 text-right">{o.requested_size}</td>
                        <td class="px-4 py-3 text-right">{o.executed_size > 0 ? o.executed_size : '—'}</td>
                        <td class="px-4 py-3 text-right">
                          {o.executed_price !== null ? o.executed_price.toLocaleString('ja-JP') : '—'}
                        </td>
                        <td class="px-4 py-3">
                          <span class={`px-2 py-0.5 rounded text-xs font-bold ${statusBadge(o.status)}`}>
                            {o.status}
                          </span>
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
                {ordersData.page > 1 && (
                  <a
                    href={buildPageUrl(ordersData.page - 1)}
                    class="inline-block bg-gray-200 hover:bg-gray-300 text-gray-800 font-semibold py-2 px-4 rounded"
                  >
                    ← Prev
                  </a>
                )}
              </div>
              <span class="text-sm text-gray-500">
                {ordersData.page} / {ordersData.total_pages}
              </span>
              <div>
                {ordersData.page < ordersData.total_pages && (
                  <a
                    href={buildPageUrl(ordersData.page + 1)}
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
