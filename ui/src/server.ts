import { createApp } from 'honox/server'
import { serve } from '@hono/node-server'

const app = createApp()

export default app

// vite dev server から import される場合は起動しない
if (process.env.NODE_ENV !== 'development') {
    const port = Number(process.env.PORT) || 5173
    serve({ fetch: app.fetch, port }, () => {
        console.log(`UI server running at http://localhost:${port}`)
    })
}
