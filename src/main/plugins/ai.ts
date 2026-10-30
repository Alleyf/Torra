/**
 * 应用插件的「借用宿主模型」通道。
 *
 * 为什么由主进程代发，而不是让插件自己带一份 API Key：
 * 用户已经在设置里配好了模型与钥匙串，插件再要一份 key 就是重复登记；而且
 * 插件的 net 权限是清单里写死的域名，运行期端点根本过不了白名单。这里只负责
 * 一次非流式的问答 —— 插件决定问什么、怎么拆步骤，宿主决定打哪个端点、花谁的钱。
 *
 * 三条纪律：
 * 1. 只走 API 通道。网页通道是把字键进别人的站点，借给插件等于让插件遥控用户的浏览器会话；
 * 2. 这里是「一次性补全」，不维护对话历史 —— 每步要带上下文就由插件自己拼进 prompt；
 * 3. 调用会计入诊断日志（模型、token、耗时），用户能在流水线里看见钱花在哪。
 */

import { ApiAgent } from '../agents/api-agent'
import type { ModelConfig, TurnContext } from '../../shared/types'

/** 主进程侧能接受的输入上限；插件宿主还会再按自己的口径截一次 */
export const AI_PROMPT_MAX_CHARS = 120_000
export const AI_SYSTEM_MAX_CHARS = 20_000
export const AI_REPLY_MAX_CHARS = 200_000

export interface PluginAiRequest {
  system?: string
  prompt: string
  /** 输出上限，宿主会夹在 [256, 4096] */
  maxTokens?: number
  /** 指定用哪个 Torra 模型；不给就取第一个可用（已启用且钥匙串里有 key）的 API 模型 */
  modelId?: string
}

export interface PluginAiReply {
  text: string
  /** Torra 模型 id 与显示名，面板可以显示「由谁作答」 */
  modelId: string
  model: string
  usage: { promptTokens: number; completionTokens: number; costUsd: number }
}

/** 面板模型下拉里的一项：只列 API 条目，网页通道借不出去 */
export interface PluginAiModel {
  id: string
  /** 给人看的名字 */
  name: string
  /** 服务端模型名：同一个端点下可能挂着好几个 */
  model: string
  enabled: boolean
  /** 钥匙串里有没有 Key；没有的能看见但不能选，免得点下去才发现白跑 */
  hasKey: boolean
}

export interface PluginAiModels {
  models: PluginAiModel[]
  /** 不指定模型时实际会用的那个；null = 一个可用的都没有 */
  preferred: string | null
}

export interface PluginAi {
  complete(req: PluginAiRequest): Promise<PluginAiReply>
  /** 列给面板选模型；老宿主没有这一项时插件要自己留着兜底 */
  models?(): PluginAiModels
}

export interface PluginAiDeps {
  models(): ModelConfig[]
  /** 与 ApiAgent 同一个解析方式：API Key 只在内存里，不落盘 */
  resolveSecret(ref: string): string | null
  /**
   * 助手此刻选中的模型。插件没点名时先跟它走 —— 两边用同一份选择，
   * 用户换助手模型后不必再去每个插件里改一遍。
   */
  preferredModelId?(): string | null
  log(event: { stage: string; subject: string; ok: boolean; detail: string }): void
}

/**
 * 与 smart-add 的 resolveAssistant 同一口径：先看指定，再跟助手，最后取第一个已启用且有 key 的 API 模型。
 * 助手选的模型若已停用或丢了 Key，不能跟着它一起失败，退回首个可用。
 */
export function pickPluginModel(
  models: ModelConfig[],
  modelId: string | undefined,
  hasKey: (ref: string) => boolean,
  preferredId?: string | null,
): ModelConfig | null {
  const api = models.filter((m) => m.transport === 'api' && m.api)
  if (!api.length) return null
  const wanted = String(modelId ?? '').trim()
  if (wanted) {
    const hit = api.find((m) => m.id === wanted)
    return hit && hasKey(hit.api!.apiKeyRef) ? hit : null
  }
  const follow = String(preferredId ?? '').trim()
  if (follow) {
    const hit = api.find((m) => m.id === follow)
    if (hit && hit.enabled && hasKey(hit.api!.apiKeyRef)) return hit
  }
  return api.find((m) => m.enabled && hasKey(m.api!.apiKeyRef)) ?? null
}

export function createPluginAi(deps: PluginAiDeps): PluginAi {
  const hasKey = (ref: string) => Boolean(deps.resolveSecret(ref))
  const defaultModel = (): ModelConfig | null =>
    pickPluginModel(deps.models(), undefined, hasKey, deps.preferredModelId?.() ?? null)

  return {
    models() {
      const wanted = defaultModel()
      return {
        models: deps
          .models()
          .filter((m) => m.transport === 'api' && m.api)
          .map((m) => ({
            id: m.id,
            name: m.displayName,
            model: m.api!.model,
            enabled: m.enabled,
            hasKey: hasKey(m.api!.apiKeyRef),
          })),
        preferred: wanted?.id ?? null,
      }
    },
    async complete(req) {
      const prompt = String(req.prompt ?? '').trim()
      if (!prompt) throw new Error('AI 请求缺少 prompt')
      const system = String(req.system ?? '').trim()
      const maxTokens = Math.min(4096, Math.max(256, Math.floor(Number(req.maxTokens) || 2048)))
      const cfg = pickPluginModel(deps.models(), req.modelId, hasKey, deps.preferredModelId?.() ?? null)
      if (!cfg) {
        throw new Error(
          req.modelId
            ? `模型「${req.modelId}」不可用：它不是 API 模型，或钥匙串里没有它的 Key`
            : '还没有可用的 API 模型：先在设置里添加一个带 Key 的 API 模型，插件才能使用 AI',
        )
      }

      const sessionId = `plugin:${cfg.id}`
      const started = Date.now()
      const agent = new ApiAgent(cfg.id, cfg.displayName, cfg.color, cfg.api!, (ref) => deps.resolveSecret(ref))
      try {
        const ctx: TurnContext = {
          sessionId,
          round: 1,
          topic: { id: sessionId, title: '插件 AI', background: '', strategy: 'roundtable', attachments: [], createdAt: started },
          digest: { confirmed: [], open: [], explored: [], rounds: [], questions: [] },
          callout: null,
          maxLenChars: 0,
          // chat 模式绕过圆桌发言格式；system 由插件给，缺省用助手的通用人设
          chat: { history: [{ role: 'user', content: prompt }], ...(system ? { system } : {}) },
        }
        const res = await agent.send(ctx, () => {})
        const textContent = String(res.content ?? '').trim()
        if (!textContent) {
          deps.log({
            stage: 'plugin:ai',
            subject: cfg.id,
            ok: false,
            detail: `空回复（${Date.now() - started}ms）`,
          })
          throw new Error('模型返回了空内容，换个模型或稍后再试')
        }
        deps.log({
          stage: 'plugin:ai',
          subject: cfg.id,
          ok: true,
          detail: `chars=${textContent.length} tok=${res.usage.promptTokens}/${res.usage.completionTokens} ms=${Date.now() - started}`,
        })
        return {
          text: textContent.slice(0, AI_REPLY_MAX_CHARS),
          modelId: cfg.id,
          model: cfg.displayName,
          usage: {
            promptTokens: res.usage.promptTokens,
            completionTokens: res.usage.completionTokens,
            costUsd: res.usage.costUsd,
          },
        }
      } finally {
        agent.dispose()
      }
    },
  }
}
