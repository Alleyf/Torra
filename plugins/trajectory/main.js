/**
 * 研究主线图 · 插件入口（CommonJS）。
 *
 * 存一份状态就够了：项目里节点、假设、台账都是小结构，拆成多个存储键只会让
 * 「加一个节点」变成两次写，中途失败就留下半截数据。
 *
 * 三条不变量：
 * 1. 节点依赖是有向无环图 —— 连线前先走一遍上游，能走回自己就拒绝；
 * 2. 假设的判定必须带证据节点或理由，界面不拦，但工具说明里写死；
 * 3. 每个写操作都返回**写完之后**的对象，助手不必再读一次才知道 id。
 */

'use strict'

const { randomUUID } = require('node:crypto')
const { createTrajectoryAi, keyOf } = require('./ai')

const STATE_KEY = 'state'
const KINDS = ['question', 'source', 'claim', 'experiment', 'decision', 'conclusion']
const NODE_STATUS = ['open', 'doing', 'done', 'dropped']
const HYPOTHESIS_STATUS = ['open', 'supported', 'refuted', 'dropped']
const STANCES = ['supports', 'refutes', 'neutral']
const LIMIT = {
  projects: 50,
  nodes: 500,
  hypotheses: 300,
  ledger: 500,
  title: 200,
  note: 8000,
  statement: 1000,
  sources: 24,
  sourceTitle: 400,
  evidenceCandidates: 20,
  abstract: 2000,
}

let ctx = null

function now() {
  return Date.now()
}

