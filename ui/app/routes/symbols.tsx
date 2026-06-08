import { createRoute } from 'honox/factory'
import type { SymbolsResponse, TradableSymbol } from '@trade-gateway/api'
import { fetchApiJson } from '../lib/api'
import { buildSymbolDetailPath } from '../lib/symbols'

const formatJstDateTime = (value: string | Date): string =>
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

const statusBadge = (status: TradableSymbol['trade_control']['status']) =>
  status === 'paused'
    ? 'bg-red-100 text-red-800'
    : 'bg-green-100 text-green-800'

export default createRoute(async (c) => {
  let errorMsg = c.req.query('error') || ''
  let data: SymbolsResponse | null = null

  try {
    data = await fetchApiJson<SymbolsResponse>('/api/symbols')
  } catch (error) {
    errorMsg = error instanceof Error ? error.message : 'Unknown error'
  }

  return c.render(
    <div class="max-w-7xl mx-auto p-4">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-3xl font-bold">Symbols</h1>
        <a href="/" class="text-blue-500 hover:underline">Back to Home</a>
      </div>

      {errorMsg && (
        <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {errorMsg}
        </div>
      )}

      {data && (
        <div class="bg-white shadow rounded-lg overflow-x-auto">
          {data.symbols.length === 0 ? (
            <p class="text-gray-500 p-4">No symbols found.</p>
          ) : (
            <table class="min-w-full text-left text-sm whitespace-nowrap">
              <thead class="uppercase tracking-wider border-b-2 text-gray-600 bg-gray-50">
                <tr>
                  <th class="px-4 py-3">Display</th>
                  <th class="px-4 py-3">Symbol ID</th>
                  <th class="px-4 py-3">Broker</th>
                  <th class="px-4 py-3">Ticker</th>
                  <th class="px-4 py-3">Currency</th>
                  <th class="px-4 py-3">Status</th>
                  <th class="px-4 py-3">Reason</th>
                  <th class="px-4 py-3">Updated</th>
                  <th class="px-4 py-3">Detail</th>
                </tr>
              </thead>
              <tbody>
                {data.symbols.map((symbol) => (
                  <tr key={symbol.id} class="border-b hover:bg-gray-50">
                    <td class="px-4 py-3 font-medium">{symbol.display_name || symbol.id}</td>
                    <td class="px-4 py-3">{symbol.id}</td>
                    <td class="px-4 py-3 capitalize">{symbol.broker}</td>
                    <td class="px-4 py-3">{symbol.ticker}</td>
                    <td class="px-4 py-3">{symbol.currency}</td>
                    <td class="px-4 py-3">
                      <span class={`px-2 py-0.5 rounded text-xs font-bold ${statusBadge(symbol.trade_control.status)}`}>
                        {symbol.trade_control.status}
                      </span>
                    </td>
                    <td class="px-4 py-3">{symbol.trade_control.reason || '—'}</td>
                    <td class="px-4 py-3 text-xs">{formatJstDateTime(symbol.updated_at)}</td>
                    <td class="px-4 py-3">
                      <a href={buildSymbolDetailPath(symbol.id)} class="text-blue-600 hover:underline">
                        Open
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
})
