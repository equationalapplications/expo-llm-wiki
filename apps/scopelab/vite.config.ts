import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import { resolve } from 'path'
import fs from 'fs'
import { createRequire } from 'module'

const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'expo-llm-wiki'
const require = createRequire(import.meta.url)

const sqlWasmPlugin = () => ({
  name: 'copy-sql-wasm',
  buildStart() {
    const src = require.resolve('sql.js/dist/sql-wasm.wasm')
    const dest = resolve('./public/sql-wasm.wasm')
    fs.mkdirSync('./public', { recursive: true })
    fs.copyFileSync(src, dest)
  },
})

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? `/${repoName}/scopelab/` : '/',
  plugins: [
    react(),
    sqlWasmPlugin(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'sql-wasm.wasm'],
      manifest: {
        name: 'ScopeLab',
        short_name: 'ScopeLab',
        description: 'Client-side LLM tool playground with memory',
        theme_color: '#1e293b',
        background_color: '#0f172a',
        display: 'standalone',
        icons: [
          {
            src: '/favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml'
          }
        ]
      },
      workbox: {
        runtimeCaching: [
          {
            urlPattern: /\.wasm$/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'wasm-cache',
              expiration: { maxEntries: 10 }
            }
          }
        ]
      }
    })
  ],
  optimizeDeps: {
    include: ['sql.js']
  }
})
