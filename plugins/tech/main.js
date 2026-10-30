/**
 * 技术工作台：每天最热的 AI 话题，加上能长期攒东西的四个区。
 *
 * 热点数据来自 AIHOT 公开 API（https://aihot.news/api/v1）。它的口径分三层，
 * 这里按「双轨」对齐：
 *   - 今天：/hot-topics 的实时 Top 10（AIHOT 自己的排序）；
 *   - 最近 7 天：/items 的条目，按 AIHOT 评分重排 —— 这不是当天的官方热榜，
 *     面板和工具都会把这句写出来，别让人以为是；
 *   - 更早：/dailies/{date} 的当日日报（哪个板块有哪几条）。
 *
 * 用法上的几条硬规矩：
 *   - AIHOT 的免费额度按 IP 限流（约 60 次/分钟），所以所有请求排队 + 缓存，
 *     面板来回切日期不会把额度打爆；
 *   - 署名要留着：每条卡片都带 AIHOT 的 attribution；
 *   - 个人 / 非商用免费，对外商用要拿到 AIHOT 的书面授权。
 *
 * 社区热榜是另外两家源：Hacker News（Algolia 搜索接口）和 GitHub Trending
 * （官方没有 API，只能读页面结构；结构一变解析就会空，所以解析失败要说失败）。
 */

'use strict'

const AIHOT_BASE = 'https://aihot.news/api/v1'
const AIHOT_UA = 'aihot-api/2.0.0'
const HN_URL = 'https://hn.algolia.com/api/v1/search?tags=front_page&hitsPerPage=20'
const GH_URL = 'https://github.com/trending?since='
/** AI 羊毛：走 RSS，站点 robots.txt 明确禁止 /api/，别去碰那个接口 */
const PROMO_RSS_URL = 'https://www.aipromonow.com/rss.xml'
const PROMO_SITE = 'https://www.aipromonow.com'

/** AIHOT 限流在 60/分钟左右；这里把请求串起来，最小间隔 900ms */
const MIN_GAP_MS = 900
const HOT_TTL_MS = 5 * 60 * 1000
const ITEMS_TTL_MS = 15 * 60 * 1000
const DAILY_TTL_MS = 6 * 60 * 60 * 1000
const COMMUNITY_TTL_MS = 20 * 60 * 1000
const PROMO_TTL_MS = 30 * 60 * 1000
/** 翻条目时最多翻几页（每页 100 条）；7 天窗口实测量级在几百条 */
const ITEM_PAGE_MAX = 8
const MAX_SAVED = 500
const MAX_KEYWORDS = 40
const MAX_RADAR_KEYWORDS = 8

let ctx = null
let chain = Promise.resolve()
let lastRequestAt = 0

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function str(value, max = 512) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

/** 任何抛出物都要变成一句能写进界面的话 */
function errText(error) {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return '未知错误'
  }
}

function num(value) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** 全部按本机时区算日期：面板上写的「今天」就是用户那边的今天 */
function dayKey(date) {
  const d = date instanceof Date ? date : new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function shiftDay(key, delta) {
  const parts = String(key || '').split('-').map(Number)
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return ''
  return dayKey(new Date(parts[0], parts[1] - 1, parts[2] + delta))
}

function daysBetween(from, to) {
  const a = String(from || '').split('-').map(Number)
  const b = String(to || '').split('-').map(Number)
  if (a.length !== 3 || b.length !== 3) return 9999
  const start = Date.UTC(a[0], a[1] - 1, a[2])
  const end = Date.UTC(b[0], b[1] - 1, b[2])
  return Math.round((end - start) / 86400000)
}

function isDateKey(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))
}

/** ISO 时间戳换成本机日期键；拿不到就回空 */
function localDayOf(iso) {
  const text = str(iso, 64)
  if (!text) return ''
  const at = Date.parse(text)
  if (!Number.isFinite(at)) return ''
  return dayKey(new Date(at))
}

