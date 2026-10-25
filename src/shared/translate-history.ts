/**
 * 翻译历史：共享层类型 + 纯函数。
 *
 * 历史只在翻译屏内部流转，不进研讨历史（那是另一套口径），因此单独
 * 存在 preferences.json 的 translateHistory 键下，条目按时间倒序。
 * 原文与译文都截断：历史是让人回找「上次那句话怎么翻的」，
 * 不是离线备份，存全文既浪费偏好文件也拖垮列表渲染。
 */

/** 自动检测方法的三档口径 */
export type DetectMethod = 'auto' | 'algo' | 'llm'

import { DEFAULT_TRANSLATE_MODEL, TRANSLATE_MODELS } from './translate'

/** source='auto' 时，真正写进提示词的判定方式 */
export const DETECT_METHOD_LABEL: Record<DetectMethod, string> = {
  auto: '自动',
  algo: '算法',
  llm: 'LLM',
}

/** source 字段里写入前先归一：白名单外的值一律回到 'auto' */
export function normalizeDetectMethod(v: unknown): DetectMethod {
  return v === 'algo' || v === 'llm' || v === 'auto' ? v : 'auto'
}

export interface TranslateHistoryEntry {
  id: string
  /** epoch ms */
  ts: number
  source: string
  target: string
  sourceText: string
  resultText: string
  model?: string
  /** 收藏的条目在历史里置顶显示，清空时也不必先取消收藏 */
  pinned?: boolean
}

/** 单条历史存进文件前的截断长度：够看清「这句话翻成了什么」，不够当存档 */
const ENTRY_CHARS = 280

/** 写文件前做的清洗：截断、去控制字符、限数量 */
export function sanitizeHistory(raw: unknown): TranslateHistoryEntry[] {
  if (!Array.isArray(raw)) return []
  const out: TranslateHistoryEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const ts = typeof o.ts === 'number' && Number.isFinite(o.ts) ? o.ts : 0
    if (ts <= 0) continue
    const strip = (v: unknown): string =>
      typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, ENTRY_CHARS) : ''
    out.push({
      id: typeof o.id === 'string' ? o.id.slice(0, 64) : `th_${ts}`,
      ts,
      source: typeof o.source === 'string' ? o.source.slice(0, 24) : 'auto',
      target: typeof o.target === 'string' ? o.target.slice(0, 24) : 'zh',
      sourceText: strip(o.sourceText),
      resultText: strip(o.resultText),
      model: typeof o.model === 'string' ? o.model.slice(0, 64) : undefined,
      pinned: o.pinned === true,
    })
  }
  return out.slice(0, 500)
}

/** 显示用的时间：今天的只显示 HH:MM，跨天显示 M月D日 HH:MM */
export function formatHistoryTs(ts: number, now: number = Date.now()): string {
  const d = new Date(ts)
  const sameDay = d.toDateString() === new Date(now).toDateString()
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (sameDay) return hm
  return `${d.getMonth() + 1}月${d.getDate()}日 ${hm}`
}

/** 自定义语言：代码只用于展示与本地检测，真正写进提示词的是 name */
export interface CustomLang {
  code: string
  name: string
}

/**
 * 翻译设置。
 *
 * 全部字段都有默认值：偏好文件缺字段、写坏一个字段都不会让整块设置失效。
 * `temperature` / `topP` 为 null 表示「模型默认」，不是 0。
 */
export interface TranslateSettings {
  markdownPreview: boolean
  autoCopy: boolean
  scrollSync: boolean
  detectMethod: DetectMethod
  bidirectional: boolean
  source: string
  target: string
  temperature: number | null
  topP: number | null
  prompt: string
  glossary: string
  instruction: string
  model: string
  pinnedModels: string[]
  customLangs: CustomLang[]
}

/** 与参考翻译器一致的默认提示词；占位符由 buildCustomPrompt 替换 */
export const DEFAULT_TRANSLATE_PROMPT =
  'You are a translation expert. Your only task is to translate text enclosed with ' +
  '<<translate_input>> from input language to {{target_language}}, provide the translation ' +
  'result directly without any explanation.'

