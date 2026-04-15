import { createRoute } from 'honox/factory'
import { hc } from 'hono/client'
import type { AppType } from '@trade-gateway/api'

export default createRoute(async (c) => {
  const apiUrl = process.env.API_URL || 'http://localhost:3000'
  const apiSecret = process.env.API_SECRET || ''

  const client = hc<AppType>(apiUrl, {
    headers: {
      Authorization: `Bearer ${apiSecret}`
    }
  })

  let errorMsg = ''
  let positionsData: any = null

  try {
    const res = await client.api.positions.$get()
    if (!res.ok) {
      errorMsg = `Failed to fetch positions: ${res.status} ${res.statusText}`
    } else {
      positionsData = await res.json()
    }
  } catch (e: any) {
    errorMsg = `Error: ${e.message}`
  }

  return c.render(
    <div class="max-w-6xl mx-auto p-4">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-3xl font-bold">Positions</h1>
        <a href="/" class="text-blue-500 hover:underline">Back to Home</a>
      </div>

      {errorMsg && (
        <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {errorMsg}
        </div>
      )}

      {positionsData && (
        <div>
          <p class="text-sm text-gray-500 mb-4">
            Last Updated: {new Date(positionsData.updated_at).toLocaleString()}
          </p>
          
          <div class="bg-white shadow rounded-lg p-4 overflow-x-auto">
            {positionsData.positions.length === 0 ? (
              <p class="text-gray-500">No positions found.</p>
            ) : (
              <table class="min-w-full text-left text-sm whitespace-nowrap">
                <thead class="uppercase tracking-wider border-b-2 text-gray-600">
                  <tr>
                    <th scope="col" class="px-6 py-3">Broker</th>
                    <th scope="col" class="px-6 py-3">Ticker</th>
                    <th scope="col" class="px-6 py-3">Side</th>
                    <th scope="col" class="px-6 py-3 text-right">Size</th>
                    <th scope="col" class="px-6 py-3 text-right">Price</th>
                    <th scope="col" class="px-6 py-3 text-right">PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {positionsData.positions.map((pos: any, i: number) => (
                    <tr key={i} class="border-b hover:bg-gray-50">
                      <td class="px-6 py-4 font-medium capitalize">{pos.broker}</td>
                      <td class="px-6 py-4">{pos.ticker}</td>
                      <td class="px-6 py-4">
                        <span class={`px-2 py-1 rounded text-xs font-bold ${pos.side === 'BUY' ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
                          {pos.side}
                        </span>
                      </td>
                      <td class="px-6 py-4 text-right">{pos.size}</td>
                      <td class="px-6 py-4 text-right">{pos.price !== undefined ? pos.price : '-'}</td>
                      <td class={`px-6 py-4 text-right font-medium ${pos.pnl && pos.pnl > 0 ? 'text-green-600' : pos.pnl && pos.pnl < 0 ? 'text-red-600' : ''}`}>
                        {pos.pnl !== undefined ? pos.pnl : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  )
})
