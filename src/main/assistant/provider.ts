/**
 * Torra API 模型 → pi ModelRuntime 的映射层。
 *
 * 三个约束决定了这里的写法：
 *
 * 1. **密钥不落盘**。KeychainSecretStore 出来的明文 key 只走
 *    `setRuntimeApiKey()`（内存覆盖层，RuntimeCredentials.read 优先于文件存储），
 *    registerProvider 配置里那个占位串永远不会被解析成真实 key，
 *    所以磁盘上任何 pi 配置都不含密钥。
 *
 * 2. **一个 Torra 模型独占一个 pi provider**。pi 的 Model 只有 `id` 一个名字字段，
 *    请求体里的 `model` 直接取它，所以注册的 id 必须是服务端认识的那个名字
 *    （cfg.api.model），而不是 Torra 内部的 cfg.id —— 后者形如 `api-user-xxx`，
 *    服务端只会回 404 model_not_available。既然 id 归服务端命名，同一 provider 里
 *    就可能出现「两个 Torra 模型同名但端点/Key 不同」，只能按 Torra id 拆 provider。
 *    顺带的好处：Key 也是 provider 级的，拆开之后换模型不再互相顶掉鉴权。
 *
 * 3. **SDK 只能通过 loadPiSdk() 取值**，类型走 import type。原因见 pi-sdk.ts。
 */

import path from 'node:path'
import type { ModelRuntime } from '@earendil-works/pi-coding-agent'
import type { ModelConfig } from '../../shared/types'
import { lookupPublicPrice } from '../../shared/model-prices'
import { loadPiSdk } from './pi-sdk'

/** Torra 模型在 pi 里的 provider 前缀。用户可见处一律显示 Torra 模型名，不显示它。 */
const PROVIDER_PREFIX = 'torra'

/**
 * Torra 模型 id → pi provider id。一个模型一个 provider，
 * 于是这里是个纯函数而不是查表：任何拿着 Torra id 的地方都能直接换算。
 */
export function piProviderId(modelId: string): string {
  return `${PROVIDER_PREFIX}-${modelId}`
}

type PiProviderConfig = Parameters<ModelRuntime['registerProvider']>[1]
type PiModelConfig = NonNullable<PiProviderConfig['models']>[number]

export interface AssistantModel {
  /** Torra 模型 id，用于上层定位配置 */
  id: string
  /** pi 侧的 provider 名（由 id 换算，见 piProviderId） */
  providerId: string
  /** 发给服务端的模型名，同时也是 pi 里的 model id */
  modelId: string
  displayName: string
  protocol: 'openai' | 'anthropic'
  baseUrl: string
  /** 该模型的 key 是否已在钥匙串里；false 时不能选为助手模型 */
  hasKey: boolean
}

export interface AssistantRuntime {
  runtime: ModelRuntime
  models: AssistantModel[]
}

/** 助手对话的输出上限。Torra 现有 API 通道用 4096 跑通过，这里放宽到 8192。 */
const ASSISTANT_MAX_TOKENS = 8192

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

/**
 * Torra 侧的 baseUrl 统一按 OpenAI 口径存（可以带 /v1），但 pi 的 Anthropic 客户端会自己
 * 补 /v1/messages —— 带着 /v1 过去就拼成 /v1/v1/messages。发言通道（ApiAgent）已按同一
 * 规则归一，两边必须一致，否则会出现「助手能用、议事厅一个字都不说」这种只对得上半边的故障。
 */
function piBaseUrl(baseUrl: string, anthropic: boolean): string {
  const base = normalizeBaseUrl(baseUrl)
  return anthropic ? base.replace(/\/v1$/, '') : base
}

/**
 * Torra 的 ApiConfig 只记录协议与端点，没有 pi 必填的 reasoning/input/cost 元数据。
 * 这里给保守值：不声明推理能力、不声明图像输入。
 * 报多了会直接表现为请求被服务端拒（给纯文本端点发 image_url），报少了只是少个能力。
 */
