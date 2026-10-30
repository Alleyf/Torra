/**
 * 研究主线图的 AI 步骤。
 *
 * 和学者工作台守同一条红线：模型只负责判断与起草，图运算、检索、落盘都在插件进程里做。
 * 模型回来的每个节点、假设、id 都要对着输入验一遍，认不出的直接丢掉；
 * 结果先回面板预览，用户勾选后才动项目 —— AI 不直接改主线。
 */

const KINDS = ['question', 'source', 'claim', 'experiment', 'decision', 'conclusion']
const NODE_STATUS = ['open', 'doing', 'done', 'dropped']
const HYPOTHESIS_STATUS = ['open', 'supported', 'refuted', 'dropped']
const STANCES = ['supports', 'refutes', 'neutral']

const LIMIT = {
  question: 800,
  goal: 60,
  contextNote: 320,
  nodes: 12,
  nodeTitle: 200,
  nodeNote: 2000,
  hypotheses: 4,
  statement: 500,
  summary: 1600,
  proposals: 8,
  why: 240,
  issues: 8,
  topic: 40,
  detail: 500,
  queries: 3,
  query: 160,
  candidates: 20,
  abstract: 1200,
  screen: 8,
}

const SYSTEM = {
  plan: '你是研究规划助手。你把研究问题拆成一条有依赖关系、能回溯的主线；只做规划，不编造文献、数字或实验结论。输出严格 JSON。',
  next: '你是研究推进助手。你只依据给定的主线判断下一步该做什么，动作必须能直接落成一次明确修改。输出严格 JSON。',
  critique: '你是研究评审。你只依据给定的节点、假设与台账指出问题，不引入外部文献当作已证实的证据。输出严格 JSON。',
  queries: '你是学术检索助手。你把假设转成可用于 arXiv / Crossref 的关键词串，不编造论文。输出严格 JSON。',
  screen: '你是证据筛选助手。你只能依据给定的题名与摘要判断证据立场；摘要里没有的信息不要补。输出严格 JSON。',
}

function str(value) {
  return typeof value === 'string' ? value : ''
}

function cap(value, max) {
  return str(value).replace(/\r\n/g, '\n').trim().slice(0, max)
}

function oneLine(value, max) {
  return cap(value, max).replace(/\s+/g, ' ')
}

function list(value) {
  return Array.isArray(value) ? value : []
}

function textList(value, max, itemMax) {
  return list(value)
    .map((v) => oneLine(v, itemMax))
    .filter(Boolean)
    .slice(0, max)
}

