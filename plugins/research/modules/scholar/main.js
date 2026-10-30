/**
 * 学者工作台：论文库 / 精读 / 多篇对比 / Idea 书柜 / 引用。
 *
 * 数据全在本机（宿主插件存储），联网只有一条路：ctx.fetch 走 host 的域名白名单。
 * 元数据来自四个互补的源：arXiv（预印本）、Crossref（DOI 题录）、OpenAlex（跨库索引，
 * 带被引与引文网络）、Europe PMC（生命科学）。哪个源没答复就报哪个，不拿别的源的结果冒充；
 * 抓不到元数据就明确报错 —— 不拿「猜出来的作者和年份」凑一条记录，那种记录以后会变成引用里最难看的部分。
 */

const { createScholarAi, keyOf } = require('./ai')
const {
  MINERU,
  createMineru,
  pdfUrlFor,
  normalizeFull,
  describeFull,
  cleanMarkdown,
  excerpt,
  trimToBytes,
} = require('./fulltext')

const LIMIT = {
  papers: 500,
  ideas: 200,
  list: 200,
  title: 400,
  note: 6000,
  tag: 24,
  tags: 20,
  questions: 50,
  linkedPapers: 20,
  projects: 80,
  sessions: 300,
  messages: 200,
  files: 40,
  messageText: 4000,
  messageData: 60000,
  fileText: 200000,
  docs: 60,
  docTitle: 200,
  docBody: 60000,
  history: 40,
  fullPreview: 12000,
  fullRead: 60000,
}

const PAPER_STATUS = [
  ['todo', '待读'],
  ['reading', '精读中'],
  ['read', '已读'],
  ['parked', '搁置'],
]
const IDEA_STATUS = [
  ['draft', '草案'],
  ['testing', '验证中'],
  ['confirmed', '已证实'],
  ['rejected', '已否决'],
]

const READING_SECTIONS = [
  ['conclusion', '结论'],
  ['evidence', '证据'],
  ['experiments', '实验'],
  ['limitations', '局限'],
]

/**
 * 检索源：四个库各有各的盲区，单走一个必然漏。
 * on 只是面板的默认勾选，用户每次都能改；id 也是 RPC 里认的名字。
 */
const SOURCES = [
  { id: 'arxiv', label: 'arXiv', on: true, note: '预印本，新工作到得快' },
  { id: 'crossref', label: 'Crossref', on: true, note: 'DOI 题录，期刊与会议都收' },
  { id: 'openalex', label: 'OpenAlex', on: true, note: '跨库索引，带被引与引文' },
  { id: 'europepmc', label: 'Europe PMC', on: false, note: '生命科学与医学' },
]
const SOURCE_IDS = SOURCES.map((s) => s.id)
const SORTS = [
  ['relevance', '相关度'],
  ['newest', '最新'],
  ['cited', '高被引'],
]

/** 英文检索里这些词只会稀释命中：arXiv 的字段查询是词面匹配，不认语义 */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'of', 'in', 'on', 'for', 'with', 'and', 'or', 'to', 'by', 'from', 'via',
  'using', 'based', 'how', 'what', 'why', 'does', 'do', 'is', 'are', 'can', 'into', 'under',
  'over', 'between', 'about', 'at', 'as', 'that', 'this', 'these', 'those', 'be', 'we', 'our',
  'their', 'its', 'it', 'than', 'then', 'not', 'no', 'use', 'used', 'new', 'toward', 'towards',
])

let ctx = null
let state = { papers: [], ideas: [], projects: [], sessions: [], docs: [], aiModelId: '' }

function str(value) {
  return typeof value === 'string' ? value : ''
}

function cap(value, max) {
  return str(value).replace(/\r\n/g, '\n').trim().slice(0, max)
}

function oneLine(value, max) {
  return cap(value, max).replace(/\s+/g, ' ')
}

function uid(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-3)
}

function normDoi(value) {
  return str(value)
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/\s+/g, '')
}

function normArxiv(value) {
  return str(value)
    .trim()
    .replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//, '')
    .replace(/\.pdf$/i, '')
    .replace(/v\d+$/, '')
}

/** 影响因子只用于筛选与展示：非法值一律留空，不拿 0 冒充「未收录」 */
function normImpact(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return ''
  return Math.round(Math.min(num, 99.99) * 100) / 100
}

function normTitle(value) {
  return str(value)
    .toLowerCase()
    .replace(/[\s\p{P}]+/gu, '')
}

function hasCjk(value) {
  return /[\u3400-\u9fff]/.test(value)
}

function cleanTags(raw) {
  const list = Array.isArray(raw) ? raw : []
  const out = []
  for (const item of list) {
    const tag = oneLine(item, LIMIT.tag)
    if (tag && !out.includes(tag)) out.push(tag)
    if (out.length >= LIMIT.tags) break
  }
  return out
}

function cleanStatus(value, pairs, fallback) {
  const raw = str(value).trim()
  return pairs.some((p) => p[0] === raw) ? raw : fallback
}

function statusLabel(value, pairs) {
  const hit = pairs.find((p) => p[0] === value)
  return hit ? hit[1] : value
}

function normalizeReading(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const out = {}
  for (const [key] of READING_SECTIONS) out[key] = cap(src[key], LIMIT.note)
  const questions = Array.isArray(src.questions) ? src.questions : []
  out.questions = questions
    .map((q) => ({
      id: str(q && q.id) || uid('q'),
      text: cap(q && q.text, 1000),
      at: Number(q && q.at) || Date.now(),
    }))
    .filter((q) => q.text)
    .slice(-LIMIT.questions)
  return out
}

function normalizePaper(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    id: str(src.id) || uid('p'),
    title: cap(src.title, LIMIT.title),
    authors: (Array.isArray(src.authors) ? src.authors : []).map((a) => oneLine(a, 120)).filter(Boolean),
    year: /^\d{4}$/.test(str(src.year)) ? String(src.year) : '',
    venue: oneLine(src.venue, 200),
    impactFactor: normImpact(src.impactFactor),
    doi: normDoi(src.doi),
    arxivId: normArxiv(src.arxivId),
    url: oneLine(src.url, 500),
    abstract: cap(src.abstract, LIMIT.note),
    tags: cleanTags(src.tags),
    status: cleanStatus(src.status, PAPER_STATUS, 'todo'),
    star: src.star === true,
    addedAt: Number(src.addedAt) || Date.now(),
    updatedAt: Number(src.updatedAt) || Date.now(),
    reading: normalizeReading(src.reading),
    // 全文只记状态与出处；正文单独存在 ft:<id>，删论文时一并删掉
    full: normalizeFull(src.full),
  }
}

function normalizeIdea(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    id: str(src.id) || uid('i'),
    title: cap(src.title, LIMIT.title),
    source: cap(src.source, 1000),
    innovation: cap(src.innovation, LIMIT.note),
    evidence: cap(src.evidence, LIMIT.note),
    status: cleanStatus(src.status, IDEA_STATUS, 'draft'),
    paperIds: (Array.isArray(src.paperIds) ? src.paperIds : []).map((v) => str(v)).filter(Boolean).slice(0, LIMIT.linkedPapers),
    createdAt: Number(src.createdAt) || Date.now(),
    updatedAt: Number(src.updatedAt) || Date.now(),
  }
}

function normalizeState(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const projects = (Array.isArray(src.projects) ? src.projects : [])
    .map(normalizeProject)
    .filter((p) => p.title)
    .slice(-LIMIT.projects)
  const projectIds = new Set(projects.map((p) => p.id))
  const sessions = (Array.isArray(src.sessions) ? src.sessions : []).map(normalizeSession).slice(-LIMIT.sessions)
  for (const session of sessions) {
    if (session.projectId && !projectIds.has(session.projectId)) session.projectId = ''
  }
  const docs = (Array.isArray(src.docs) ? src.docs : []).map(normalizeDoc).slice(-LIMIT.docs)
  for (const doc of docs) {
    if (doc.projectId && !projectIds.has(doc.projectId)) doc.projectId = ''
  }
  return {
    papers: (Array.isArray(src.papers) ? src.papers : []).map(normalizePaper).filter((p) => p.title).slice(-LIMIT.papers),
    ideas: (Array.isArray(src.ideas) ? src.ideas : []).map(normalizeIdea).filter((i) => i.title).slice(-LIMIT.ideas),
    projects,
    sessions,
    docs,
    // 手工挑过的模型；空串 = 跟随助手。模型被删/停用的校正放在 ai.models 里做
    aiModelId: oneLine(src.aiModelId, 120),
  }
}

async function load() {
  state = normalizeState(await ctx.storage.get('state'))
}

async function save() {
  await ctx.storage.set('state', state)
}

function findPaper(id) {
  return state.papers.find((p) => p.id === id) || null
}

function requirePaper(id) {
  const paper = findPaper(str(id))
  if (!paper) throw new Error('找不到这篇论文：先在论文库里加进来')
  return paper
}

function findIdea(id) {
  return state.ideas.find((i) => i.id === id) || null
}

function findDuplicate(candidate, skipId) {
  const doi = normDoi(candidate.doi)
  const arxivId = normArxiv(candidate.arxivId)
  const titleKey = normTitle(candidate.title)
  return (
    state.papers.find((p) => {
      if (p.id === skipId) return false
      if (doi && p.doi === doi) return true
      if (arxivId && p.arxivId === arxivId) return true
      return !!titleKey && normTitle(p.title) === titleKey && (!candidate.year || !p.year || candidate.year === p.year)
    }) || null
  )
}

/* ------------------------------------------------------------------ *
 * 元数据：arXiv / Crossref
 * ------------------------------------------------------------------ */

function decodeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
}

function xmlTag(block, name) {
  const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>'))
  return m ? decodeXml(m[1]).replace(/\s+/g, ' ').trim() : ''
}

function parseArxivFeed(xml) {
  const entries = [...String(xml).matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1])
  const out = []
  for (const block of entries) {
    const link = xmlTag(block, 'id')
    const arxivId = normArxiv(link)
    const authors = [...block.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/g)].map((m) =>
      decodeXml(m[1]).replace(/\s+/g, ' ').trim(),
    )
    const published = xmlTag(block, 'published')
    const doi = xmlTag(block, 'arxiv:doi')
    const title = xmlTag(block, 'title')
    if (!title) continue
    out.push({
      source: 'arxiv',
      title,
      authors,
      year: published.slice(0, 4),
      venue: 'arXiv',
      doi: normDoi(doi),
      arxivId,
      url: arxivId ? `https://arxiv.org/abs/${arxivId}` : link,
      abstract: xmlTag(block, 'summary').slice(0, LIMIT.note),
    })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * 取元数据的网络层
 *
 * Crossref 对同一 IP 的短时并发很敏感：三组检索式一起打过去，它会直接回 429；
 * OpenAlex 的匿名额度是整个出口 IP 共享的，连着跑几轮也会见底。以前这里一次失败
 * 就报「没答复」，用户既不知道是限流还是断网，也没机会补一次。
 *
 * 现在做三件事：同一域名排队（不再并发打同一个源）、429/5xx 退避重试、
 * 失败时把状态码和服务的原话带回去。成功的答复缓存十分钟，重试和重跑都不必再花额度。
 * ------------------------------------------------------------------ */

const SOURCES_UA = 'Torra-Scholar/0.4 (+research plugin)'
const RETRY_STATUS = new Set([429, 500, 502, 503, 504])
const HOST_GAP = {
  'api.crossref.org': 1000,
  'api.openalex.org': 400,
  'export.arxiv.org': 1200,
  'www.ebi.ac.uk': 300,
  // flash 通道按出口 IP 限流：提交与轮询都排在同一个槽里，别自己把自己压死
  'mineru.net': 800,
}
const HOST_CHAIN = new Map()
const SEARCH_CACHE = new Map()
const SEARCH_CACHE_TTL = 10 * 60 * 1000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 同一域名串行 + 最小间隔：Crossref 这类服务按秒限流，压过去只会换回 429 */
function hostSlot(url, task) {
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    host = ''
  }
  const gap = HOST_GAP[host] || 0
  const previous = HOST_CHAIN.get(host)
  const start = previous ? previous.then(() => (gap ? sleep(gap) : undefined)) : Promise.resolve()
  const done = start.then(task)
  HOST_CHAIN.set(host, done.catch(() => undefined))
  return done
}

