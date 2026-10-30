/**
 * 科研工作台：把原来的「服务器看板 / 学者工作台 / 研究主线图」并成一个插件。
 *
 * 三个旧插件各自是完整的一套（存储键、RPC 名、工具名），直接接进来会互相覆盖：
 * 学者和主线都有 project.list / project.create / ai.plan。所以这里不重写它们，
 * 只在外面套一层命名空间：
 *   - 存储：模块自己的键加前缀（server:servers、scholar:state、trajectory:state）；
 *   - RPC：注册成 `<模块>.<原接口名>`，例如 scholar.paper.list、server.server.list；
 *   - 工具：去掉模块前缀再统一挂到 research_ 下（scholar_add_paper → research_add_paper）。
 *
 * 迁移在宿主的 PluginService 里做（它才知道 plugin-data 的布局），这里只负责在新命名空间里读。
 * 面板外壳在 ui.html：四区（概览/资料/主线/实验），三个模块各自一个嵌套帧，
 * 后台调用仍走这里注册的接口。
 *
 * 外壳还多管两件事，都是从调研里学来的交互约定：
 *   - **帧**：外壳发起的每一次动作都留下一帧（动作 + 参数 + 状态 + 前后计数），
 *     面板据此能回看「上次那步到底做了什么」，而不是只留一个最终结果；
 *   - **待批**：破坏性动作不直接执行，先落成一张待批卡（做什么、在哪、参数是什么），
 *     用户批准或拒绝都留痕。执行统一发生在插件进程里，界面只负责呈现和收集人点头。
 */

'use strict'

const MODULES = [
  { id: 'scholar', label: '文献资料', file: './modules/scholar/main.js' },
  { id: 'trajectory', label: '研究主线', file: './modules/trajectory/main.js' },
  { id: 'server', label: '实验机器', file: './modules/server/main.js' },
]

const TOOL_PREFIX = 'research_'
/** 外壳自己的共享上下文：一个课题名 + 一句说明，三个区都看得到 */
const CONTEXT_KEY = 'shell:context'
const CONTEXT_MAX = 200
/** 帧与待批的存储键 */
const FRAMES_KEY = 'shell:frames'
const APPROVALS_KEY = 'shell:approvals'
/** 留痕的上限：面板只看最近这些，太老的帧没有回看价值 */
const FRAME_MAX = 200
const APPROVAL_MAX = 100
/** 单帧里参数与结果的体积上限，免得面板被一个巨大的搜索结果撑爆 */
const PAYLOAD_MAX = 2000

let ctx = null
let shellContext = { title: '', note: '' }
const status = new Map()
/**
 * 模块注册过的接口：全名（scholar.paper.remove）→ 处理函数。
 * 外壳要替用户执行动作并留痕，就得能按名字调回模块自己的接口，
 * 而不是自己在宿主那边复制一份业务逻辑。
 */
const moduleRpc = new Map()

function str(value, max = 4096) {
  return typeof value === 'string' ? value.slice(0, max) : ''
}

