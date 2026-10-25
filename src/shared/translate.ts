/**
 * 翻译功能的共享层（main / preload / renderer 三段共用，不得依赖运行时）
 *
 * 接入的是哔哩哔哩开源的 Index-Translate 系列的**免费公开 API**：
 *   https://index-translate.bilibili.com/v1
 * 端点不校验密钥，因此这一层没有任何凭据、没有计价口径，也就不进讨论模型列表
 * —— 那是另一套东西（有 Key、有单价、要参与共识核算）。这里只做「翻一段话」。
 *
 * 提示词的口径照抄官方 call_api.py 的 build_prompt：官方本地推理服务与公开 API
 * 用的是同一套 instTrans 提示词，两边措辞一致，模型行为才一致。
 */

/** 目标语言：代码沿用官方的语言代码，中文名用于界面与提示词 */
export interface TranslateLang {
  code: string
  name: string
}

export const TARGET_LANGS: TranslateLang[] = [
  { code: 'en', name: '英语' },
  { code: 'zh', name: '中文' },
  { code: 'ja', name: '日语' },
  { code: 'ko', name: '韩语' },
  { code: 'fr', name: '法语' },
  { code: 'de', name: '德语' },
  { code: 'es', name: '西班牙语' },
  { code: 'pt', name: '葡萄牙语' },
  { code: 'ru', name: '俄语' },
  { code: 'ar', name: '阿拉伯语' },
  { code: 'it', name: '意大利语' },
  { code: 'nl', name: '荷兰语' },
  { code: 'pl', name: '波兰语' },
  { code: 'ro', name: '罗马尼亚语' },
  { code: 'sv', name: '瑞典语' },
  { code: 'tr', name: '土耳其语' },
  { code: 'hi', name: '印地语' },
  { code: 'vi', name: '越南语' },
  { code: 'th', name: '泰语' },
  { code: 'id', name: '印尼语' },
  { code: 'ms', name: '马来语' },
  { code: 'fil', name: '菲律宾语' },
  { code: 'ukr_cyrl', name: '乌克兰语' },
  { code: 'fas_arab', name: '波斯语' },
  { code: 'ces_latn', name: '捷克语' },
  { code: 'ell_grek', name: '希腊语' },
  { code: 'dan_latn', name: '丹麦语' },
  { code: 'hun_latn', name: '匈牙利语' },
  { code: 'fin_latn', name: '芬兰语' },
  { code: 'nob_latn', name: '书面挪威语' },
  { code: 'slk_latn', name: '斯洛伐克语' },
  { code: 'bul_cyrl', name: '保加利亚语' },
]

/** 语言代码 → 中文名，供提示词用（不在表内的代码原样透传） */
export const LANG_NAMES: Record<string, string> = Object.fromEntries(
  TARGET_LANGS.map((l) => [l.code, l.name]),
)

/** 官方公开端点当前提供的翻译模型 */
export interface TranslateModel {
  id: string
  /** 界面上的一句话说明：这一枚的取舍是什么 */
  note: string
}

export const TRANSLATE_MODELS: TranslateModel[] = [
  { id: 'Index-Translate-35B-A3B', note: '旗舰 · 质量最好' },
  { id: 'Index-Translate-9B', note: '均衡 · 质量与速度兼顾' },
  { id: 'Index-Translate-2B', note: '轻量 · 速度最快' },
]

export const DEFAULT_TRANSLATE_MODEL = 'Index-Translate-9B'

/** 图片直译入参。dataUrl 由渲染层从本地文件读出，主进程会再校验一次。 */
export interface TranslateImageInput {
  name: string
  mime: string
  dataUrl: string
  /** 缩放前的原始字节数，只用于界面提示，不参与请求 */
  originalBytes?: number
  /** 缩放前后的像素尺寸，给界面一句「已缩放」的实话；不参与请求 */
  scaledFrom?: { w: number; h: number }
}

