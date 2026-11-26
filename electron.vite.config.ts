import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          runtime: resolve(__dirname, 'src/runtime/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    }
  },
  renderer: {
    server: {
      // 本机 IPv6 回环不可用，固定 IPv4 否则 Electron 连不上 5173
      host: '127.0.0.1'
    },
    build: {
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-three': ['three'],
            'vendor-mermaid': ['mermaid'],
            'vendor-pdf': ['pdfjs-dist'],
            'vendor-office': ['xlsx', 'jszip', 'mammoth']
          }
        }
      }
    },
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react(), tailwindcss()]
  }
})
