/**
 * API 模型的品牌域名归一。
 *
 * favicon 只能按域名取图，而 API 端点往往不是品牌主站（api.deepseek.com），
 * 中转站更可能完全没有公开图标。这里先认模型名，再认端点主机，最后才退回
 * 主机自身；本地/内网地址直接返回 undefined，交给界面统一字母牌兜底。
 */

export interface ModelBrandInput {
  transport?: 'webview' | 'api'
  /** 网页模型已经解析好的站点域名 */
  domain?: string
  baseUrl?: string
  model?: string
  displayName?: string
}

const HOST_BRANDS: ReadonlyArray<readonly [suffix: string, domain: string]> = [
  ['api.openai.com', 'openai.com'],
  ['openai.azure.com', 'openai.com'],
  ['api.anthropic.com', 'anthropic.com'],
  ['generativelanguage.googleapis.com', 'google.com'],
  ['ai.google.dev', 'google.com'],
  ['api.deepseek.com', 'deepseek.com'],
  ['api.moonshot.cn', 'moonshot.cn'],
  ['platform.moonshot.cn', 'moonshot.cn'],
  ['dashscope.aliyuncs.com', 'aliyun.com'],
  ['dashscope-intl.aliyuncs.com', 'aliyun.com'],
  ['open.bigmodel.cn', 'bigmodel.cn'],
  ['ark.cn-beijing.volces.com', 'volcengine.com'],
  ['api.x.ai', 'x.ai'],
  ['api.mistral.ai', 'mistral.ai'],
  ['api.groq.com', 'groq.com'],
  ['openrouter.ai', 'openrouter.ai'],
  ['api.together.xyz', 'together.ai'],
  ['api.fireworks.ai', 'fireworks.ai'],
  ['api.perplexity.ai', 'perplexity.ai'],
  ['api.cohere.com', 'cohere.com'],
  ['api.minimax.chat', 'minimax.io'],
  ['api.minimaxi.com', 'minimax.io'],
  ['api.stepfun.com', 'stepfun.com'],
  ['api.baichuan-ai.com', 'baichuan-ai.com'],
  ['api.lingyiwanwu.com', '01.ai'],
] as const

const MODEL_BRANDS: ReadonlyArray<readonly [pattern: RegExp, domain: string]> = [
  [/(^|[/\s_.-])(gpt|chatgpt|openai|davinci|text-embedding|o[1-9](?:-|$))/i, 'openai.com'],
  [/(^|[/\s_.-])(claude|anthropic)(?:-|$)/i, 'anthropic.com'],
  [/(^|[/\s_.-])(gemini|gemma|palm|bard|google)(?:-|$)/i, 'google.com'],
  [/(^|[/\s_.-])deepseek(?:-|$)/i, 'deepseek.com'],
  [/(^|[/\s_.-])(kimi|moonshot)(?:-|$)/i, 'moonshot.cn'],
  [/(^|[/\s_.-])(qwen|qwq|qvq|tongyi)(?:-|$)/i, 'aliyun.com'],
  [/(^|[/\s_.-])(glm|chatglm|zhipu)(?:-|$)/i, 'bigmodel.cn'],
  [/(^|[/\s_.-])(doubao|skylark)(?:-|$)/i, 'volcengine.com'],
  [/(^|[/\s_.-])grok(?:-|$)/i, 'x.ai'],
  [/(^|[/\s_.-])(mistral|mixtral|codestral|pixtral)(?:-|$)/i, 'mistral.ai'],
  [/(^|[/\s_.-])(llama|meta-llama)(?:-|$)/i, 'meta.com'],
  [/(^|[/\s_.-])(command|cohere)(?:-|$)/i, 'cohere.com'],
  [/(^|[/\s_.-])(sonar|pplx)(?:-|$)/i, 'perplexity.ai'],
  [/(^|[/\s_.-])(ernie|wenxin)(?:-|$)/i, 'baidu.com'],
  [/(^|[/\s_.-])hunyuan(?:-|$)/i, 'tencent.com'],
  [/(^|[/\s_.-])(spark|xinghuo)(?:-|$)/i, 'xfyun.cn'],
  [/(^|[/\s_.-])(minimax|abab)(?:-|$)/i, 'minimax.io'],
  [/(^|[/\s_.-])step(?:[-_]|$)/i, 'stepfun.com'],
  [/(^|[/\s_.-])(yi|零一)(?:[-_]|$)/i, '01.ai'],
  [/(^|[/\s_.-])(nova|titan)(?:-|$)/i, 'aws.amazon.com'],
  [/(^|[/\s_.-])phi(?:[-_]|$)/i, 'microsoft.com'],
] as const

const PRIVATE_HOST_RE =
  /^(localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$)/i

function normalizeDomain(value: string | undefined): string | undefined {
  const domain = value?.trim().toLowerCase().replace(/\.$/, '')
  if (!domain || domain.length > 253 || !domain.includes('.')) return undefined
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(domain)) return undefined
  return domain
}

function hostnameOf(baseUrl: string | undefined): string | undefined {
  if (!baseUrl) return undefined
  try {
    return normalizeDomain(new URL(baseUrl).hostname.replace(/^\[|\]$/g, ''))
  } catch {
    return undefined
  }
}

function isPrivateHost(host: string): boolean {
  return PRIVATE_HOST_RE.test(host) || !host.includes('.') || /\.(local|internal|lan)$/i.test(host)
}

function brandFromHost(host: string): string {
  for (const [suffix, domain] of HOST_BRANDS) {
    if (host === suffix || host.endsWith(`.${suffix}`)) return domain
  }
  if (host.startsWith('api.')) {
    const parent = host.slice(4)
    if (parent.includes('.')) return parent
  }
  return host
}

function brandFromName(model: string | undefined, displayName: string | undefined): string | undefined {
  const haystack = `${model ?? ''} ${displayName ?? ''}`.trim()
  if (!haystack) return undefined
  for (const [pattern, domain] of MODEL_BRANDS) {
    if (pattern.test(haystack)) return domain
  }
  return undefined
}

/** 返回可供 favicon 缓存取图的公网域名；内网端点返回 undefined。 */
export function brandDomainFor(input: ModelBrandInput): string | undefined {
  const explicit = normalizeDomain(input.domain)
  if (explicit) return explicit
  if (input.transport === 'webview') return undefined

  const fromModel = brandFromName(input.model, input.displayName)
  if (fromModel) return fromModel

  const host = hostnameOf(input.baseUrl)
  if (!host || isPrivateHost(host)) return undefined
  return brandFromHost(host)
}