/** 公开端点没有单独的图片上传接口，这里限制单张图片体积，避免 IPC 与请求体过大 */
export const TRANSLATE_IMAGE_MAX_BYTES = 12 * 1024 * 1024

/** 一次翻译的入参 */
export interface TranslateRequest {
  text: string
  /** 目标语言代码 */
  target: string
  /** 自定义语言名称；给「自定义语言」用，缺省时按内置表解析 */
  targetName?: string
  /** 源语言代码；'auto' 表示自动判断 */
  source?: string
  /** 自定义源语言名称；给「自定义语言」用 */
  sourceName?: string
  model?: string
  /** 自由指令：格式、口吻、保留结构之类的硬性要求 */
  instruction?: string
  /** 术语对照：源词→目标词，多组用逗号分隔 */
  glossary?: string
  /**
   * 覆写整段提示词（翻译设置里的「翻译提示词」）。
   * 支持 {{target_language}} / {{source_language}} / <<translate_input>> 三个占位符。
   */
  customPrompt?: string
  /** 采样温度；缺省表示用模型默认（当前端点默认 0） */
  temperature?: number
  /** Top-P；缺省表示用模型默认 */
  topP?: number
  /** 可选图片；有图片时 text 作为补充说明，不再作为主要翻译对象 */
  image?: TranslateImageInput
}

export interface TranslateResult {
  ok: boolean
  /** 译文（失败时为空串） */
  text: string
  /** 实际使用的模型 */
  model?: string
  /** 失败原因：一句话说清是什么坏了 */
  reason?: string
  /** 上游报的原始错误，供排查 */
  detail?: string
}

/** 单次输入的字符上限：超出就分批，而不是让模型静默截断 */
export const TRANSLATE_TEXT_MAX_CHARS = 12_000

/** 一次请求允许提交的总字符数。再大就拒绝，避免串行几十次请求把界面卡死 */
export const TRANSLATE_REQUEST_MAX_CHARS = 200_000

/** 指令与术语是提示词装饰，不该无限长 */
export const TRANSLATE_PROMPT_FIELD_MAX_CHARS = 8_000

/**
 * 术语对照的解析：接受「a→b」「a:b」「a->b」三种写法，逗号分隔。
 * 解析不出来就整段忽略 —— 术语写错不该让整次翻译失败。
 */
export function parseGlossaryTerms(input: string): string[] {
  const text = (input ?? '').trim()
  if (!text) return []
  const out: string[] = []
  for (const item of text.replace(/，/g, ',').split(',')) {
    const t = item.trim()
    if (!t) continue
    for (const sep of ['->', '→', ':', '：']) {
      const at = t.indexOf(sep)
      if (at > 0) {
        out.push(`${t.slice(0, at).trim()}→${t.slice(at + sep.length).trim()}`)
        break
      }
    }
  }
  return out
}

/**
 * 拼一句 instTrans 提示词。
 *
 * 与官方 call_api.py 的 build_prompt 逐条对齐：术语走【硬性要求】，自由指令走【注意】，
 * JSON 输入且带 JSON 约束时追加「只输出 JSON」的收尾句。
 */
