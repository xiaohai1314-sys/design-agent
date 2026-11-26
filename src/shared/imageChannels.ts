import type {
  ImageChannelProtocol,
  ImageChannelRole,
  ImageGenChannel,
  ImageGenConfig
} from './protocol'

export const PRIMARY_IMAGE_CHANNEL_ID = 'primary'

const VALID_PROTOCOLS: ImageChannelProtocol[] = ['auto', 'chat-first', 'images-first']
const VALID_ROLES: ImageChannelRole[] = ['generate', 'edit']

function sanitizeProtocol(raw: unknown): ImageChannelProtocol {
  return VALID_PROTOCOLS.includes(raw as ImageChannelProtocol)
    ? (raw as ImageChannelProtocol)
    : 'auto'
}

function sanitizeRoles(raw: unknown): ImageChannelRole[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const roles = raw.filter((r): r is ImageChannelRole =>
    VALID_ROLES.includes(r as ImageChannelRole)
  )
  return roles.length > 0 ? [...new Set(roles)] : undefined
}

function sanitizeChannel(raw: Partial<ImageGenChannel>, index: number): ImageGenChannel {
  return {
    id: typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : `channel-${index + 1}`,
    name:
      typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : `渠道 ${index + 1}`,
    enabled: raw.enabled !== false,
    baseUrl: typeof raw.baseUrl === 'string' ? raw.baseUrl : '',
    apiKey: typeof raw.apiKey === 'string' ? raw.apiKey : '',
    model: typeof raw.model === 'string' ? raw.model : '',
    editModel: typeof raw.editModel === 'string' ? raw.editModel : undefined,
    protocol: sanitizeProtocol(raw.protocol),
    defaultSize: typeof raw.defaultSize === 'string' ? raw.defaultSize : undefined,
    roles: sanitizeRoles(raw.roles)
  }
}

/** 由旧版单槽平铺字段构造主渠道 */
export function imageChannelFromLegacy(
  config: ImageGenConfig,
  overrides?: Partial<ImageGenChannel>
): ImageGenChannel {
  return sanitizeChannel(
    {
      id: PRIMARY_IMAGE_CHANNEL_ID,
      name: '主渠道',
      enabled: config.enabled,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      editModel: config.editModel,
      protocol: 'auto',
      defaultSize: config.defaultSize,
      ...overrides
    },
    0
  )
}

/**
 * 规范化生图配置（幂等）：
 * - 无 channels 时，把旧版单槽字段迁移为一条主渠道（值原样保留）；
 * - 有 channels 时，channels[0] 为主渠道：平铺字段与它互为镜像，
 *   两者不一致时以平铺字段为准（旧版 UI 只编辑平铺字段），随后回写镜像；
 * - 主渠道的 enabled 跟随总开关 config.enabled，其余渠道用各自的 enabled。
 */
export function normalizeImageGenConfig(config: ImageGenConfig): ImageGenConfig {
  const rawChannels = Array.isArray(config.channels) ? config.channels : []
  let channels: ImageGenChannel[]
  if (rawChannels.length === 0) {
    channels = [imageChannelFromLegacy(config)]
  } else {
    channels = rawChannels.map((c, i) => sanitizeChannel(c, i))
    const primary = channels[0]
    channels[0] = {
      ...primary,
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
      editModel: config.editModel,
      defaultSize: config.defaultSize,
      enabled: config.enabled
    }
  }
  const primary = channels[0]
  return {
    enabled: config.enabled,
    baseUrl: primary.baseUrl,
    apiKey: primary.apiKey,
    model: primary.model,
    editModel: primary.editModel,
    defaultSize: primary.defaultSize,
    channels
  }
}

/**
 * 解析出当前配置的渠道列表（保持配置顺序）：
 * 总开关关闭时返回空；未启用 / 无 Key 的渠道会被剔除。
 * baseUrl / model 为空的渠道保留在列表中（与旧版单槽行为一致，由调用方拼默认端点/模型），
 * 调用方可在组链时对非主渠道做更严格的完整性过滤。
 */
export function resolveImageChannels(config?: ImageGenConfig): ImageGenChannel[] {
  if (!config?.enabled) return []
  const normalized = normalizeImageGenConfig(config)
  return (normalized.channels ?? []).filter((c) => c.enabled && c.apiKey.trim())
}

/**
 * 按任务方向排序渠道：声明了对应 role 的渠道优先，其余保持原顺序。
 * 没有任何渠道声明该 role 时返回原顺序（单渠道用户不受影响）。
 */
export function sortChannelsForRole(
  channels: ImageGenChannel[],
  role?: ImageChannelRole
): ImageGenChannel[] {
  if (!role) return channels
  const preferred = channels.filter((c) => c.roles?.includes(role))
  if (preferred.length === 0) return channels
  const rest = channels.filter((c) => !c.roles?.includes(role))
  return [...preferred, ...rest]
}

/** 取规范化后的渠道列表（主渠道在前，降级链顺序） */
export function imageChannelsOf(img: ImageGenConfig): ImageGenChannel[] {
  return normalizeImageGenConfig(img).channels ?? []
}
