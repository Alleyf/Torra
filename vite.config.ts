import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath, URL } from 'node:url'

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url))

export default defineConfig({
  root: r('./src/renderer'),
  base: './',
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': r('./src/shared'),
      '@renderer': r('./src/renderer'),
    },
  },
  server: {
    // 与主进程 loadURL 保持同一地址族：Windows 上 localhost 可能解析到 ::1，
    // 两端不一致会连不上 dev server
    host: '127.0.0.1',
    port: 5273,
    strictPort: true,
  },
  build: {
    outDir: r('./dist/renderer'),
    // 只清 renderer 子目录，避免删掉 tsc 产出的 dist/main、dist/preload
    emptyOutDir: true,
    target: 'chrome130',
  },
})
