import { createRoute } from 'honox/factory'
import Counter from '../islands/counter'

export default createRoute((c) => {
  return c.render(
    <div class="max-w-4xl mx-auto p-8 text-center">
      <title>Trade Gateway</title>
      <h1 class="text-3xl font-bold mb-8">Trade Gateway Dashboard</h1>

      <div class="flex justify-center space-x-6 mb-12">
        <a href="/positions" class="bg-indigo-500 hover:bg-indigo-600 text-white font-semibold py-3 px-6 rounded shadow">
          View Positions
        </a>
        <a href="/saxo-uic" class="bg-teal-500 hover:bg-teal-600 text-white font-semibold py-3 px-6 rounded shadow">
          Search Saxo UIC
        </a>
        <a href="/trade-records" class="bg-purple-500 hover:bg-purple-600 text-white font-semibold py-3 px-6 rounded shadow">
          Trade Records
        </a>
        <a href="/orders-v2" class="bg-orange-500 hover:bg-orange-600 text-white font-semibold py-3 px-6 rounded shadow">
          Orders V2
        </a>
        <a href="/symbols" class="bg-slate-600 hover:bg-slate-700 text-white font-semibold py-3 px-6 rounded shadow">
          Symbols
        </a>
      </div>

      <div class="border-t pt-8">
        <h2 class="text-xl font-semibold mb-4">Interactive Island Test</h2>
        <Counter />
      </div>
    </div>
  )
})