function newId(prefix) {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 10)}`
}

function text(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

function oneOf(value, allowed, fallback) {
  const v = text(value, 32)
  return allowed.includes(v) ? v : fallback
}

function fail(message) {
  throw new Error(message)
}

function emptyState() {
  return { projects: [] }
}

function normalizeSource(raw) {
  const src = raw && typeof raw === 'object' ? raw : {}
  const title = text(src.title, LIMIT.sourceTitle)
  if (!title) return null
  return {
    id: text(src.id, 64) || newId('s'),
    title,
    authors: (Array.isArray(src.authors) ? src.authors : [])
      .map((a) => text(a, 120))
      .filter(Boolean)
      .slice(0, 8),
    year: text(src.year, 8),
    venue: text(src.venue, 160),
    doi: text(src.doi, 300),
    arxivId: text(src.arxivId, 80),
    url: text(src.url, 500),
    stance: STANCES.includes(src.stance) ? src.stance : 'neutral',
    why: text(src.why, 300),
    addedAt: Number(src.addedAt) || now(),
  }
}

function normalizeSources(raw) {
  const out = []
  const seen = new Set()
  for (const item of Array.isArray(raw) ? raw : []) {
    const source = normalizeSource(item)
    if (!source) continue
    const key = keyOf(source)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(source)
  }
  return out.slice(-LIMIT.sources)
}

function normalize(raw) {
  const state = raw && typeof raw === 'object' && Array.isArray(raw.projects) ? raw : emptyState()
  for (const project of state.projects) {
    project.nodes = Array.isArray(project.nodes) ? project.nodes : []
    project.hypotheses = Array.isArray(project.hypotheses) ? project.hypotheses : []
    project.ledger = Array.isArray(project.ledger) ? project.ledger : []
    for (const node of project.nodes) {
      node.parents = Array.isArray(node.parents) ? node.parents.filter((id) => typeof id === 'string') : []
      if (!KINDS.includes(node.kind)) node.kind = 'claim'
      if (!NODE_STATUS.includes(node.status)) node.status = 'open'
    }
    for (const hypothesis of project.hypotheses) {
      hypothesis.evidence = Array.isArray(hypothesis.evidence) ? hypothesis.evidence.filter((id) => typeof id === 'string') : []
      hypothesis.sources = normalizeSources(hypothesis.sources)
      if (!HYPOTHESIS_STATUS.includes(hypothesis.status)) hypothesis.status = 'open'
    }
  }
  return state
}

/* ── 图运算 ── */

function nodeById(project, id) {
  const node = project.nodes.find((n) => n.id === id)
  if (!node) fail(`节点「${id}」不在项目里：先用 trajectory_overview 看一遍`)
  return node
}

/** start 沿 parents 能不能走到 target：能走通说明 start 下游于 target */
function dependsOn(byId, start, target, seen) {
  if (start === target) return true
  if (seen.has(start)) return false
  seen.add(start)
  const node = byId.get(start)
  if (!node) return false
  return node.parents.some((id) => dependsOn(byId, id, target, seen))
}

/** 节点深度 = 到最远根节点的边数；有环时按 0 处理，不让面板因为脏数据直接崩掉 */
function depths(nodes) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const memo = new Map()
  const visit = (id, stack) => {
    if (memo.has(id)) return memo.get(id)
    if (stack.has(id)) return 0
    const node = byId.get(id)
    if (!node) return 0
    stack.add(id)
    let depth = 0
    for (const parent of node.parents) depth = Math.max(depth, visit(parent, stack) + 1)
    stack.delete(id)
    memo.set(id, depth)
    return depth
  }
  for (const node of nodes) visit(node.id, new Set())
  return memo
}

function mainLine(project) {
  const depth = depths(project.nodes)
  return [...project.nodes]
    .sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0) || a.createdAt - b.createdAt)
    .map((node) => ({ ...node, depth: depth.get(node.id) ?? 0 }))
}

function snapshot(project) {
  return {
    project: {
      id: project.id,
      title: project.title,
      question: project.question,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    },
    nodes: mainLine(project),
    hypotheses: project.hypotheses,
    ledger: project.ledger.slice(-100).reverse(),
  }
}

/* ── 写入 ── */

function touch(project) {
  project.updatedAt = now()
}

function makeProject(state, input) {
  if (state.projects.length >= LIMIT.projects) fail(`项目数上限 ${LIMIT.projects}：先删掉不用的`)
  const title = text(input.title, LIMIT.title)
  if (!title) fail('项目标题不能为空')
  const project = {
    id: newId('p'),
    title,
    question: text(input.question, LIMIT.note),
    createdAt: now(),
    updatedAt: now(),
    nodes: [],
    hypotheses: [],
    ledger: [],
  }
  state.projects.push(project)
  return project
}

function projectById(state, id) {
  const project = state.projects.find((p) => p.id === id)
  if (!project) fail(`项目「${id}」不存在：先用 trajectory_overview 看一遍`)
  return project
}

function updateProject(project, patch) {
  if (patch.title !== undefined) {
    const title = text(patch.title, LIMIT.title)
    if (!title) fail('项目标题不能为空')
    project.title = title
  }
  if (patch.question !== undefined) project.question = text(patch.question, LIMIT.note)
  touch(project)
  return project
}

function addNode(project, input) {
  if (project.nodes.length >= LIMIT.nodes) fail(`节点数上限 ${LIMIT.nodes}`)
  const title = text(input.title, LIMIT.title)
  if (!title) fail('节点标题不能为空')
  const byId = new Map(project.nodes.map((n) => [n.id, n]))
  const parents = []
  for (const raw of Array.isArray(input.parents) ? input.parents : []) {
    const id = text(raw, 64)
    if (!id || !byId.has(id) || parents.includes(id)) continue
    parents.push(id)
  }
  const node = {
    id: newId('n'),
    title,
    kind: oneOf(input.kind, KINDS, 'claim'),
    note: text(input.note, LIMIT.note),
    status: oneOf(input.status, NODE_STATUS, 'open'),
    parents,
    createdAt: now(),
    updatedAt: now(),
  }
  project.nodes.push(node)
  touch(project)
  return { ...node, depth: mainLine(project).find((n) => n.id === node.id).depth }
}

function linkNodes(project, fromId, toId) {
  if (fromId === toId) fail('不能把节点连到它自己')
  const byId = new Map(project.nodes.map((n) => [n.id, n]))
  nodeById(project, fromId)
  const to = nodeById(project, toId)
  if (to.parents.includes(fromId)) return to
  // from 的上游里能走到 to，说明 from 已经依赖 to；再加 to→from 就成环
  if (dependsOn(byId, fromId, toId, new Set())) fail('这条连线会形成环：两个节点已在上游/下游关系里')
  to.parents.push(fromId)
  to.updatedAt = now()
  touch(project)
  return to
}

function unlinkNodes(project, fromId, toId) {
  const to = nodeById(project, toId)
  const index = to.parents.indexOf(fromId)
  if (index >= 0) to.parents.splice(index, 1)
  to.updatedAt = now()
  touch(project)
  return to
}

function updateNode(project, nodeId, patch) {
  const node = nodeById(project, nodeId)
  if (patch.title !== undefined) {
    const title = text(patch.title, LIMIT.title)
    if (!title) fail('节点标题不能为空')
    node.title = title
  }
  if (patch.note !== undefined) node.note = text(patch.note, LIMIT.note)
  if (patch.status !== undefined) {
    const status = oneOf(patch.status, NODE_STATUS, '')
    if (!status) fail(`状态只能是 ${NODE_STATUS.join(' / ')}`)
    node.status = status
  }
  node.updatedAt = now()
  touch(project)
  return node
}

function removeNode(project, nodeId) {
  const index = project.nodes.findIndex((n) => n.id === nodeId)
  if (index < 0) fail(`节点「${nodeId}」不在项目里`)
  project.nodes.splice(index, 1)
  for (const node of project.nodes) {
    const at = node.parents.indexOf(nodeId)
    if (at >= 0) node.parents.splice(at, 1)
  }
  for (const hypothesis of project.hypotheses) {
    const at = hypothesis.evidence.indexOf(nodeId)
    if (at >= 0) hypothesis.evidence.splice(at, 1)
  }
  touch(project)
}

function addHypothesis(project, input) {
  if (project.hypotheses.length >= LIMIT.hypotheses) fail(`假设数上限 ${LIMIT.hypotheses}`)
  const statement = text(input.statement, LIMIT.statement)
  if (!statement) fail('假设内容不能为空')
  const evidence = []
  if (input.evidenceNodeId !== undefined) {
    const id = text(input.evidenceNodeId, 64)
    if (id) {
      nodeById(project, id)
      evidence.push(id)
    }
  }
  const hypothesis = {
    id: newId('h'),
    statement,
    status: 'open',
    note: '',
    evidence,
    sources: [],
    createdAt: now(),
    updatedAt: now(),
  }
  project.hypotheses.push(hypothesis)
  touch(project)
  return hypothesis
}

function updateHypothesis(project, hypothesisId, patch) {
  const hypothesis = project.hypotheses.find((h) => h.id === hypothesisId)
  if (!hypothesis) fail(`假设「${hypothesisId}」不在项目里`)
  if (patch.status !== undefined) {
    const status = oneOf(patch.status, HYPOTHESIS_STATUS, '')
    if (!status) fail(`假设状态只能是 ${HYPOTHESIS_STATUS.join(' / ')}`)
    hypothesis.status = status
  }
  if (patch.note !== undefined) hypothesis.note = text(patch.note, LIMIT.note)
  if (patch.evidenceNodeId !== undefined) {
    const id = text(patch.evidenceNodeId, 64)
    if (id) {
      nodeById(project, id)
      if (!hypothesis.evidence.includes(id)) hypothesis.evidence.push(id)
    }
  }
  hypothesis.updatedAt = now()
  touch(project)
  return hypothesis
}

function attachSources(project, hypothesisId, input) {
  const hypothesis = project.hypotheses.find((h) => h.id === hypothesisId)
  if (!hypothesis) fail(`假设「${hypothesisId}」不在项目里`)
  if (!Array.isArray(hypothesis.sources)) hypothesis.sources = []
  const candidates = Array.isArray(input && input.candidates) ? input.candidates : []
  const picks = new Map(
    (Array.isArray(input && input.picks) ? input.picks : []).map((pick) => [text(pick && pick.key, 400), pick]),
  )
  const seen = new Set(hypothesis.sources.map((source) => keyOf(source)))
  const added = []
  let duplicated = 0
  for (const item of candidates) {
    if (hypothesis.sources.length >= LIMIT.sources) break
    const pick = picks.get(text(item && item.key, 400))
    if (!pick) continue
    const source = normalizeSource({ ...item, stance: pick.stance, why: pick.why })
    if (!source) continue
    const key = keyOf(source)
    if (seen.has(key)) {
      duplicated += 1
      continue
    }
    seen.add(key)
    hypothesis.sources.push(source)
    added.push(source)
  }
  hypothesis.updatedAt = now()
  touch(project)
  return { added, duplicated, sources: hypothesis.sources, total: hypothesis.sources.length }
}

function addLedger(project, input) {
  if (!Array.isArray(project.ledger)) project.ledger = []
  project.ledger.push({
    id: newId('l'),
    at: now(),
    text: text(input.text, LIMIT.note),
    result: text(input.result, LIMIT.note),
  })
  if (project.ledger.length > LIMIT.ledger) project.ledger.splice(0, project.ledger.length - LIMIT.ledger)
  touch(project)
  return project.ledger[project.ledger.length - 1]
}

/* ── AI 结果落库：先建节点，再补边（补边时才做环检测），最后登记假设 ── */

function acceptPlan(project, input) {
  const draft = input && typeof input.draft === 'object' ? input.draft : input
  const rawNodes = (Array.isArray(draft && draft.nodes) ? draft.nodes : []).slice(0, 16)
  const rawHyps = (Array.isArray(draft && draft.hypotheses) ? draft.hypotheses : []).slice(0, 6)
  const warnings = []
  const byKey = new Map()
  const added = []
  for (const raw of rawNodes) {
    if (project.nodes.length >= LIMIT.nodes) {
      warnings.push(`节点数到上限 ${LIMIT.nodes}，后面的草案没有写入`)
      break
    }
    try {
      const node = addNode(project, {
        title: raw && raw.title,
        kind: raw && raw.kind,
        note: raw && raw.note,
      })
      byKey.set(text(raw && raw.key, 64), node.id)
      added.push({ key: text(raw && raw.key, 64), id: node.id, title: node.title, kind: node.kind })
    } catch (error) {
      warnings.push(String((error && error.message) || error))
    }
  }
  const existing = new Set(project.nodes.map((n) => n.id))
  let links = 0
  for (const raw of rawNodes) {
    const toId = byKey.get(text(raw && raw.key, 64))
    if (!toId) continue
    for (const pref of Array.isArray(raw && raw.parents) ? raw.parents : []) {
      const ref = text(pref, 64)
      const fromId = byKey.get(ref) || (existing.has(ref) ? ref : '')
      if (!fromId || fromId === toId) continue
      try {
        linkNodes(project, fromId, toId)
        links += 1
      } catch (error) {
        warnings.push(String((error && error.message) || error))
      }
    }
  }
  let hypotheses = 0
  for (const raw of rawHyps) {
    if (project.hypotheses.length >= LIMIT.hypotheses) {
      warnings.push(`假设数到上限 ${LIMIT.hypotheses}，后面的草案没有写入`)
      break
    }
    const evidence = []
    for (const pref of Array.isArray(raw && raw.evidence) ? raw.evidence : []) {
      const ref = text(pref, 64)
      const id = byKey.get(ref) || (existing.has(ref) ? ref : '')
      if (id && !evidence.includes(id)) evidence.push(id)
    }
    try {
      const hypothesis = addHypothesis(project, {
        statement: raw && raw.statement,
        ...(evidence[0] ? { evidenceNodeId: evidence[0] } : {}),
      })
      for (const extra of evidence.slice(1)) if (!hypothesis.evidence.includes(extra)) hypothesis.evidence.push(extra)
      hypotheses += 1
    } catch (error) {
      warnings.push(String((error && error.message) || error))
    }
  }
  if (!added.length && !hypotheses) fail(warnings[0] || '草案里没有可写入的节点')
  touch(project)
  return { added, links, hypotheses, warnings: warnings.slice(0, 8), project: snapshot(project) }
}

function acceptProposals(project, input) {
  const proposals = (Array.isArray(input && input.proposals) ? input.proposals : []).slice(0, 12)
  const applied = []
  const warnings = []
  for (const raw of proposals) {
    const type = text(raw && raw.type, 32)
    try {
      if (type === 'add_node') {
        const node = addNode(project, {
          title: raw.title,
          kind: raw.kind,
          note: raw.note,
          parents: raw.parents,
        })
        applied.push({ type, id: node.id, text: node.title })
      } else if (type === 'update_node') {
        const id = text(raw.nodeId, 64)
        nodeById(project, id)
        const patch = {}
        if (raw.status !== undefined) patch.status = raw.status
        if (raw.note !== undefined) patch.note = raw.note
        if (raw.title !== undefined) patch.title = raw.title
        if (!Object.keys(patch).length) fail('这条更新没有任何改动')
        const node = updateNode(project, id, patch)
        applied.push({ type, id, text: `${node.title} → ${node.status}` })
      } else if (type === 'add_hypothesis') {
        const hypothesis = addHypothesis(project, {
          statement: raw.statement,
          ...(text(raw.evidenceNodeId, 64) ? { evidenceNodeId: raw.evidenceNodeId } : {}),
        })
        if (text(raw.note, LIMIT.note)) hypothesis.note = text(raw.note, LIMIT.note)
        applied.push({ type, id: hypothesis.id, text: hypothesis.statement })
      } else if (type === 'update_hypothesis') {
        const hypothesis = project.hypotheses.find((h) => h.id === text(raw.hypothesisId, 64))
        if (!hypothesis) fail(`假设「${text(raw.hypothesisId, 64)}」不在项目里`)
        if (raw.status === undefined && raw.note === undefined) fail('这条判定没有任何改动')
        updateHypothesis(project, hypothesis.id, {
          ...(raw.status !== undefined ? { status: raw.status } : {}),
          ...(raw.note !== undefined ? { note: raw.note } : {}),
        })
        applied.push({ type, id: hypothesis.id, text: `${hypothesis.statement} → ${hypothesis.status}` })
      } else if (type === 'ledger') {
        const entry = addLedger(project, { text: raw.text, result: raw.result })
        applied.push({ type, id: entry.id, text: entry.text })
      } else {
        fail(`未知动作：${type || '空'}`)
      }
    } catch (error) {
      warnings.push(String((error && error.message) || error))
    }
  }
  touch(project)
  return { applied, warnings: warnings.slice(0, 8), project: snapshot(project) }
}

/* ── 证据检索：arXiv + Crossref，走宿主的 net 白名单 ── */

function normDoi(value) {
  return text(value, 300)
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
    .replace(/\s+/g, '')
}

function normArxiv(value) {
  return text(value, 160)
    .replace(/^https?:\/\/arxiv\.org\/(abs|pdf)\//, '')
    .replace(/\.pdf$/i, '')
    .replace(/v\d+$/, '')
}

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
      title: text(title, LIMIT.sourceTitle),
      authors,
      year: published.slice(0, 4),
      venue: 'arXiv',
      doi: normDoi(doi),
      arxivId,
      url: arxivId ? `https://arxiv.org/abs/${arxivId}` : link,
      abstract: xmlTag(block, 'summary').slice(0, LIMIT.abstract),
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
    .map((a) => [a.family, a.given].filter(Boolean).join(', ') || text(a.name, 120))
    .filter(Boolean)
  const parts = item.issued && Array.isArray(item.issued['date-parts']) ? item.issued['date-parts'][0] : []
  const venue = Array.isArray(item['container-title']) ? item['container-title'][0] : item['container-title']
  return {
    source: 'crossref',
    title: text(String(title).replace(/\s+/g, ' ').trim(), LIMIT.sourceTitle),
    authors,
    year: parts && parts[0] ? String(parts[0]) : '',
    venue: text(venue, 160),
    doi: normDoi(item.DOI),
    arxivId: '',
    url: text(item.URL, 500) || (item.DOI ? `https://doi.org/${normDoi(item.DOI)}` : ''),
    abstract: text(item.abstract, 8000).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, LIMIT.abstract),
  }
}

