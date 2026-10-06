/**
 * 公开价目表（USD / 百万 tokens）。
 *
 * 为什么要有这张表：API 模型的单价此前只能靠人填或靠助手回忆，两者都会留 0 ——
 * 单价为 0 时费用统计与预算熔断等于没生效（doctor 会报 api:price:* warn）。
 * 这里按各家**公开定价页**抄一份可比对的默认值，认不出的模型仍然保持 0（宁可少算钱，
 * 也不要拿编造的高价污染费用口径）。
 *
 * 每条都带来源与核对日期：价目会变，出问题时要能追溯到抄的是哪一页。
 * 第三方中转（如 intern-ai / 各种 Anthropic 兼容网关）按自家价目收费，
 * 命中这里的条目只是估算下界，用户可在设置页改回实际单价。
 */

/** 人民币计价折算美元用的汇率：官方页只给 CNY，字段口径是 USD */
export const USD_CNY = 7.1

export interface PublicPrice {
  /** 输入单价 USD/百万 token（未命中缓存） */
  pricePerMTokIn: number
  /** 输出单价 USD/百万 token */
  pricePerMTokOut: number
  /** 缓存命中的输入单价，仅用于说明口径，不参与计费折算 */
  cacheHitIn?: number
  source: string
  asOf: string
  note?: string
}

interface Row extends PublicPrice {
  /** 按顺序试匹配：更具体的别名要排在前面 */
  patterns: RegExp[]
}

const OPENAI_SRC = 'https://developers.openai.com/api/docs/pricing'
const ANTHROPIC_SRC = 'https://platform.claude.com/docs/en/about-claude/pricing'
const DEEPSEEK_SRC = 'https://api-docs.deepseek.com/quick_start/pricing'
const KIMI_SRC = 'https://platform.kimi.com/docs/pricing/chat'
const GEMINI_SRC = 'https://ai.google.dev/gemini-api/docs/pricing'
const AS_OF = '2026-10-07'

/** 官方只给人民币价目时用它折算 */
function cny(
  inYuan: number,
  outYuan: number,
  source: string,
  cacheHitYuan?: number,
  note?: string,
): Pick<PublicPrice, 'pricePerMTokIn' | 'pricePerMTokOut' | 'cacheHitIn' | 'note' | 'source'> {
  return {
    pricePerMTokIn: Math.round((inYuan / USD_CNY) * 1e4) / 1e4,
    pricePerMTokOut: Math.round((outYuan / USD_CNY) * 1e4) / 1e4,
    cacheHitIn: cacheHitYuan === undefined ? undefined : Math.round((cacheHitYuan / USD_CNY) * 1e4) / 1e4,
    note: `官方价目 ${inYuan}/${outYuan} 元（每百万 token 输入未命中缓存/输出），按 1 USD = ${USD_CNY} CNY 折算。${note ?? ''}`,
    source,
  }
}

