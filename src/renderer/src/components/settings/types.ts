import type { ImageChannelTestLevel } from '@shared/protocol'

export interface ProbeResultState {
  status: 'testing' | 'ok' | 'fail'
  latencyMs?: number
  message?: string
}

/** 生图渠道测试结果（比聊天渠道多一档 warn：探活未完全确认、但不代表出图不可用） */
export interface ImageProbeState {
  status: 'testing' | 'ok' | 'warn' | 'fail'
  level?: ImageChannelTestLevel
  latencyMs?: number
  message?: string
}