export const DEFAULT_TRANSLATE_SETTINGS: TranslateSettings = {
  markdownPreview: true,
  autoCopy: false,
  scrollSync: true,
  detectMethod: 'auto',
  bidirectional: false,
  source: 'en',
  target: 'zh',
  temperature: null,
  topP: null,
  prompt: DEFAULT_TRANSLATE_PROMPT,
  glossary: '',
  instruction: '',
  model: DEFAULT_TRANSLATE_MODEL,
  pinnedModels: ['Index-Translate-9B'],
  customLangs: [],
}

function clampNumber(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return Math.min(max, Math.max(min, v))
}

/** 偏好文件里的翻译设置清洗：字段级兜底，坏字段不影响其他字段 */
export function sanitizeTranslateSettings(raw: unknown): TranslateSettings {
  const o = (raw ?? {}) as Record<string, unknown>
  const d = DEFAULT_TRANSLATE_SETTINGS
  const bool = (v: unknown, fallback: boolean): boolean =>
    typeof v === 'boolean' ? v : fallback
  const str = (v: unknown, fallback: string, max: number): string =>
    typeof v === 'string' ? v.slice(0, max) : fallback

  const customLangs: CustomLang[] = []
  if (Array.isArray(o.customLangs)) {
    for (const item of o.customLangs.slice(0, 30)) {
      if (!item || typeof item !== 'object') continue
      const c = item as Record<string, unknown>
      const code = typeof c.code === 'string' ? c.code.trim().toLowerCase().slice(0, 24) : ''
      const name = typeof c.name === 'string' ? c.name.trim().slice(0, 40) : ''
      if (!code || !name) continue
      if (!/^[a-z0-9_-]{1,24}$/.test(code)) continue
      if (code === 'auto') continue
      customLangs.push({ code, name })
    }
  }

  const modelIds = new Set(TRANSLATE_MODELS.map((m) => m.id))
  const pinnedModels = Array.isArray(o.pinnedModels)
    ? o.pinnedModels
        .filter((s): s is string => typeof s === 'string' && modelIds.has(s))
        .slice(0, 8)
    : d.pinnedModels

  return {
    markdownPreview: bool(o.markdownPreview, d.markdownPreview),
    autoCopy: bool(o.autoCopy, d.autoCopy),
    scrollSync: bool(o.scrollSync, d.scrollSync),
    detectMethod: normalizeDetectMethod(o.detectMethod),
    bidirectional: bool(o.bidirectional, d.bidirectional),
    source: str(o.source, d.source, 24),
    target: str(o.target, d.target, 24),
    temperature: clampNumber(o.temperature, 0, 2),
    topP: clampNumber(o.topP, 0, 1),
    prompt: str(o.prompt, d.prompt, 8000),
    glossary: str(o.glossary, d.glossary, 8000),
    instruction: str(o.instruction, d.instruction, 8000),
    model: typeof o.model === 'string' && modelIds.has(o.model) ? o.model : d.model,
    pinnedModels,
    customLangs,
  }
}

/**
 * 本地脚本判定：只做四个最稳的区分（假名 / 谚文 / 汉字 / 拉丁），
 * 不够精确，但「算法」档要的就是不花网络、不花 token 的快速判断。
 */
export function detectLangByScript(text: string): string {
  const t = (text ?? '').trim()
  if (!t) return 'auto'
  const count = (re: RegExp): number => (t.match(re) ?? []).length
  const kana = count(/[\u3040-\u30ff]/g)
  const hangul = count(/[\uac00-\ud7af]/g)
  const han = count(/[\u3400-\u9fff]/g)
  const cyrillic = count(/[\u0400-\u04ff]/g)
  const arabic = count(/[\u0600-\u06ff]/g)
  const latin = count(/[A-Za-z]/g)
  const best = Math.max(kana, hangul, han, cyrillic, arabic, latin)
  if (best === 0) return 'auto'
  if (best === kana) return 'ja'
  if (best === hangul) return 'ko'
  if (best === han) return 'zh'
  if (best === cyrillic) return 'ru'
  if (best === arabic) return 'ar'
  return 'en'
}