/** 从模型回复里抠出 JSON：先剥围栏，再取第一个括号到最后一个闭括号 */
function jsonFromText(raw) {
  const source = String(raw == null ? '' : raw).trim()
  if (!source) throw new Error('模型返回了空内容')
  const body = source.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  const start = body.search(/[[{]/)
  if (start < 0) throw new Error('模型回复里没有 JSON')
  const sliced = body.slice(start)
  const end = Math.max(sliced.lastIndexOf('}'), sliced.lastIndexOf(']'))
  if (end < 0) throw new Error('模型回复的 JSON 不完整')
  try {
    return JSON.parse(sliced.slice(0, end + 1))
  } catch (error) {
    throw new Error('模型没有按 JSON 作答：' + String((error && error.message) || error).slice(0, 120))
  }
}

/** 同一篇论文在不同库里可能只有 DOI / arXiv / 题名三种身份，取最先能对上的那个 */
function keyOf(item) {
  const doi = oneLine(item && item.doi, 300).toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, '')
  if (doi) return 'doi:' + doi
  const arxivId = oneLine(item && item.arxivId, 80).toLowerCase().replace(/^arxiv:/, '')
  if (arxivId) return 'ax:' + arxivId
  return 't:' + oneLine(item && item.title, 400).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

function kindOf(value) {
  return KINDS.includes(value) ? value : 'claim'
}

function nodeStatus(value) {
  return NODE_STATUS.includes(value) ? value : ''
}

function hypStatus(value) {
  return HYPOTHESIS_STATUS.includes(value) ? value : ''
}

function stanceOf(value) {
  return STANCES.includes(value) ? value : 'neutral'
}

function nodesOf(project) {
  return list(project && project.nodes)
}

function hypothesesOf(project) {
  return list(project && project.hypotheses)
}

function projectQuestion(project) {
  return oneLine(project && project.project && project.project.question, LIMIT.question)
}

/** 把项目压成模型能读完的摘要：note 截断、台账只给最近五条 */
function digest(project) {
  const nodes = nodesOf(project)
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const nodeLines = nodes.map((n) => {
    const parents = list(n.parents)
      .map((id) => (byId.get(id) ? byId.get(id).title : id))
      .filter(Boolean)
    return [
      `- ${n.id} [${kindOf(n.kind)}/${n.status || 'open'}] ${oneLine(n.title, LIMIT.nodeTitle)}`,
      parents.length ? `  上游：${parents.map((t) => oneLine(t, 60)).join('；')}` : '  上游：无',
      n.note ? `  说明：${oneLine(n.note, LIMIT.contextNote)}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  })
  const hypLines = hypothesesOf(project).map((h) => {
    const evidence = list(h.evidence)
    const sources = list(h.sources)
    return [
      `- ${h.id} (${h.status || 'open'}) ${oneLine(h.statement, LIMIT.statement)}`,
      evidence.length ? `  证据节点：${evidence.join(',')}` : '  证据节点：无',
      sources.length ? `  外部来源：${sources.length} 篇` : '',
      h.note ? `  说明：${oneLine(h.note, LIMIT.contextNote)}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  })
  const ledgerLines = list(project && project.ledger).slice(0, 5).map((e) => {
    return `- ${oneLine(e.text, 300)}${e.result ? ' → ' + oneLine(e.result, 200) : ''}`
  })
  return [
    nodes.length ? '节点：\n' + nodeLines.join('\n') : '节点：还没有',
    hypLines.length ? '假设：\n' + hypLines.join('\n') : '假设：还没有',
    ledgerLines.length ? '最近台账：\n' + ledgerLines.join('\n') : '台账：空',
  ].join('\n\n')
}

/** 本地就能看出来的结构问题：给评审喂事实，也直接回给面板当「体检结果」 */
function signals(project) {
  const nodes = nodesOf(project)
  const facts = []
  const orphans = nodes.filter((n) => kindOf(n.kind) !== 'question' && !list(n.parents).length)
  if (orphans.length) {
    facts.push({
      label: '没有上游的节点',
      count: orphans.length,
      items: orphans.slice(0, 4).map((n) => oneLine(n.title, 80)),
    })
  }
  const bare = hypothesesOf(project).filter(
    (h) => h.status === 'open' && !list(h.evidence).length && !list(h.sources).length,
  )
  if (bare.length) {
    facts.push({
      label: '没有任何证据的假设',
      count: bare.length,
      items: bare.slice(0, 4).map((h) => oneLine(h.statement, 80)),
    })
  }
  const stale = nodes.filter((n) => n.status === 'doing' && Date.now() - (Number(n.updatedAt) || 0) > 14 * 864e5)
  if (stale.length) {
    facts.push({
      label: '停在「进行中」超过两周',
      count: stale.length,
      items: stale.slice(0, 4).map((n) => oneLine(n.title, 80)),
    })
  }
  if (nodes.length && !nodes.some((n) => kindOf(n.kind) === 'conclusion')) {
    facts.push({ label: '还没有结论节点', count: 1, items: ['这条主线目前没有落点'] })
  }
  return facts
}

function createTrajectoryAi(deps) {
  const complete = deps.complete

  async function askJson(system, prompt, maxTokens) {
    const first = await complete({ system, prompt, maxTokens: maxTokens || 1600 })
    try {
      return { data: jsonFromText(first.text), model: first.model, usage: first.usage }
    } catch (error) {
      // 只给一次返工机会：有些模型习惯先写一句「好的」再给 JSON
      const second = await complete({
        system,
        prompt: prompt + '\n\n上一次回复无法解析（' + String(error.message || error) + '）。这次只输出 JSON，不要代码块，不要任何解释。',
        maxTokens: maxTokens || 1600,
      })
      return { data: jsonFromText(second.text), model: second.model, usage: second.usage }
    }
  }

  /** 1. 起草主线：节点只给本地 key，parents 可以指向新 key 或已有节点 id */
  async function plan(input) {
    const question = cap(input.question, LIMIT.question)
    if (!question) throw new Error('先写一句要研究的问题')
    const goal = oneLine(input.goal, LIMIT.goal) || '梳理主线'
    const project = input.project && typeof input.project === 'object' ? input.project : null
    const existing = nodesOf(project)
    const existingIds = new Set(existing.map((n) => str(n.id)))
    const prompt = [
      '研究问题：' + question,
      '规划目标：' + goal,
      projectQuestion(project) && projectQuestion(project) !== question ? '项目里记录的问题：' + projectQuestion(project) : '',
      existing.length ? '已有主线（不要重复；新节点可以挂在已有节点下，parents 直接写已有 id）：\n' + digest(project) : '项目还是空的。',
      '',
      '请设计一条能从问题走到结论的研究主线：',
      '1. 8–' + LIMIT.nodes + ' 个节点，按依赖顺序给出；第一个节点是 question（研究问题本身），最后通常是 conclusion 或 decision；',
      '2. kind 只能取 question / source / claim / experiment / decision / conclusion；',
      '3. 每个 title 一句话说清「做了什么 / 判断了什么」，不要写「开始调研」「阅读文献」这类空壳；note 写关键细节或预期证据，没有就留空；',
      '4. parents 是上游节点：本次新节点用英文字母数字组成的 key（如 a1、b2），已有节点用它的 id；不许成环；',
      '5. 另给 1–' + LIMIT.hypotheses + ' 条可证伪的假设，evidence 引用节点 key 或已有 id。',
      '输出 JSON：{"nodes":[{"key":"a1","title":"…","kind":"claim","note":"…","parents":[]}],"hypotheses":[{"statement":"…","note":"…","evidence":["a1"]}],"summary":"四五句话说明这条主线怎么推进、卡点可能在哪"}',
    ]
      .filter(Boolean)
      .join('\n')

    const out = await askJson(SYSTEM.plan, prompt, 2600)
    const data = out.data && typeof out.data === 'object' ? out.data : {}
    const nodes = []
    const keys = new Set()
    for (const raw of list(data.nodes).slice(0, LIMIT.nodes)) {
      const title = oneLine(raw && raw.title, LIMIT.nodeTitle)
      if (!title) continue
      let key = oneLine(raw.key, 40).replace(/\s+/g, '') || 'k' + (nodes.length + 1)
      if (keys.has(key)) key = key + '_' + (nodes.length + 1)
      keys.add(key)
      const parents = []
      for (const pref of list(raw.parents)) {
        const id = oneLine(pref, 64)
        if (!id || id === key || parents.includes(id)) continue
        if (keys.has(id) || existingIds.has(id)) parents.push(id)
      }
      nodes.push({ key, title, kind: kindOf(raw.kind), note: cap(raw.note, LIMIT.nodeNote), parents })
    }
    if (!nodes.length) throw new Error('模型没有给出可用的主线节点：换个说法或换一个模型再试')

    const hypotheses = []
    for (const raw of list(data.hypotheses).slice(0, LIMIT.hypotheses)) {
      const statement = oneLine(raw && raw.statement, LIMIT.statement)
      if (!statement) continue
      const evidence = []
      for (const ref of list(raw.evidence)) {
        const id = oneLine(ref, 64)
        if (!id || evidence.includes(id)) continue
        if (keys.has(id) || existingIds.has(id)) evidence.push(id)
      }
      hypotheses.push({ statement, note: cap(raw.note, LIMIT.nodeNote), evidence })
    }
    return {
      nodes,
      hypotheses,
      summary: cap(data.summary, LIMIT.summary),
      model: out.model,
    }
  }

  /** 2. 推演下一步：每条提案都对应一次能落库的修改，accept 时再验一遍 id */
  async function next(input) {
    const project = input.project && typeof input.project === 'object' ? input.project : null
    if (!project || !nodesOf(project).length) throw new Error('主线还是空的：先起草一条主线，或手动加几个节点')
    const focus = oneLine(input.focus, LIMIT.why)
    const nodeIds = new Set(nodesOf(project).map((n) => str(n.id)))
    const hypIds = new Set(hypothesesOf(project).map((h) => str(h.id)))
    const prompt = [
      '当前研究主线：',
      digest(project),
      focus ? '\n用户当前的关注点：' + focus : '',
      '',
      '请判断现在最值得做的 1–' + LIMIT.proposals + ' 个动作。每个动作必须能落成一次明确修改，并从上面原样引用 id：',
      '- add_node：新增节点（title 必填，kind 六选一，parents 用已有节点 id；不要重复已有节点）；',
      '- update_node：把某个节点推进状态（open/doing/done/dropped）、补 note 或改 title；',
      '- add_hypothesis：登记一条可证伪的假设（statement 必填）；',
      '- update_hypothesis：判定假设（supported/refuted/dropped/open），必须给 note 说明依据；',
      '- ledger：记一笔这一轮实际做了什么与结果（不要提前写没发生的结果）。',
      '每条给 why（一句话依据，引用具体的节点或假设）。没有依据的判定不要给。',
      '输出 JSON：{"proposals":[{"type":"add_node","why":"…","title":"…","kind":"claim","note":"…","parents":["n_…"]}],"summary":"两三句话说明这些动作把主线推进到哪里"}',
    ]
      .filter(Boolean)
      .join('\n')

    const out = await askJson(SYSTEM.next, prompt, 2000)
    const data = out.data && typeof out.data === 'object' ? out.data : {}
    const proposals = []
    for (const raw of list(data.proposals).slice(0, LIMIT.proposals)) {
      const type = oneLine(raw && raw.type, 32)
      const why = oneLine(raw.why, LIMIT.why)
      if (type === 'add_node') {
        const title = oneLine(raw.title, LIMIT.nodeTitle)
        if (!title) continue
        const parents = list(raw.parents)
          .map((v) => oneLine(v, 64))
          .filter((v, i, all) => nodeIds.has(v) && all.indexOf(v) === i)
          .slice(0, 4)
        proposals.push({
          type,
          why,
          title,
          kind: kindOf(raw.kind),
          note: cap(raw.note, LIMIT.nodeNote),
          parents,
        })
      } else if (type === 'update_node') {
        const nodeId = oneLine(raw.nodeId, 64)
        if (!nodeIds.has(nodeId)) continue
        const patch = {}
        const status = nodeStatus(raw.status)
        if (status) patch.status = status
        if (raw.note !== undefined) patch.note = cap(raw.note, LIMIT.nodeNote)
        if (raw.title !== undefined) patch.title = oneLine(raw.title, LIMIT.nodeTitle)
        if (!Object.keys(patch).length) continue
        if (patch.title === '') delete patch.title
        proposals.push({ type, why, nodeId, ...patch })
      } else if (type === 'add_hypothesis') {
        const statement = oneLine(raw.statement, LIMIT.statement)
        if (!statement) continue
        const evidenceNodeId = oneLine(raw.evidenceNodeId, 64)
        proposals.push({
          type,
          why,
          statement,
          note: cap(raw.note, LIMIT.nodeNote),
          ...(nodeIds.has(evidenceNodeId) ? { evidenceNodeId } : {}),
        })
      } else if (type === 'update_hypothesis') {
        const hypothesisId = oneLine(raw.hypothesisId, 64)
        if (!hypIds.has(hypothesisId)) continue
        const status = hypStatus(raw.status)
        const note = cap(raw.note, LIMIT.nodeNote)
        if (!status && !note) continue
        proposals.push({ type, why, hypothesisId, ...(status ? { status } : {}), ...(note ? { note } : {}) })
      } else if (type === 'ledger') {
        const text = cap(raw.text, LIMIT.nodeNote)
        if (!text) continue
        proposals.push({ type, why, text, result: cap(raw.result, LIMIT.nodeNote) })
      }
    }
    if (!proposals.length) throw new Error('模型没有给出可执行的动作：补充一点台账或换一个模型')
    return { proposals, summary: cap(data.summary, LIMIT.summary), model: out.model }
  }

  /** 3. 评审：结构信号由本地算，模型补语义判断；target 必须对得上真实 id */
  async function critique(input) {
    const project = input.project && typeof input.project === 'object' ? input.project : null
    if (!project || !nodesOf(project).length) throw new Error('主线还是空的：先起草一条主线')
    const facts = signals(project)
    const nodeIds = new Set(nodesOf(project).map((n) => str(n.id)))
    const hypIds = new Set(hypothesesOf(project).map((h) => str(h.id)))
    const factText = facts.length
      ? facts.map((f) => `- ${f.label}：${f.count} 处（${f.items.join('；')}）`).join('\n')
      : '- 没有发现明显的结构问题'
    const prompt = [
      '当前研究主线：',
      digest(project),
      '',
      '本地结构检查：',
      factText,
      '',
      '请评审这条主线。只依据上面的内容：',
      '1. severity 取 high / medium / low；target 填节点 id、假设 id，或空字符串（针对整体）；',
      '2. 重点看：判断缺少证据、假设长期 open、实验与结论接不上、节点太笼统无法执行、结论早于实验、台账证明停在原地；',
      '3. 每条给 topic（不超过 ' + LIMIT.topic + ' 字）、detail（一句话说清问题与影响）、suggestion（一句话、能直接执行）；',
      '4. 不要提出「再去查文献」这类没有对象的建议；最多 ' + LIMIT.issues + ' 条，按严重度排序。',
      '输出 JSON：{"issues":[{"severity":"high","target":"","topic":"…","detail":"…","suggestion":"…"}],"summary":"两三句话总评"}',
    ].join('\n')

    const out = await askJson(SYSTEM.critique, prompt, 2000)
    const data = out.data && typeof out.data === 'object' ? out.data : {}
    const rank = { high: 0, medium: 1, low: 2 }
    const issues = []
    for (const raw of list(data.issues)) {
      const topic = oneLine(raw && raw.topic, LIMIT.topic)
      const detail = oneLine(raw.detail, LIMIT.detail)
      if (!topic || !detail) continue
      const target = oneLine(raw.target, 64)
      issues.push({
        severity: ['high', 'medium', 'low'].includes(raw.severity) ? raw.severity : 'medium',
        target: nodeIds.has(target) || hypIds.has(target) ? target : '',
        topic,
        detail,
        suggestion: oneLine(raw.suggestion, LIMIT.detail),
      })
    }
    issues.sort((a, b) => rank[a.severity] - rank[b.severity])
    if (!issues.length) throw new Error('模型没有给出评审意见：换一个模型再试')
    return {
      issues: issues.slice(0, LIMIT.issues),
      facts,
      summary: cap(data.summary, LIMIT.summary),
      model: out.model,
    }
  }

  /** 4a. 找证据的第一步：把假设转成 2–3 组检索式 */
  async function queries(input) {
    const statement = cap(input.statement, LIMIT.statement)
    if (!statement) throw new Error('先选一条假设')
    const question = oneLine(input.question, LIMIT.question)
    const note = oneLine(input.note, LIMIT.contextNote)
    const prompt = [
      question ? '研究问题：' + question : '',
      '待验证的假设：' + statement,
      note ? '已有说明：' + note : '',
      '今天是 ' + new Date().getFullYear() + ' 年。',
      '',
      '请给出 2–' + LIMIT.queries + ' 组可用于 arXiv / Crossref 的检索式：',
      '1. 每组是一条关键词串，用空格连接，不要布尔运算符、引号或括号；',
      '2. 优先英文术语，覆盖同义词与相邻概念；不要三组只换一个词；',
      '3. note 用一句话说明你想找哪类证据（支持 / 反驳 / 基准测试）。',
      '输出 JSON：{"queries":["…"],"note":"…"}',
    ]
      .filter(Boolean)
      .join('\n')

    const out = await askJson(SYSTEM.queries, prompt, 700)
    const data = out.data && typeof out.data === 'object' ? out.data : {}
    let found = textList(data.queries, LIMIT.queries, LIMIT.query)
    if (!found.length) found = [oneLine(statement, LIMIT.query)]
    return { queries: found, note: oneLine(data.note, 300), model: out.model }
  }

  /** 4c. 找证据的第三步：只依据题名与摘要判断每一篇是支持还是反驳 */
  async function screen(input) {
    const statement = cap(input.statement, LIMIT.statement)
    if (!statement) throw new Error('缺少假设内容')
    const candidates = list(input.candidates).slice(0, LIMIT.candidates)
    if (!candidates.length) throw new Error('没有候选论文可判断')
    const known = new Set(candidates.map((item) => keyOf(item)))
    const prompt = [
      '待验证的假设：' + statement,
      '',
      '检索到的论文（只有题名与摘要）：',
      candidates
        .map((item, index) =>
          [
            '[' + index + '] id=' + keyOf(item),
            '题名：' + oneLine(item.title, 400),
            '年份：' + (oneLine(item.year, 8) || '未知') + '  来源：' + (oneLine(item.venue, 120) || '未知'),
            '摘要：' + (oneLine(item.abstract, LIMIT.abstract) || '无'),
          ].join('\n'),
        )
        .join('\n\n'),
      '',
      '请判断每篇论文对假设构成什么证据（最多 ' + LIMIT.screen + ' 篇）：',
      '- supports：摘要里的结果或结论支持这条假设；',
      '- refutes：结果与假设相反；',
      '- neutral：相关但摘要不足以判定支持或反驳。',
      '只依据摘要，不确定就给 neutral；id 必须原样照抄；why 不超过 60 字，点明依据。',
      '不要为了凑数把明显无关的论文判成 supports。',
      '输出 JSON：{"picks":[{"id":"…","stance":"supports|refutes|neutral","why":"…"}],"note":"一句话说明这批证据够不够"}',
    ].join('\n')

    const out = await askJson(SYSTEM.screen, prompt, 1600)
    const data = out.data && typeof out.data === 'object' ? out.data : {}
    const picks = []
    const seen = new Set()
    for (const raw of list(data.picks)) {
      const id = oneLine(raw && raw.id, 400)
      if (!known.has(id) || seen.has(id)) continue
      seen.add(id)
      picks.push({ key: id, stance: stanceOf(raw.stance), why: oneLine(raw.why, LIMIT.why) })
    }
    if (!picks.length) throw new Error('模型没有从候选里挑出任何证据：换一组检索式')
    return { picks: picks.slice(0, LIMIT.screen), note: oneLine(data.note, 300), model: out.model }
  }

  return { plan, next, critique, queries, screen }
}

module.exports = { createTrajectoryAi, jsonFromText, keyOf, signals, LIMIT }
