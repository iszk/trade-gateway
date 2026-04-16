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

  const keyword = c.req.query('keyword') || ''
  let errorMsg = ''
  let instruments: any[] = []

  if (keyword) {
    try {
      // The RPC endpoint should match what we defined in the API index.ts
      const res = await client.api.saxo.instruments.$get({
        query: { keyword }
      })
      if (!res.ok) {
        errorMsg = `Failed to fetch instruments: ${res.status} ${res.statusText}`
        const errorData = await res.json().catch(() => null);
        if (errorData && typeof errorData === 'object' && 'error' in errorData) {
            errorMsg += ` - ${(errorData as any).error.message}`
        }
      } else {
        const data = await res.json()
        instruments = data.instruments || []
      }
    } catch (e: any) {
      errorMsg = `Error: ${e.message}`
    }
  }

  return c.render(
    <div class="max-w-4xl mx-auto p-4">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-3xl font-bold">Saxo UIC Search</h1>
        <a href="/" class="text-blue-500 hover:underline">Back to Home</a>
      </div>

      <form method="GET" action="/saxo-uic" class="mb-8">
        <div class="flex gap-2">
          <input
            type="text"
            name="keyword"
            value={keyword}
            placeholder="Search by ticker, name, e.g. US30..."
            class="border border-gray-300 rounded px-4 py-2 flex-grow focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            type="submit"
            class="bg-blue-500 hover:bg-blue-600 text-white font-semibold py-2 px-6 rounded shadow"
          >
            Search
          </button>
        </div>
      </form>

      {errorMsg && (
        <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {errorMsg}
        </div>
      )}

      {keyword && !errorMsg && instruments.length === 0 && (
        <p class="text-gray-500">No instruments found for "{keyword}".</p>
      )}

      {instruments.length > 0 && (
        <div class="bg-white shadow rounded-lg p-4 overflow-x-auto">
          <table class="min-w-full text-left text-sm whitespace-nowrap">
            <thead class="uppercase tracking-wider border-b-2 text-gray-600">
              <tr>
                <th scope="col" class="px-6 py-3">UIC</th>
                <th scope="col" class="px-6 py-3">Symbol</th>
                <th scope="col" class="px-6 py-3">Description</th>
                <th scope="col" class="px-6 py-3">Asset Type</th>
                <th scope="col" class="px-6 py-3">Currency</th>
              </tr>
            </thead>
            <tbody>
              {instruments.map((inst, i) => (
                <tr key={`${inst.Identifier}-${i}`} class="border-b hover:bg-gray-50">
                  <td class="px-6 py-4 font-mono font-bold">{inst.Identifier}</td>
                  <td class="px-6 py-4">{inst.Symbol}</td>
                  <td class="px-6 py-4">{inst.Description}</td>
                  <td class="px-6 py-4">{inst.AssetType}</td>
                  <td class="px-6 py-4">{inst.CurrencyCode}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
})
