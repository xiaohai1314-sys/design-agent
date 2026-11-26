/// <reference types="vite/client" />
import type { DesignAgentBridgeApi } from '@shared/ipc'

declare global {
  interface Window {
    designAgent: DesignAgentBridgeApi
  }
}

export {}
