import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import type { Plugin } from 'vite'

// S4：打包后的界面加上内容安全策略。自用版本允许从 https CDN 加载脚本、样式、字体和图片（HTML 预览常用）；
// connect-src 仍限定本地资源，即使出现注入也无法把数据通过 fetch/XHR 发往外部；
// 开发模式不注入（Vite 热更新需要内联脚本）。HTML 预览 iframe（srcdoc）会继承该策略。
const RENDERER_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob: https:",
  "style-src 'self' 'unsafe-inline' https:",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: https:",
  "media-src 'self' data: blob: https:",
  "worker-src 'self' blob:",
  "connect-src 'self' data: blob:",
  "frame-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'"
].join('; ')

function injectRendererCsp(): Plugin {
  return {
    name: 'design-agent-inject-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<head>',
        `<head>\n    <meta http-equiv="Content-Security-Policy" content="${RENDERER_CSP}" />`
      )
    }
  }
}

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
            'vendor-office': ['exceljs', 'jszip', 'mammoth']
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
    plugins: [react(), tailwindcss(), injectRendererCsp()]
  }
})
