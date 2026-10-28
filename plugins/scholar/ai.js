/**
 * 学者工作台的 AI 步骤。
 *
 * 拆成「宿主一次补全 + 这里做提示词与校验」，是因为搜索、入库、存储都要碰到插件自己的
 * ctx 与数据；把整条流水线塞进一次模型调用，模型既看不到真实检索结果，也没法分步重试。
 *
 * 红线：模型只能读我们喂给它的候选（题名/摘要/笔记），不允许它自由编造论文；
 * 每个 ID 回来都要对着输入表验一遍，认不出的直接丢掉，不入库、不进对比。
 */

const LIMIT = {
  question: 500,
  queries: 4,
  query: 160,
  candidates: 24,
  abstract: 1200,
  screen: 8,
  notesBatch: 3,
  ideas: 3,
  note: 1200,
}

const SYSTEM = {
  plan: '你是学术文献调研的检索规划助手。你只给检索式和纳入/排除标准，不编造论文、不总结文献内容。输出严格 JSON。',
  screen: '你是文献筛选助手。只能依据给定的题名与摘要判断相关性；摘要里没有的信息不要补。输出严格 JSON。',
  notes: '你是论文精读助手。只能依据给定的题名与摘要写笔记；摘要没提到的写「摘要未提」，不要用常识补全。输出严格 JSON。',
  synthesize: '你是研究综述助手。只能依据给定的精读笔记做归纳与对比，不引入新论文、不编造数字。输出严格 JSON。',
  ideas: '你是研究选题助手。基于给定的问题、对比结论与缺口提出可验证的新想法；不重复给定论文已做的工作。输出严格 JSON。',
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

function candidateLine(item, index) {
  const authors = textList(item.authors, 3, 80).join(', ')
  const abstract = oneLine(item.abstract, LIMIT.abstract)
  return [
    '[' + index + '] id=' + keyOf(item),
    '题名：' + oneLine(item.title, 400),
    '年份：' + (oneLine(item.year, 8) || '未知') + '  来源：' + (oneLine(item.venue, 120) || '未知'),
    ...(authors ? ['作者：' + authors] : []),
    ...(abstract ? ['摘要：' + abstract] : ['摘要：无']),
  ].join('\n')
}

function createScholarAi(deps) {
  const complete = deps.complete
  const search = deps.search

  async function askJson(system, prompt, maxTokens) {
    const first = await complete({ system, prompt, maxTokens: maxTokens || 1200 })
    try {
      return { data: jsonFromText(first.text), model: first.model, usage: first.usage }
    } catch (error) {
      // 只给一次返工机会：有些模型习惯先写一句「好的」再给 JSON
      const second = await complete({
        system,
        prompt: prompt + '\n\n上一次回复无法解析（' + String(error.message || error) + '）。这次只输出 JSON，不要代码块，不要任何解释。',
        maxTokens: maxTokens || 1200,
      })
      return { data: jsonFromText(second.text), model: second.model, usage: second.usage }
    }
  }

  /** 1. 把研究问题翻译成 2–4 组互补的检索式；模型崩了就用原问题上 arXiv */
  async function plan(input) {
    const question = cap(input.question, LIMIT.question)
    if (!question) throw new Error('先写一句要研究的问题')
    const goal = oneLine(input.goal, 40) || '综述'
    const prompt = [
      '研究问题：' + question,
      '调研目标：' + goal,
      '今天是 ' + new Date().getFullYear() + ' 年。',
      '',
      '请把这个问题拆成 2–4 组检索式，要求：',
      '1. 覆盖同义词、上下位概念与可能的英文术语，不要三组只换一个词；',
      '2. 每组是一条可直接丢给 arXiv / Crossref 的关键词串（用空格连接，不要布尔运算符、不要引号）；',
      '3. 给出纳入标准与排除标准，各 1–3 条，短句。',
      '输出 JSON：{"queries":["…"],"include":["…"],"exclude":["…"],"note":"一句话说明检索范围"}',
    ].join('\n')
    const out = await askJson(SYSTEM.plan, prompt, 900)
    const data = out.data && typeof out.data === 'object' ? out.data : {}
    let queries = textList(data.queries, LIMIT.queries, LIMIT.query)
    if (!queries.length) queries = [oneLine(question, LIMIT.query)]
    return {
      queries,
      include: textList(data.include, 3, 200),
      exclude: textList(data.exclude, 3, 200),
      note: oneLine(data.note, 300),
      model: out.model,
    }
  }

  /** 2. 多组检索式并行取回，按 DOI/arXiv/题名去重，只留有摘要的优先 */
  async function gather(input) {
    const queries = textList(input.queries, LIMIT.queries, LIMIT.query)
    if (!queries.length) throw new Error('没有可用的检索式')
    const perQuery = Math.min(Math.max(Number(input.perQuery) || 6, 3), 10)
    const errors = []
    const batches = await Promise.all(
      queries.map((query) =>
        search(query, perQuery).catch((error) => {
          errors.push(query + '：' + error.message)
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
      if (candidates.length >= LIMIT.candidates) break
    }
    if (!candidates.length) {
      throw new Error('检索没有结果' + (errors.length ? '：' + errors.join('；') : '：换一组更宽的关键词'))
    }
    return { candidates, errors }
  }

  /** 3. 相关度筛选：只认输入表里出现过的 id，模型多编的条目直接丢弃 */
  async function screen(input) {
    const question = cap(input.question, LIMIT.question)
    const candidates = list(input.candidates).slice(0, LIMIT.candidates)
    if (!question) throw new Error('缺少研究问题')
    if (!candidates.length) throw new Error('没有候选可筛')
    const prompt = [
      '研究问题：' + question,
      '',
      '以下是检索到的论文（只有题名与摘要，没有全文）：',
      candidates.map((item, index) => candidateLine(item, index)).join('\n\n'),
      '',
      '请挑出真正与问题相关的，按相关度排序（最多 ' + LIMIT.screen + ' 篇）。',
      '判断标准：是否直接研究该问题 / 提供关键方法或证据 / 是绕不开的基线。',
      'id 必须原样照抄上面列表里的 id；不确定相关就给 low，不要为了凑数硬选。',
      '输出 JSON：{"picks":[{"id":"…","relevance":"high|medium|low","why":"≤60字，点明与问题的关系"}],"note":"一句话说明筛掉了什么"}',
    ].join('\n')
    const out = await askJson(SYSTEM.screen, prompt, 1400)
    const raw = list(out.data && out.data.picks)
    const known = new Map(candidates.map((item) => [item.key, item]))
    const rank = { high: 0, medium: 1, low: 2 }
    const picks = []
    const seen = new Set()
    for (const item of raw) {
      const id = oneLine(item && item.id, 400)
      if (!known.has(id) || seen.has(id)) continue
      seen.add(id)
      const relevance = ['high', 'medium', 'low'].includes(item.relevance) ? item.relevance : 'medium'
      picks.push({ key: id, relevance, why: oneLine(item.why, 200) })
    }
    if (!picks.length) throw new Error('模型没有从候选里选出任何一篇：换个问题或加一组检索式')
    picks.sort((a, b) => rank[a.relevance] - rank[b.relevance])
    return {
      picks: picks.slice(0, LIMIT.screen),
      note: oneLine(out.data && out.data.note, 300),
      model: out.model,
    }
  }

  /** 4. 一篇（或三篇）一批做精读卡片：四段分开写，摘要没写的明说没有 */
  async function notes(input) {
    const question = cap(input.question, LIMIT.question)
    const papers = list(input.papers).slice(0, LIMIT.notesBatch)
    if (!question) throw new Error('缺少研究问题')
    if (!papers.length) throw new Error('没有要精读的论文')
    const prompt = [
      '研究问题：' + question,
      '',
      '请精读下面 ' + papers.length + ' 篇论文的题名与摘要：',
      papers.map((item, index) => candidateLine(item, index)).join('\n\n'),
      '',
      '每篇写五项，全部用中文，只依据给定信息：',
      '- conclusion：核心结论（一句话）；',
      '- evidence：支撑结论的证据；',
      '- experiments：实验设置与关键数字，摘要没写就写「摘要未提」；',
      '- limitations：作者承认或摘要能看出的局限；',
      '- relation：与上述研究问题的关系（支持 / 反对 / 提供方法 / 仅背景）。',
      'id 必须原样照抄；判断不了的两三句写完即可，不要扩写成段落。',
      '输出 JSON：{"notes":[{"id":"…","conclusion":"…","evidence":"…","experiments":"…","limitations":"…","relation":"…"}]}',
    ].join('\n')
    const out = await askJson(SYSTEM.notes, prompt, 1800)
    const raw = list(out.data && out.data.notes)
    const known = new Set(papers.map((item) => keyOf(item)))
    const cleaned = []
    for (const item of raw) {
      const id = oneLine(item && item.id, 400)
      if (!known.has(id)) continue
      cleaned.push({
        key: id,
        conclusion: oneLine(item.conclusion, LIMIT.note),
        evidence: oneLine(item.evidence, LIMIT.note),
        experiments: oneLine(item.experiments, LIMIT.note),
        limitations: oneLine(item.limitations, LIMIT.note),
        relation: oneLine(item.relation, 300),
      })
    }
    if (!cleaned.length) throw new Error('模型没有返回可用的精读笔记')
    return { notes: cleaned, model: out.model }
  }

  /** 5. 跨篇对比：维度由模型给，但每一行必须对得上输入里的论文 */
  async function synthesize(input) {
    const question = cap(input.question, LIMIT.question)
    const papers = list(input.papers)
    if (!question) throw new Error('缺少研究问题')
    if (!papers.length) throw new Error('没有可对比的论文')
    const prompt = [
      '研究问题：' + question,
      '',
      '以下是已精读的论文与笔记：',
      papers
        .map((item, index) =>
          [
            '[' + index + '] id=' + oneLine(item.key, 400) + ' 题名：' + oneLine(item.title, 400),
            '结论：' + (oneLine(item.conclusion, LIMIT.note) || '未提'),
            '证据：' + (oneLine(item.evidence, LIMIT.note) || '未提'),
            '实验：' + (oneLine(item.experiments, LIMIT.note) || '未提'),
            '局限：' + (oneLine(item.limitations, LIMIT.note) || '未提'),
          ].join('\n'),
        )
        .join('\n\n'),
      '',
      '请给出一张对比表：',
      '1. dimensions：3–5 个对比维度，必须能区分这些论文（例如「方法主体」「数据与规模」「主要结论」「局限」），不要写「其他」；',
      '2. rows：每篇一行，cells 与 dimensions 一一对应，短句、可含数字；笔记没写就写「未提」；',
      '3. summary：四五句话回答「这些工作合起来把问题推进到了哪一步、还缺什么」；',
      '4. gaps：2–4 条尚未被这些论文解决的缺口，每条一句话。',
      '输出 JSON：{"dimensions":["…"],"rows":[{"id":"…","cells":["…"]}],"summary":"…","gaps":["…"]}',
    ].join('\n')
    const out = await askJson(SYSTEM.synthesize, prompt, 2200)
    const data = out.data && typeof out.data === 'object' ? out.data : {}
    let dimensions = textList(data.dimensions, 5, 40)
    if (!dimensions.length) dimensions = ['方法', '数据', '结论', '局限']
    const known = new Map(papers.map((item) => [oneLine(item.key, 400), item]))
    const rows = []
    for (const row of list(data.rows)) {
      const id = oneLine(row && row.id, 400)
      if (!known.has(id)) continue
      const cells = list(row.cells).map((v) => oneLine(v, 400))
      while (cells.length < dimensions.length) cells.push('未提')
      rows.push({ key: id, cells: cells.slice(0, dimensions.length) })
    }
    if (!rows.length) throw new Error('模型没有给出可用的对比表')
    return {
      dimensions,
      rows,
      summary: cap(data.summary, 2000),
      gaps: textList(data.gaps, 4, 300),
      model: out.model,
    }
  }

  /** 6. 选题草案：只能基于已读到的论文，且关联 id 必须在表内 */
  async function ideas(input) {
    const question = cap(input.question, LIMIT.question)
    const papers = list(input.papers)
    const gaps = textList(input.gaps, 4, 300)
    if (!question) throw new Error('缺少研究问题')
    const prompt = [
      '研究问题：' + question,
      '',
      '已读论文与笔记：',
      papers
        .map((item, index) =>
          [
            '[' + index + '] id=' + oneLine(item.key, 400) + ' 题名：' + oneLine(item.title, 400),
            '结论：' + (oneLine(item.conclusion, LIMIT.note) || '未提'),
            '局限：' + (oneLine(item.limitations, LIMIT.note) || '未提'),
          ].join('\n'),
        )
        .join('\n\n'),
      '',
      '已知缺口：' + (gaps.length ? gaps.join('；') : '未总结'),
      '',
      '请提 ' + LIMIT.ideas + ' 条可验证的新想法。每条：',
      '- title：一句话说清要做什么；',
      '- innovation：相对上面这些工作新在哪（不要重复它们已经做过的）；',
      '- evidence：现有笔记里支持它的线索，或明确写「暂无直接证据，属推断」；',
      '- test：最小验证实验（数据、指标、对照）一句话；',
      '- paperIds：支撑它的论文 id，从上面列表里原样选，没有就给空数组。',
      '输出 JSON：{"ideas":[{"title":"…","innovation":"…","evidence":"…","test":"…","paperIds":["…"]}]}',
    ].join('\n')
    const out = await askJson(SYSTEM.ideas, prompt, 1800)
    const known = new Set(papers.map((item) => oneLine(item.key, 400)))
    const ideas = []
    for (const item of list(out.data && out.data.ideas).slice(0, LIMIT.ideas)) {
      const title = oneLine(item && item.title, 200)
      if (!title) continue
      ideas.push({
        title,
        innovation: cap(item.innovation, LIMIT.note),
        evidence: cap(item.evidence, LIMIT.note),
        test: cap(item.test, LIMIT.note),
        paperKeys: list(item.paperIds)
          .map((v) => oneLine(v, 400))
          .filter((v) => known.has(v)),
      })
    }
    if (!ideas.length) throw new Error('模型没有给出可用的想法')
    return { ideas, model: out.model }
  }

  return { plan, gather, screen, notes, synthesize, ideas }
}

module.exports = { createScholarAi, jsonFromText, keyOf, LIMIT }
