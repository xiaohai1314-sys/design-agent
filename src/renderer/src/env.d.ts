/// <reference types="vite/client" />
import type { ZmoBridgeApi } from '@shared/ipc'

declare global {
  interface Window {
    zmo: ZmoBridgeApi
  }
}

export {}