function decodeEntities(text) {
  return String(text || '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

function stripTags(text) {
  return decodeEntities(String(text || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
}

/* ------------------------------------------------------------------ *
 * 请求：排队 + 缓存
 * ------------------------------------------------------------------ */

async function request(url, headers) {
  const run = chain.then(async () => {
    const wait = MIN_GAP_MS - (Date.now() - lastRequestAt)
    if (wait > 0) await sleep(wait)
    lastRequestAt = Date.now()
    const res = await ctx.fetch({ url, headers: headers || {} })
    if (!res || res.status >= 400) {
      throw new Error(`${res ? res.status : '无响应'}：${url}`)
    }
    return res.body
  })
  // 一条失败不能连累后面的：链子自己接上
  chain = run.then(() => undefined, () => undefined)
  return run
}

async function fetchJson(url, headers) {
  const body = await request(url, headers)
  try {
    return JSON.parse(body)
  } catch {
    throw new Error(`返回的不是 JSON：${url}`)
  }
}

async function cacheGet(key, ttl) {
  const raw = await ctx.storage.get(key)
  if (!raw || typeof raw !== 'object') return null
  const at = num(raw.at)
  if (!at || Date.now() - at > ttl) return null
  return raw.value
}

async function cacheSet(key, value) {
  try {
    await ctx.storage.set(key, { at: Date.now(), value })
  } catch {
    // 缓存写不进去不影响结果，只是下次要重新拉
  }
}

async function cached(key, ttl, loader) {
  const hit = await cacheGet(key, ttl)
  if (hit !== null && hit !== undefined) return { value: hit, cached: true }
  const value = await loader()
  await cacheSet(key, value)
  return { value, cached: false }
}

/* ------------------------------------------------------------------ *
 * 归一化：把三个接口的形状压成同一种卡片
 * ------------------------------------------------------------------ */

function attributionOf(item) {
  const attribution = item && item.attribution
  if (attribution && typeof attribution === 'object') {
    return { name: str(attribution.name, 80), url: str(attribution.url, 400) }
  }
  return null
}

function linksOf(item) {
  const links = (item && item.links) || {}
  return {
    aihot: str(links.aihot, 400),
    original: str(links.original, 600),
    story: str(links.story, 400),
  }
}

function sourceName(item) {
  const source = item && item.source
  if (source && typeof source === 'object') return str(source.name, 120)
  return str(source, 120)
}

/** 实时热榜：只有排序信号，没有摘要 */
function normalizeHot(payload) {
  const items = payload && Array.isArray(payload.items) ? payload.items : []
  return items.map((item, index) => ({
    id: str(item.id, 64),
    rank: num(item.rank) || index + 1,
    title: str(item.title, 300),
    summary: '',
    source: sourceName(item),
    category: '',
    score: 0,
    sourceCount: num(item.sourceCount),
    signalCount: num(item.signalCount),
    participantCount: num(item.participantCount),
    sourceNames: Array.isArray(item.sourceNames) ? item.sourceNames.slice(0, 8).map((n) => str(n, 120)) : [],
    publishedAt: '',
    latestAt: str(item.latestAt, 40),
    links: linksOf(item),
    attribution: attributionOf(item),
  }))
}

/** 条目：有摘要和 AIHOT 评分 */
function normalizeItems(payload) {
  const items = payload && Array.isArray(payload.items) ? payload.items : []
  return items.map((item, index) => ({
    id: str(item.id, 64),
    rank: index + 1,
    title: str(item.title, 300),
    summary: str(item.summary, 600),
    source: sourceName(item),
    category: str(item.category, 40),
    score: num(item.score),
    sourceCount: 0,
    signalCount: 0,
    participantCount: 0,
    sourceNames: [],
    publishedAt: str(item.publishedAt, 40),
    latestAt: str(item.publishedAt, 40),
    links: linksOf(item),
    attribution: attributionOf(item),
  }))
}

/** 日报：一个导语 + 若干板块 */
function normalizeDaily(payload) {
  const report = (payload && payload.report) || payload || {}
  const lead = report.lead || {}
  const sections = Array.isArray(report.sections) ? report.sections : []
  return {
    date: str(report.date, 20),
    generatedAt: str(report.generatedAt, 40),
    windowStart: str(report.windowStart, 40),
    windowEnd: str(report.windowEnd, 40),
    links: linksOf({ links: report.links }),
    attribution: attributionOf({ attribution: report.attribution }),
    lead: { title: str(lead.title, 300), paragraph: str(lead.leadParagraph, 1200) },
    flashes: Array.isArray(report.flashes) ? report.flashes.length : 0,
    sections: sections.map((section) => ({
      label: str(section.label, 80),
      items: (Array.isArray(section.items) ? section.items : []).map((item) => ({
        id: str(item.id, 64),
        rank: 0,
        title: str(item.title, 300),
        summary: str(item.summary, 600),
        source: sourceName(item),
        category: '',
        score: 0,
        sourceCount: 0,
        signalCount: 0,
        participantCount: 0,
        sourceNames: [],
        publishedAt: '',
        latestAt: '',
        links: linksOf(item),
        attribution: attributionOf(item),
      })),
    })),
  }
}

/* ------------------------------------------------------------------ *
 * 社区热榜
 * ------------------------------------------------------------------ */

function parseHn(payload) {
  const hits = payload && Array.isArray(payload.hits) ? payload.hits : []
  return hits.map((hit) => ({
    id: str(hit.objectID, 32),
    title: str(hit.title, 300),
    url: str(hit.url, 600) || `https://news.ycombinator.com/item?id=${str(hit.objectID, 32)}`,
    points: num(hit.points),
    comments: num(hit.num_comments),
    author: str(hit.author, 80),
    createdAt: str(hit.created_at, 40),
  }))
}

function parseGithubTrending(html) {
  const out = []
  const articleRe = /<article class="Box-row">([\s\S]*?)<\/article>/g
  let match = articleRe.exec(String(html || ''))
  while (match) {
    const block = match[1]
    const repoMatch = block.match(/<h2[\s\S]{0,600}?href="\/([^"]+)"/)
    if (repoMatch) {
      const repo = repoMatch[1].trim().replace(/\s+/g, '')
      const descMatch = block.match(/<p class="col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/)
      const langMatch = block.match(/itemprop="programmingLanguage">([^<]+)</)
      const todayMatch = block.match(/([\d,]+)\s*stars today/)
      const starsMatch = block.match(/href="\/[^"]+\/stargazers"[\s\S]{0,800}?<\/svg>\s*([\d,]+)/)
      out.push({
        repo,
        url: `https://github.com/${repo}`,
        description: descMatch ? stripTags(descMatch[1]) : '',
        language: langMatch ? decodeEntities(langMatch[1]).trim() : '',
        stars: starsMatch ? num(starsMatch[1].replace(/,/g, '')) : 0,
        starsToday: todayMatch ? num(todayMatch[1].replace(/,/g, '')) : 0,
      })
    }
    match = articleRe.exec(String(html || ''))
  }
  return out
}

/* ------------------------------------------------------------------ *
 * AI 羊毛：RSS 解析
 * ------------------------------------------------------------------ */

function rssText(raw) {
  const text = String(raw || '').trim()
  const cdata = text.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/)
  // 先解实体再剥标签：RSS 里常把 <b> 写成 &lt;b&gt;，只剥一次会留下字面标签
  return stripTags(decodeEntities(cdata ? cdata[1] : text))
}

/** RSS 里的 link 带 utm 参数；guid 通常是干净的原文地址，优先用它 */
function promoCanonicalUrl(guid, link) {
  const preferred = str(guid, 600) || str(link, 600)
  if (!preferred) return ''
  try {
    const parsed = new URL(preferred)
    parsed.search = ''
    parsed.hash = ''
    return parsed.toString()
  } catch {
    return str(link, 600)
  }
}

function parsePromoRss(xml) {
  const out = []
  const itemRe = /<item>([\s\S]*?)<\/item>/g
  const text = String(xml || '')
  let match = itemRe.exec(text)
  while (match) {
    const block = match[1]
    const pick = (tag) => {
      const found = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
      return found ? rssText(found[1]) : ''
    }
    const title = pick('title')
    const url = promoCanonicalUrl(pick('guid'), pick('link'))
    const rawDate = pick('pubDate')
    const at = Date.parse(rawDate)
    const slugMatch = url.match(/\/promos\/([^/?#]+)/)
    if (title || url) {
      out.push({
        id: slugMatch ? slugMatch[1] : hashKey(url || title),
        title,
        url,
        summary: str(pick('description'), 600),
        publishedAt: Number.isFinite(at) ? new Date(at).toISOString() : '',
        publishedText: str(rawDate, 60),
        source: 'AI Promo Now',
      })
    }
    match = itemRe.exec(text)
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 数据源
 * ------------------------------------------------------------------ */

async function fetchHotTopics() {
  const { value, cached: hit } = await cached('cache.hot', HOT_TTL_MS, () =>
    fetchJson(`${AIHOT_BASE}/hot-topics`, { 'User-Agent': AIHOT_UA, Accept: 'application/json' }),
  )
  return { items: normalizeHot(value), cached: hit }
}

async function fetchItems(params) {
  const query = new URLSearchParams()
  query.set('mode', 'all')
  query.set('window', '7d')
  query.set('limit', '100')
  // 只认字符串：对象传进来会被 String() 变成 "[object Object]"，
  // 服务端不会报错，只会静默返回空结果。
  const keyword = params && typeof params.q === 'string' ? params.q.trim() : ''
  if (keyword) query.set('q', keyword)
  if (params && params.category) query.set('category', String(params.category))
  const key = keyword ? `cache.items.${hashKey(keyword)}` : 'cache.items.all'
  const { value, cached: hit } = await cached(key, ITEMS_TTL_MS, () =>
    fetchJson(`${AIHOT_BASE}/items?${query.toString()}`, { 'User-Agent': AIHOT_UA, Accept: 'application/json' }),
  )
  return { items: normalizeItems(value), cached: hit }
}

/** 条目接口的一页。cursor 为空就是最新一页 */
async function fetchItemsPage(cursor) {
  const query = new URLSearchParams()
  query.set('mode', 'all')
  query.set('window', '7d')
  query.set('limit', '100')
  if (cursor) query.set('cursor', String(cursor))
  return fetchJson(`${AIHOT_BASE}/items?${query.toString()}`, { 'User-Agent': AIHOT_UA, Accept: 'application/json' })
}

/**
 * 「近 7 天按评分重排」要覆盖整整一周，而条目接口一页只给 100 条、
 * 且按时间倒序 —— 只取一页，最近两三天之外的日子全是空的。
 * 这里顺着 cursor 往下翻，翻过目标那天为止，再多翻也没有意义。
 *
 * 缓存只留那天自己的条目：翻页时扫过的条目全部塞进存储会让插件的
 * store.json 长到几 MB，而面板最后只会显示当天那几十条。
 */
async function fetchItemsForDay(date) {
  const { value, cached: hit } = await cached(`cache.day.${date}`, ITEMS_TTL_MS, async () => {
    const items = []
    let cursor = ''
    for (let page = 0; page < ITEM_PAGE_MAX; page += 1) {
      const payload = await fetchItemsPage(cursor)
      const batch = normalizeItems(payload)
      for (const item of batch) {
        if (localDayOf(item.publishedAt) === date) items.push(item)
      }
      const oldest = batch.length ? batch[batch.length - 1].publishedAt : ''
      // 倒序翻到这里已经比目标那天更旧，说明那天的条目全都收齐了
      if (!oldest || localDayOf(oldest) < date) break
      const next = payload && payload.page ? payload.page.nextCursor : ''
      if (!payload || !payload.page || !payload.page.hasMore || !next) break
      cursor = next
    }
    return items
  })
  return { items: Array.isArray(value) ? value : [], cached: hit }
}

async function fetchDaily(date) {
  const { value, cached: hit } = await cached(`cache.daily.${date}`, DAILY_TTL_MS, () =>
    fetchJson(`${AIHOT_BASE}/dailies/${date}`, { 'User-Agent': AIHOT_UA, Accept: 'application/json' }),
  )
  return { report: normalizeDaily(value), cached: hit }
}

async function fetchDailiesIndex() {
  const { value, cached: hit } = await cached('cache.dailies', DAILY_TTL_MS, () =>
    fetchJson(`${AIHOT_BASE}/dailies?limit=60`, { 'User-Agent': AIHOT_UA, Accept: 'application/json' }),
  )
  const items = value && Array.isArray(value.items) ? value.items : []
  return {
    dailies: items.map((item) => ({
      date: str(item.date, 20),
      generatedAt: str(item.generatedAt, 40),
      leadTitle: str(item.leadTitle, 300),
      leadParagraph: str(item.leadParagraph, 600),
      url: str((item.links && item.links.aihot) || '', 400) || `https://aihot.news/daily/${str(item.date, 20)}`,
    })),
    cached: hit,
  }
}

async function fetchCommunity(source) {
  const wanted = source === 'hn' || source === 'github' ? source : 'all'
  const out = { hn: [], github: [] }
  if (wanted === 'all' || wanted === 'hn') {
    const { value, cached: hit } = await cached('cache.hn', COMMUNITY_TTL_MS, () =>
      fetchJson(HN_URL, { Accept: 'application/json' }),
    )
    out.hn = parseHn(value)
    out.hnCached = hit
  }
  if (wanted === 'all' || wanted === 'github') {
    const { value, cached: hit } = await cached('cache.github', COMMUNITY_TTL_MS, async () => {
      const html = await request(`${GH_URL}daily`, { 'User-Agent': 'Mozilla/5.0 Torra/0.4', Accept: 'text/html' })
      return parseGithubTrending(html)
    })
    out.github = value
    out.githubCached = hit
  }
  return out
}

async function fetchPromos() {
  const { value, cached: hit } = await cached('cache.promos', PROMO_TTL_MS, async () => {
    const xml = await request(PROMO_RSS_URL, {
      'User-Agent': 'Mozilla/5.0 Torra/0.4',
      Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
    })
    return parsePromoRss(xml)
  })
  return { items: Array.isArray(value) ? value : [], cached: hit }
}

/** 关键词/查询串进缓存键要短且稳定 */
function hashKey(text) {
  let hash = 5381
  const value = String(text || '')
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + value.charCodeAt(i)) >>> 0
  }
  return hash.toString(36)
}

/* ------------------------------------------------------------------ *
 * 热点：双轨口径
 * ------------------------------------------------------------------ */

async function hotPayload(dateInput) {
  const today = dayKey()
  const date = isDateKey(dateInput) ? String(dateInput) : today
  const age = daysBetween(date, today)

  if (date === today) {
    const { items, cached: hit } = await fetchHotTopics()
    return {
      date,
      mode: 'live',
      metric: 'AIHOT 实时热榜 Top 10（AIHOT 的排序口径）',
      items,
      lead: null,
      sections: [],
      fetchedAt: Date.now(),
      cached: hit,
    }
  }

  if (age >= 1 && age <= 7) {
    const { items, cached: hit } = await fetchItemsForDay(date)
    const filtered = items
      .filter((item) => localDayOf(item.publishedAt) === date)
      .sort((a, b) => b.score - a.score || (a.publishedAt < b.publishedAt ? 1 : -1))
      .map((item, index) => ({ ...item, rank: index + 1 }))
    return {
      date,
      mode: 'rerank',
      metric: '近 7 天条目按 AIHOT 评分重排（当天没有官方热榜，排序是我们重排的）',
      items: filtered,
      lead: null,
      sections: [],
      fetchedAt: Date.now(),
      cached: hit,
    }
  }

  const { report, cached: hit } = await fetchDaily(date)
  return {
    date,
    mode: 'daily',
    metric: 'AIHOT 当日日报（按板块整理）',
    items: report.sections.flatMap((section) => section.items.map((item) => ({ ...item, section: section.label }))),
    lead: report.lead,
    sections: report.sections,
    attribution: report.attribution,
    fetchedAt: Date.now(),
    cached: hit,
  }
}

/* ------------------------------------------------------------------ *
 * 本地状态：收藏队列 / 关键词
 * ------------------------------------------------------------------ */

function emptyState() {
  return { saved: [], keywords: [], layout: 'grid3' }
}

/** 面板的三种卡片形态；坏值一律回落到三列，别让旧数据把列表撑坏 */
function normalizeLayout(value) {
  return ['list', 'grid2', 'grid3'].includes(value) ? value : 'grid3'
}

async function loadState() {
  const raw = await ctx.storage.get('state')
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyState()
  return {
    saved: Array.isArray(raw.saved) ? raw.saved : [],
    keywords: Array.isArray(raw.keywords) ? raw.keywords : [],
    layout: normalizeLayout(raw.layout),
  }
}

async function saveState(state) {
  await ctx.storage.set('state', state)
}

function normalizeSaved(item) {
  const src = item && typeof item === 'object' ? item : {}
  const status = ['todo', 'reading', 'done', 'dropped'].includes(src.status) ? src.status : 'todo'
  const tags = Array.isArray(src.tags) ? src.tags.map((t) => str(t, 40)).filter(Boolean).slice(0, 12) : []
  return {
    id: str(src.id, 64) || `s${Date.now().toString(36)}`,
    title: str(src.title, 300),
    url: str(src.url, 600),
    summary: str(src.summary, 1200),
    note: str(src.note, 2000),
    source: str(src.source, 120),
    tags,
    status,
    createdAt: num(src.createdAt) || Date.now(),
    updatedAt: num(src.updatedAt) || Date.now(),
  }
}

/* ------------------------------------------------------------------ *
 * 关键词雷达
 * ------------------------------------------------------------------ */

async function radarPayload() {
  const state = await loadState()
  const keywords = state.keywords.slice(0, MAX_RADAR_KEYWORDS)
  const groups = []
  for (const keyword of keywords) {
    const text = str(keyword && keyword.text, 60).trim()
    if (!text) continue
    try {
      // 注意传的是 text，不是整个 keyword 对象 —— 传对象会被
      // String() 变成 "[object Object]"，服务端一个字也匹配不到。
      const { items } = await fetchItems({ q: text })
      groups.push({
        keyword: text,
        count: items.length,
        items: items.slice(0, 8).map((item, index) => ({ ...item, rank: index + 1 })),
      })
    } catch (error) {
      groups.push({ keyword: text, count: 0, items: [], error: errText(error) })
    }
  }
  return { groups, at: Date.now() }
}

/* ------------------------------------------------------------------ *
 * 收藏导出
 * ------------------------------------------------------------------ */

function exportMarkdown(saved) {
  const lines = ['# 技术工作台 · 收藏与阅读队列', '']
  const groups = { todo: '待读', reading: '在读', done: '已读', dropped: '已放弃' }
  for (const key of ['reading', 'todo', 'done', 'dropped']) {
    const items = saved.filter((item) => item.status === key)
    if (!items.length) continue
    lines.push(`## ${groups[key]}`, '')
    for (const item of items) {
      const tags = item.tags.length ? ` \`${item.tags.join('` `')}\`` : ''
      lines.push(`- [${item.title || '(无标题)'}](${item.url})${tags}`)
      if (item.note) lines.push(`  - 笔记：${item.note}`)
      if (item.summary) lines.push(`  - 摘要：${item.summary}`)
    }
    lines.push('')
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ *
 * 装配
 * ------------------------------------------------------------------ */

const TOOL_NAMES = [
  'tech_hot',
  'tech_search',
  'tech_daily',
  'tech_saved',
  'tech_save',
  'tech_keywords',
  'tech_community',
  'tech_deals',
]

async function activate(context) {
  ctx = context

  const tool = (name, fn) => ctx.tools.handle(name, fn)
  const rpc = (name, fn) => ctx.rpc.handle(name, fn)

  /* ---- 面板接口 ---- */

  rpc('hot', async (params) => hotPayload((params && params.date) || ''))
  rpc('dailies', async () => fetchDailiesIndex())
  rpc('search', async (params) => {
    const p = params && typeof params === 'object' ? params : {}
    const query = str(p.q, 120)
    if (!query) throw new Error('缺少检索词')
    const { items } = await fetchItems({ q: query, category: str(p.category, 40) })
    return { query, items: items.slice(0, Math.max(1, Math.min(num(p.limit) || 20, 50))) }
  })
  rpc('community', async (params) => fetchCommunity((params && params.source) || 'all'))
  rpc('promos', async (params) => {
    const p = params && typeof params === 'object' ? params : {}
    const { items, cached: hit } = await fetchPromos()
    return {
      items: items.slice(0, Math.max(1, Math.min(num(p.limit) || 30, 60))),
      total: items.length,
      cached: hit,
      source: { name: 'AI Promo Now', url: PROMO_SITE },
    }
  })
  rpc('radar', async () => radarPayload())

  rpc('saved.list', async (params) => {
    const state = await loadState()
    const p = params && typeof params === 'object' ? params : {}
    const status = str(p.status, 20)
    const tag = str(p.tag, 40)
    let items = state.saved
    if (status) items = items.filter((item) => item.status === status)
    if (tag) items = items.filter((item) => item.tags.includes(tag))
    items = items.slice().sort((a, b) => b.updatedAt - a.updatedAt)
    return { items, tags: [...new Set(state.saved.flatMap((item) => item.tags))].sort() }
  })
  rpc('saved.add', async (params) => {
    const p = params && typeof params === 'object' ? params : {}
    const state = await loadState()
    const item = normalizeSaved({
      ...p,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    if (!item.title && !item.url) throw new Error('至少给一条标题或链接')
    state.saved.unshift(item)
    if (state.saved.length > MAX_SAVED) state.saved.length = MAX_SAVED
    await saveState(state)
    return { item }
  })
  rpc('saved.update', async (params) => {
    const p = params && typeof params === 'object' ? params : {}
    const state = await loadState()
    const index = state.saved.findIndex((item) => item.id === str(p.id, 64))
    if (index < 0) throw new Error('收藏不存在')
    const merged = normalizeSaved({
      ...state.saved[index],
      ...p,
      id: state.saved[index].id,
      createdAt: state.saved[index].createdAt,
      updatedAt: Date.now(),
    })
    state.saved[index] = merged
    await saveState(state)
    return { item: merged }
  })
  rpc('saved.remove', async (params) => {
    const p = params && typeof params === 'object' ? params : {}
    const state = await loadState()
    const before = state.saved.length
    state.saved = state.saved.filter((item) => item.id !== str(p.id, 64))
    await saveState(state)
    return { removed: before - state.saved.length }
  })
  rpc('saved.export', async () => {
    const state = await loadState()
    return { markdown: exportMarkdown(state.saved) }
  })

  rpc('keywords.list', async () => {
    const state = await loadState()
    return { keywords: state.keywords }
  })
  rpc('keywords.add', async (params) => {
    const p = params && typeof params === 'object' ? params : {}
    const text = str(p.text, 60).trim()
    if (!text) throw new Error('关键词不能为空')
    const state = await loadState()
    if (state.keywords.some((item) => item.text.toLowerCase() === text.toLowerCase())) {
      return { keywords: state.keywords, added: false }
    }
    state.keywords.push({ text, createdAt: Date.now() })
    if (state.keywords.length > MAX_KEYWORDS) state.keywords.length = MAX_KEYWORDS
    await saveState(state)
    return { keywords: state.keywords, added: true }
  })
  rpc('keywords.remove', async (params) => {
    const p = params && typeof params === 'object' ? params : {}
    const state = await loadState()
    const text = str(p.text, 60).trim()
    state.keywords = state.keywords.filter((item) => item.text.toLowerCase() !== text.toLowerCase())
    await saveState(state)
    return { keywords: state.keywords }
  })
  rpc('prefs.get', async () => {
    const state = await loadState()
    return { layout: state.layout }
  })
  rpc('prefs.set', async (params) => {
    const p = params && typeof params === 'object' ? params : {}
    const state = await loadState()
    state.layout = normalizeLayout(p.layout)
    await saveState(state)
    return { layout: state.layout }
  })
  rpc('cache.clear', async () => {
    const keys = await ctx.storage.list()
    for (const key of keys) {
      if (key.startsWith('cache.')) await ctx.storage.delete(key)
    }
    return { cleared: true }
  })

  /* ---- 助手工具 ---- */

  tool('tech_hot', async (params) => {
    const p = params && typeof params === 'object' ? params : {}
    const payload = await hotPayload(str(p.date, 20))
    const limit = Math.max(1, Math.min(num(p.limit) || 10, 30))
    return {
      date: payload.date,
      mode: payload.mode,
      metric: payload.metric,
      lead: payload.lead,
      items: payload.items.slice(0, limit),
      attribution: { name: 'AIHOT', url: 'https://aihot.news' },
    }
  })

  tool('tech_search', async (params) => {
    const p = params && typeof params === 'object' ? params : {}
    const query = str(p.q, 120)
    if (!query) throw new Error('缺少检索词')
    const { items } = await fetchItems({ q: query })
    return {
      query,
      window: '近 7 天',
      items: items.slice(0, Math.max(1, Math.min(num(p.limit) || 15, 50))),
      attribution: { name: 'AIHOT', url: 'https://aihot.news' },
    }
  })

  tool('tech_daily', async (params) => {
    const p = params && typeof params === 'object' ? params : {}
    const date = str(p.date, 20)
    if (!isDateKey(date)) {
      const { dailies } = await fetchDailiesIndex()
      return { dailies: dailies.slice(0, 30) }
    }
    const { report } = await fetchDaily(date)
    return { date: report.date, lead: report.lead, sections: report.sections, attribution: report.attribution }
  })

  tool('tech_saved', async (params) => {
    const p = params && typeof params === 'object' ? params : {}
    const state = await loadState()
    const status = str(p.status, 20)
    const items = status ? state.saved.filter((item) => item.status === status) : state.saved
    return { count: items.length, items: items.slice(0, Math.max(1, Math.min(num(p.limit) || 50, 200))) }
  })

  tool('tech_save', async (params) => {
    const p = params && typeof params === 'object' ? params : {}
    const state = await loadState()
    const item = normalizeSaved({ ...p, createdAt: Date.now(), updatedAt: Date.now() })
    if (!item.title && !item.url) throw new Error('至少给一条标题或链接')
    state.saved.unshift(item)
    if (state.saved.length > MAX_SAVED) state.saved.length = MAX_SAVED
    await saveState(state)
    return { item, count: state.saved.length }
  })

  tool('tech_keywords', async (params) => {
    const p = params && typeof params === 'object' ? params : {}
    if (p.add) {
      const text = str(p.add, 60).trim()
      const state = await loadState()
      if (!state.keywords.some((item) => item.text.toLowerCase() === text.toLowerCase())) {
        state.keywords.push({ text, createdAt: Date.now() })
        await saveState(state)
      }
      return { keywords: state.keywords }
    }
    if (p.remove) {
      const state = await loadState()
      state.keywords = state.keywords.filter((item) => item.text.toLowerCase() !== str(p.remove, 60).trim().toLowerCase())
      await saveState(state)
      return { keywords: state.keywords }
    }
    const payload = await radarPayload()
    return { groups: payload.groups }
  })

  tool('tech_community', async (params) => {
    const p = params && typeof params === 'object' ? params : {}
    const source = str(p.source, 20)
    const payload = await fetchCommunity(source)
    return {
      hn: payload.hn.slice(0, 20),
      github: payload.github.slice(0, 20),
      sources: ['Hacker News（Algolia 公开接口）', 'GitHub Trending（官方页面结构）'],
    }
  })

  tool('tech_deals', async (params) => {
    const p = params && typeof params === 'object' ? params : {}
    const { items } = await fetchPromos()
    return {
      count: items.length,
      items: items.slice(0, Math.max(1, Math.min(num(p.limit) || 20, 60))),
      note: '来自 AI Promo Now 的 RSS，最近发布的 30 条优惠；额度、期限与条款以原页面为准。',
      attribution: { name: 'AI Promo Now', url: PROMO_SITE },
    }
  })

  ctx.log('info', `技术工作台就绪：${TOOL_NAMES.length} 个工具`)
}

module.exports = {
  activate,
  normalizeHot,
  normalizeItems,
  normalizeDaily,
  parseHn,
  parseGithubTrending,
  parsePromoRss,
  normalizeLayout,
  dayKey,
  shiftDay,
  daysBetween,
  localDayOf,
  exportMarkdown,
  stripTags,
}