async function searchSources(query, limit) {
  const q = text(query, 300)
  if (!q) fail('搜索词不能为空')
  const n = Math.min(Math.max(Number(limit) || 6, 1), 10)
  const errors = []
  const tasks = [
    (async () => {
      const url =
        'https://export.arxiv.org/api/query?search_query=all:' +
        encodeURIComponent(q) +
        `&start=0&max_results=${n}&sortBy=relevance`
      return parseArxivFeed((await getJson(url)).body)
    })(),
    (async () => {
      const url =
        'https://api.crossref.org/works?query.bibliographic=' +
        encodeURIComponent(q) +
        `&rows=${n}&select=title,author,issued,container-title,DOI,URL,abstract`
      const items = JSON.parse((await getJson(url)).body).message.items || []
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
    fail(`两个元数据源都没答复：${errors.join('；')}`)
  }
  const seen = new Set()
  const out = []
  for (const item of settled[0].concat(settled[1])) {
    const key = keyOf(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out.slice(0, n)
}

async function searchEvidence(rawQueries, perQuery) {
  const queries = (Array.isArray(rawQueries) ? rawQueries : [])
    .map((q) => text(q, 160))
    .filter(Boolean)
    .slice(0, 3)
  if (!queries.length) fail('没有可用的检索式')
  const n = Math.min(Math.max(Number(perQuery) || 6, 3), 10)
  const errors = []
  const batches = await Promise.all(
    queries.map((query) =>
      searchSources(query, n).catch((error) => {
        errors.push(`${query}：${error.message}`)
        return []
      }),
    ),
  )
  const seen = new Set()
  const candidates = []
  for (const item of batches.flat()) {
    const key = keyOf(item)
    if (!key || seen.has(key)) continue
    seen.add(key)
    candidates.push({ ...item, key })
    if (candidates.length >= LIMIT.evidenceCandidates) break
  }
  if (!candidates.length) {
    fail('检索没有结果' + (errors.length ? `：${errors.join('；')}` : '：换一组更宽的关键词'))
  }
  return { candidates, errors: errors.slice(0, 4) }
}

/* ── AI 通道：面板一步步调，结果先在界面上预览 ── */

let aiLastModel = ''
let trajectoryAi = null

function aiEngine() {
  if (!trajectoryAi) {
    trajectoryAi = createTrajectoryAi({ complete: (req) => ctx.ai.complete(req) })
  }
  return trajectoryAi
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

/* ── 对外 ── */

module.exports = {
  async activate(context) {
    ctx = context
    let state = emptyState()
    let loaded = false

    async function load() {
      if (loaded) return state
      state = normalize(await ctx.storage.get(STATE_KEY))
      loaded = true
      return state
    }

    async function save() {
      await ctx.storage.set(STATE_KEY, state)
    }

    /** 所有写操作都走这里：先读、改、落盘、再返回快照，避免各处理器自己记顺序 */
    async function mutate(fn) {
      await load()
      const value = fn(state)
      await save()
      return value
    }

    async function read(fn) {
      await load()
      return fn(state)
    }

    ctx.rpc.handle('project.list', () =>
      read((s) => ({
        projects: s.projects.map((p) => ({
          id: p.id,
          title: p.title,
          question: p.question,
          nodeCount: p.nodes.length,
          openHypotheses: p.hypotheses.filter((h) => h.status === 'open').length,
          updatedAt: p.updatedAt,
        })),
      })),
    )

    ctx.rpc.handle('project.create', (params) => mutate((s) => snapshot(makeProject(s, params))))

    ctx.rpc.handle('project.update', (params) =>
      mutate((s) => snapshot(updateProject(projectById(s, text(params.projectId, 64)), params))),
    )

    ctx.rpc.handle('project.get', (params) =>
      read((s) => snapshot(projectById(s, text(params.projectId, 64)))),
    )

    ctx.rpc.handle('project.remove', (params) =>
      mutate((s) => {
        const id = text(params.projectId, 64)
        const index = s.projects.findIndex((p) => p.id === id)
        if (index < 0) fail(`项目「${id}」不存在`)
        s.projects.splice(index, 1)
        return { ok: true }
      }),
    )

    ctx.rpc.handle('node.add', (params) =>
      mutate((s) => addNode(projectById(s, text(params.projectId, 64)), params)),
    )

    ctx.rpc.handle('node.update', (params) =>
      mutate((s) => updateNode(projectById(s, text(params.projectId, 64)), text(params.nodeId, 64), params)),
    )

    ctx.rpc.handle('node.remove', (params) =>
      mutate((s) => {
        removeNode(projectById(s, text(params.projectId, 64)), text(params.nodeId, 64))
        return { ok: true }
      }),
    )

    ctx.rpc.handle('node.link', (params) =>
      mutate((s) => linkNodes(projectById(s, text(params.projectId, 64)), text(params.from, 64), text(params.to, 64))),
    )

    ctx.rpc.handle('node.unlink', (params) =>
      mutate((s) => unlinkNodes(projectById(s, text(params.projectId, 64)), text(params.from, 64), text(params.to, 64))),
    )

    ctx.rpc.handle('hypothesis.add', (params) =>
      mutate((s) => addHypothesis(projectById(s, text(params.projectId, 64)), params)),
    )

    ctx.rpc.handle('hypothesis.update', (params) =>
      mutate((s) =>
        updateHypothesis(projectById(s, text(params.projectId, 64)), text(params.hypothesisId, 64), params),
      ),
    )

    ctx.rpc.handle('ledger.add', (params) =>
      mutate((s) => addLedger(projectById(s, text(params.projectId, 64)), params)),
    )

    /* ── AI：读一遍项目、跑一步、把结果回给面板预览；只有 accept* 会写库 ── */

    const aiProject = (params) => projectById(state, text(params && params.projectId, 64))
    const aiHypothesis = (params) => {
      const project = aiProject(params)
      const id = text(params && params.hypothesisId, 64)
      const hypothesis = project.hypotheses.find((h) => h.id === id)
      if (!hypothesis) fail(`假设「${id}」不在项目里`)
      return { project, hypothesis }
    }

    ctx.rpc.handle('ai.status', () =>
      read(() => ({
        available: Boolean(ctx.ai && typeof ctx.ai.complete === 'function'),
        model: aiLastModel,
      })),
    )

    ctx.rpc.handle('ai.plan', (params) =>
      read(async () => {
        requireAi()
        const projectId = text(params && params.projectId, 64)
        return rememberModel(
          await aiEngine().plan({
            question: params && params.question,
            goal: params && params.goal,
            project: projectId ? snapshot(projectById(state, projectId)) : null,
          }),
        )
      }),
    )

    ctx.rpc.handle('ai.next', (params) =>
      read(async () => {
        requireAi()
        return rememberModel(
          await aiEngine().next({ project: snapshot(aiProject(params)), focus: params && params.focus }),
        )
      }),
    )

    ctx.rpc.handle('ai.critique', (params) =>
      read(async () => {
        requireAi()
        return rememberModel(await aiEngine().critique({ project: snapshot(aiProject(params)) }))
      }),
    )

    ctx.rpc.handle('ai.evidence.queries', (params) =>
      read(async () => {
        requireAi()
        const { project, hypothesis } = aiHypothesis(params)
        return rememberModel(
          await aiEngine().queries({
            statement: hypothesis.statement,
            note: hypothesis.note,
            question: project.question,
          }),
        )
      }),
    )

    ctx.rpc.handle('ai.evidence.search', (params) =>
      read(() => searchEvidence(params && params.queries, params && params.perQuery)),
    )

    ctx.rpc.handle('ai.evidence.screen', (params) =>
      read(async () => {
        requireAi()
        const { hypothesis } = aiHypothesis(params)
        return rememberModel(
          await aiEngine().screen({
            statement: hypothesis.statement,
            candidates: params && params.candidates,
          }),
        )
      }),
    )

    ctx.rpc.handle('ai.accept.plan', (params) =>
      mutate((s) => acceptPlan(projectById(s, text(params && params.projectId, 64)), params)),
    )

    ctx.rpc.handle('ai.accept.proposals', (params) =>
      mutate((s) => acceptProposals(projectById(s, text(params && params.projectId, 64)), params)),
    )

    ctx.rpc.handle('ai.accept.evidence', (params) =>
      mutate((s) => {
        const { project, hypothesis } = aiHypothesis(params)
        const result = attachSources(project, hypothesis.id, params)
        return { ...result, project: snapshot(project) }
      }),
    )

    /* ── 助手工具：参数校验与界面同源，只是返回更短 ── */

    ctx.tools.handle('trajectory_overview', (params) =>
      read((s) => {
        const projectId = text(params.projectId, 64)
        if (!projectId) {
          return {
            projects: s.projects.map((p) => ({
              id: p.id,
              title: p.title,
              nodes: p.nodes.length,
              openHypotheses: p.hypotheses.filter((h) => h.status === 'open').length,
              updatedAt: p.updatedAt,
            })),
          }
        }
        const view = snapshot(projectById(s, projectId))
        return {
          project: view.project,
          nodes: view.nodes.map((n) => ({
            id: n.id,
            title: n.title,
            kind: n.kind,
            status: n.status,
            depth: n.depth,
            parents: n.parents,
            ...(n.note ? { note: n.note.slice(0, 300) } : {}),
          })),
          hypotheses: view.hypotheses.map((h) => ({
            id: h.id,
            statement: h.statement,
            status: h.status,
            evidence: h.evidence,
            ...(h.sources && h.sources.length
              ? {
                  sources: h.sources.slice(0, 5).map((source) => ({
                    title: source.title,
                    stance: source.stance,
                    ...(source.year ? { year: source.year } : {}),
                    ...(source.url ? { url: source.url } : {}),
                  })),
                }
              : {}),
            ...(h.note ? { note: h.note.slice(0, 300) } : {}),
          })),
          lastLedger: view.ledger.slice(0, 5),
        }
      }),
    )

    ctx.tools.handle('trajectory_add_node', (params) =>
      mutate((s) => {
        const node = addNode(projectById(s, text(params.projectId, 64)), params)
        return { id: node.id, title: node.title, kind: node.kind, depth: node.depth, parents: node.parents }
      }),
    )

    ctx.tools.handle('trajectory_link_nodes', (params) =>
      mutate((s) => {
        const node = linkNodes(projectById(s, text(params.projectId, 64)), text(params.from, 64), text(params.to, 64))
        return { id: node.id, title: node.title, parents: node.parents }
      }),
    )

    ctx.tools.handle('trajectory_update_node', (params) =>
      mutate((s) => {
        const node = updateNode(projectById(s, text(params.projectId, 64)), text(params.nodeId, 64), params)
        return { id: node.id, title: node.title, status: node.status }
      }),
    )

    ctx.tools.handle('trajectory_add_hypothesis', (params) =>
      mutate((s) => {
        const h = addHypothesis(projectById(s, text(params.projectId, 64)), params)
        return { id: h.id, statement: h.statement, status: h.status, evidence: h.evidence }
      }),
    )

    ctx.tools.handle('trajectory_update_hypothesis', (params) =>
      mutate((s) => {
        const h = updateHypothesis(projectById(s, text(params.projectId, 64)), text(params.hypothesisId, 64), params)
        return { id: h.id, statement: h.statement, status: h.status, evidence: h.evidence }
      }),
    )

    ctx.tools.handle('trajectory_add_source', (params) =>
      mutate((s) => {
        const project = projectById(s, text(params.projectId, 64))
        const hypothesisId = text(params.hypothesisId, 64)
        const key = keyOf(params)
        const result = attachSources(project, hypothesisId, {
          candidates: [{ ...params, key }],
          picks: [{ key, stance: params.stance, why: params.why }],
        })
        return {
          hypothesisId,
          added: result.added.map((source) => source.title),
          total: result.total,
        }
      }),
    )

    ctx.tools.handle('trajectory_record_ledger', (params) =>
      mutate((s) => {
        const entry = addLedger(projectById(s, text(params.projectId, 64)), params)
        return { id: entry.id, at: entry.at, text: entry.text, result: entry.result }
      }),
    )

    ctx.log('info', `研究主线图已就绪，数据目录：${ctx.dataDir}`)
  },
}