export function buildTranslatePrompt(input: {
  text: string
  target: string
  targetName?: string
  source?: string
  sourceName?: string
  instruction?: string
  glossary?: string
}): { prompt: string; error?: string } {
  const target = (input.target ?? '').trim().toLowerCase()
  const targetName = (input.targetName ?? '').trim() || LANG_NAMES[target]
  if (!targetName) return { prompt: '', error: `不认识的目标语言：${input.target}` }

  const source = (input.source ?? 'auto').trim().toLowerCase()
  const hasSource = !!source && source !== 'auto'
  const sourceName = hasSource
    ? ((input.sourceName ?? '').trim() || LANG_NAMES[source]) ?? input.source
    : ''

  const constraints: string[] = []
  const terms = parseGlossaryTerms(input.glossary ?? '')
  if (terms.length > 0) {
    constraints.push(`【硬性要求】专名/术语对照: ${terms.join('、')}`)
  }
  for (const rawLine of (input.instruction ?? '').split('\n')) {
    const line = rawLine.trim().replace(/^\d+\.\s*/, '')
    if (!line) continue
    if (line.startsWith('【硬性要求】') || line.startsWith('【注意】') || line.startsWith('【软性要求】')) {
      constraints.push(line)
    } else {
      constraints.push(`【注意】${line}`)
    }
  }

  const text = (input.text ?? '').trim()

  if (constraints.length > 0) {
    const headerSrc = sourceName ? `${sourceName}文本` : '文本'
    const header = `请将以下${headerSrc}翻译成${targetName}，并且严格遵循所有约束要求。`
    const reqLines = constraints.map((c, i) => `${i + 1}. ${c}`)

    const isJson = text.startsWith('{') && text.endsWith('}')
    const wantsJson = constraints.some((c) => c.includes('JSON') || c.includes('json'))
    const suffix =
      isJson && wantsJson
        ? '请以相同的 JSON 格式输出翻译结果，key 保持不变，value 为对应译文。只输出 JSON，不要有任何额外说明。'
        : '只输出译文，不要有任何额外说明。'

    return {
      prompt: `${header}\n\n【源文】\n${text}\n\n【约束要求】\n${reqLines.join('\n')}\n\n${suffix}`,
    }
  }

  const body = sourceName
    ? `请将以下${sourceName}文本翻译为${targetName}，直接输出翻译结果，不要进行任何解释。`
    : `请将以下文本翻译为${targetName}，直接输出翻译结果，不要进行任何解释。`
  return { prompt: `${body}\n\n${text}` }
}

/**
 * 用用户自定义的提示词模板拼一次请求。
 *
 * 模板里的占位符只有三个：
 * - `{{target_language}}` → 目标语言名
 * - `{{source_language}}` → 源语言名（auto 时为空）
 * - `<<translate_input>>` → 原文
 *
 * 模板没带输入占位符时把原文补在末尾，免得用户漏写一句就发出一个没有正文的请求。
 */
export function buildCustomPrompt(input: {
  template: string
  text: string
  target: string
  targetName?: string
  source?: string
  sourceName?: string
  instruction?: string
  glossary?: string
}): { prompt: string; error?: string } {
  const target = (input.target ?? '').trim().toLowerCase()
  const targetName = (input.targetName ?? '').trim() || LANG_NAMES[target]
  if (!targetName) return { prompt: '', error: `不认识的目标语言：${input.target}` }

  const source = (input.source ?? 'auto').trim().toLowerCase()
  const hasSource = !!source && source !== 'auto'
  const sourceName = hasSource
    ? ((input.sourceName ?? '').trim() || LANG_NAMES[source]) ?? input.source
    : ''

  const text = (input.text ?? '').trim()
  let prompt = (input.template ?? '')
    .replace(/\{\{\s*target_language\s*\}\}/gi, () => targetName)
    .replace(/\{\{\s*source_language\s*\}\}/gi, () => sourceName ?? '')

  const hasBodyPlaceholder = /<<\s*translate_input\s*>>/i.test(prompt)
  prompt = prompt.replace(/<<\s*translate_input\s*>>/gi, () => text)
  if (!hasBodyPlaceholder && text) prompt = `${prompt.trim()}\n\n${text}`
  if (!prompt.trim() && text) prompt = text

  const extras: string[] = []
  const terms = parseGlossaryTerms(input.glossary ?? '')
  if (terms.length > 0) extras.push(`【硬性要求】专名/术语对照: ${terms.join('、')}`)
  if ((input.instruction ?? '').trim()) extras.push(`【注意】${input.instruction!.trim()}`)
  if (extras.length > 0) prompt = `${prompt.trim()}\n\n${extras.join('\n')}`

  return { prompt }
}

