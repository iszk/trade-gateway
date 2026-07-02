import { createApp } from 'honox/server'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'

const app = createApp({})
const staticRoot = process.env.STATIC_ROOT || './dist'
const isProductionServer = process.env.NODE_ENV !== 'development'

if (isProductionServer) {
  app.use('/static/*', serveStatic({ root: staticRoot }))
  app.use('/favicon.ico', serveStatic({ root: staticRoot }))
}

export default app

// vite dev server から import される場合は起動しない
if (isProductionServer) {
  const port = Number(process.env.PORT) || 5173
  serve({ fetch: app.fetch, port }, () => {
    console.log(`UI server running at http://localhost:${port}`)
  })
}