function toPiModelConfig(cfg: ModelConfig, headers?: Record<string, string>, nameOverride?: string): PiModelConfig {
  const api = cfg.api!
  const wireApi = api.wireApi ?? (api.protocol === 'anthropic' ? 'anthropic-messages' : 'chat-completions')
  const anthropic = wireApi === 'anthropic-messages'
  const responses = wireApi === 'responses'
  const contextWindow = Math.max(4096, Math.floor(api.maxContextTokens || 128000))
  // 清单成员按公开价目重算，认不出沿用条目单价；默认模型保持条目价不动
  const listed = nameOverride ? lookupPublicPrice(nameOverride) : null
  return {
    // 这个 id 会被原样写进请求体的 model 字段，必须是服务端侧的模型名
    id: (nameOverride ?? api.model).trim(),
    name: cfg.displayName,
    api: anthropic ? 'anthropic-messages' : responses ? 'openai-responses' : 'openai-completions',
    baseUrl: piBaseUrl(api.baseUrl, anthropic),
    // Codex 复用 provider 的自定义请求头：值只在主进程内存，来自钥匙串
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    reasoning: false,
    // 只有模型显式声明支持视觉时才报 image：给纯文本端点发 image 会被服务端拒
    input: cfg.api?.vision ? ['text', 'image'] : ['text'],
    cost: {
      input: listed?.pricePerMTokIn || api.pricePerMTokIn || 0,
      output: listed?.pricePerMTokOut || api.pricePerMTokOut || 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow,
    maxTokens: Math.min(ASSISTANT_MAX_TOKENS, Math.max(1024, Math.floor(contextWindow / 4))),
    ...(anthropic
      ? {}
      : {
          // 第三方 OpenAI 兼容端点的公约数：不发明细角色、不用新字段名、不猜推理参数。
          compat: {
            supportsDeveloperRole: false,
            supportsStore: false,
            supportsReasoningEffort: false,
            maxTokensField: 'max_tokens',
          },
        }),
  }
}

export function isUsableApiModel(cfg: ModelConfig): boolean {
  return (
    cfg.enabled &&
    cfg.transport === 'api' &&
    !!cfg.api &&
    typeof cfg.api.baseUrl === 'string' &&
    cfg.api.baseUrl.trim().length > 0 &&
    typeof cfg.api.model === 'string' &&
    cfg.api.model.trim().length > 0
  )
}

/**
 * 建立助手用的 ModelRuntime。
 *
 * `modelsPath: null` 是刻意的：不读也不写 `~/.pi/agent/models.json` ——
 * 桌面应用不能借用 CLI 的配置文件，否则用户改 CLI 就改变了应用行为。
 * `allowModelNetwork: false` 同理：启动阶段不发任何模型目录请求。
 */
export async function createAssistantRuntime(opts: {
  userDataDir: string
  models: ModelConfig[]
  hasKey: (ref: string) => boolean
  getSecret: (ref: string) => string | null
}): Promise<AssistantRuntime> {
  const sdk = await loadPiSdk()
  const usable = opts.models.filter(isUsableApiModel)
  const piDir = path.join(opts.userDataDir, 'pi')

  const runtime = await sdk.ModelRuntime.create({
    authPath: path.join(piDir, 'auth.json'),
    modelsPath: null,
    allowModelNetwork: false,
  })

  for (const cfg of usable) {
    // 可切换清单里的每个模型都注册成独立 Model：id 必须是服务端认识的名字，
    // 默认模型排头（pi 取 provider 下第一个作为 fallback）。费用按名查公开价目，
    // 认不出沿用条目单价 —— 与议事厅 effectiveApiConfig 同一口径。
    const names = cfg.api!.availableModels?.length
      ? cfg.api!.availableModels
      : [cfg.api!.model]
    const models = names.map((name) =>
      toPiModelConfig(cfg, parseSecretHeaders(cfg.api!.headersRef ? opts.getSecret(cfg.api!.headersRef) : null), name),
    )
    // registerProvider 会同步校验并 throw（缺 baseUrl / api 等），失败要冒泡：
    // 静默降级会让上层以为「没有可用模型」，而真实原因是某个模型配置写坏了。
    runtime.registerProvider(piProviderId(cfg.id), {
      name: cfg.displayName,
      baseUrl: models[0]!.baseUrl,
      // 占位串：真实 key 永远通过 setRuntimeApiKey 注入，不进这个配置对象。
      apiKey: '$TORRA_PI_UNSET',
      models,
    })
  }

  return {
    runtime,
    models: usable.map((cfg) => ({
      id: cfg.id,
      providerId: piProviderId(cfg.id),
      modelId: cfg.api!.model.trim(),
      displayName: cfg.displayName,
      protocol: cfg.api!.protocol === 'anthropic' ? 'anthropic' : 'openai',
      baseUrl: normalizeBaseUrl(cfg.api!.baseUrl),
      hasKey: opts.hasKey(cfg.api!.apiKeyRef),
    })),
  }
}

/** 解析钥匙串里保存的 JSON 请求头（由 Codex 导入写入）；坏数据静默为空，不外泄原文 */
export function parseSecretHeaders(raw: string | null): Record<string, string> | undefined {
  if (!raw) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed)) if (typeof v === 'string') out[k] = v
    return Object.keys(out).length > 0 ? out : undefined
  } catch {
    return undefined
  }
}

/**
 * 把某个 Torra 模型的 key 装进 runtime，并返回 pi 侧的 Model 句柄。
 *
 * key 由调用方现场从钥匙串取：不缓存、不写日志、不回传渲染层。
 * 每个条目独占一个 provider，所以注入的 key 只作用于这一个条目；
 * modelName 缺省取条目默认模型，给了则取清单里注册的那个（同 provider 下多个 Model）。
 */
export async function applyModelKey(
  runtime: ModelRuntime,
  modelId: string,
  apiKey: string,
  modelName?: string,
): Promise<NonNullable<ReturnType<ModelRuntime['getModel']>>> {
  if (!apiKey) throw new Error(`模型 ${modelId} 缺少 API Key`)
  const providerId = piProviderId(modelId)
  const list = runtime.getModels(providerId)
  const model = (modelName ? list.find((m) => m.id === modelName) : undefined) ?? list[0]
  if (!model) throw new Error(`助手尚未注册该模型：${modelId}${modelName ? ` 的 ${modelName}` : ''}`)
  await runtime.setRuntimeApiKey(providerId, apiKey)
  return model
}
