import { createRoute } from 'honox/factory'
import type { SymbolsResponse, TradableSymbol } from '@trade-gateway/api'
import { fetchApiJson, sendApiJson } from '../lib/api'

const textValue = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : ''

export const POST = createRoute(async (c) => {
  const body = await c.req.parseBody()
  const action = textValue(body.action)
  const symbolId = textValue(body.symbol_id)

  if (!symbolId) {
    return c.redirect('/symbols?error=missing_symbol_id')
  }

  try {
    if (action === 'save') {
      await sendApiJson(`/api/symbols/${encodeURIComponent(symbolId)}`, 'PUT', {
        display_name: textValue(body.display_name) || undefined,
        currency: textValue(body.currency) || 'JPY',
        note: textValue(body.note) || undefined,
      })
    } else if (action === 'pause' || action === 'resume') {
      await sendApiJson(`/api/symbols/${encodeURIComponent(symbolId)}/trade-control`, 'PATCH', {
        status: action === 'pause' ? 'paused' : 'active',
        reason: textValue(body.reason) || undefined,
      })
    }
  } catch (error) {
    const message = encodeURIComponent(error instanceof Error ? error.message : 'Unknown error')
    return c.redirect(`/symbols?error=${message}`)
  }

  return c.redirect('/symbols')
})

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

      <form method="post" action="/symbols" class="bg-white shadow rounded-lg p-4 mb-6">
        <input type="hidden" name="action" value="save" />
        <div class="grid grid-cols-1 gap-3 md:grid-cols-5">
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Symbol ID</label>
            <input name="symbol_id" placeholder="bitflyer:BTC_JPY" class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Display Name</label>
            <input name="display_name" class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Currency</label>
            <input name="currency" value="JPY" class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm" />
          </div>
          <div>
            <label class="block text-xs font-semibold text-gray-600 mb-1">Note</label>
            <input name="note" class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm" />
          </div>
          <div class="flex items-end">
            <button type="submit" class="bg-blue-500 hover:bg-blue-600 text-white font-semibold py-1.5 px-4 rounded shadow text-sm w-full">
              Save
            </button>
          </div>
        </div>
      </form>

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
                  <th class="px-4 py-3">Action</th>
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
                      <form method="post" action="/symbols" class="flex gap-2">
                        <input type="hidden" name="symbol_id" value={symbol.id} />
                        <input
                          name="reason"
                          value={symbol.trade_control.reason || ''}
                          placeholder="reason"
                          class="border border-gray-300 rounded px-2 py-1 text-xs"
                        />
                        {symbol.trade_control.status === 'paused' ? (
                          <button type="submit" name="action" value="resume" class="bg-green-600 hover:bg-green-700 text-white font-semibold py-1 px-3 rounded text-xs">
                            Resume
                          </button>
                        ) : (
                          <button type="submit" name="action" value="pause" class="bg-red-600 hover:bg-red-700 text-white font-semibold py-1 px-3 rounded text-xs">
                            Pause
                          </button>
                        )}
                      </form>
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
