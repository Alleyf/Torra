/**
 * 学者工作台：论文库 / 精读 / 多篇对比 / Idea 书柜 / 引用。
 *
 * 数据全在本机（宿主插件存储），联网只有一条路：ctx.fetch 走 host 的域名白名单。
 * 元数据来自 arXiv 与 Crossref，抓不到就明确报错 —— 不拿「猜出来的作者和年份」凑一条记录，
 * 那种记录以后会变成引用里最难看的部分。
 */

const { createScholarAi } = require('./ai')

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

let ctx = null
let state = { papers: [], ideas: [], projects: [], sessions: [], docs: [] }

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

async function getJson(url) {
  const res = await ctx.fetch({ url, headers: { accept: 'application/json, application/atom+xml' } })
  if (res.status < 200 || res.status >= 300) throw new Error(`元数据服务返回 ${res.status}`)
  return res
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
    title: String(title).replace(/\s+/g, ' ').trim(),
    authors,
    year: parts && parts[0] ? String(parts[0]) : '',
    venue: str(venue),
    doi: normDoi(item.DOI),
    arxivId: '',
    url: str(item.URL) || (item.DOI ? `https://doi.org/${normDoi(item.DOI)}` : ''),
    abstract: str(item.abstract).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMIT.note),
  }
}

async function searchSources(query, limit) {
  const q = cap(query, 300)
  if (!q) throw new Error('搜索词不能为空')
  const n = Math.min(Math.max(Number(limit) || 6, 1), 10)
  const errors = []
  const tasks = [
    (async () => {
      const url =
        'https://export.arxiv.org/api/query?search_query=all:' +
        encodeURIComponent(q) +
        `&start=0&max_results=${n}&sortBy=relevance`
      const res = await getJson(url)
      return parseArxivFeed(res.body)
    })(),
    (async () => {
      const url =
        'https://api.crossref.org/works?query.bibliographic=' +
        encodeURIComponent(q) +
        `&rows=${n}&select=title,author,issued,container-title,DOI,URL,abstract`
      const res = await getJson(url)
      const items = JSON.parse(res.body).message.items || []
      return items.map(crossrefItem).filter(Boolean)
    })(),
  ]
  const settled = await Promise.all(
    tasks.map((task) =>
      task.catch((error) => {
        errors.push(error.message)
        return []
      }),
    ),
  )
  if (!settled[0].length && !settled[1].length && errors.length) {
    throw new Error(`两个元数据源都没答复：${errors.join('；')}`)
  }
  return mergeResults(settled[0].concat(settled[1])).slice(0, n)
}

function mergeResults(list) {
  const out = []
  const seen = new Set()
  for (const item of list) {
    const keys = [item.doi ? 'doi:' + normDoi(item.doi) : '', item.arxivId ? 'ax:' + item.arxivId : '', 't:' + normTitle(item.title)]
    if (keys.some((k) => k && seen.has(k))) continue
    for (const k of keys) if (k) seen.add(k)
    out.push(item)
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
      complete: (req) => ctx.ai.complete(req),
      search: (query, limit) => searchSources(query, limit),
    })
  }
  return scholarAi
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
  'scholar_add_paper',
  'scholar_list_papers',
  'scholar_get_paper',
  'scholar_update_paper',
  'scholar_remove_paper',
  'scholar_save_reading',
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
    const results = await searchSources(p.query, p.limit)
    return results.map((r) => ({
      title: r.title,
      authors: r.authors.slice(0, 6),
      year: r.year,
      venue: r.venue,
      doi: r.doi,
      arxivId: r.arxivId,
      url: r.url,
      source: r.source,
    }))
  })

  tool('scholar_add_paper', (p) => addPaper(p))
  tool('scholar_list_papers', (p) => listPapers(p))
  tool('scholar_get_paper', (p) => ({ paper: summarizePaper(requirePaper(p.paperId)) }))
  tool('scholar_update_paper', (p) => updatePaper(p))
  tool('scholar_remove_paper', (p) => removePaper(p.paperId))
  tool('scholar_save_reading', (p) => saveReading(p))
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
    },
    tags: [...new Set(state.papers.flatMap((p) => p.tags))].sort((a, b) => a.localeCompare(b, 'zh-CN')),
  }))
  rpc('paper.list', (p) => listPapers(p))
  rpc('paper.get', (p) => ({ paper: summarizePaper(requirePaper(p.paperId)) }))
  rpc('paper.search', async (p) => ({ results: await searchSources(p.query, p.limit) }))
  rpc('paper.add', (p) => addPaper(p))
  rpc('paper.update', (p) => updatePaper(p))
  rpc('paper.remove', (p) => removePaper(p.paperId))
  rpc('reading.save', (p) => saveReading(p))
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
  }))
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
    return rememberModel(await aiEngine().notes(p))
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