/** 429 的正文通常写着原因（OpenAlex 会直接说额度见底），别把它丢掉 */
function serviceError(status, res) {
  const body = str(res && res.body)
  let detail = ''
  if (body) {
    const quoted = body.match(/"(?:message|error|detail)"\s*:\s*"([^"]{1,140})"/)
    detail = quoted ? quoted[1] : body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
  }
  const head =
    status === 429
      ? '请求被限流（429）'
      : status === 401 || status === 403
        ? `拒绝访问（${status}）`
        : status >= 500
          ? `服务端出错（${status}）`
          : `HTTP ${status}`
  return detail ? head + '：' + detail : head
}

async function fetchJson(url) {
  return hostSlot(url, async () => {
    const res = await ctx.fetch({
      url,
      headers: { accept: 'application/json, application/atom+xml', 'user-agent': SOURCES_UA },
    })
    return res
  })
}

async function getJson(url) {
  let lastError = new Error('元数据服务没有答复')
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(1200 * attempt + Math.round(Math.random() * 400))
    let res
    try {
      res = await fetchJson(url)
    } catch (error) {
      const message = String((error && error.message) || error).slice(0, 160)
      // 超时是 45 秒的整段等待，再试一次只会让面板多卡一轮
      if (/abort|timed? ?out/i.test(message)) throw new Error('请求超时')
      // 权限、白名单、跳转被拦都不是「再试一次」能变的
      if (/权限|permission|重定向|URL 不合法|只允许|不支持/.test(message)) throw new Error(message)
      lastError = new Error(message || '网络请求失败')
      continue
    }
    if (res.status >= 200 && res.status < 300) return res
    lastError = new Error(serviceError(res.status, res))
    if (!RETRY_STATUS.has(res.status)) throw lastError
    const retryAfter = Number((res.headers || {})['retry-after'])
    if (Number.isFinite(retryAfter) && retryAfter > 0 && retryAfter <= 5) {
      await sleep(retryAfter * 1000)
    }
  }
  throw lastError
}

/**
 * OpenAlex 的免费 Key（可选）。
 *
 * 匿名调用按出口 IP 共享一份很小的日额度，多跑几组检索就会 429；填了 Key 提到
 * 每天 $1。每次现读钥匙串而不是缓存：用户在设置里刚填完就该立刻生效，
 * 一次宿主调用比一次 HTTP 便宜得多。
 */
async function openAlexKey() {
  try {
    const value = await ctx.secret('openalex')
    return typeof value === 'string' && value.trim() ? value.trim() : null
  } catch {
    // 清单没声明 secrets 能力、或钥匙串不可用：都按匿名额度走，不要把检索整个拦下
    return null
  }
}

async function openAlexJson(url) {
  const key = await openAlexKey()
  const target = key ? url + (url.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(key) : url
  try {
    return await getJson(target)
  } catch (error) {
    const message = String((error && error.message) || error)
    if (!key && /429|限流/.test(message)) {
      throw new Error(message + '；匿名额度按出口 IP 共享，设置 → 密钥 里填一个 OpenAlex Key 可提高日额度')
    }
    throw error
  }
}

/** MinerU 的提交是 POST；同样走域名排队，但只试一次：用户能看见失败并手动重试 */
async function postJson(url, payload) {
  return hostSlot(url, async () => {
    const res = await ctx.fetch({
      url,
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': SOURCES_UA },
      body: JSON.stringify(payload),
    })
    if (res.status < 200 || res.status >= 300) throw new Error(serviceError(res.status, res))
    try {
      return JSON.parse(str(res.body) || '{}')
    } catch {
      throw new Error('服务返回的不是 JSON')
    }
  })
}

/** 全文是 markdown 文本，不是 JSON；同样只读白名单里的域名 */
async function getText(url) {
  return hostSlot(url, async () => {
    const res = await ctx.fetch({
      url,
      headers: { accept: 'text/markdown, text/plain;q=0.9, */*;q=0.5', 'user-agent': SOURCES_UA },
    })
    if (res.status < 200 || res.status >= 300) throw new Error(serviceError(res.status, res))
    return str(res.body)
  })
}

/** 成功答复的短时缓存：补取失败的源、重跑同一组检索式都不再重复花额度 */
function cacheKey(id, query, per, opts) {
  const years = opts.years || {}
  return [id, query, per, opts.sort, years.from || '', years.to || ''].join('|')
}

async function searchItems(id, query, per, opts) {
  const key = cacheKey(id, query, per, opts)
  const hit = SEARCH_CACHE.get(key)
  if (hit && Date.now() - hit.at < SEARCH_CACHE_TTL) return hit.items
  const items = await SEARCHERS[id](query, per, opts)
  if (SEARCH_CACHE.size > 80) SEARCH_CACHE.clear()
  SEARCH_CACHE.set(key, { at: Date.now(), items })
  return items
}

function crossrefItem(item) {
  const title = Array.isArray(item.title) ? item.title[0] : item.title
  if (!title) return null
  const authors = (Array.isArray(item.author) ? item.author : [])
    .map((a) => [a.family, a.given].filter(Boolean).join(', ') || str(a.name))
    .filter(Boolean)
  const parts = item.issued && Array.isArray(item.issued['date-parts']) ? item.issued['date-parts'][0] : []
  const venue = Array.isArray(item['container-title']) ? item['container-title'][0] : item['container-title']
  return {
    source: 'crossref',
    sources: ['crossref'],
    title: String(title).replace(/\s+/g, ' ').trim(),
    authors,
    year: parts && parts[0] ? String(parts[0]) : '',
    venue: str(venue),
    doi: normDoi(item.DOI),
    arxivId: '',
    url: str(item.URL) || (item.DOI ? `https://doi.org/${normDoi(item.DOI)}` : ''),
    abstract: str(item.abstract).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMIT.note),
    citations: Number(item['is-referenced-by-count']) || 0,
  }
}

/** 面板传上来的源列表：认不出的丢掉；一个都不剩就退回默认勾选 */
function pickSources(raw) {
  const wanted = (Array.isArray(raw) ? raw : []).map((v) => str(v).toLowerCase())
  const list = [...new Set(wanted.filter((id) => SOURCE_IDS.includes(id)))]
  return list.length ? list : SOURCES.filter((s) => s.on).map((s) => s.id)
}

function pickSort(raw) {
  const value = str(raw)
  return SORTS.some(([id]) => id === value) ? value : 'relevance'
}

/** 年份框留空就是不加限；写成两位/乱填的不猜，直接不当筛选 */
function pickYears(from, to) {
  const clean = (v) => (/^\d{4}$/.test(str(v).trim()) ? Number(str(v).trim()) : 0)
  const a = clean(from)
  const b = clean(to)
  const years = [a, b].filter(Boolean)
  if (!years.length) return null
  return { from: a || Math.min(...years), to: b || 0 }
}

function yearOf(item) {
  return /^\d{4}$/.test(str(item.year)) ? Number(item.year) : 0
}

function inYears(item, years) {
  if (!years) return true
  const year = yearOf(item)
  if (!year) return true // 年份不明的留着：它可能正是漏掉的那篇
  if (years.from && year < years.from) return false
  if (years.to && year > years.to) return false
  return true
}