const ROWS: Row[] = [
  // ── OpenAI ─────────────────────────────────────────────
  { patterns: [/^gpt-6-astra/], pricePerMTokIn: 10, cacheHitIn: 1, pricePerMTokOut: 50, source: OPENAI_SRC, asOf: AS_OF },
  { patterns: [/^gpt-6\.1-sol/], pricePerMTokIn: 2, cacheHitIn: 0.1, pricePerMTokOut: 10, source: OPENAI_SRC, asOf: AS_OF },
  { patterns: [/^gpt-6-sol/], pricePerMTokIn: 2, cacheHitIn: 0.2, pricePerMTokOut: 10, source: OPENAI_SRC, asOf: AS_OF },
  { patterns: [/^gpt-6-luna/], pricePerMTokIn: 0.1, cacheHitIn: 0.01, pricePerMTokOut: 0.5, source: OPENAI_SRC, asOf: AS_OF },
  {
    patterns: [/^gpt-5\.6-sol/],
    pricePerMTokIn: 4,
    cacheHitIn: 0.4,
    pricePerMTokOut: 20,
    source: OPENAI_SRC,
    asOf: AS_OF,
  },
  { patterns: [/^gpt-5\.6-terra/], pricePerMTokIn: 2, cacheHitIn: 0.2, pricePerMTokOut: 12, source: OPENAI_SRC, asOf: AS_OF },
  { patterns: [/^gpt-5\.6-luna/], pricePerMTokIn: 0.2, cacheHitIn: 0.02, pricePerMTokOut: 1.2, source: OPENAI_SRC, asOf: AS_OF },
  {
    patterns: [/^gpt-5\.5-pro/, /^gpt-5\.4-pro/],
    pricePerMTokIn: 30,
    pricePerMTokOut: 180,
    source: OPENAI_SRC,
    asOf: AS_OF,
    note: 'pro 档不公开缓存价，按未命中计。',
  },
  {
    patterns: [/^gpt-5\.5/],
    pricePerMTokIn: 5,
    cacheHitIn: 0.5,
    pricePerMTokOut: 30,
    source: OPENAI_SRC,
    asOf: AS_OF,
    note: '官方按 ≤272K 上下文档位计价，更长上下文另列。',
  },
  { patterns: [/^gpt-5\.4-mini/], pricePerMTokIn: 0.75, cacheHitIn: 0.075, pricePerMTokOut: 4.5, source: OPENAI_SRC, asOf: AS_OF },
  { patterns: [/^gpt-5\.4-nano/], pricePerMTokIn: 0.2, cacheHitIn: 0.02, pricePerMTokOut: 1.25, source: OPENAI_SRC, asOf: AS_OF },
  {
    patterns: [/^gpt-5\.4/],
    pricePerMTokIn: 2.5,
    cacheHitIn: 0.25,
    pricePerMTokOut: 15,
    source: OPENAI_SRC,
    asOf: AS_OF,
  },
  { patterns: [/^gpt-5\.2-pro/], pricePerMTokIn: 21, pricePerMTokOut: 168, source: OPENAI_SRC, asOf: AS_OF },
  { patterns: [/^gpt-5\.2/], pricePerMTokIn: 1.75, cacheHitIn: 0.175, pricePerMTokOut: 14, source: OPENAI_SRC, asOf: AS_OF },
  { patterns: [/^gpt-5-pro/], pricePerMTokIn: 15, pricePerMTokOut: 120, source: OPENAI_SRC, asOf: AS_OF },
  { patterns: [/^gpt-5-mini/], pricePerMTokIn: 0.25, cacheHitIn: 0.025, pricePerMTokOut: 2, source: OPENAI_SRC, asOf: AS_OF },
  { patterns: [/^gpt-5-nano/], pricePerMTokIn: 0.05, cacheHitIn: 0.005, pricePerMTokOut: 0.4, source: OPENAI_SRC, asOf: AS_OF },
  { patterns: [/^gpt-5\.1/, /^gpt-5($|[-.]\d)/], pricePerMTokIn: 1.25, cacheHitIn: 0.125, pricePerMTokOut: 10, source: OPENAI_SRC, asOf: AS_OF },
  { patterns: [/^o4-mini/], pricePerMTokIn: 1.1, cacheHitIn: 0.275, pricePerMTokOut: 4.4, source: OPENAI_SRC, asOf: AS_OF },
  { patterns: [/^o3-mini/], pricePerMTokIn: 1.1, cacheHitIn: 0.55, pricePerMTokOut: 4.4, source: OPENAI_SRC, asOf: AS_OF },
  { patterns: [/^o3-pro/], pricePerMTokIn: 20, pricePerMTokOut: 80, source: OPENAI_SRC, asOf: AS_OF },
  { patterns: [/^o3/], pricePerMTokIn: 2, cacheHitIn: 0.5, pricePerMTokOut: 8, source: OPENAI_SRC, asOf: AS_OF },
  { patterns: [/^gpt-4\.1-mini/], pricePerMTokIn: 0.4, cacheHitIn: 0.1, pricePerMTokOut: 1.6, source: OPENAI_SRC, asOf: AS_OF },
  { patterns: [/^gpt-4\.1-nano/], pricePerMTokIn: 0.1, cacheHitIn: 0.025, pricePerMTokOut: 0.4, source: OPENAI_SRC, asOf: AS_OF },
  { patterns: [/^gpt-4\.1/], pricePerMTokIn: 2, cacheHitIn: 0.5, pricePerMTokOut: 8, source: OPENAI_SRC, asOf: AS_OF },
  { patterns: [/^gpt-4o-mini/], pricePerMTokIn: 0.15, cacheHitIn: 0.075, pricePerMTokOut: 0.6, source: OPENAI_SRC, asOf: AS_OF },
  { patterns: [/^gpt-4o/], pricePerMTokIn: 2.5, cacheHitIn: 1.25, pricePerMTokOut: 10, source: OPENAI_SRC, asOf: AS_OF },

  // ── Anthropic ─────────────────────────────────────────
  { patterns: [/^claude-(fable|mythos)-5\.1/], pricePerMTokIn: 10, cacheHitIn: 0.25, pricePerMTokOut: 50, source: ANTHROPIC_SRC, asOf: AS_OF },
  { patterns: [/^claude-(fable|mythos)-5/], pricePerMTokIn: 10, cacheHitIn: 1, pricePerMTokOut: 50, source: ANTHROPIC_SRC, asOf: AS_OF },
  { patterns: [/^claude-opus-5\.5/], pricePerMTokIn: 4, cacheHitIn: 0.2, pricePerMTokOut: 20, source: ANTHROPIC_SRC, asOf: AS_OF },
  { patterns: [/^claude-opus-(5|4\.8|4\.7|4\.6|4\.5)/], pricePerMTokIn: 5, cacheHitIn: 0.5, pricePerMTokOut: 25, source: ANTHROPIC_SRC, asOf: AS_OF },
  { patterns: [/^claude-opus-(4\.1|4)/], pricePerMTokIn: 15, cacheHitIn: 1.5, pricePerMTokOut: 75, source: ANTHROPIC_SRC, asOf: AS_OF },
  { patterns: [/^claude-sonnet-(5\.5|5)/], pricePerMTokIn: 2, cacheHitIn: 0.2, pricePerMTokOut: 10, source: ANTHROPIC_SRC, asOf: AS_OF },
  { patterns: [/^claude-sonnet-(4\.6|4\.5|4)/], pricePerMTokIn: 3, cacheHitIn: 0.3, pricePerMTokOut: 15, source: ANTHROPIC_SRC, asOf: AS_OF },
  { patterns: [/^claude-haiku-4\.5/], pricePerMTokIn: 1, cacheHitIn: 0.1, pricePerMTokOut: 5, source: ANTHROPIC_SRC, asOf: AS_OF },
  { patterns: [/^claude-haiku-3\.5/], pricePerMTokIn: 0.8, cacheHitIn: 0.08, pricePerMTokOut: 4, source: ANTHROPIC_SRC, asOf: AS_OF },

  // ── DeepSeek（官方页同时给 CNY 与 USD；USD 取空闲时段）──────
  {
    patterns: [/^deepseek-v4-pro/, /^deepseek-pro/],
    pricePerMTokIn: 0.66,
    cacheHitIn: 0.022,
    pricePerMTokOut: 1.98,
    source: DEEPSEEK_SRC,
    asOf: AS_OF,
    note: '空闲时段价；高峰时段（北京时间工作日 9-12、14-18）翻倍。缓存命中输入 4.5 元/百万 → 0.15 元。',
  },
  {
    patterns: [/^deepseek-flash/, /^deepseek-v4\.1-flash/, /^deepseek-v4-flash/, /^deepseek-chat/, /^deepseek/],
    pricePerMTokIn: 0.15,
    cacheHitIn: 0.003,
    pricePerMTokOut: 0.6,
    source: DEEPSEEK_SRC,
    asOf: AS_OF,
    note: '空闲时段价；高峰时段翻倍。旧名 deepseek-v4-flash* 已下线，由 V4.1-Flash 承接并按 Flash 价目计费。',
  },

  // ── 月之暗面 Kimi（官方只给 CNY）─────────────────────────
  { patterns: [/^kimi-k3/], ...cny(20, 100, KIMI_SRC, 2), source: KIMI_SRC, asOf: AS_OF },
  { patterns: [/^kimi-k2\.7-code-highspeed/], ...cny(13, 54, KIMI_SRC, 2.6), source: KIMI_SRC, asOf: AS_OF },
  { patterns: [/^kimi-k2\.7-code/], ...cny(6.5, 27, KIMI_SRC, 1.3), source: KIMI_SRC, asOf: AS_OF },
  { patterns: [/^kimi-k2\.6/, /^kimi-k2\.5/, /^kimi-k2/], ...cny(6.5, 27, KIMI_SRC, 1.1), source: KIMI_SRC, asOf: AS_OF },

  // ── Google Gemini ─────────────────────────────────────
  {
    patterns: [/^gemini-3\.8-flash/],
    pricePerMTokIn: 0.75,
    pricePerMTokOut: 3.75,
    source: GEMINI_SRC,
    asOf: AS_OF,
    note: '官方标注为促销价，有效期到 2026 年底。',
  },
  { patterns: [/^gemini-3\.5-flash-lite/], pricePerMTokIn: 0.3, pricePerMTokOut: 2.5, source: GEMINI_SRC, asOf: AS_OF },
  {
    patterns: [/^gemini-2\.5-pro/],
    pricePerMTokIn: 1.25,
    pricePerMTokOut: 10,
    source: GEMINI_SRC,
    asOf: AS_OF,
    note: '官方按上下文长度分档（1.25–2.50 / 10–15），这里取低档。',
  },
  { patterns: [/^gemini-.*-flash/], pricePerMTokIn: 0.3, pricePerMTokOut: 2.5, source: GEMINI_SRC, asOf: AS_OF },
]

function normalize(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .trim()
    // 服务商名/渠道前缀与日期后缀都不影响价目档位：gpt-5.2-2026-09-01 → gpt-5.2
    .replace(/^[\w.-]+\//, '')
    .replace(/-(\d{4}[-_]?\d{2}[-_]?\d{2}|\d{4}|\d{2}\d{2})$/, '')
}

/**
 * 按模型名查公开单价。命中不了返回 null —— 调用方保持 0，
 * 因为「按 0 计」比「按编造的高价计」更可诊断（doctor 会显式报未配置单价）。
 */
export function lookupPublicPrice(modelName: string): PublicPrice | null {
  const n = normalize(modelName)
  if (!n) return null
  for (const row of ROWS) {
    if (row.patterns.some((p) => p.test(n))) {
      return {
        pricePerMTokIn: row.pricePerMTokIn,
        pricePerMTokOut: row.pricePerMTokOut,
        cacheHitIn: row.cacheHitIn,
        source: row.source,
        asOf: row.asOf,
        note: row.note,
      }
    }
  }
  return null
}
