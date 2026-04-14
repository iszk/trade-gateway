import { createRoute } from 'honox/factory'
import Counter from '../islands/counter'
import { hc } from 'hono/client'
import type { AppType } from '@trade-gateway/api'

// Hono RPC のクライアント作成例 (ここでは型チェックのテスト用)
const client = hc<AppType>('/')

export default createRoute((c) => {
  const name = c.req.query('name') ?? 'Hono'
  return c.render(
    <div class="py-8 text-center">
      <title>{name}</title>
      <h1 class="text-3xl font-bold">Hello, {name}!</h1>
      <Counter />
    </div>
  )
})
