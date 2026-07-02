import adapter from '@hono/vite-dev-server/node'
import tailwindcss from '@tailwindcss/vite'
import honox from 'honox/vite'
import { defineConfig } from 'vite'

export default defineConfig(({ isSsrBuild }) => {
  return {
    define: isSsrBuild ? {
      'process.env': 'process.env',
    } : undefined,
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:3000',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api/, ''),
        }
      }
    },
    plugins: [
      honox({
        devServer: { adapter },
        client: { input: ['/app/client.ts', '/app/style.css'] }
      }),
      tailwindcss(),
    ]
  }
})