/**
 * 图片翻译提示词。
 *
 * 与官方 call_api.py 的 --image 分支保持同一口径；参考文本、术语和指令都是可选项。
 */
export function buildImageTranslatePrompt(input: {
  text?: string
  target: string
  targetName?: string
  source?: string
  sourceName?: string
  instruction?: string
  glossary?: string
}): { prompt: string; error?: string } {
  const target = (input.target ?? '').trim().toLowerCase()
  const targetName = (input.targetName ?? '').trim() || LANG_NAMES[target]
  if (!targetName) return { prompt: '', error: `无法识别目标语言：${input.target}` }

  const source = (input.source ?? 'auto').trim().toLowerCase()
  const hasSource = !!source && source !== 'auto'
  const sourceName = hasSource
    ? ((input.sourceName ?? '').trim() || LANG_NAMES[source]) ?? input.source
    : ''
  const basePrompt = sourceName
    ? `请将图片中的${sourceName}文本翻译为${targetName}，直接输出翻译结果，不要进行任何解释。`
    : `请将图片中的文本翻译为${targetName}，直接输出翻译结果，不要进行任何解释。`

  const extras: string[] = []
  const text = (input.text ?? '').trim()
  if (text) extras.push(`【参考文本/关注内容】\n${text}`)
  if ((input.instruction ?? '').trim()) extras.push(`【指令要求】${input.instruction!.trim()}`)

  const terms = parseGlossaryTerms(input.glossary ?? '')
  if (terms.length > 0) extras.push(`【术语对照】${terms.join('、')}`)

  return {
    prompt:
      extras.length > 0
        ? `${basePrompt}\n\n${extras.join('\n\n')}\n\n只输出翻译结果，不要进行任何解释。`
        : basePrompt,
  }
}

/**
 * 去掉思维链残留。
 *
 * 官方文档明确要求关掉思考（enable_thinking=false），因为开着时 CoT 正文可能
 * 顶掉译文。但万一上游仍然吐了 <think> 块，界面上就不该出现一串思考草稿。
 */
export function stripThink(text: string): string {
  let t = text ?? ''
  const at = t.indexOf('</think>')
  if (at >= 0) t = t.slice(at + '</think>'.length)
  return t.replace(/^<think>/, '').trim()
}

/**
 * 研讨发言内嵌翻译的提示词。
 *
 * 这里翻的是一整条模型发言，不是独立翻译屏里的裸文本：Markdown、代码和链接
 * 都是原发言的一部分，译文必须保留它们，否则「读得懂」会以「看起来不一样」为代价。
 */
export const DISCUSSION_TRANSLATION_INSTRUCTION = [
  '这是研讨中的一条模型发言。请忠实译为中文，不要总结、扩写或解释。',
  '保留 Markdown 的段落、标题、列表、粗体、引用和表格结构。',
  '代码块、行内代码、公式、URL、文件路径和模型名保持原样，不翻译。',
  '专有名词和关键术语首次出现时，可在中文后用括号保留英文原文。',
].join('\n')

/**
 * 判断一条研讨发言是否值得自动译成中文。
 *
 * 只看正文，不看代码块、行内代码、链接地址和图片地址：一份中文回答里夹一个函数名，
 * 不该整条被送去翻译；一份英文回答即使带代码，也仍要能读出正文。
 */
export function shouldTranslateDiscussionSpeech(text: string): boolean {
  const prose = (text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/gi, ' ')

  const latinChars = (prose.match(/[A-Za-z]/g) ?? []).length
  const latinWords = (prose.match(/[A-Za-z][A-Za-z'’-]*/g) ?? []).length
  if (latinChars < 40 || latinWords < 8) return false

  const cjkChars = (prose.match(/[\u3400-\u9fff]/g) ?? []).length
  if (cjkChars === 0) return true

  // 中英混排很常见；只有中文占比低于 12% 时才认定「主体不是中文」。
  return cjkChars / (cjkChars + latinChars) < 0.12
}
