import { createRoute } from 'honox/factory'
import type { TradableSymbol } from '@trade-gateway/api'
import { fetchApiJson, sendApiJson } from '../../lib/api'
import { buildApiSymbolPath, buildSymbolDetailPath } from '../../lib/symbols'

type SymbolResponse = {
  symbol: TradableSymbol
}

const textValue = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : ''

const getSymbolIdParam = (value: string | undefined): string =>
  decodeURIComponent(value || '')

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

export const POST = createRoute(async (c) => {
  const symbolId = getSymbolIdParam(c.req.param('symbol_id'))
  const body = await c.req.parseBody()
  const action = textValue(body.action)
  const detailPath = buildSymbolDetailPath(symbolId)

  try {
    if (action === 'save') {
      await sendApiJson(buildApiSymbolPath(symbolId), 'PUT', {
        display_name: textValue(body.display_name) || undefined,
        currency: textValue(body.currency) || 'JPY',
        note: textValue(body.note) || undefined,
      })
    } else if (action === 'pause' || action === 'resume') {
      await sendApiJson(`${buildApiSymbolPath(symbolId)}/trade-control`, 'PATCH', {
        status: action === 'pause' ? 'paused' : 'active',
        reason: textValue(body.reason) || undefined,
      })
    } else {
      return c.redirect(`${detailPath}?error=unknown_action`)
    }
  } catch (error) {
    const message = encodeURIComponent(error instanceof Error ? error.message : 'Unknown error')
    return c.redirect(`${detailPath}?error=${message}`)
  }

  return c.redirect(`${detailPath}?saved=1`)
})

export default createRoute(async (c) => {
  const symbolId = getSymbolIdParam(c.req.param('symbol_id'))
  const errorMsg = c.req.query('error') || ''
  const saved = c.req.query('saved') === '1'
  let data: SymbolResponse | null = null
  let fetchError = ''

  try {
    data = await fetchApiJson<SymbolResponse>(buildApiSymbolPath(symbolId))
  } catch (error) {
    fetchError = error instanceof Error ? error.message : 'Unknown error'
  }

  return c.render(
    <div class="max-w-4xl mx-auto p-4">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-3xl font-bold">Symbol Detail</h1>
        <a href="/symbols" class="text-blue-500 hover:underline">Back to Symbols</a>
      </div>

      {errorMsg && (
        <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {errorMsg}
        </div>
      )}

      {saved && (
        <div class="bg-green-100 border border-green-400 text-green-700 px-4 py-3 rounded mb-4">
          Saved.
        </div>
      )}

      {fetchError && (
        <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {fetchError}
        </div>
      )}

      {data && (
        <div class="space-y-6">
          <section class="bg-white shadow rounded-lg p-4">
            <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <div class="text-xs font-semibold uppercase text-gray-500">Symbol ID</div>
                <div class="font-medium">{data.symbol.id}</div>
              </div>
              <div>
                <div class="text-xs font-semibold uppercase text-gray-500">Status</div>
                <span class={`inline-block px-2 py-0.5 rounded text-xs font-bold ${statusBadge(data.symbol.trade_control.status)}`}>
                  {data.symbol.trade_control.status}
                </span>
              </div>
              <div>
                <div class="text-xs font-semibold uppercase text-gray-500">Broker</div>
                <div class="capitalize">{data.symbol.broker}</div>
              </div>
              <div>
                <div class="text-xs font-semibold uppercase text-gray-500">Ticker</div>
                <div>{data.symbol.ticker}</div>
              </div>
              <div>
                <div class="text-xs font-semibold uppercase text-gray-500">Trade Control Reason</div>
                <div>{data.symbol.trade_control.reason || '—'}</div>
              </div>
              <div>
                <div class="text-xs font-semibold uppercase text-gray-500">Updated</div>
                <div>{formatJstDateTime(data.symbol.updated_at)}</div>
              </div>
            </div>
          </section>

          <section class="bg-white shadow rounded-lg p-4">
            <h2 class="text-xl font-semibold mb-4">Metadata</h2>
            <form method="post" action={buildSymbolDetailPath(data.symbol.id)}>
              <input type="hidden" name="action" value="save" />
              <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label class="block text-xs font-semibold text-gray-600 mb-1">Display Name</label>
                  <input name="display_name" value={data.symbol.display_name || ''} class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm" />
                </div>
                <div>
                  <label class="block text-xs font-semibold text-gray-600 mb-1">Currency</label>
                  <input name="currency" value={data.symbol.currency} class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm" />
                </div>
                <div class="sm:col-span-2">
                  <label class="block text-xs font-semibold text-gray-600 mb-1">Note</label>
                  <textarea name="note" class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm min-h-24">{data.symbol.note || ''}</textarea>
                </div>
              </div>
              <div class="mt-4 flex justify-end">
                <button type="submit" class="bg-blue-500 hover:bg-blue-600 text-white font-semibold py-2 px-6 rounded shadow text-sm">
                  Save
                </button>
              </div>
            </form>
          </section>

          <section class="bg-white shadow rounded-lg p-4">
            <h2 class="text-xl font-semibold mb-4">Trade Control</h2>
            <form method="post" action={buildSymbolDetailPath(data.symbol.id)}>
              <div class="grid grid-cols-1 gap-4 sm:grid-cols-[1fr_auto]">
                <div>
                  <label class="block text-xs font-semibold text-gray-600 mb-1">Reason</label>
                  <input
                    name="reason"
                    value={data.symbol.trade_control.reason || ''}
                    class="border border-gray-300 rounded px-3 py-1.5 w-full text-sm"
                  />
                </div>
                <div class="flex items-end">
                  {data.symbol.trade_control.status === 'paused' ? (
                    <button type="submit" name="action" value="resume" class="bg-green-600 hover:bg-green-700 text-white font-semibold py-2 px-6 rounded shadow text-sm">
                      Resume
                    </button>
                  ) : (
                    <button type="submit" name="action" value="pause" class="bg-red-600 hover:bg-red-700 text-white font-semibold py-2 px-6 rounded shadow text-sm">
                      Pause
                    </button>
                  )}
                </div>
              </div>
            </form>
          </section>
        </div>
      )}
    </div>
  )
})