function num(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** 参数与结果都可能是任意结构；留痕时只留可序列化的那一部分 */
function plain(value, max = PAYLOAD_MAX) {
  if (value == null) return null
  if (typeof value === 'string') return value.slice(0, max)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  try {
    const text = JSON.stringify(value)
    if (text === undefined) return String(value)
    return text.length > max ? text.slice(0, max) + '…' : JSON.parse(text)
  } catch {
    return String(value).slice(0, max)
  }
}

function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** 模块的工具名统一收进 research_：清单只允许一个前缀 */
function toolNameFor(moduleId, name) {
  if (typeof name !== 'string' || !name) return ''
  const tail = name.startsWith(`${moduleId}_`) ? name.slice(moduleId.length + 1) : name
  return `${TOOL_PREFIX}${tail}`
}

/**
 * 给模块一份「看着像原宿主」的 ctx。
 *
 * 只拦 storage / rpc / tools / log 四处；fetch、ai、secret 原样透传 —— 它们的
 * 权限由清单和宿主管，包一层反而会掩盖「没声明就拒绝」的提示。
 */
function moduleContext(base, moduleId, takenTools) {
  return {
    ...base,
    storage: {
      get: (key) => base.storage.get(`${moduleId}:${key}`),
      set: (key, value) => base.storage.set(`${moduleId}:${key}`, value),
      delete: (key) => base.storage.delete(`${moduleId}:${key}`),
      list: () =>
        base.storage.list().then((keys) =>
          keys
            .filter((key) => key.startsWith(`${moduleId}:`))
            .map((key) => key.slice(moduleId.length + 1)),
        ),
    },
    log: (level, message) => base.log(level, `[${moduleId}] ${message}`),
    rpc: {
      handle(name, fn) {
        if (typeof name !== 'string' || !name) throw new Error('接口名不能为空')
        const full = `${moduleId}.${name}`
        // 记一份到注册表：外壳执行动作时要按全名调回模块自己的接口
        moduleRpc.set(full, fn)
        base.rpc.handle(full, fn)
      },
    },
    tools: {
      handle(name, fn) {
        const renamed = toolNameFor(moduleId, name)
        if (!renamed) throw new Error('工具名不能为空')
        if (takenTools.has(renamed)) {
          base.log('error', `工具 ${renamed} 重名（${moduleId}），已跳过`)
          return
        }
        takenTools.add(renamed)
        base.tools.handle(renamed, fn)
      },
    },
  }
}

async function loadContext() {
  const raw = await ctx.storage.get(CONTEXT_KEY)
  if (!raw || typeof raw !== 'object') return
  shellContext = {
    title: str(raw.title, CONTEXT_MAX),
    note: str(raw.note, CONTEXT_MAX),
  }
}

async function readList(key) {
  const raw = await ctx.storage.get(key)
  return Array.isArray(raw) ? raw : []
}

async function writeList(key, list) {
  await ctx.storage.set(key, list)
  return list
}

/**
 * 一次动作前后的规模快照。
 *
 * 帧的价值在于「能看见变化」：光有成功失败看不出这次到底加了几篇论文。
 * 计数全部取自各模块自己的列表接口，取不到就留空而不是猜一个数。
 */
async function snapshotCounts() {
  const counts = { papers: null, ideas: null, projects: null, servers: null }
  const call = async (name, params) => {
    const fn = moduleRpc.get(name)
    if (!fn) return null
    try {
      return await fn(params || {})
    } catch {
      return null
    }
  }
  const [meta, projects, servers] = await Promise.all([
    call('scholar.meta'),
    call('trajectory.project.list'),
    call('server.server.list'),
  ])
  const m = meta && typeof meta === 'object' ? meta : {}
  const mc = m.counts && typeof m.counts === 'object' ? m.counts : {}
  counts.papers = num(mc.papers, 0)
  counts.ideas = num(mc.ideas, 0)
  counts.projects = Array.isArray(projects && projects.projects) ? projects.projects.length : 0
  const sc = servers && typeof servers === 'object' ? servers.counts : null
  counts.servers = sc && typeof sc === 'object' ? num(sc.total, 0) : 0
  return counts
}

/** 把两个快照的差写成人话：+2 篇论文、-1 个项目 */
function describeDelta(before, after) {
  const labels = { papers: '篇论文', ideas: '条 Idea', projects: '个项目', servers: '台机器' }
  const parts = []
  for (const key of Object.keys(labels)) {
    const from = num(before && before[key], 0)
    const to = num(after && after[key], 0)
    const diff = to - from
    if (!diff) continue
    parts.push(`${diff > 0 ? '+' : ''}${diff} ${labels[key]}`)
  }
  return parts.join('，')
}

/** 一帧：动作 + 参数 + 状态 + 结果 + 前后计数 */
async function recordFrame(frame) {
  const list = await readList(FRAMES_KEY)
  const entry = {
    id: str(frame.id, 64) || newId('frame'),
    at: num(frame.at, Date.now()),
    action: str(frame.action, 80),
    title: str(frame.title, 120),
    status: frame.status === 'error' ? 'error' : 'ok',
    summary: str(frame.summary, 600),
    params: plain(frame.params),
    before: frame.before && typeof frame.before === 'object' ? frame.before : null,
    after: frame.after && typeof frame.after === 'object' ? frame.after : null,
    delta: str(frame.delta, 120),
    ms: num(frame.ms, 0),
  }
  list.unshift(entry)
  await writeList(FRAMES_KEY, list.slice(0, FRAME_MAX))
  return entry
}

/**
 * 执行一个模块动作，并把过程记成一帧。
 *
 * 失败也留帧：错误信息是研究者回头排查时最需要的那一行，
 * 静默失败只会让人以为「这一步没反应」。
 */
async function runAction(action, title, params) {
  const fn = moduleRpc.get(action)
  if (!fn) throw new Error(`动作没有实现：${action}`)
  const before = await snapshotCounts()
  const startedAt = Date.now()
  try {
    const result = await fn(params)
    const after = await snapshotCounts()
    const frame = await recordFrame({
      action,
      title: title || action,
      params,
      status: 'ok',
      summary: describeResult(result),
      before,
      after,
      delta: describeDelta(before, after),
      at: startedAt,
      ms: Date.now() - startedAt,
    })
    return { ok: true, result: plain(result, 4000), frame }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const frame = await recordFrame({
      action,
      title: title || action,
      params,
      status: 'error',
      summary: message,
      before,
      after: before,
      delta: '',
      at: startedAt,
      ms: Date.now() - startedAt,
    })
    return { ok: false, error: message, frame }
  }
}

/** 结果摘要：接口返回的形状各不相同，挑能说清「做了什么」的那部分 */
function describeResult(result) {
  if (result == null) return ''
  if (typeof result === 'string') return result.slice(0, 300)
  if (typeof result !== 'object') return String(result)
  const obj = result
  if (obj.paper && obj.paper.title) return `论文：${obj.paper.title}`
  if (obj.project && obj.project.title) return `项目：${obj.project.title}`
  if (obj.idea && obj.idea.statement) return `Idea：${obj.idea.statement}`
  if (obj.idea && obj.idea.title) return `Idea：${obj.idea.title}`
  if (obj.server && obj.server.label) return `机器：${obj.server.label}`
  if (obj.ideas && Array.isArray(obj.ideas)) return `生成 ${obj.ideas.length} 条 Idea`
  if (obj.papers && Array.isArray(obj.papers)) return `命中 ${obj.papers.length} 篇论文`
  if (obj.results && Array.isArray(obj.results)) return `命中 ${obj.results.length} 条结果`
  if (obj.servers && Array.isArray(obj.servers)) return `${obj.servers.length} 台机器`
  if (obj.markdown) return `导出 ${String(obj.markdown).length} 字 Markdown`
  if (obj.node && obj.node.title) return `节点：${obj.node.title}`
  if (obj.entry) return '已记入台账'
  try {
    const text = JSON.stringify(result)
    return text.length > 300 ? text.slice(0, 300) + '…' : text
  } catch {
    return ''
  }
}

/** 待批卡：先落卡，再由人点头，卡里写清做什么、在哪、参数是什么 */
async function createApproval(payload) {
  const p = payload && typeof payload === 'object' ? payload : {}
  const action = str(p.action, 80)
  if (!action) throw new Error('待批卡缺动作')
  if (!moduleRpc.has(action)) throw new Error(`动作没有实现：${action}`)
  const list = await readList(APPROVALS_KEY)
  const card = {
    id: newId('apv'),
    at: Date.now(),
    action,
    title: str(p.title, 120) || action,
    impact: str(p.impact, 300),
    params: plain(p.params),
    status: 'pending',
    decidedAt: 0,
    result: '',
  }
  list.unshift(card)
  await writeList(APPROVALS_KEY, list.slice(0, APPROVAL_MAX))
  return card
}

/**
 * 批准或拒绝一张待批卡。
 *
 * 批准才执行；拒绝也留痕（拒绝原因和参数一起记下来），
 * 否则「我没点错」和「我没想清楚」这两件事事后分不开。
 */
async function resolveApproval(id, approved) {
  const list = await readList(APPROVALS_KEY)
  const card = list.find((item) => item && item.id === id)
  if (!card) throw new Error('待批卡不在了')
  if (card.status !== 'pending') throw new Error('这张卡已经处理过了')
  if (!approved) {
    card.status = 'rejected'
    card.decidedAt = Date.now()
    card.result = '用户拒绝'
    await writeList(APPROVALS_KEY, list)
    await recordFrame({
      action: card.action,
      title: card.title,
      params: card.params,
      status: 'ok',
      summary: '用户拒绝执行',
      at: card.decidedAt,
    })
    return { card, executed: false }
  }
  const outcome = await runAction(card.action, card.title, card.params && typeof card.params === 'object' ? card.params : {})
  card.status = outcome.ok ? 'approved' : 'error'
  card.decidedAt = Date.now()
  card.result = outcome.ok ? '已执行' : outcome.error
  await writeList(APPROVALS_KEY, list)
  return { card, executed: outcome.ok, result: outcome.result, error: outcome.error, frame: outcome.frame }
}

async function activate(context) {
  ctx = context
  await loadContext()

  const takenTools = new Set()
  for (const module of MODULES) {
    try {
      // eslint-disable-next-line global-require
      const entry = require(module.file)
      const activateModule = entry && (entry.activate || (entry.default && entry.default.activate))
      if (typeof activateModule !== 'function') throw new Error('模块没有导出 activate(ctx)')
      await activateModule(moduleContext(ctx, module.id, takenTools))
      status.set(module.id, { id: module.id, label: module.label, ok: true })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      status.set(module.id, { id: module.id, label: module.label, ok: false, error: message })
      ctx.log('error', `模块 ${module.id} 没起来：${message}`)
    }
  }

  ctx.rpc.handle('shell.context.get', () => ({ ...shellContext }))
  ctx.rpc.handle('shell.context.set', async (params) => {
    const p = params && typeof params === 'object' ? params : {}
    shellContext = {
      title: typeof p.title === 'string' ? p.title.slice(0, CONTEXT_MAX) : shellContext.title,
      note: typeof p.note === 'string' ? p.note.slice(0, CONTEXT_MAX) : shellContext.note,
    }
    await ctx.storage.set(CONTEXT_KEY, shellContext)
    return { ...shellContext }
  })
  /* 外壳的模块状态：哪个模块没起来要说清楚，而不是让那一页永远空着 */
  ctx.rpc.handle('shell.modules', () => ({ modules: MODULES.map((m) => status.get(m.id)) }))

  /* 面板壳需要一眼看全的规模：论文、Idea、项目、机器各多少 */
  ctx.rpc.handle('shell.status', async () => ({
    modules: MODULES.map((m) => status.get(m.id)),
    counts: await snapshotCounts(),
    frames: (await readList(FRAMES_KEY)).length,
    pending: (await readList(APPROVALS_KEY)).filter((c) => c && c.status === 'pending').length,
  }))

  /* 动作出口：面板不直接调模块接口，统一从这里过，好留痕 */
  ctx.rpc.handle('shell.run', async (params) => {
    const p = params && typeof params === 'object' ? params : {}
    const action = str(p.action, 80)
    if (!action) throw new Error('动作不能为空')
    return runAction(action, str(p.title, 120), p.params && typeof p.params === 'object' ? p.params : {})
  })

  /* 帧：每一次动作的结果都在，能回看 */
  ctx.rpc.handle('shell.frames.list', async () => ({ frames: await readList(FRAMES_KEY) }))
  ctx.rpc.handle('shell.frames.clear', async () => {
    await writeList(FRAMES_KEY, [])
    return { ok: true }
  })

  /* 待批卡：破坏性动作先落卡，人点头才执行 */
  ctx.rpc.handle('shell.approvals.list', async () => {
    const list = await readList(APPROVALS_KEY)
    return {
      pending: list.filter((card) => card && card.status === 'pending'),
      decided: list.filter((card) => card && card.status !== 'pending'),
    }
  })
  ctx.rpc.handle('shell.approvals.create', async (params) => {
    const card = await createApproval(params)
    return { card }
  })
  ctx.rpc.handle('shell.approvals.resolve', async (params) => {
    const p = params && typeof params === 'object' ? params : {}
    const id = str(p.id, 64)
    if (!id) throw new Error('待批卡缺 id')
    return resolveApproval(id, p.approved !== false)
  })

  const ok = [...status.values()].filter((m) => m.ok).length
  ctx.log('info', `科研工作台就绪：${ok}/${MODULES.length} 个模块，工具 ${takenTools.size} 个`)
}

module.exports = { activate }
