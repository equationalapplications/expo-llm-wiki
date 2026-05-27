import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import fs from 'fs'

// Copy sql-wasm.wasm to public on startup
const sqlWasmPlugin = () => ({
  name: 'copy-sql-wasm',
  buildStart() {
    const src = resolve('./node_modules/sql.js/dist/sql-wasm.wasm')
    const dest = resolve('./public/sql-wasm.wasm')
    fs.mkdirSync('./public', { recursive: true })
    fs.copyFileSync(src, dest)
  },
})

const repoName = process.env.GITHUB_REPOSITORY?.split('/')[1] ?? 'expo-llm-wiki'

export default defineConfig({
  base: process.env.GITHUB_ACTIONS ? `/${repoName}/playground/` : '/',
  plugins: [react(), sqlWasmPlugin()],
  optimizeDeps: {
    include: ['sql.js'],
  },
})