/** arXiv 的字段查询是词面匹配：去掉虚词、逐词做「题名或摘要」，比 all:整句 命中率高得多 */
function arxivTerms(query) {
  return query
    .replace(/[“”"]/g, ' ')
    .split(/\s+/)
    .map((v) => v.replace(/[^\p{L}\p{N}.\-]/gu, '').trim())
    .filter((v) => v.length > 1 && !STOP_WORDS.has(v.toLowerCase()))
    .slice(0, 6)
}

function arxivField(term) {
  return '(ti:"' + term + '" OR abs:"' + term + '")'
}

function arxivQuery(query, mode) {
  // 用户自己写了布尔表达式或字段前缀就原样交给 arXiv，不再替他改
  if (/\b(?:AND|OR|ANDNOT)\b/.test(query) || /(^|\s)(?:ti|abs|au|cat|all|co|jr|rn):/i.test(query)) return query
  const terms = arxivTerms(query)
  if (!terms.length) return 'all:' + query.replace(/\s+/g, ' ')
  return terms.map(arxivField).join(mode === 'any' ? ' OR ' : ' AND ')
}

async function arxivFetch(searchQuery, n, sortBy) {
  const url =
    'https://export.arxiv.org/api/query?search_query=' +
    encodeURIComponent(searchQuery) +
    `&start=0&max_results=${n}&sortBy=${sortBy}` +
    (sortBy === 'relevance' ? '' : '&sortOrder=descending')
  const res = await getJson(url)
  return parseArxivFeed(res.body)
}

async function arxivSearch(query, n, opts) {
  const sortBy = opts.sort === 'newest' ? 'submittedDate' : 'relevance'
  // 多个词全都要命中太苛刻：先按 AND 查，空了再放宽成 OR，别因为一个词把整组结果清零
  const tight = await arxivFetch(arxivQuery(query, 'all'), n, sortBy)
  if (tight.length || arxivTerms(query).length < 2) return tight
  return arxivFetch(arxivQuery(query, 'any'), n, sortBy)
}

async function crossrefSearch(query, n, opts) {
  const parts = [
    'query.bibliographic=' + encodeURIComponent(query),
    'rows=' + n,
    'select=title,author,issued,container-title,DOI,URL,abstract,is-referenced-by-count,type',
  ]
  if (opts.sort === 'newest') parts.push('sort=published', 'order=desc')
  if (opts.sort === 'cited') parts.push('sort=is-referenced-by-count', 'order=desc')
  const filters = []
  if (opts.years && opts.years.from) filters.push('from-pub-date:' + opts.years.from + '-01-01')
  if (opts.years && opts.years.to) filters.push('until-pub-date:' + opts.years.to + '-12-31')
  if (filters.length) parts.push('filter=' + filters.join(','))
  const res = await getJson('https://api.crossref.org/works?' + parts.join('&'))
  const items = JSON.parse(res.body).message.items || []
  return items.map(crossrefItem).filter(Boolean)
}

/** OpenAlex 的摘要是倒排索引，不还原就是一堆词袋 */
function openAlexAbstract(index) {
  if (!index || typeof index !== 'object') return ''
  const pairs = []
  for (const word of Object.keys(index)) {
    const positions = Array.isArray(index[word]) ? index[word] : []
    for (const pos of positions) pairs.push([Number(pos), word])
  }
  return pairs
    .sort((a, b) => a[0] - b[0])
    .map((pair) => pair[1])
    .join(' ')
    .slice(0, LIMIT.note)
}

function openAlexItem(work) {
  const w = work && typeof work === 'object' ? work : {}
  const id = str(w.id)
  const doi = normDoi(w.doi)
  const source = w.primary_location && w.primary_location.source
  const authors = (Array.isArray(w.authorships) ? w.authorships : [])
    .map((a) => oneLine(a && a.author && a.author.display_name, 120))
    .filter(Boolean)
  return {
    source: 'openalex',
    sources: ['openalex'],
    title: oneLine(w.display_name || w.title, LIMIT.title),
    authors,
    year: /^\d{4}$/.test(String(w.publication_year || '')) ? String(w.publication_year) : '',
    venue: oneLine(source && source.display_name, 200),
    doi,
    arxivId: '',
    url: doi ? `https://doi.org/${doi}` : id,
    abstract: oneLine(openAlexAbstract(w.abstract_inverted_index), LIMIT.note),
    citations: Number(w.cited_by_count) || 0,
    openalexId: id.replace(/^https?:\/\/openalex\.org\//, ''),
    type: str(w.type),
  }
}

/** OpenAlex 的字段：select 控制体积，少了 primary_location 就没法填来源 */
const OPENALEX_SELECT =
  'id,doi,display_name,publication_year,cited_by_count,primary_location,authorships,abstract_inverted_index,type'

async function openAlexSearch(query, n, opts) {
  const params = [
    'search=' + encodeURIComponent(query),
    'per-page=' + n,
    'select=' + OPENALEX_SELECT,
    'sort=' + (opts.sort === 'cited' ? 'cited_by_count:desc' : opts.sort === 'newest' ? 'publication_date:desc' : 'relevance_score:desc'),
  ]
  const filters = []
  if (opts.years && opts.years.from) filters.push('from_publication_date:' + opts.years.from + '-01-01')
  if (opts.years && opts.years.to) filters.push('to_publication_date:' + opts.years.to + '-12-31')
  if (filters.length) params.push('filter=' + filters.join(','))
  const res = await openAlexJson('https://api.openalex.org/works?' + params.join('&'))
  const list = (JSON.parse(res.body) || {}).results || []
  return list.map(openAlexItem).filter((item) => item.title)
}

/** Europe PMC 的摘要混着 JATS 标签，先把标签与实体剥掉再进笔记 */
function plainText(value) {
  return decodeXml(str(value))
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function europePmcSearch(query, n, opts) {
  const params = [
    'query=' + encodeURIComponent(query),
    'format=json',
    'pageSize=' + n,
    'resultType=core',
  ]
  if (opts.sort === 'newest') params.push('sort=P_PDATE_D desc')
  if (opts.sort === 'cited') params.push('sort=CITED desc')
  const res = await getJson('https://www.ebi.ac.uk/europepmc/webservices/rest/search?' + params.join('&'))
  const list = ((JSON.parse(res.body) || {}).resultList || {}).result || []
  return list
    .map((entry) => {
      const e = entry && typeof entry === 'object' ? entry : {}
      const journal = e.journalInfo && e.journalInfo.journal
      const doi = normDoi(e.doi)
      return {
        source: 'europepmc',
        sources: ['europepmc'],
        title: plainText(e.title).slice(0, LIMIT.title),
        authors: str(e.authorString)
          .split(/[,;]/)
          .map((v) => v.trim())
          .filter(Boolean),
        year: /^\d{4}$/.test(String(e.pubYear || '')) ? String(e.pubYear) : '',
        venue: oneLine((journal && journal.title) || e.journalTitle, 200),
        doi,
        arxivId: '',
        url: doi ? `https://doi.org/${doi}` : e.id ? `https://europepmc.org/article/${str(e.source) || 'MED'}/${e.id}` : '',
        abstract: plainText(e.abstractText).slice(0, LIMIT.note),
        citations: Number(e.citedByCount) || 0,
      }
    })
    .filter((item) => item.title)
}

const SEARCHERS = {
  arxiv: arxivSearch,
  crossref: crossrefSearch,
  openalex: openAlexSearch,
  europepmc: europePmcSearch,
}

/** 多源并行取回；哪个源出错就记在报告里，不连坐其它源 */
async function searchAll(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const query = cap(raw.query, 300)
  if (!query) throw new Error('搜索词不能为空')
  const limit = Math.min(Math.max(Number(raw.limit) || 8, 1), 20)
  const sources = pickSources(raw.sources)
  const sort = pickSort(raw.sort)
  const years = pickYears(raw.yearFrom, raw.yearTo)

  // 直接贴 DOI / arXiv 编号：走精确题录，别当关键词把整句丢给搜索引擎
  let direct = null
  let directError = ''
  if (!raw.noIdentifier) {
    try {
      direct = await lookupIdentifier(query)
    } catch (error) {
      directError = error.message
    }
  }
  if (direct) {
    const item = { ...direct, sources: ['identifier'], citations: Number(direct.citations) || 0 }
    return {
      results: [item],
      sources: [{ id: 'identifier', label: '编号定位', count: 1, error: '' }],
      identifier: true,
      sort,
      years,
    }
  }

  const { items: all, report } = await searchAcross(query, sources, limit, sort, years)

  if (!all.length) {
    const failed = report.filter((r) => r.error)
    if (failed.length === report.length) {
      throw new Error('这些源都没答复：' + failed.map((r) => r.label + '（' + r.error + '）').join('；'))
    }
    return { results: [], sources: report, identifier: false, sort, years, note: directError }
  }

  const merged = mergeResults(all).filter((item) => inYears(item, years))
  return { results: sortResults(merged, sort).slice(0, limit), sources: report, identifier: false, sort, years }
}

/** 一组检索式打到多个源；每个源的答复与错误各自记账，互不连坐 */
async function searchAcross(query, sources, limit, sort, years) {
  const per = Math.min(limit, 8)
  const runs = await Promise.all(
    sources.map((id) =>
      searchItems(id, query, per, { sort, years })
        .then((items) => ({ id, items, error: '' }))
        .catch((error) => ({ id, items: [], error: String((error && error.message) || error).slice(0, 200) })),
    ),
  )
  return {
    items: runs.flatMap((run) => run.items),
    report: runs.map((run) => ({
      id: run.id,
      label: (SOURCES.find((s) => s.id === run.id) || {}).label || run.id,
      count: run.items.length,
      error: run.error,
    })),
  }
}

/**
 * 只补没答复的那几路：拿原来那几组检索式再打一遍，成功的并进已有候选。
 * 面板用它实现「只补 Crossref」，不用把 arXiv 上已经勾好的结果推倒重来。
 */
async function retrySearch(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const queries = (Array.isArray(raw.queries) ? raw.queries : [])
    .map((q) => cap(q, 300))
    .filter(Boolean)
    .slice(0, 4)
  if (!queries.length) throw new Error('没有可补取的检索式')
  const wanted = (Array.isArray(raw.sources) ? raw.sources : []).map((v) => str(v).toLowerCase())
  const sources = [...new Set(wanted.filter((id) => SOURCE_IDS.includes(id)))]
  if (!sources.length) throw new Error('没有要补取的来源')
  const limit = Math.min(Math.max(Number(raw.limit) || 6, 1), 20)
  const sort = pickSort(raw.sort)
  const years = pickYears(raw.yearFrom, raw.yearTo)

  const errors = []
  const batches = await Promise.all(
    queries.map((query) =>
      searchAcross(query, sources, limit, sort, years).catch((error) => {
        errors.push(query + '：' + String((error && error.message) || error).slice(0, 200))
        return { items: [], report: [] }
      }),
    ),
  )
  const seen = new Set()
  const candidates = []
  for (const item of batches.flatMap((batch) => batch.items)) {
    const key = keyOf(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    candidates.push({ ...item, key })
    if (candidates.length >= 40) break
  }
  const report = new Map()
  for (const entry of batches.flatMap((batch) => batch.report)) {
    const hit = report.get(entry.id) || { id: entry.id, label: entry.label, count: 0, error: '' }
    hit.count += Number(entry.count) || 0
    if (entry.error && !hit.error) hit.error = entry.error
    report.set(entry.id, hit)
  }
  return { candidates, errors, sources: [...report.values()] }
}

function sortResults(list, sort) {
  if (sort === 'newest') {
    return list.slice().sort((a, b) => yearOf(b) - yearOf(a))
  }
  if (sort === 'cited') {
    return list.slice().sort((a, b) => (Number(b.citations) || 0) - (Number(a.citations) || 0))
  }
  return list
}

/** 同一篇在多个库里各有各的身份：取最先能对上的 DOI / arXiv / 题名，命中就合并 */
function mergeResults(list) {
  const out = []
  const seen = new Map()
  for (const item of list) {
    if (!item || !item.title) continue
    const keys = [
      item.doi ? 'doi:' + normDoi(item.doi) : '',
      item.arxivId ? 'ax:' + item.arxivId : '',
      't:' + normTitle(item.title),
    ].filter(Boolean)
    let hit = null
    for (const key of keys) {
      if (seen.has(key)) {
        hit = seen.get(key)
        break
      }
    }
    if (!hit) {
      const entry = Object.assign({}, item, {
        sources: Array.isArray(item.sources) && item.sources.length ? item.sources.slice() : [item.source].filter(Boolean),
        citations: Number(item.citations) || 0,
      })
      out.push(entry)
      for (const key of keys) seen.set(key, entry)
      continue
    }
    for (const id of item.sources || [item.source]) {
      if (id && hit.sources.indexOf(id) < 0) hit.sources.push(id)
    }
    // 后到的源补空位：Crossref 常有摘要而 arXiv 没有，反之亦然
    if (!hit.abstract && item.abstract) hit.abstract = item.abstract
    if (!hit.venue && item.venue) hit.venue = item.venue
    if (!hit.year && item.year) hit.year = item.year
    if (!hit.doi && item.doi) {
      hit.doi = normDoi(item.doi)
      seen.set('doi:' + hit.doi, hit)
    }
    if (!hit.arxivId && item.arxivId) {
      hit.arxivId = normArxiv(item.arxivId)
      seen.set('ax:' + hit.arxivId, hit)
    }
    if (!hit.url && item.url) hit.url = item.url
    hit.citations = Math.max(Number(hit.citations) || 0, Number(item.citations) || 0)
    if (String(item.title).length > String(hit.title).length) hit.title = item.title
  }
  return out
}

/** 用户可能直接贴 DOI 或 arXiv 编号：那就别当关键词搜 */
async function lookupIdentifier(raw) {
  const value = cap(raw, 300)
  if (!value) return null
  if (/^10\.\d{4,9}\/\S+$/i.test(value)) {
    const res = await getJson('https://api.crossref.org/works/' + encodeURIComponent(value))
    const paper = crossrefItem(JSON.parse(res.body).message)
    if (!paper) throw new Error('Crossref 没有返回这篇论文的元数据')
    return paper
  }
  if (/^\d{4}\.\d{4,5}(v\d+)?$/.test(value) || /^arxiv:/i.test(value)) {
    const id = normArxiv(value.replace(/^arxiv:/i, ''))
    const res = await getJson('https://export.arxiv.org/api/query?id_list=' + encodeURIComponent(id))
    const list = parseArxivFeed(res.body)
    if (!list.length) throw new Error(`arXiv 上找不到 ${id}`)
    return list[0]
  }
  return null
}

async function resolveMetadata(input) {
  const doi = normDoi(input.doi)
  const arxivId = normArxiv(input.arxivId)
  if (!doi && !arxivId) return null
  const found = await lookupIdentifier(doi ? doi : arxivId)
  return found
}

/* ------------------------------------------------------------------ *
 * 引文扩检：沿种子论文往前（它引用的）与往后（引用它的）各走一圈
 *
 * 关键词检索只能命中「用词一样」的工作；真正绕不开的基线常常换了说法，
 * 只能从引文网络里捞。这里统一走 OpenAlex：它按 DOI 有稳定的作品号，
 * 引文关系是结构化的，不像网页抓取那样时有时无。
 * ------------------------------------------------------------------ */

const SEED_SELECT = 'id,doi,display_name,publication_year,cited_by_count,referenced_works'

function openAlexShortId(value) {
  return str(value).replace(/^https?:\/\/openalex\.org\//, '')
}

async function openAlexSeed(seed) {
  const doi = normDoi(seed.doi)
  if (doi) {
    try {
      const res = await openAlexJson('https://api.openalex.org/works/doi:' + encodeURIComponent(doi) + '?select=' + SEED_SELECT)
      const work = JSON.parse(res.body)
      if (work && work.id) return work
    } catch (error) {
      // DOI 没登记在 OpenAlex 不算错：下面再用题名试一次
    }
  }
  let title = oneLine(seed.title, LIMIT.title)
  if (!title && normArxiv(seed.arxivId)) {
    const found = await lookupIdentifier('arxiv:' + normArxiv(seed.arxivId))
    title = oneLine(found && found.title, LIMIT.title)
  }
  if (!title) throw new Error('扩检需要 DOI、arXiv 编号或题名')
  const res = await openAlexJson('https://api.openalex.org/works?search=' + encodeURIComponent(title) + '&per-page=5&select=' + SEED_SELECT)
  const hits = (JSON.parse(res.body) || {}).results || []
  const want = normTitle(title)
  const hit =
    hits.find((w) => normTitle(w.display_name) === want) ||
    hits.find((w) => want.length > 20 && normTitle(w.display_name).indexOf(want) >= 0)
  if (!hit) throw new Error('OpenAlex 里没对上这篇：换成 DOI 或 arXiv 编号再试更稳')
  return hit
}

async function openAlexByIds(ids) {
  const list = ids
    .map((value) => openAlexShortId(value))
    .filter((value) => /^W\d+$/.test(value))
    .slice(0, 40)
  if (!list.length) return []
  const res = await openAlexJson(
    'https://api.openalex.org/works?filter=openalex_id:' +
      encodeURIComponent(list.join('|')) +
      '&per-page=' +
      list.length +
      '&select=' +
      OPENALEX_SELECT,
  )
  const byId = new Map()
  for (const work of (JSON.parse(res.body) || {}).results || []) {
    const item = openAlexItem(work)
    if (item.openalexId) byId.set(item.openalexId, item)
  }
  // 按引文表里的原始顺序还原；批量接口不保证顺序
  return list.map((id) => byId.get(id)).filter(Boolean)
}

async function snowball(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const seedInput = {
    doi: normDoi(raw.doi),
    arxivId: normArxiv(raw.arxivId),
    title: oneLine(raw.title, LIMIT.title),
  }
  if (!seedInput.doi && !seedInput.arxivId && !seedInput.title) {
    throw new Error('扩检要先有一篇种子论文：给它 DOI、arXiv 编号或题名')
  }
  const work = await openAlexSeed(seedInput)
  const seedId = openAlexShortId(work.id)
  const limit = Math.min(Math.max(Number(raw.limit) || 10, 1), 25)
  const refIds = (Array.isArray(work.referenced_works) ? work.referenced_works : []).slice(0, 40)

  const [refResult, citeResult] = await Promise.allSettled([
    openAlexByIds(refIds),
    openAlexJson(
      'https://api.openalex.org/works?filter=cites:' +
        encodeURIComponent(seedId) +
        '&per-page=' +
        limit +
        '&sort=publication_date:desc&select=' +
        OPENALEX_SELECT,
    ).then((res) => ((JSON.parse(res.body) || {}).results || []).map(openAlexItem).filter((item) => item.title)),
  ])
  const references = refResult.status === 'fulfilled' ? refResult.value : []
  const citing = citeResult.status === 'fulfilled' ? citeResult.value : []
  const errors = [refResult, citeResult]
    .filter((r) => r.status === 'rejected')
    .map((r) => String((r.reason && r.reason.message) || r.reason).slice(0, 160))
  if (!references.length && !citing.length && errors.length) {
    throw new Error('OpenAlex 没答复，引文扩检暂时走不通：' + errors.join('；'))
  }

  const seen = new Set()
  const stamp = (list, via) =>
    list
      .map((item) => Object.assign({}, item, { key: keyOf(item), via }))
      .filter((item) => {
        if (seen.has(item.key)) return false
        seen.add(item.key)
        return true
      })

  return {
    seed: {
      key: keyOf(Object.assign({ doi: work.doi, title: work.display_name })),
      openalexId: seedId,
      title: oneLine(work.display_name, LIMIT.title),
      year: /^\d{4}$/.test(String(work.publication_year || '')) ? String(work.publication_year) : '',
      citedByCount: Number(work.cited_by_count) || 0,
      doi: normDoi(work.doi),
    },
    references: stamp(
      references.slice().sort((a, b) => (Number(b.citations) || 0) - (Number(a.citations) || 0)).slice(0, limit),
      'reference',
    ),
    citing: stamp(citing.slice(0, limit), 'citing'),
    errors,
  }
}

/* ------------------------------------------------------------------ *
 * 论文
 * ------------------------------------------------------------------ */

async function addPaper(input) {
  const raw = input && typeof input === 'object' ? input : {}
  let meta = null
  const errors = []
  if (raw.doi || raw.arxivId) {
    try {
      meta = await resolveMetadata(raw)
    } catch (error) {
      errors.push(error.message)
    }
  }
  const merged = {
    title: cap(raw.title, LIMIT.title) || (meta ? meta.title : ''),
    authors: Array.isArray(raw.authors) && raw.authors.length ? raw.authors : meta ? meta.authors : [],
    year: str(raw.year) || (meta ? meta.year : ''),
    venue: str(raw.venue) || (meta ? meta.venue : ''),
    doi: normDoi(raw.doi) || (meta ? meta.doi : ''),
    arxivId: normArxiv(raw.arxivId) || (meta ? meta.arxivId : ''),
    url: str(raw.url) || (meta ? meta.url : ''),
    abstract: str(raw.abstract) || (meta ? meta.abstract : ''),
    impactFactor: raw.impactFactor,
    tags: raw.tags,
    status: raw.status,
  }
  if (!merged.title) {
    throw new Error(errors.length ? `抓元数据失败：${errors.join('；')}` : '需要标题，或者给出 DOI / arXiv 编号')
  }
  const duplicate = findDuplicate(merged)
  if (duplicate) return { duplicated: true, paper: duplicate }
  if (state.papers.length >= LIMIT.papers) throw new Error(`论文库最多 ${LIMIT.papers} 条，先清理一些`)
  const paper = normalizePaper({ ...merged, star: raw.star === true })
  state.papers.push(paper)
  await save()
  return { duplicated: false, paper }
}

async function updatePaper(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const paper = requirePaper(raw.paperId)
  if (raw.title !== undefined) {
    const title = cap(raw.title, LIMIT.title)
    if (!title) throw new Error('标题不能为空')
    paper.title = title
  }
  if (raw.authors !== undefined) paper.authors = (Array.isArray(raw.authors) ? raw.authors : []).map((a) => oneLine(a, 120)).filter(Boolean)
  if (raw.year !== undefined) paper.year = /^\d{4}$/.test(str(raw.year)) ? String(raw.year) : ''
  if (raw.venue !== undefined) paper.venue = oneLine(raw.venue, 200)
  if (raw.impactFactor !== undefined) paper.impactFactor = normImpact(raw.impactFactor)
  if (raw.url !== undefined) paper.url = oneLine(raw.url, 500)
  if (raw.abstract !== undefined) paper.abstract = cap(raw.abstract, LIMIT.note)
  if (raw.tags !== undefined) paper.tags = cleanTags(raw.tags)
  if (raw.status !== undefined) paper.status = cleanStatus(raw.status, PAPER_STATUS, paper.status)
  if (raw.star !== undefined) paper.star = raw.star === true
  if (raw.doi !== undefined) paper.doi = normDoi(raw.doi)
  const duplicate = findDuplicate(paper, paper.id)
  if (duplicate) throw new Error(`改完会和「${duplicate.title}」重复`)
  paper.updatedAt = Date.now()
  await save()
  return { paper }
}

async function removePaper(id) {
  const paper = requirePaper(id)
  state.papers = state.papers.filter((p) => p.id !== paper.id)
  for (const idea of state.ideas) idea.paperIds = idea.paperIds.filter((pid) => pid !== paper.id)
  // 全文是单独的大值：论文没了还留着，只会悄悄占满本机存储
  await ctx.storage.delete(fulltextKey(paper.id)).catch(() => undefined)
  await save()
  return { removed: paper.id }
}

function summarizePaper(paper) {
  return {
    id: paper.id,
    title: paper.title,
    authors: paper.authors,
    year: paper.year,
    venue: paper.venue,
    impactFactor: paper.impactFactor,
    doi: paper.doi,
    arxivId: paper.arxivId,
    url: paper.url,
    tags: paper.tags,
    status: paper.status,
    statusLabel: statusLabel(paper.status, PAPER_STATUS),
    star: paper.star,
    abstract: paper.abstract,
    reading: paper.reading,
    full: paper.full,
    /** 这篇能不能解析：界面据此决定是给「解析全文」还是提示补 arXiv 编号 */
    pdfUrl: pdfUrlFor(paper),
  }
}

function listPapers(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const status = raw.status ? cleanStatus(raw.status, PAPER_STATUS, '') : ''
  const tag = oneLine(raw.tag, LIMIT.tag)
  const q = normTitle(raw.query)
  const yearFrom = /^\d{4}$/.test(str(raw.yearFrom)) ? Number(raw.yearFrom) : 0
  const yearTo = /^\d{4}$/.test(str(raw.yearTo)) ? Number(raw.yearTo) : 0
  const venue = oneLine(raw.venue, 200).toLowerCase()
  const minImpact = Number(raw.minImpact) > 0 ? Number(raw.minImpact) : 0
  const items = state.papers
    .filter((p) => (!status || p.status === status) && (!tag || p.tags.includes(tag)))
    .filter((p) => !q || normTitle(p.title + ' ' + p.abstract + ' ' + p.tags.join(' ')).includes(q))
    .filter((p) => {
      const year = Number(p.year) || 0
      if (yearFrom && (!year || year < yearFrom)) return false
      if (yearTo && (!year || year > yearTo)) return false
      if (venue && !p.venue.toLowerCase().includes(venue)) return false
      if (minImpact && !(Number(p.impactFactor) >= minImpact)) return false
      return true
    })
    .sort((a, b) => Number(b.star) - Number(a.star) || b.updatedAt - a.updatedAt)
    .slice(0, Math.min(Number(raw.limit) || LIMIT.list, LIMIT.list))
  return { papers: items.map(summarizePaper), total: state.papers.length }
}

async function saveReading(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const paper = requirePaper(raw.paperId)
  for (const [key] of READING_SECTIONS) {
    if (raw[key] !== undefined) paper.reading[key] = cap(raw[key], LIMIT.note)
  }
  if (raw.question !== undefined) {
    const text = cap(raw.question, 1000)
    if (text) {
      if (paper.reading.questions.length >= LIMIT.questions) throw new Error(`追问最多 ${LIMIT.questions} 条`)
      paper.reading.questions.push({ id: uid('q'), text, at: Date.now() })
    }
  }
  if (raw.status !== undefined) paper.status = cleanStatus(raw.status, PAPER_STATUS, paper.status)
  paper.updatedAt = Date.now()
  await save()
  return { paper: summarizePaper(paper) }
}

/* ------------------------------------------------------------------ *
 * MinerU 全文
 *
 * 论文库只存元数据；全文是按需解析出来的证据层，单独一个存储键，删论文时一起删。
 * 提交、查询、下载拆成三步：解析要一两分钟，任何一步卡住都能单独重来，
 * 面板也不用等一次长 RPC。
 * ------------------------------------------------------------------ */

const mineru = createMineru({ postJson, getJson, getText })

function fulltextKey(id) {
  return 'ft:' + id
}

async function readFulltext(paper) {
  return str(await ctx.storage.get(fulltextKey(paper.id)))
}

async function fulltextStart(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const paper = requirePaper(raw.paperId)
  if (paper.full.state === 'done') throw new Error('这篇已经解析过全文了：要重来先清除全文')
  if (paper.full.state === 'queued' || paper.full.state === 'running') {
    return { paper: summarizePaper(paper), full: paper.full }
  }
  const given = oneLine(raw.url, 600)
  if (given && !/^https?:\/\//i.test(given)) throw new Error('全文地址必须是 http(s) 链接')
  const url = given || pdfUrlFor(paper)
  if (!url) {
    throw new Error('这篇没有公开 PDF 地址：补一个 arXiv 编号或 .pdf 链接后再解析；付费墙里的 PDF 解析不了')
  }
  paper.full = normalizeFull({ state: 'queued', url, at: Date.now(), note: '正在提交给 MinerU' })
  try {
    const taskId = await mineru.submit(url)
    paper.full.taskId = taskId
    paper.full.note = '已提交，MinerU 排队中'
  } catch (error) {
    // 提交失败留在本地：界面显示原因与原地址，用户改完地址能直接重试
    paper.full.state = 'failed'
    paper.full.note = cap(error && error.message ? error.message : error, 300)
  }
  paper.updatedAt = Date.now()
  await save()
  return { paper: summarizePaper(paper), full: paper.full }
}

async function fulltextPoll(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const paper = requirePaper(raw.paperId)
  const full = paper.full
  if (full.state !== 'queued' && full.state !== 'running') {
    return { paper: summarizePaper(paper), full }
  }
  if (!full.taskId) {
    full.state = 'failed'
    full.note = '任务号丢了：重新提交一次'
    await save()
    return { paper: summarizePaper(paper), full }
  }
  let got
  try {
    got = await mineru.status(full.taskId)
  } catch (error) {
    // 网络抖一下不等于任务死了：保留状态，下一轮再问；失败原因先写给用户看
    const reason = cap(error && error.message ? error.message : error, 260)
    full.tries += 1
    // 连续问不通（任务过期、接口改版）就别让界面一直转，留下原因让人重来
    if (full.tries >= 12) {
      full.state = 'failed'
      full.note = '查询连续失败 12 次：' + reason
    } else {
      full.note = cap('查询失败，稍后自动重试：' + reason, 300)
    }
    await save()
    return { paper: summarizePaper(paper), full, retry: full.state !== 'failed' }
  }
  full.tries = 0
  if (got.state === 'failed') {
    full.state = 'failed'
    full.note = got.note || 'MinerU 解析失败：常见原因是页数超过 20 页或文件超过 10MB'
  } else if (got.state === 'done') {
    try {
      const body = await mineru.download(got.markdownUrl)
      const stored = trimToBytes(cleanMarkdown(body), MINERU.maxBytes)
      await ctx.storage.set(fulltextKey(paper.id), stored.text)
      full.state = 'done'
      full.chars = stored.text.length
      full.trimmed = stored.trimmed
      full.note = stored.trimmed ? '已解析；超过本机单篇上限，尾部已截断' : ''
    } catch (error) {
      full.state = 'failed'
      full.note = cap('全文下载失败：' + (error && error.message ? error.message : error), 300)
    }
  } else {
    full.state = got.state
    full.note = got.state === 'running' ? 'MinerU 正在解析' : '排队中'
  }
  paper.updatedAt = Date.now()
  await save()
  return { paper: summarizePaper(paper), full }
}

async function fulltextGet(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const paper = requirePaper(raw.paperId)
  if (paper.full.state !== 'done') {
    return { paper: summarizePaper(paper), full: paper.full, text: '', chars: 0, truncated: false }
  }
  const body = await readFulltext(paper)
  const offset = Math.max(0, Number(raw.offset) || 0)
  const limit = Math.min(Math.max(Number(raw.limit) || LIMIT.fullPreview, 500), LIMIT.fullRead)
  return {
    paper: summarizePaper(paper),
    full: paper.full,
    text: body.slice(offset, offset + limit),
    chars: body.length,
    offset,
    truncated: offset + limit < body.length,
  }
}

async function fulltextClear(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const paper = requirePaper(raw.paperId)
  await ctx.storage.delete(fulltextKey(paper.id))
  paper.full = normalizeFull({})
  paper.updatedAt = Date.now()
  await save()
  return { paper: summarizePaper(paper), full: paper.full }
}

/**
 * 给精读步骤补上全文节选。
 *
 * 候选可能还没入库（没有本地 id），所以先按 DOI/arXiv/题名 key 回论文库里找；
 * 找不到就用摘要，绝不把别的论文的全文拼到它头上。
 */
async function attachFulltext(papers) {
  const list = Array.isArray(papers) ? papers : []
  if (!list.length) return list
  const per = Math.min(MINERU.excerpt, Math.max(6000, Math.floor(52000 / list.length)))
  const out = []
  for (const item of list) {
    const src = item && typeof item === 'object' ? item : {}
    const identity = oneLine(src.key, 400) || keyOf(src)
    const local = (src.id && findPaper(str(src.id))) || state.papers.find((p) => keyOf(p) === identity) || null
    if (!local || local.full.state !== 'done') {
      out.push(src)
      continue
    }
    const body = await readFulltext(local)
    if (!body) {
      out.push(src)
      continue
    }
    const letter = excerpt(body, per)
    out.push({ ...src, fulltext: letter, fullChars: body.length })
  }
  return out
}

/* ------------------------------------------------------------------ *
 * Idea 书柜
 * ------------------------------------------------------------------ */

function summarizeIdea(idea) {
  return {
    ...idea,
    statusLabel: statusLabel(idea.status, IDEA_STATUS),
    papers: idea.paperIds.map((id) => {
      const paper = findPaper(id)
      return { id, title: paper ? paper.title : id }
    }),
  }
}

async function addIdea(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const title = cap(raw.title, LIMIT.title)
  if (!title) throw new Error('Idea 标题不能为空')
  if (state.ideas.length >= LIMIT.ideas) throw new Error(`Idea 书柜最多 ${LIMIT.ideas} 条`)
  const paperIds = (Array.isArray(raw.paperIds) ? raw.paperIds : []).map((id) => str(id)).filter((id) => findPaper(id))
  const idea = normalizeIdea({ ...raw, title, paperIds })
  state.ideas.push(idea)
  await save()
  return { idea: summarizeIdea(idea) }
}

async function updateIdea(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const idea = findIdea(str(raw.ideaId))
  if (!idea) throw new Error('找不到这条 Idea')
  if (raw.title !== undefined) {
    const title = cap(raw.title, LIMIT.title)
    if (!title) throw new Error('Idea 标题不能为空')
    idea.title = title
  }
  if (raw.source !== undefined) idea.source = cap(raw.source, 1000)
  if (raw.innovation !== undefined) idea.innovation = cap(raw.innovation, LIMIT.note)
  if (raw.evidence !== undefined) idea.evidence = cap(raw.evidence, LIMIT.note)
  if (raw.status !== undefined) idea.status = cleanStatus(raw.status, IDEA_STATUS, idea.status)
  if (raw.paperIds !== undefined) {
    idea.paperIds = (Array.isArray(raw.paperIds) ? raw.paperIds : []).map((id) => str(id)).filter((id) => findPaper(id)).slice(0, LIMIT.linkedPapers)
  }
  idea.updatedAt = Date.now()
  await save()
  return { idea: summarizeIdea(idea) }
}

async function removeIdea(id) {
  const idea = findIdea(str(id))
  if (!idea) throw new Error('找不到这条 Idea')
  state.ideas = state.ideas.filter((i) => i.id !== idea.id)
  await save()
  return { removed: idea.id }
}

function listIdeas(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const status = raw.status ? cleanStatus(raw.status, IDEA_STATUS, '') : ''
  const items = state.ideas
    .filter((i) => !status || i.status === status)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, LIMIT.list)
  return { ideas: items.map(summarizeIdea), total: state.ideas.length }
}

function exportIdeasMarkdown() {
  const lines = [`# Idea 书柜（${new Date().toISOString().slice(0, 10)}）`, '']
  if (!state.ideas.length) lines.push('_还没有记录。_')
  for (const idea of state.ideas) {
    lines.push(`## ${idea.title}`, '')
    lines.push(`- 状态：${statusLabel(idea.status, IDEA_STATUS)}`)
    if (idea.source) lines.push(`- 来源：${idea.source.replace(/\n/g, ' ')}`)
    if (idea.innovation) lines.push(`- 创新点：${idea.innovation.replace(/\n/g, ' ')}`)
    if (idea.evidence) lines.push(`- 证据：${idea.evidence.replace(/\n/g, ' ')}`)
    const papers = idea.paperIds.map((id) => findPaper(id)).filter(Boolean)
    if (papers.length) {
      lines.push('- 关联论文：')
      for (const paper of papers) lines.push(`  - ${paper.title}${paper.year ? `（${paper.year}）` : ''}`)
    }
    lines.push('')
  }
  return lines.join('\n').trim() + '\n'
}

/* ------------------------------------------------------------------ *
 * 项目与会话
 *
 * 研究不是一次问答：一个项目下挂着若干会话，会话按顺序记下提问、检索、筛选、
 * 精读、对比与入库，文件抽屉放这一场产出的笔记与引用。
 * 会话只存摘要与结论，不存原文全文 —— 它是回忆，不是备份。
 * ------------------------------------------------------------------ */

const MESSAGE_KINDS = ['text', 'question', 'plan', 'gather', 'screen', 'notes', 'synth', 'ideas', 'accept', 'error']

function normalizeProject(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    id: str(src.id) || uid('prj'),
    title: oneLine(src.title, LIMIT.title),
    createdAt: Number(src.createdAt) || Date.now(),
    updatedAt: Number(src.updatedAt) || Date.now(),
  }
}

/** 会话数据只留能重建界面的部分；超限就退化成预览，别让一条消息撑爆存储 */
function clipData(raw) {
  if (raw == null) return null
  try {
    const text = JSON.stringify(raw)
    if (text.length <= LIMIT.messageData) return JSON.parse(text)
    return { truncated: true, preview: text.slice(0, 2000) }
  } catch (error) {
    return null
  }
}

function normalizeMessage(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    id: str(src.id) || uid('m'),
    role: src.role === 'user' ? 'user' : 'ai',
    kind: MESSAGE_KINDS.includes(str(src.kind)) ? str(src.kind) : 'text',
    text: cap(src.text, LIMIT.messageText),
    data: clipData(src.data),
    at: Number(src.at) || Date.now(),
  }
}

function normalizeFile(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  return {
    id: str(src.id) || uid('f'),
    name: oneLine(src.name, 120) || '未命名',
    kind: ['note', 'cite', 'export', 'pdf', 'text'].includes(str(src.kind)) ? str(src.kind) : 'text',
    text: cap(src.text, LIMIT.fileText),
    createdAt: Number(src.createdAt) || Date.now(),
  }
}

function normalizeSession(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const messages = (Array.isArray(src.messages) ? src.messages : []).map(normalizeMessage).slice(-LIMIT.messages)
  return {
    id: str(src.id) || uid('s'),
    projectId: str(src.projectId),
    title: oneLine(src.title, LIMIT.title) || firstQuestion(messages) || '新会话',
    question: cap(src.question, 2000),
    goal: oneLine(src.goal, 20) || '综述',
    messages,
    files: (Array.isArray(src.files) ? src.files : []).map(normalizeFile).slice(-LIMIT.files),
    createdAt: Number(src.createdAt) || Date.now(),
    updatedAt: Number(src.updatedAt) || Date.now(),
  }
}

function firstQuestion(messages) {
  const hit = messages.find((m) => m.kind === 'question' && m.text)
  return hit ? oneLine(hit.text, 60) : ''
}

function findSession(id) {
  return state.sessions.find((s) => s.id === str(id)) || null
}

function requireSession(id) {
  const session = findSession(id)
  if (!session) throw new Error('找不到这个会话：先新建一个')
  return session
}

function touchProject(projectId) {
  const project = state.projects.find((p) => p.id === projectId)
  if (project) project.updatedAt = Date.now()
}

function summarizeSession(session) {
  const last = session.messages[session.messages.length - 1]
  return {
    id: session.id,
    projectId: session.projectId,
    title: session.title,
    question: session.question,
    goal: session.goal,
    messages: session.messages.length,
    files: session.files.length,
    lastKind: last ? last.kind : '',
    lastText: last ? last.text.slice(0, 80) : '',
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  }
}

function summarizeProject(project) {
  const sessions = state.sessions.filter((s) => s.projectId === project.id)
  return {
    ...project,
    sessions: sessions.length,
    docs: state.docs.filter((d) => d.projectId === project.id).length,
    lastAt: sessions.reduce((max, s) => Math.max(max, s.updatedAt), project.updatedAt),
  }
}

function listProjects() {
  return {
    projects: state.projects.slice().sort((a, b) => b.updatedAt - a.updatedAt).map(summarizeProject),
    total: state.projects.length,
  }
}

async function createProject(input) {
  const title = cap(input.title, LIMIT.title)
  if (!title) throw new Error('项目名不能为空')
  if (state.projects.length >= LIMIT.projects) throw new Error(`项目最多 ${LIMIT.projects} 个，先清理一些`)
  if (state.projects.some((p) => p.title === title)) throw new Error(`已经有同名项目「${title}」`)
  const project = normalizeProject({ title })
  state.projects.push(project)
  await save()
  return { project: summarizeProject(project) }
}

async function updateProject(input) {
  const project = state.projects.find((p) => p.id === str(input.projectId))
  if (!project) throw new Error('找不到这个项目')
  if (input.title !== undefined) {
    const title = cap(input.title, LIMIT.title)
    if (!title) throw new Error('项目名不能为空')
    if (state.projects.some((p) => p.id !== project.id && p.title === title)) throw new Error(`已经有同名项目「${title}」`)
    project.title = title
  }
  project.updatedAt = Date.now()
  await save()
  return { project: summarizeProject(project) }
}

async function removeProject(id) {
  const project = state.projects.find((p) => p.id === str(id))
  if (!project) throw new Error('找不到这个项目')
  state.projects = state.projects.filter((p) => p.id !== project.id)
  let detached = 0
  for (const session of state.sessions) {
    if (session.projectId === project.id) {
      session.projectId = ''
      detached += 1
    }
  }
  for (const doc of state.docs) {
    if (doc.projectId === project.id) {
      doc.projectId = ''
      detached += 1
    }
  }
  await save()
  return { removed: project.id, detached }
}

function listSessions(input) {
  const projectId = typeof input.projectId === 'string' ? input.projectId : null
  const items = state.sessions
    .filter((s) => projectId === null || s.projectId === projectId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
  return { sessions: items.map(summarizeSession), total: state.sessions.length }
}

async function createSession(input) {
  if (state.sessions.length >= LIMIT.sessions) throw new Error(`会话最多 ${LIMIT.sessions} 个，先删除一些`)
  const projectId = str(input.projectId)
  if (projectId && !state.projects.some((p) => p.id === projectId)) throw new Error('项目不存在')
  const session = normalizeSession({
    projectId,
    title: str(input.title),
    question: str(input.question),
    goal: str(input.goal),
  })
  state.sessions.push(session)
  touchProject(projectId)
  await save()
  return { session }
}

async function getSession(input) {
  const session = requireSession(input.sessionId)
  return { session, project: state.projects.find((p) => p.id === session.projectId) || null }
}

async function updateSession(input) {
  const session = requireSession(input.sessionId)
  if (input.title !== undefined) {
    const title = oneLine(input.title, LIMIT.title)
    if (!title) throw new Error('会话标题不能为空')
    session.title = title
  }
  if (input.projectId !== undefined) {
    const projectId = str(input.projectId)
    if (projectId && !state.projects.some((p) => p.id === projectId)) throw new Error('项目不存在')
    session.projectId = projectId
  }
  if (input.question !== undefined) session.question = cap(input.question, 2000)
  if (input.goal !== undefined) session.goal = oneLine(input.goal, 20) || session.goal
  session.updatedAt = Date.now()
  touchProject(session.projectId)
  await save()
  return { session: summarizeSession(session) }
}

async function removeSession(id) {
  const session = requireSession(id)
  state.sessions = state.sessions.filter((s) => s.id !== session.id)
  touchProject(session.projectId)
  await save()
  return { removed: session.id }
}

async function appendMessage(input) {
  const session = requireSession(input.sessionId)
  const message = normalizeMessage({
    role: input.role,
    kind: input.kind,
    text: input.text,
    data: input.data,
  })
  session.messages.push(message)
  if (session.messages.length > LIMIT.messages) session.messages = session.messages.slice(-LIMIT.messages)
  if (message.kind === 'question' && message.text) {
    session.question = cap(message.text, 2000)
    const asked = session.messages.filter((m) => m.kind === 'question').length
    if (asked === 1) session.title = oneLine(message.text, 60)
  }
  session.updatedAt = Date.now()
  touchProject(session.projectId)
  await save()
  return { message, session: summarizeSession(session) }
}

async function attachFile(input) {
  const session = requireSession(input.sessionId)
  if (session.files.length >= LIMIT.files) throw new Error(`文件抽屉最多 ${LIMIT.files} 个文件，先删掉一些`)
  const text = cap(input.text, LIMIT.fileText)
  if (!text) throw new Error('文件内容不能为空')
  const file = normalizeFile(input)
  file.text = text
  session.files.push(file)
  session.updatedAt = Date.now()
  touchProject(session.projectId)
  await save()
  return { file, session: summarizeSession(session) }
}

async function removeFile(input) {
  const session = requireSession(input.sessionId)
  const id = str(input.fileId)
  const before = session.files.length
  session.files = session.files.filter((f) => f.id !== id)
  if (session.files.length === before) throw new Error('找不到这个文件')
  session.updatedAt = Date.now()
  await save()
  return { removed: id, session: summarizeSession(session) }
}

/* ------------------------------------------------------------------ *
 * 对比与引用
 * ------------------------------------------------------------------ */

function comparePapers(input) {
  const ids = (Array.isArray(input && input.paperIds) ? input.paperIds : []).map((id) => str(id))
  const papers = ids.map(requirePaper)
  if (papers.length < 2) throw new Error('至少选两篇论文才能对比')
  if (papers.length > 6) throw new Error('一次最多对比 6 篇')
  return {
    papers: papers.map((paper) => ({
      id: paper.id,
      title: paper.title,
      short: paper.authors.slice(0, 1).join('') + (paper.authors.length > 1 ? ' 等' : ''),
      year: paper.year,
      venue: paper.venue,
      status: statusLabel(paper.status, PAPER_STATUS),
      tags: paper.tags,
      sections: READING_SECTIONS.map(([key, label]) => ({ key, label, text: paper.reading[key] })),
      hasNotes: READING_SECTIONS.some(([key]) => paper.reading[key]),
    })),
  }
}

/* ---- 引用格式 ---- */

function splitName(raw) {
  const name = str(raw).trim()
  if (!name) return { family: '', given: '' }
  if (name.includes(',')) {
    const [family, given] = name.split(',')
    return { family: family.trim(), given: (given || '').trim() }
  }
  const parts = name.split(/\s+/)
  if (parts.length === 1) return { family: name, given: '' }
  return { family: parts[parts.length - 1], given: parts.slice(0, -1).join(' ') }
}

function initials(given, dots) {
  return given
    .split(/[\s.-]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + (dots ? '.' : ''))
    .join(' ')
}

function gbtAuthors(authors) {
  const list = authors.slice(0, 3).map((name) => {
    const { family, given } = splitName(name)
    if (!given) return family
    return `${family.toUpperCase()} ${initials(given, false)}`
  })
  if (authors.length > 3) return list.join(', ') + (authors.some(hasCjk) ? ', 等' : ', et al')
  return list.join(', ')
}

function apaAuthors(authors) {
  const one = (name) => {
    const { family, given } = splitName(name)
    return given ? `${family}, ${initials(given, true)}` : family
  }
  if (!authors.length) return ''
  if (authors.length === 1) return one(authors[0])
  if (authors.length <= 20) {
    return authors.slice(0, -1).map(one).join(', ') + ', & ' + one(authors[authors.length - 1])
  }
  return authors.slice(0, 19).map(one).join(', ') + ', … ' + one(authors[authors.length - 1])
}

function bibAuthors(authors) {
  return authors
    .map((name) => {
      const { family, given } = splitName(name)
      return given ? `${family}, ${given}` : family
    })
    .join(' and ')
}

/** BibTeX 的字段用花括号包裹：内容里再出现花括号会把条目截断 */
function bibText(value) {
  return str(value).replace(/[{}]/g, '')
}

function bibKey(paper) {
  if (paper.doi) return paper.doi.replace(/[^A-Za-z0-9]/g, '')
  if (paper.arxivId) return 'arxiv' + paper.arxivId.replace(/[^A-Za-z0-9]/g, '')
  const first = splitName(paper.authors[0] || 'anon').family.replace(/[^A-Za-z0-9]/g, '').toLowerCase() || 'anon'
  return first + (paper.year || '') + normTitle(paper.title).slice(0, 12)
}

function citeOne(paper, style) {
  const authors = paper.authors
  const year = paper.year
  const doi = paper.doi
  if (style === 'bibtex') {
    const fields = []
    if (authors.length) fields.push(`  author = {${bibText(bibAuthors(authors))}}`)
    fields.push(`  title = {{${bibText(paper.title)}}}`)
    if (year) fields.push(`  year = {${year}}`)
    if (paper.arxivId) {
      fields.push(`  archivePrefix = {arXiv}`)
      fields.push(`  eprint = {${paper.arxivId}}`)
      if (paper.venue && paper.venue !== 'arXiv') fields.push(`  journal = {${bibText(paper.venue)}}`)
    } else if (paper.venue) {
      fields.push(`  journal = {${bibText(paper.venue)}}`)
    }
    if (doi) fields.push(`  doi = {${doi}}`)
    if (paper.url) fields.push(`  url = {${bibText(paper.url)}}`)
    const type = paper.arxivId || !paper.venue ? 'misc' : 'article'
    return `@${type}{${bibKey(paper)},\n${fields.join(',\n')}\n}`
  }
  if (style === 'apa') {
    const who = apaAuthors(authors) || paper.title
    const tail = paper.arxivId
      ? `arXiv. ${paper.url || 'https://arxiv.org/abs/' + paper.arxivId}`
      : doi
        ? `https://doi.org/${doi}`
        : paper.url
    return `${who} (${year || 'n.d.'}). ${paper.title}. ${paper.venue ? paper.venue + '. ' : ''}${tail || ''}`.replace(/\s+/g, ' ').trim()
  }
  // GB/T 7714-2015（简化：没有卷期页码时省略它们）
  const who = gbtAuthors(authors) || paper.title
  const type = paper.arxivId ? 'EB/OL' : paper.venue ? 'J' : 'Z'
  const where = paper.arxivId
    ? `arXiv:${paper.arxivId}${paper.url ? `, ${paper.url}` : ''}`
    : paper.venue || paper.url
  const parts = [`${who}. ${paper.title}[${type}]`]
  if (where) parts.push(`${where}, ${year || 'n.d.'}`)
  else if (year) parts.push(year)
  let text = parts.join('. ') + '.'
  if (doi) text += ` DOI: ${doi}.`
  return text
}

const CITE_STYLES = ['gbt', 'apa', 'bibtex', 'ris', 'markdown', 'html']

function escapeHtml(value) {
  return str(value).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function risOne(paper) {
  const lines = ['TY  - ' + (paper.arxivId || !paper.venue ? 'GEN' : 'JOUR')]
  for (const name of paper.authors) {
    const { family, given } = splitName(name)
    lines.push('AU  - ' + (given ? family + ', ' + given : family))
  }
  lines.push('TI  - ' + paper.title)
  if (paper.year) lines.push('PY  - ' + paper.year)
  if (paper.venue) lines.push('JO  - ' + paper.venue)
  if (paper.doi) lines.push('DO  - ' + paper.doi)
  if (paper.arxivId) lines.push('AN  - arXiv:' + paper.arxivId)
  if (paper.url) lines.push('UR  - ' + paper.url)
  lines.push('ER  - ', '')
  return lines.join('\r\n')
}

function citePapers(input) {
  const ids = (Array.isArray(input && input.paperIds) ? input.paperIds : []).map((id) => str(id))
  const papers = ids.map(requirePaper)
  if (!papers.length) throw new Error('先选至少一篇论文')
  const style = CITE_STYLES.includes(str(input.style)) ? str(input.style) : 'gbt'
  return {
    style,
    items: papers.map((paper, index) => {
      if (style === 'ris') return { id: paper.id, title: paper.title, text: risOne(paper) }
      const base = citeOne(paper, style === 'markdown' || style === 'html' ? 'gbt' : style)
      const text = style === 'markdown' ? String(index + 1) + '. ' + base : style === 'html' ? '<li>' + escapeHtml(base) + '</li>' : base
      return { id: paper.id, title: paper.title, text }
    }),
  }
}

/* ------------------------------------------------------------------ *
 * 写作：项目文档与 [CITE:] 标注
 *
 * 正文只存标记，不存编号：[CITE:提示] 是待补引用，[CITE:#paperId] 是已定引用。
 * 编号在渲染与导出时按第一次出现的顺序计算，插入、替换都不会让别的编号错位。
 * 候选只来自本地论文库（题名/作者/年份/来源的字面重合），认不出就留空让用户挑，
 * 宁可空着也不自动编一条参考文献。
 * ------------------------------------------------------------------ */

const DOC_MARKER = /\[CITE:([^\]]{0,200})\]/g
const DOC_STYLES = ['gbt', 'apa', 'bibtex']

function normalizeDoc(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const history = (Array.isArray(src.history) ? src.history : [])
    .map((item) => ({
      id: str(item && item.id) || uid('h'),
      kind: ['create', 'annotate', 'export', 'edit'].includes(str(item && item.kind)) ? str(item && item.kind) : 'edit',
      text: oneLine(item && item.text, 200),
      at: Number(item && item.at) || Date.now(),
    }))
    .filter((item) => item.text)
    .slice(0, LIMIT.history)
  return {
    id: str(src.id) || uid('doc'),
    projectId: str(src.projectId),
    title: oneLine(src.title, LIMIT.docTitle) || '未命名文档',
    body: cap(src.body, LIMIT.docBody),
    style: DOC_STYLES.includes(str(src.style)) ? str(src.style) : 'gbt',
    history,
    createdAt: Number(src.createdAt) || Date.now(),
    updatedAt: Number(src.updatedAt) || Date.now(),
  }
}

function requireDoc(id) {
  const doc = state.docs.find((d) => d.id === str(id))
  if (!doc) throw new Error('找不到这份文档：先新建一份')
  return doc
}

function docHistory(doc, kind, text) {
  doc.history.unshift({ id: uid('h'), kind, text: oneLine(text, 200), at: Date.now() })
  doc.history = doc.history.slice(0, LIMIT.history)
}

/** 解析引用标记：payload 以 # 开头是已定的论文，否则是待补的提示 */
function docMarkers(body) {
  const text = str(body)
  const out = []
  DOC_MARKER.lastIndex = 0
  let match = DOC_MARKER.exec(text)
  while (match) {
    const payload = match[1]
    out.push({
      raw: match[0],
      hint: payload,
      paperId: payload.startsWith('#') ? payload.slice(1) : '',
      index: match.index,
    })
    match = DOC_MARKER.exec(text)
  }
  return out
}

function docCitations(doc) {
  const numbered = []
  const seen = new Map()
  const unresolved = []
  for (const marker of docMarkers(doc.body)) {
    if (!marker.paperId) {
      const hit = unresolved.find((item) => item.hint === marker.hint)
      if (hit) hit.count += 1
      else unresolved.push({ hint: marker.hint, count: 1 })
      continue
    }
    if (seen.has(marker.paperId)) continue
    const paper = findPaper(marker.paperId)
    numbered.push({
      paperId: marker.paperId,
      number: numbered.length + 1,
      missing: !paper,
      title: paper ? paper.title : marker.paperId,
    })
    seen.set(marker.paperId, numbered.length)
  }
  return { numbered, unresolved }
}

function summarizeDoc(doc, withBody) {
  const citations = docCitations(doc)
  return {
    id: doc.id,
    projectId: doc.projectId,
    title: doc.title,
    style: doc.style,
    chars: doc.body.length,
    cites: citations.numbered.length,
    pending: citations.unresolved.reduce((sum, item) => sum + item.count, 0),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    history: doc.history,
    ...(withBody ? { body: doc.body, citations } : {}),
  }
}

function listDocs(input) {
  const raw = input && typeof input === 'object' ? input : {}
  const projectId = typeof raw.projectId === 'string' ? raw.projectId : null
  const items = state.docs
    .filter((doc) => projectId === null || doc.projectId === projectId)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, Math.min(Number(raw.limit) || LIMIT.docs, LIMIT.docs))
  return { docs: items.map((doc) => summarizeDoc(doc, false)), total: state.docs.length }
}

async function createDoc(input) {
  if (state.docs.length >= LIMIT.docs) throw new Error('文档最多 ' + LIMIT.docs + ' 份，先删掉一些')
  const projectId = str(input.projectId)
  if (projectId && !state.projects.some((p) => p.id === projectId)) throw new Error('项目不存在')
  const doc = normalizeDoc({ projectId, title: input.title, body: input.body, style: input.style })
  docHistory(doc, 'create', '新建文档')
  state.docs.push(doc)
  touchProject(projectId)
  await save()
  return { doc: summarizeDoc(doc, true) }
}

async function updateDoc(input) {
  const doc = requireDoc(input.docId)
  if (input.title !== undefined) {
    const title = oneLine(input.title, LIMIT.docTitle)
    if (!title) throw new Error('标题不能为空')
    doc.title = title
  }
  if (input.body !== undefined) doc.body = cap(input.body, LIMIT.docBody)
  if (input.style !== undefined && DOC_STYLES.includes(str(input.style))) doc.style = str(input.style)
  if (input.projectId !== undefined) {
    const projectId = str(input.projectId)
    if (projectId && !state.projects.some((p) => p.id === projectId)) throw new Error('项目不存在')
    doc.projectId = projectId
  }
  doc.updatedAt = Date.now()
  touchProject(doc.projectId)
  await save()
  return { doc: summarizeDoc(doc, true) }
}

async function removeDoc(input) {
  const doc = requireDoc(input.docId)
  state.docs = state.docs.filter((d) => d.id !== doc.id)
  touchProject(doc.projectId)
  await save()
  return { removed: doc.id }
}

function getDoc(input) {
  return { doc: summarizeDoc(requireDoc(input.docId), true) }
}

function docCandidates(input) {
  const hint = oneLine(input && input.hint, 200)
  if (!hint) throw new Error('这个标记是空的：写成 [CITE:要引用什么]')
  const normHint = normTitle(hint)
  const tokens = hint
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => normTitle(token))
    .filter(Boolean)
  const items = []
  for (const paper of state.papers) {
    const title = normTitle(paper.title)
    const rest = normTitle([paper.authors.join(' '), paper.year, paper.venue, paper.tags.join(' ')].join(' '))
    let score = 0
    const why = []
    if (normHint && title.includes(normHint)) {
      score += 12
      why.push('题名命中')
    }
    let hits = 0
    for (const token of new Set(tokens)) {
      if (title.includes(token)) {
        score += 3
        hits += 1
      } else if (rest.includes(token)) score += 1
    }
    if (hits) why.push('题名对上 ' + hits + ' 个词')
    if (paper.year && hint.includes(paper.year)) {
      score += 2
      why.push('年份对上')
    }
    if (paper.impactFactor && hint.toLowerCase().includes(String(paper.impactFactor))) {
      score += 1
      why.push('影响因子对上')
    }
    if (score <= 0) continue
    items.push({ paper, score, why })
  }
  items.sort((a, b) => b.score - a.score || Number(b.paper.star) - Number(a.paper.star) || b.paper.updatedAt - a.paper.updatedAt)
  const limit = Math.min(Math.max(Number(input.limit) || 5, 1), 10)
  return {
    hint,
    items: items.slice(0, limit).map((item) => ({
      score: item.score,
      why: item.why.slice(0, 3).join(' · '),
      paper: summarizePaper(item.paper),
    })),
  }
}

async function annotateDoc(input) {
  const doc = requireDoc(input.docId)
  const hint = str(input.hint)
  const raw = '[CITE:' + hint + ']'
  const count = doc.body.split(raw).length - 1
  if (!count) throw new Error('正文里找不到这个标记：可能已经改过')
  const paperId = str(input.paperId)
  let replacement = ''
  const same = count > 1 ? '（同类 ' + count + ' 处）' : ''
  if (paperId) {
    const paper = requirePaper(paperId)
    replacement = '[CITE:#' + paper.id + ']'
    docHistory(doc, 'annotate', '「' + (hint.startsWith('#') ? hint.slice(1) : hint || '空标记') + '」→ ' + paper.title + same)
  } else {
    docHistory(doc, 'annotate', '删除标记「' + (hint.startsWith('#') ? hint.slice(1) : hint || '空标记') + '」' + same)
  }
  doc.body = doc.body.split(raw).join(replacement)
  doc.updatedAt = Date.now()
  touchProject(doc.projectId)
  await save()
  return { doc: summarizeDoc(doc, true) }
}

function docFileName(title, ext) {
  const stamp = new Date().toISOString().slice(0, 10)
  const base = oneLine(title, 80).replace(/[\\/:*?"<>|\r\n]/g, ' ').replace(/\s+/g, ' ').trim() || '未命名'
  return base + '-' + stamp + '.' + ext
}

/** 正文里的标记换成 [n]；缺号或论文已删的显示 [?]，unresolved 里另有提示 */
function renderDocBody(doc) {
  const citations = docCitations(doc)
  const numbers = new Map(citations.numbered.map((item) => [item.paperId, item.number]))
  const body = str(doc.body).replace(DOC_MARKER, (whole, payload) => {
    const hint = str(payload)
    if (!hint.startsWith('#')) return '[?]'
    const number = numbers.get(hint.slice(1))
    return number ? '[' + number + ']' : '[?]'
  })
  const refs = citations.numbered.map((item) => {
    const paper = findPaper(item.paperId)
    return {
      number: item.number,
      text: paper ? citeOne(paper, doc.style) : '（论文已删除：' + item.paperId + '）',
    }
  })
  return { body, refs, citations }
}

async function exportDoc(input) {
  const doc = requireDoc(input.docId)
  const format = ['markdown', 'html', 'bibtex', 'ris'].includes(str(input.format)) ? str(input.format) : 'markdown'
  const rendered = renderDocBody(doc, format === 'html')
  const papers = rendered.citations.numbered.map((item) => findPaper(item.paperId)).filter(Boolean)
  let text = ''
  let ext = 'md'
  if (format === 'markdown') {
    const refs = rendered.refs.map((ref) => ref.number + '. ' + ref.text).join('\n')
    text = '# ' + doc.title + '\n\n' + rendered.body + (refs ? '\n\n## 参考文献\n\n' + refs : '') + '\n'
  } else if (format === 'html') {
    const paragraphs = escapeHtml(rendered.body)
      .split(/\n{2,}/)
      .map((chunk) => {
        const heading = /^#{1,4}\s+/.exec(chunk)
        if (heading) return '<h2>' + chunk.replace(/^#{1,4}\s+/, '') + '</h2>'
        return '<p>' + chunk.replace(/\n/g, '<br>') + '</p>'
      })
      .join('\n')
    const refs = rendered.refs.map((ref) => '<li>' + escapeHtml(ref.text) + '</li>').join('\n')
    text =
      '<!doctype html>\n<html lang="zh-CN">\n<head>\n<meta charset="utf-8">\n<title>' +
      escapeHtml(doc.title) +
      '</title>\n</head>\n<body>\n<h1>' +
      escapeHtml(doc.title) +
      '</h1>\n' +
      paragraphs +
      (refs ? '\n<h2>参考文献</h2>\n<ol>\n' + refs + '\n</ol>' : '') +
      '\n</body>\n</html>\n'
    ext = 'html'
  } else if (format === 'bibtex') {
    text = papers.map((paper) => citeOne(paper, 'bibtex')).join('\n\n') + '\n'
    ext = 'bib'
  } else {
    text = papers.map(risOne).join('\r\n')
    ext = 'ris'
  }
  docHistory(doc, 'export', format + ' · ' + papers.length + ' 篇引用')
  await save()
  return { format, text, filename: docFileName(doc.title, ext) }
}

/* ------------------------------------------------------------------ *
 * AI 研究台
 *
 * 面板一步步调这里，而不是一次 RPC 跑完整条流水线：
 * 检索、筛选、精读各自可能失败，分开之后界面能指出断在哪一步并只重跑那一步；
 * 用户也能在「入库」之前看见每一篇的具体理由，而不是收到一包黑箱结果。
 * ------------------------------------------------------------------ */

let aiLastModel = ''
let scholarAi = null

function aiEngine() {
  if (!scholarAi) {
    scholarAi = createScholarAi({
      // 每次调用时才读选中的模型：用户在面板里换了模型，不用重启插件进程
      complete: (req) =>
        ctx.ai.complete(state.aiModelId ? Object.assign({}, req, { modelId: state.aiModelId }) : req),
      // 取回这一步要连逐源报告一起交给面板：用户得看见「哪个库没接话」
      search: (query, limit, opts) => searchAll(Object.assign({ query, limit }, opts || {})),
    })
  }
  return scholarAi
}

/** 面板的模型下拉：只列 API 条目，附「不指定时用谁」（宿主按助手的当前模型算） */
async function aiModelList() {
  if (!ctx || !ctx.ai || typeof ctx.ai.complete !== 'function') {
    return { supported: false, available: false, models: [], preferred: '', selected: state.aiModelId }
  }
  if (typeof ctx.ai.models !== 'function') {
    return { supported: false, available: true, models: [], preferred: '', selected: state.aiModelId }
  }
  const out = (await ctx.ai.models()) || {}
  const models = (Array.isArray(out.models) ? out.models : [])
    .map((m) => ({
      id: str(m && m.id),
      name: oneLine(m && m.name, 80) || str(m && m.id),
      model: str(m && m.model),
      enabled: !m || m.enabled !== false,
      hasKey: Boolean(m && m.hasKey),
    }))
    .filter((m) => m.id)
  // 挑过的模型被删、停用或丢了 Key 时退回跟随：留着一个死 id，每一步都会先报错
  if (state.aiModelId) {
    const hit = models.find((m) => m.id === state.aiModelId)
    if (!hit || !hit.enabled || !hit.hasKey) {
      state.aiModelId = ''
      await save()
    }
  }
  return {
    supported: true,
    available: true,
    models,
    preferred: str(out.preferred),
    selected: state.aiModelId,
  }
}

function requireAi() {
  if (!ctx || !ctx.ai || typeof ctx.ai.complete !== 'function') {
    throw new Error('这个 Torra 没有给插件 AI 通道：确认插件清单声明了 ai 能力，并升级到带 AI 的版本')
  }
}

function rememberModel(reply) {
  if (reply && typeof reply.model === 'string' && reply.model) aiLastModel = reply.model
  return reply
}

/** 把 AI 选出的 key 还原成完整候选；面板拿回来的数据可能被改过，这里以本地检索结果为准 */
function selectedCandidates(input) {
  const all = Array.isArray(input.candidates) ? input.candidates : []
  const wanted = new Set((Array.isArray(input.keys) ? input.keys : []).map((v) => str(v)))
  const picked = all.filter((item) => wanted.has(str(item.key)))
  if (!picked.length) throw new Error('没有勾选论文')
  if (picked.length > 12) throw new Error('一次最多入库 12 篇')
  return picked
}

/**
 * 入库并写精读笔记。
 *
 * 已存在的论文不覆盖人工笔记：只补空着的字段 —— AI 摘要顶掉用户自己读出来的结论，
 * 是最不该发生的「聪明的错误」。
 */
async function acceptAiPapers(input) {
  const papers = selectedCandidates(input)
  const notesByKey = new Map(
    (Array.isArray(input.notes) ? input.notes : []).map((note) => [str(note && note.key), note]),
  )
  const tag = oneLine(input.tag, LIMIT.tag) || 'AI 调研'
  const added = []
  const duplicated = []
  const saved = []
  let notesWritten = 0
  for (const item of papers) {
    const result = await addPaper({
      title: item.title,
      authors: item.authors,
      year: item.year,
      venue: item.venue,
      doi: item.doi,
      arxivId: item.arxivId,
      url: item.url,
      abstract: item.abstract,
      tags: [tag],
    })
    const paper = result.paper
    saved.push({ key: str(item.key), id: paper.id })
    if (result.duplicated) duplicated.push(paper.id)
    else added.push(paper.id)
    const note = notesByKey.get(str(item.key))
    if (!note) continue
    const patch = { paperId: paper.id }
    let changed = false
    for (const [key] of READING_SECTIONS) {
      if (!paper.reading[key] && str(note[key]).trim()) {
        patch[key] = note[key]
        changed = true
      }
    }
    if (changed) {
      await saveReading(patch)
      notesWritten += 1
    }
  }
  return { added, duplicated, saved, notesWritten, total: state.papers.length }
}

/* ------------------------------------------------------------------ *
 * 装配
 * ------------------------------------------------------------------ */

function tool(name, fn) {
  ctx.tools.handle(name, async (params) => {
    await load()
    return fn((params && typeof params === 'object' ? params : {}))
  })
}

function rpc(name, fn) {
  ctx.rpc.handle(name, async (params) => {
    await load()
    return fn((params && typeof params === 'object' ? params : {}))
  })
}

const TOOL_NAMES = [
  'scholar_search_papers',
  'scholar_snowball',
  'scholar_add_paper',
  'scholar_list_papers',
  'scholar_get_paper',
  'scholar_update_paper',
  'scholar_remove_paper',
  'scholar_save_reading',
  'scholar_parse_fulltext',
  'scholar_read_fulltext',
  'scholar_compare',
  'scholar_cite',
  'scholar_add_idea',
  'scholar_update_idea',
  'scholar_list_ideas',
  'scholar_export_ideas',
]

async function activate(context) {
  ctx = context
  await load()

  tool('scholar_search_papers', async (p) => {
    const out = await searchAll({
      query: p.query,
      limit: p.limit,
      sources: p.sources,
      sort: p.sort,
      yearFrom: p.yearFrom,
      yearTo: p.yearTo,
    })
    return out.results.map((r) => ({
      title: r.title,
      authors: r.authors.slice(0, 6),
      year: r.year,
      venue: r.venue,
      doi: r.doi,
      arxivId: r.arxivId,
      url: r.url,
      citations: r.citations,
      sources: r.sources,
    }))
  })

  tool('scholar_snowball', async (p) => {
    const out = await snowball(p)
    const brief = (item) => ({
      title: item.title,
      authors: item.authors.slice(0, 6),
      year: item.year,
      venue: item.venue,
      doi: item.doi,
      arxivId: item.arxivId,
      url: item.url,
      citations: item.citations,
    })
    return {
      seed: out.seed,
      references: out.references.map(brief),
      citing: out.citing.map(brief),
      errors: out.errors,
    }
  })

  tool('scholar_add_paper', (p) => addPaper(p))
  tool('scholar_list_papers', (p) => listPapers(p))
  tool('scholar_get_paper', (p) => ({ paper: summarizePaper(requirePaper(p.paperId)) }))
  tool('scholar_update_paper', (p) => updatePaper(p))
  tool('scholar_remove_paper', (p) => removePaper(p.paperId))
  tool('scholar_save_reading', (p) => saveReading(p))
  tool('scholar_parse_fulltext', async (p) => {
    const out = await fulltextStart(p)
    return {
      paperId: out.paper.id,
      title: out.paper.title,
      state: out.full.state,
      note: out.full.note || describeFull(out.full),
      hint:
        out.full.state === 'queued' || out.full.state === 'running'
          ? '解析要 1–3 分钟：稍后用 research_read_fulltext 取回；用户在精读页也能看到进度'
          : out.full.state === 'done'
            ? '已有全文，可以直接 research_read_fulltext'
            : '提交失败：核对它是公开可下载的 PDF，再重试',
    }
  })
  tool('scholar_read_fulltext', async (p) => {
    const raw = p && typeof p === 'object' ? p : {}
    const out = await fulltextGet({ paperId: raw.paperId, offset: raw.offset, limit: raw.limit || 18000 })
    return {
      paperId: out.paper.id,
      title: out.paper.title,
      state: out.full.state,
      note: describeFull(out.full),
      chars: out.chars,
      offset: out.offset || 0,
      text: out.text,
      truncated: out.truncated,
      hint:
        out.full.state === 'done'
          ? '引用全文里的数字时要区分「全文」与「摘要」'
          : '还没有全文：先 research_parse_fulltext（只支持公开 PDF）',
    }
  })
  tool('scholar_compare', (p) => comparePapers(p))
  tool('scholar_cite', (p) => citePapers(p))
  tool('scholar_add_idea', (p) => addIdea(p))
  tool('scholar_update_idea', (p) => updateIdea(p))
  tool('scholar_list_ideas', (p) => listIdeas(p))
  tool('scholar_export_ideas', () => ({ markdown: exportIdeasMarkdown() }))

  rpc('meta', () => ({
    paperStatus: PAPER_STATUS,
    ideaStatus: IDEA_STATUS,
    counts: {
      papers: state.papers.length,
      ideas: state.ideas.length,
      reading: state.papers.filter((p) => p.status === 'reading' || READING_SECTIONS.some(([k]) => p.reading[k])).length,
      starred: state.papers.filter((p) => p.star).length,
      projects: state.projects.length,
      sessions: state.sessions.length,
      docs: state.docs.length,
      /* 按状态分桶，给侧栏筛选器用；上面的 reading 是「有笔记」，两者含义不同 */
      byStatus: {
        todo: state.papers.filter((p) => p.status === 'todo').length,
        reading: state.papers.filter((p) => p.status === 'reading').length,
        read: state.papers.filter((p) => p.status === 'read').length,
        parked: state.papers.filter((p) => p.status === 'parked').length,
      },
    },
    tags: [...new Set(state.papers.flatMap((p) => p.tags))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
    sources: SOURCES,
    sorts: SORTS,
  }))
  rpc('paper.list', (p) => listPapers(p))
  rpc('paper.get', (p) => ({ paper: summarizePaper(requirePaper(p.paperId)) }))
  rpc('paper.search', (p) => searchAll(p))
  rpc('paper.retry', (p) => retrySearch(p))
  rpc('paper.snowball', (p) => snowball(p))
  rpc('paper.add', (p) => addPaper(p))
  rpc('paper.update', (p) => updatePaper(p))
  rpc('paper.remove', (p) => removePaper(p.paperId))
  rpc('reading.save', (p) => saveReading(p))
  /* 全文：提交一次，面板轮询；get 只回预览，避免一屏塞进整篇论文 */
  rpc('fulltext.start', (p) => fulltextStart(p))
  rpc('fulltext.poll', (p) => fulltextPoll(p))
  rpc('fulltext.get', (p) => fulltextGet(p))
  rpc('fulltext.clear', (p) => fulltextClear(p))
  rpc('idea.list', (p) => listIdeas(p))
  rpc('idea.add', (p) => addIdea(p))
  rpc('idea.update', (p) => updateIdea(p))
  rpc('idea.remove', (p) => removeIdea(p.ideaId))
  rpc('compare', (p) => comparePapers(p))
  rpc('cite', (p) => citePapers(p))
  rpc('export.ideas', () => ({ markdown: exportIdeasMarkdown() }))

  /* 写作：项目文档 + [CITE:] 标注 */
  rpc('doc.list', (p) => listDocs(p))
  rpc('doc.create', (p) => createDoc(p))
  rpc('doc.get', (p) => getDoc(p))
  rpc('doc.update', (p) => updateDoc(p))
  rpc('doc.remove', (p) => removeDoc(p))
  rpc('doc.suggest', (p) => docCandidates(p))
  rpc('doc.annotate', (p) => annotateDoc(p))
  rpc('doc.citations', (p) => ({ citations: docCitations(requireDoc(p.docId)) }))
  rpc('doc.export', (p) => exportDoc(p))

  /* 项目 / 会话 / 文件：研究工作区的骨架 */
  rpc('project.list', () => listProjects())
  rpc('project.create', (p) => createProject(p))
  rpc('project.update', (p) => updateProject(p))
  rpc('project.remove', (p) => removeProject(p.projectId))
  rpc('session.list', (p) => listSessions(p))
  rpc('session.create', (p) => createSession(p))
  rpc('session.get', (p) => getSession(p))
  rpc('session.update', (p) => updateSession(p))
  rpc('session.remove', (p) => removeSession(p.sessionId))
  rpc('session.append', (p) => appendMessage(p))
  rpc('session.attach', (p) => attachFile(p))
  rpc('session.detach', (p) => removeFile(p))

  /* AI 研究台：面板逐步调，断在哪一步就重跑哪一步 */
  rpc('ai.status', () => ({
    available: Boolean(ctx.ai && typeof ctx.ai.complete === 'function'),
    model: aiLastModel,
    selected: state.aiModelId,
    canPick: Boolean(ctx.ai && typeof ctx.ai.models === 'function'),
  }))
  rpc('ai.models', () => aiModelList())
  rpc('ai.set-model', async (p) => {
    const wanted = oneLine(p && p.modelId, 120)
    if (wanted) {
      const list = await aiModelList()
      if (!list.supported) throw new Error('这个 Torra 还不能给插件列模型：先升级，或继续沿用默认模型')
      const hit = list.models.find((m) => m.id === wanted)
      if (!hit) throw new Error('模型「' + wanted + '」不在可用清单里，刷新后再试')
      if (!hit.enabled) throw new Error('模型「' + hit.name + '」已停用：先到设置里启用它')
      if (!hit.hasKey) throw new Error('模型「' + hit.name + '」还没有 API Key：先在设置里填写')
    }
    state.aiModelId = wanted
    await save()
    aiLastModel = ''
    return aiModelList()
  })
  rpc('ai.plan', async (p) => {
    requireAi()
    return rememberModel(await aiEngine().plan(p))
  })
  rpc('ai.gather', (p) => aiEngine().gather(p))
  rpc('ai.screen', async (p) => {
    requireAi()
    return rememberModel(await aiEngine().screen(p))
  })
  rpc('ai.notes', async (p) => {
    requireAi()
    const raw = p && typeof p === 'object' ? p : {}
    // 精读能读到全文时就不要只喂摘要：实验数字与局限大多只在正文里
    return rememberModel(await aiEngine().notes({ ...raw, papers: await attachFulltext(raw.papers) }))
  })
  rpc('ai.synthesize', async (p) => {
    requireAi()
    return rememberModel(await aiEngine().synthesize(p))
  })
  rpc('ai.ideas', async (p) => {
    requireAi()
    return rememberModel(await aiEngine().ideas(p))
  })
  rpc('ai.accept', (p) => acceptAiPapers(p))

  ctx.log('info', `学者工作台就绪：${TOOL_NAMES.length} 个工具，${state.papers.length} 篇论文，${state.ideas.length} 条 Idea，${state.sessions.length} 个会话`)
}

module.exports = { activate }
