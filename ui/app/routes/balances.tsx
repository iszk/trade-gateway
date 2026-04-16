import { createRoute } from 'honox/factory'
import type { BrokerBalance } from '@trade-gateway/api'
import { fetchApiJson } from '../lib/api'

type BalancesResponse = {
  balances: BrokerBalance[]
  updated_at: number
}

export default createRoute(async (c) => {
  let errorMsg = ''
  let balancesData: BalancesResponse | null = null

  try {
    balancesData = await fetchApiJson<BalancesResponse>('/api/balances')
  } catch (e) {
    errorMsg = e instanceof Error ? e.message : 'Unknown error'
  }

  return c.render(
    <div class="max-w-4xl mx-auto p-4">
      <div class="flex justify-between items-center mb-6">
        <h1 class="text-3xl font-bold">Balances</h1>
        <a href="/" class="text-blue-500 hover:underline">Back to Home</a>
      </div>

      {errorMsg && (
        <div class="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
          {errorMsg}
        </div>
      )}

      {balancesData && (
        <div>
          <p class="text-sm text-gray-500 mb-4">
            Last Updated: {new Date(balancesData.updated_at).toLocaleString()}
          </p>
          <div class="space-y-8">
            {balancesData.balances.map((brokerBal) => (
              <div key={brokerBal.broker} class="bg-white shadow rounded-lg p-4">
                <h2 class="text-xl font-semibold mb-4 capitalize border-b pb-2">{brokerBal.broker}</h2>
                {brokerBal.balances.length === 0 ? (
                  <p class="text-gray-500">No balances found.</p>
                ) : (
                  <div class="overflow-x-auto">
                    <table class="min-w-full text-left text-sm whitespace-nowrap">
                      <thead class="uppercase tracking-wider border-b-2 text-gray-600">
                        <tr>
                          <th scope="col" class="px-6 py-3">Asset</th>
                          <th scope="col" class="px-6 py-3 text-right">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {brokerBal.balances.map((bal, i) => (
                          <tr key={`${bal.asset}-${i}`} class="border-b hover:bg-gray-50">
                            <td class="px-6 py-4 font-medium">{bal.asset}</td>
                            <td class="px-6 py-4 text-right">{bal.amount}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
})
