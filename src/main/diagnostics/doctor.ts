/**
 * 分层体检 —— 沿真实因果链自顶向下检查，找到「最先阻断的那一层」。
 *
 * 为什么要分层而不是逐项检查：一次「适配器失效」的表象可能来自
 * 视口为 0（站点退化成移动端）、登录过期、选择器漂移、通道未注入、
 * 主持缺 Key 完全不同的原因。把它们平铺成一张清单，用户只会照着头一条
 * 去改一个根本没坏的东西。分层的作用是**归因**：上层 fail 时下层标 skip，
 * 因为下层的结果此时没有意义。
 *
 * 三条硬约束：
 * 1. 只读。绝不发送消息、绝不清 cookie、绝不写站点状态。
 *    输入框可写性用「写一个字符 → 回读 → 还原」验证，还原在同一个语句里完成。
 * 2. 每个 fail 必须带证据 + 可执行动作。没有建议的失败等于把问题退回给用户。
 * 3. 检查项之间不共享「页面已就绪」这种隐含假设，各自重新观测 ——
 *    体检随时可能被用户中途点开，不能依赖上一次跑的现场。
 */

import { app, session, type WebContentsView } from 'electron'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ModelConfig } from '../../shared/types'
import type { AdapterSpec } from '../../shared/adapter'
import type { CheckResult, DiagLayer, DoctorReport } from '../../shared/diagnostics'
import { LAYER_LABEL, LAYER_ORDER, layerRank, summarize } from '../../shared/diagnostics'
import type { AdapterRegistry } from '../adapters/registry'
import type { WebviewPool } from '../webview/pool'
import type { SecretStore, SessionStore } from '../store/session-store'
import { INJECT_SCRIPT } from '../webview/inject'
import { PICKER_SCRIPT } from '../webview/picker'
import { diag } from './log'

export interface DoctorDeps {
  pool: WebviewPool
  registry: AdapterRegistry
  models: () => ModelConfig[]
  secrets: SecretStore
  store: SessionStore
  moderatorId: () => string | null
  rootDir: string
}

export interface DoctorOptions {
  /** 只体检某个模型（网页或 API 皆可）；缺省体检全部启用的模型 + 主持 */
  modelId?: string
  /**
   * 是否向 API 端点发一次 GET /models 探测。
   * 免费、不改状态，但需要联网；关掉后 Key 写错、baseUrl 漏 /v1 都查不出来。
   */
  probeApi?: boolean
  /**
   * 是否有另一个进程正持有这些分区（离线 CLI 在 Torra 运行时用 --force 强跑）。
   * 此时 cookie 库由对方持有，本进程读到的登录态会随机翻转 ——
   * 实测同一个 deepseek-web 两次跑分别是「输入框可用」和「被重定向到 /sign_in」。
   * 与其报一条真假难辨的 fail，不如如实报「不可判定」，
   * 免得用户为了一个并不存在的问题去重新登录。
   */
  contended?: boolean
}

/** 易漂选择器特征：哈希类名、CSS Modules 生成名、React 动态 id */
const DRIFT_PATTERNS: Array<{ re: RegExp; why: string }> = [
  { re: /\[class\*="_?[0-9a-zA-Z]{6,}"\]/, why: '按 class 前缀匹配哈希类名，站点每次构建都会变' },
  { re: /\.[A-Za-z]?[a-z]?[0-9a-f]{5,}[0-9a-f]+\b/, why: '选择器里含哈希类名' },
  { re: /#[^,\s]*:r\d+:/, why: 'React 动态 id，随渲染顺序变化' },
  { re: /\b(css|sc|jsx|emotion)-[a-z0-9]{4,}\b/i, why: 'CSS-in-JS 生成类名' },
]

function check(
  layer: DiagLayer,
  id: string,
  title: string,
  status: CheckResult['status'],
  evidence: string[],
  opts: { subject?: string; fix?: string; suggestion?: string; apply?: CheckResult['apply'] } = {},
): CheckResult {
  return {
    id,
    layer,
    title,
    subject: opts.subject,
    status,
    ms: 0,
    evidence,
    fix: opts.fix,
    suggestion: opts.suggestion,
    apply: opts.apply,
  }
}

/** 计时包装：体检本身也要留下耗时，慢本身就是问题（导航没完成、页面卡住） */
async function timed<T>(id: string, fn: () => Promise<T>): Promise<{ r: T; ms: number }> {
  const t0 = Date.now()
  const r = await fn()
  return { r, ms: Date.now() - t0 }
}

export async function runDoctor(deps: DoctorDeps, opts: DoctorOptions = {}): Promise<DoctorReport> {
  const startedAt = Date.now()
  const checks: CheckResult[] = []
  /** 本次为体检临时创建的实例，跑完必须释放，否则会一直占着内存预算 */
  const created: string[] = []

  const webModels = deps
    .models()
    .filter((m) => m.enabled && m.transport === 'webview')
    .filter((m) => !opts.modelId || m.id === opts.modelId)

  try {
    const env = await checkEnv(deps)
    checks.push(...env)
    // 环境层不通过时，后面的结论全部无效（历史上就这么误判过登录态）
    if (env.some((c) => c.status === 'fail')) {
      return finish(startedAt, checks, deps, 'env')
    }

    checks.push(...(await checkAdapters(deps, webModels)))

    // API 通道与网页通道是两种故障域：前者查配置/Key/端点/模型名，后者查登录/选择器。
    // 主持本身也走 API 直连，所以它若同时是参会模型，只查一次，避免两条重复结论。
    const apiTargets = deps
      .models()
      .filter((m) => m.enabled && m.transport === 'api')
      .filter((m) => !opts.modelId || m.id === opts.modelId)
    const modId = deps.moderatorId()
    if (modId) {
      const mod = deps.models().find((m) => m.id === modId)
      if (mod?.api && !apiTargets.some((m) => m.id === modId)) apiTargets.push(mod)
    }
    for (const m of apiTargets) {
      checks.push(...(await checkApiChannel(deps, m, opts)))
    }

    // 指定了范围却一个目标都没配上：多半是选了已停用的模型。
    // 不报出来的话面板会显示「通过 0 / 失败 0」，看起来像体检坏了。
    if (opts.modelId && webModels.length === 0 && apiTargets.length === 0) {
      const picked = deps.models().find((m) => m.id === opts.modelId)
      checks.push(
        check('env', `scope:${opts.modelId}`, `${opts.modelId} 无可体检的通道`, 'warn', [
          picked ? `enabled=${picked.enabled}` : 'models.json 中不存在该 id',
        ], {
          subject: opts.modelId,
          fix: picked ? '该模型已停用，体检只覆盖启用中的模型' : '重新选择范围内的模型',
        }),
      )
    }

    for (const m of webModels) {
      const spec = m.adapterId ? deps.registry.get(m.adapterId)?.spec : undefined
      if (!spec) {
        checks.push(
          check('adapter', `adapter:bound:${m.id}`, `${m.displayName} 未绑定可用适配器`, 'fail', [
            `adapterId=${m.adapterId ?? '(空)'}`,
          ], { subject: m.id, fix: '在设置页重新创建该网页模型，或为该模型指定一个存在的适配器' }),
        )
        continue
      }
      await checkWebModel(deps, m, spec, created, checks, opts.contended)
    }

    checks.push(...(await checkModerator(deps)))
    checks.push(...(await checkOutput(deps)))
  } finally {
    for (const id of created) {
      try {
        deps.pool.disposeEntry(id)
      } catch {
        /* 体检收尾不能失败 */
      }
    }
  }

  // 「最先阻断」取因果最靠前的失败层，不是数组里第一条失败：
  // 主持缺 Key（api 层）和某个选择器漂移（selector 层）同时出现时，先修前者。
  const blocking = checks
    .filter((c) => c.status === 'fail')
    .sort((a, b) => layerRank(a.layer) - layerRank(b.layer))[0]?.layer
  return finish(startedAt, checks, deps, blocking)
}

/**
 * 单个网页模型的四跳：登录态 → 通道 → 注入 → 选择器。
 * 顺序即归因顺序：上层不通时下层结果没有解释力，直接 skip 掉，
 * 免得用户照着「selector 0 命中」去改一个其实只是没登录的适配器。
 */
async function checkWebModel(
  deps: DoctorDeps,
  m: ModelConfig,
  spec: AdapterSpec,
  created: string[],
  out: CheckResult[],
  contended?: boolean,
): Promise<void> {
  /*
   * 先把实例准备好，再判登录态 —— 顺序反了就得靠「补测替换」打补丁。
   * 原先的补丁只在「结论不再是 warn」时替换旧条目：DeepSeek 把凭据放在 cookie
   * 而不是 localStorage，tokenKeys 恒为空，补测仍是 warn，
   * 于是报告里永远留着一条「实例未初始化」的旧判定，
   * 而同一场体检下面的选择器全绿 —— 两条互相矛盾，没人知道该信谁。
   */
  if (!deps.pool.has(m.id)) {
    const rt = deps.registry.get(m.adapterId ?? '')
    if (!rt) return
    deps.pool.ensure(m.id, rt, m.partition)
    created.push(m.id)
    await deps.pool.waitReady(m.id, 25000)
  }
  const view = deps.pool.get(m.id)
  if (!view) {
    out.push(
      check('channel', `channel:live:${m.id}`, `${m.displayName} 无法建立页面通道`, 'fail', ['实例创建后等待加载超时'], {
        subject: m.id,
        fix: '打开登录窗手动访问一次站点，确认网络与站点可用后再体检',
      }),
    )
    return
  }

  const login = await checkLogin(deps, m, contended)
  out.push(login)

  if (login.status === 'fail') {
    out.push(
      check('channel', `channel:pending:${m.id}`, `${m.displayName} 后续检查已跳过`, 'skip', [
        '登录态未通过，此时的选择器结果不可解释',
      ], { subject: m.id }),
    )
    return
  }

  out.push(await checkChannel(m, view))

  // 争用下登录不可判定，就别再报选择器 —— 命中 0 会被解读成「站点改版」
  if (login.id === `login:contended:${m.id}`) {
    out.push(
      check('selector', `selector:pending:${m.id}`, `${m.displayName} 选择器检查已跳过`, 'skip', [
        '登录态不可判定时的页面内容没有解释力',
      ], { subject: m.id }),
    )
    return
  }

  const selectors = await checkSelectors(m, spec, view)
  out.push(...selectors.checks)
  if (!selectors.injected) {
    out.push(
      check('channel', `channel:inject:${m.id}`, `${m.displayName} 注入脚本未生效`, 'fail', [
        'executeJavaScript 无法写入 window.__torra',
      ], { subject: m.id, fix: '重载该模型页面后重试体检' }),
    )
  }

  const clean = selectors.checks.every((c) => c.status === 'pass' || c.status === 'warn')
  if (clean && selectors.injected && m.adapterId) {
    // 体检通过就把健康态写回 registry：状态灯与「最近自检」不再长期停在 unknown，
    // 用户不必为已经好的东西再手动跑一次检查。只改内存态，不动 YAML。
    deps.registry.setHealth(m.adapterId, 'ok')
    diag.log({ ts: Date.now(), layer: 'adapter', stage: 'health-ok', subject: m.adapterId, ok: true })
  }
}


function finish(startedAt: number, checks: CheckResult[], deps: DoctorDeps, blocking?: DiagLayer): DoctorReport {
  // 按因果层排序：网页模型是逐个跑「登录→通道→选择器」的，收集顺序会 layered-interleaved；
  // 报告与 CLI 都假定「同一层连续出现」，不排序就会在多个模型时重复打印层标题。
  const ordered = [...checks].sort((a, b) => layerRank(a.layer) - layerRank(b.layer))
  const report: DoctorReport = {
    startedAt,
    finishedAt: Date.now(),
    userData: app.getPath('userData'),
    scope: deps.models().length + ' models',
    checks: ordered,
    summary: summarize(ordered),
  }
  if (blocking) report.blockingLayer = blocking
  diag.log({
    ts: startedAt,
    layer: 'env',
    stage: 'doctor',
    ok: report.summary.fail === 0,
    ms: report.finishedAt - startedAt,
    detail: `pass=${report.summary.pass} warn=${report.summary.warn} fail=${report.summary.fail} blocking=${blocking ?? '-'}`,
  })
  return report
}

/**
 * L0 运行环境。
 * userData 是唯一会让所有下游结论作废的变量：分区名相同但根目录不同，
 * 读到的是一个全新空分区，于是「未登录」「选择器缺失」全是假象。
 */
async function checkEnv(deps: DoctorDeps): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  const ud = app.getPath('userData')
  const looksLikeApp = path.basename(ud).toLowerCase() === 'torra'
  out.push(
    check(
      'env',
      'env:userdata',
      '进程使用的是应用自己的数据目录',
      looksLikeApp ? 'pass' : 'fail',
      [`userData=${ud}`, `app.name=${app.name}`],
      {
        fix: looksLikeApp
          ? undefined
          : '这是以脚本方式启动了第二个 Electron 实例（默认落到 %APPDATA%\\Electron）。用 npm run doctor，或先退出 Torra 再跑。',
      },
    ),
  )

  const writable = ['sessions', 'keys', 'logs', 'adapters']
  for (const sub of writable) {
    const dir = path.join(deps.rootDir, sub)
    const probe = path.join(dir, `.diag-write-test-${Date.now()}`)
    try {
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(probe, 'x', 'utf8')
      await fs.rm(probe, { force: true })
      out.push(check('env', `env:writable:${sub}`, `数据目录可写：${sub}`, 'pass', [dir]))
    } catch (e) {
      out.push(
        check('env', `env:writable:${sub}`, `数据目录不可写：${sub}`, 'fail', [dir, (e as Error).message], {
          fix: '检查该目录权限或是否被杀毒软件锁定；讨论记录与密钥写入都依赖它',
        }),
      )
    }
  }
  return out
}

/** L1 适配器静态内容。改版是「渐变」的：选择器先在页面上变成 0 命中，之后才失败。 */
async function checkAdapters(deps: DoctorDeps, webModels: ModelConfig[]): Promise<CheckResult[]> {
  const out: CheckResult[] = []
  const seen = new Set<string>()
  for (const m of webModels) {
    const id = m.adapterId
    if (!id || seen.has(id)) continue
    seen.add(id)
    const rt = deps.registry.get(id)
    if (!rt) continue // 绑定缺失在模型循环里单独报，更贴近用户看到的对象
    const spec = rt.spec
    const drift: string[] = []
    for (const [field, value] of Object.entries(spec.selectors)) {
      if (!value) continue
      for (const p of DRIFT_PATTERNS) {
        if (p.re.test(value)) drift.push(`${field}=${value} —— ${p.why}`)
      }
    }
    if (drift.length > 0) {
      out.push(
        check('adapter', `adapter:drift:${id}`, `${spec.name} 的选择器含易漂 token`, 'fail', drift, {
          subject: id,
          fix: '改用语义属性（name / placeholder / data-testid / 全局语义类名），或把 send_mode 改成 enter 去掉按钮依赖',
        }),
      )
    }

    if (spec.health_probe !== spec.selectors.input) {
      out.push(
        check(
          'adapter',
          `adapter:probe:${id}`,
          `${spec.name} 的健康探针与输入框选择器不一致`,
          'warn',
          [`health_probe=${spec.health_probe}`, `input=${spec.selectors.input}`],
          {
            subject: id,
            fix: '两者应指向同一个输入区：探针判「能用」而发送找不到元素时，状态灯会与真实行为矛盾',
          },
        ),
      )
    }

    if (spec.completion.mode !== 'dom_stable' && !spec.selectors.stop && !spec.selectors.generating) {
      out.push(
        check(
          'adapter',
          `adapter:completion:${id}`,
          `${spec.name} 声明了 ${spec.completion.mode} 但没有对应判定元素`,
          'warn',
          [`stop=${spec.selectors.stop ?? '-'}`, `generating=${spec.selectors.generating ?? '-'}`],
          { subject: id, fix: '把 completion.mode 改成 dom_stable，否则会一路降级到兜底并浪费一轮等待' },
        ),
      )
    }

    if (deps.registry.isStale(id)) {
      out.push(
        check('adapter', `adapter:stale:${id}`, `${spec.name} 长期未验证`, 'warn', [`verified_at=${spec.verified_at}`], {
          subject: id,
          fix: '若下面的选择器命中检查全绿，说明站点没改版，可在适配器里把 verified_at 更新为今天',
        }),
      )
    }

    const neverChecked = !rt.lastCheckedAt
    out.push(
      check(
        'adapter',
        `adapter:health:${id}`,
        neverChecked
          ? `${spec.name} 尚未做过自检`
          : `${spec.name} 最近一次自检结论${rt.health === 'ok' ? '良好' : '异常'}`,
        neverChecked ? 'skip' : rt.health === 'ok' ? 'pass' : 'fail',
        [
          `health=${rt.health}`,
          `lastError=${rt.lastError ?? '-'}`,
          `lastCheckedAt=${neverChecked ? '(从未)' : new Date(rt.lastCheckedAt).toISOString()}`,
        ],
        { subject: id },
      ),
    )
  }
  return out
}

/** L3 登录态：分区名、cookie 与页面存储、实例真实使用的分区 */
async function checkLogin(
  deps: DoctorDeps,
  m: ModelConfig,
  contended = false,
): Promise<CheckResult> {
  const declared = m.partition ?? `persist:torra-${m.id}`
  const actual = deps.pool.getPartition(m.id) ?? declared
  const mismatch = actual !== declared
  const id = `login:${m.id}`
  const ev: string[] = [`declaredPartition=${declared}`, `actualPartition=${actual}`]

  /*
   * cookie 只取域名、名称与到期时间 —— 体检需要知道「有没有凭据、是否过期」，
   * 永远不需要凭据本身。
   * 到期时间是区分两类「未登录」的唯一依据：
   * 过期（用户去重新登录）与「时间没到却被判未登录」（站点风控，或分区被另一个实例持有）。
   * 过去把它们报成同一条，导致 DeepSeek 明明只要重登，却被引导去改适配器。
   */
  let auth: Array<{ name: string; domain: string; exp: number }> = []
  let cookieTotal = 0
  const fmt = (t: number) => (t > 0 ? new Date(t * 1000).toISOString().slice(0, 16) : '会话级')
  try {
    const cookies = await session.fromPartition(actual).cookies.get({})
    cookieTotal = cookies.length
    auth = cookies
      .filter((c) => /token|auth|session|jwt|bearer|uid|passport/i.test(c.name))
      .map((c) => ({ name: c.name, domain: c.domain ?? '', exp: c.expirationDate ?? 0 }))
    ev.push(
      `cookies=${cookieTotal}`,
      `authCookies=${auth.map((c) => `${c.domain} :: ${c.name}`).join(', ') || '(none)'}`,
    )
    if (auth.length > 0) ev.push(`到期时间=${auth.map((c) => `${c.name}:${fmt(c.exp)}`).join(', ')}`)
  } catch (e) {
    ev.push(`cookies 读取失败：${(e as Error).message}`)
  }

  if (mismatch) {
    ev.push('实例已在运行且使用了与配置不同的分区')
  }

  const inspect = await deps.pool.inspectLogin(m.id)
  ev.push(`state=${inspect.state}`, `reason=${inspect.reason}`, `url=${inspect.url}`, `tokenKeys=${inspect.tokenKeys.join(', ') || '(none)'}`)

  const nowS = Date.now() / 1000
  const dead = auth.filter((c) => c.exp > 0 && c.exp < nowS)
  const alive = auth.filter((c) => !(c.exp > 0 && c.exp < nowS))
  // 一天内到期的凭据：现在能用，但一场长讨论跑到后半程会掉线
  const soon = alive.filter((c) => c.exp > 0 && c.exp - nowS < 36 * 3600)

  if (inspect.state === 'logged-in') {
    if (soon.length > 0 && auth.length > 0) {
      return check(
        'login',
        id,
        `${m.displayName} 登录态可用，但凭据即将过期`,
        'warn',
        [...ev, `最近到期=${soon.map((c) => `${c.name}:${fmt(c.exp)}`).join(', ')}`],
        {
          subject: m.id,
          fix: '趁现在点一次「登录」续期。讨论中途掉登录会让该模型整轮缺席，且已经花掉的时间作废',
        },
      )
    }
    return check('login', id, `${m.displayName} 登录态可用`, 'pass', ev, {
      subject: m.id,
      fix: mismatch ? '模型配置的分区与实际分区不一致，建议重启应用使二者一致' : undefined,
    })
  }
  /*
   * 争用时（离线 CLI 在 Torra 运行中强跑）不报「未登录」。
   * cookie 库由另一个进程持有，本进程读到的登录态会随机翻转 ——
   * 实测同一个 deepseek-web 连着两次跑，一次给出可用输入框、一次被重定向到 /sign_in。
   * 报成 fail 会把用户推去重新登录一个根本没掉线的账号。
   */
  if (contended) {
    return check(
      'login',
      `login:contended:${m.id}`,
      `${m.displayName} 登录态在分区争用下不可判定`,
      'warn',
      [...ev, '本次为离线强跑：cookie 由另一个 Torra 进程持有'],
      {
        subject: m.id,
        fix: '退出 Torra 后重跑 npm run doctor，或直接在设置页点「链路体检」（同进程、无争用）。这条结论不代表你掉线，不要为此重新登录',
      },
    )
  }

  if (inspect.state === 'unknown') {
    return check('login', id, `${m.displayName} 登录态无法判定`, 'warn', ev, {
      subject: m.id,
      fix: '实例可能尚未加载完成。打开登录窗看一眼页面即可确认',
    })
  }

  // 未登录分三种，修复动作完全不同，不能笼统说「请登录」
  if (alive.length > 0) {
    return check(
      'login',
      id,
      `${m.displayName} 未登录：凭据未过期但被站点拒绝`,
      'fail',
      [...ev, `未过期凭据=${alive.map((c) => `${c.name}:${fmt(c.exp)}`).join(', ')}`],
      {
        subject: m.id,
        fix: '两种可能：站点在服务端注销了会话（去登录窗重登一次即可）；或本机有另一个 Torra 进程正持有该分区，本进程拿不到 cookie（先退出另一个实例再体检，此时任何登录结论都不可采信）。改适配器不会修好它',
      },
    )
  }
  if (dead.length > 0) {
    return check(
      'login',
      id,
      `${m.displayName} 登录已过期`,
      'fail',
      [...ev, `已过期=${dead.map((c) => `${c.name}:${fmt(c.exp)}`).join(', ')}`],
      { subject: m.id, fix: '在设置页点「登录」，在弹出的窗口里重新登录（Torra 不代管凭据），登录后自动重测' },
    )
  }
  return check('login', id, `${m.displayName} 该分区内没有登录凭据`, 'fail', ev, {
    subject: m.id,
    fix: '从未登录过。在设置页点「登录」完成首次登录，登录后自动重测',
  })
}

/** L4 通道：视口、可见性、加载状态。0×0 视口是「适配器失效」的头号假因 */
async function checkChannel(m: ModelConfig, view: WebContentsView): Promise<CheckResult> {
  const facts = await view.webContents
    .executeJavaScript(
      `({w:window.innerWidth,h:window.innerHeight,vis:document.visibilityState,ready:document.readyState,url:location.href,title:document.title,token:!!window.__torra})`,
      true,
    )
    .catch(() => null)

  if (!facts) {
    return check('channel', `channel:live:${m.id}`, `${m.displayName} 页面无响应`, 'fail', ['executeJavaScript 超时/抛错'], {
      subject: m.id,
      fix: '重载该模型页面（设置页 → 重新探测）',
    })
  }
  const f = facts as { w: number; h: number; vis: string; ready: string; url: string; title: string; token: boolean }
  const ev = [`viewport=${f.w}x${f.h}`, `visibility=${f.vis}`, `ready=${f.ready}`, `url=${f.url}`, `title=${f.title}`]
  const recentFail = diag.tail(200, { subject: m.id }).find((e) => e.stage === 'did-fail-load')
  if (recentFail) ev.push(`最近导航失败=${recentFail.detail ?? 'unknown'} @${new Date(recentFail.ts).toISOString()}`)

  if (f.w < 600 || f.h < 400) {
    return check('channel', `channel:viewport:${m.id}`, `${m.displayName} 视口过小`, 'fail', ev, {
      subject: m.id,
      fix: '后台实例必须挂在有真实尺寸的窗口上（宿主窗口）。0×0 会让站点渲染移动端布局，选择器随之全变',
    })
  }
  if (f.ready !== 'complete') {
    return check('channel', `channel:ready:${m.id}`, `${m.displayName} 页面尚未渲染完成`, 'warn', ev, {
      subject: m.id,
      fix: '稍等几秒重跑体检；持续 not complete 说明站点被限速或导航中断',
    })
  }
  return check('channel', `channel:viewport:${m.id}`, `${m.displayName} 通道就绪`, 'pass', ev, { subject: m.id })
}

interface PickedInput {
  total: number
  visible: number
  index: number
  tag: string
  name: string
  placeholder: string
  editable: boolean
}

/**
 * 让页面按 send() 将要使用的同一条通道，报告它选中哪个输入框。
 * 注入脚本不在了（injected=false）时返回 null，调用方退回纯命中数统计。
 */
async function pickInputElement(
  wc: WebContentsView['webContents'],
  spec: AdapterSpec,
  injected: boolean,
): Promise<PickedInput | null> {
  if (!injected) return null
  const call = `window.__torra && window.__torra.pickInput(${JSON.stringify({
    selectors: { input: spec.selectors.input },
  })})`
  return (await wc.executeJavaScript(call, true).catch(() => null)) as PickedInput | null
}

/**
 * L5 选择器命中 + 输入框可写性。
 * 命中数与「能否真的写进去」是两件事：React 受控组件会吞掉直接改 value 的写入，
 * 所以用注入脚本里的同一条原生 setter 通道验证，验证完立刻还原。
 */
async function checkSelectors(
  m: ModelConfig,
  spec: AdapterSpec,
  view: WebContentsView,
): Promise<{ checks: CheckResult[]; injected: boolean }> {
  const wc = view.webContents
  const injected = await wc
    .executeJavaScript(INJECT_SCRIPT + '\n;!!window.__torra', true)
    .then(() => true)
    .catch(() => false)

  const hits = await wc
    .executeJavaScript(
      `(() => {
        const sels = ${JSON.stringify({
          input: spec.selectors.input,
          send: spec.selectors.send ?? '',
          stream: spec.selectors.stream,
          stop: spec.selectors.stop ?? '',
          generating: spec.selectors.generating ?? '',
        })};
        const out = {};
        for (const k in sels) { if (!sels[k]) continue;
          try { out[k] = document.querySelectorAll(sels[k]).length; } catch (e) { out[k] = 'INVALID:' + e.message; }
        }
        const editables = [...document.querySelectorAll('textarea,[contenteditable="true"],input[type=text]')].slice(0, 6)
          .map(el => {
            const r = el.getBoundingClientRect();
            return el.tagName.toLowerCase()
              + (el.id ? '#' + el.id : '')
              + (el.getAttribute('name') ? '[name=' + el.getAttribute('name') + ']' : '')
              + (el.getAttribute('placeholder') ? '[ph=' + el.getAttribute('placeholder').slice(0, 20) + ']' : '')
              + (el.isContentEditable ? ':editable' : '')
              + (r.width && r.height ? ':shown' : ':hidden');
          });
        return { hits: out, editables };
      })()`,
      true,
    )
    .catch(() => null) as { hits: Record<string, number | string>; editables: string[] } | null

  const checks: CheckResult[] = []
  if (!hits) {
    checks.push(
      check('selector', `selector:hits:${m.id}`, `${m.displayName} 选择器命中数读取失败`, 'fail', ['页面脚本抛错'], {
        subject: m.id,
      }),
    )
    return { checks, injected }
  }

  const inputHits = Number(hits.hits.input ?? 0)
  /**
   * 体检必须沿 send() 的同一条选取通道（多命中时可见优先），
   * 否则会出现「体检测 A 框全绿、讨论里写进 B 框」的假阴性。
   */
  const picked = await pickInputElement(wc, spec, injected)
  const visibleHits = picked ? picked.visible : inputHits
  const ev = [`hits=${JSON.stringify(hits.hits)}`, `editables=${hits.editables.join(' | ') || '(none)'}`]
  if (picked) {
    ev.push(
      `写入目标=${picked.tag}${picked.name ? `[name=${picked.name}]` : ''}${
        picked.placeholder ? `[ph=${picked.placeholder}]` : ''
      } 第${picked.index}个（命中 ${picked.total} / 可见 ${picked.visible}）`,
    )
  }

  if (visibleHits !== 1) {
    const suggestion = await suggestInput(wc)
    checks.push(
      check(
        'selector',
        `selector:input:${m.id}`,
        `${m.displayName} 可用输入框异常：${visibleHits} 个可见`,
        'fail',
        ev,
        {
          subject: m.id,
          fix:
            visibleHits === 0
              ? inputHits > 0
                ? '选择器有命中但都不可见：多半打到了自适应 textarea 的隐藏镜像节点。用拾取器在真实可见的框上点一次重设 input'
                : '页面里没有该元素：多半是站点改版。把下面的建议选择器套用到适配器即可'
              : '多个可见元素同时匹配，写入目标不确定 —— 收紧到能唯一命中的属性',
          suggestion: suggestion ?? undefined,
          apply: suggestion
            ? { modelId: m.id, adapterId: m.adapterId ?? m.id, field: 'input', value: suggestion }
            : undefined,
        },
      ),
    )
    return { checks, injected }
  }

  const idx = picked && Number.isInteger(picked.index) ? Math.trunc(picked.index) : 0
  const writable = await wc
    .executeJavaScript(
      `(() => {
        const el = [...document.querySelectorAll(${JSON.stringify(spec.selectors.input)})][${idx}];
        if (!el) return { ok: false, why: 'gone' };
        const tag = el.tagName.toLowerCase();
        if (tag === 'textarea' || tag === 'input') {
          const before = el.value;
          const proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, before + '·');
          el.dispatchEvent(new Event('input', { bubbles: true }));
          const seen = el.value.includes('·');
          setter.call(el, before);
          el.dispatchEvent(new Event('input', { bubbles: true }));
          return { ok: seen && el.value === before, why: 'value=' + JSON.stringify(el.value).slice(0, 30) };
        }
        return { ok: el.isContentEditable, why: 'contenteditable' };
      })()`,
      true,
    )
    .catch(() => ({ ok: false, why: 'script error' })) as { ok: boolean; why: string }

  if (!writable.ok) {
    checks.push(
      check('selector', `selector:writable:${m.id}`, `${m.displayName} 输入框写入不被接受`, 'fail', [ev.join(' '), `why=${writable.why}`], {
        subject: m.id,
        fix: '站点可能用了受控组件之外的写入通道，或该元素是隐藏的镜像节点 —— 用拾取器在真实可见的框上点一次',
      }),
    )
  } else {
    checks.push(check('selector', `selector:input:${m.id}`, `${m.displayName} 输入框命中且可写`, 'pass', [...ev, `writable=${writable.why}`], { subject: m.id }))
  }

  const streamHits = Number(hits.hits.stream ?? 0)
  if (streamHits === 0) {
    checks.push(
      check('selector', `selector:stream:${m.id}`, `${m.displayName} 回复容器选择器当前 0 命中`, 'warn', ev, {
        subject: m.id,
        fix: '新会话页面没有历史消息时 0 命中是正常的；若讨论中始终读不到正文，请用拾取器在回复气泡上点一次重设 stream',
      }),
    )
  } else {
    checks.push(check('selector', `selector:stream:${m.id}`, `${m.displayName} 回复容器可读取`, 'pass', ev, { subject: m.id }))
  }

  if (spec.send_mode === 'click' && Number(hits.hits.send ?? 0) === 0) {
    checks.push(
      check('selector', `selector:send:${m.id}`, `${m.displayName} 发送按钮选择器 0 命中`, 'fail', ev, {
        subject: m.id,
        fix: '去掉 send 选择器并把 send_mode 改为 enter —— 键盘通道不受按钮改名影响',
      }),
    )
  }

  return { checks, injected }
}

/** 用拾取脚本在真实页面上算出一个唯一命中的输入框选择器，作为可直接套用的建议 */
async function suggestInput(wc: Electron.WebContents): Promise<string | null> {
  const scan = await wc
    .executeJavaScript(PICKER_SCRIPT + '\n;window.__torraPicker ? window.__torraPicker.scan() : null', true)
    .catch(() => null) as { input?: Array<{ chosen: string; candidates: Array<{ selector: string; matches: number }> }> } | null
  const first = scan?.input?.[0]
  if (!first) return null
  const unique = first.candidates.find((c) => c.matches === 1)
  return unique?.selector ?? first.chosen ?? null
}

interface ApiProbe {
  status: number | null
  error?: string
  ids: string[]
}

/**
 * GET {baseUrl}/models —— 唯一「不计费、不改状态」就能同时验证
 * 地址、协议与 Key 的 API 探测。
 * 绝不做补全请求：那要花用户的钱，而体检的授权边界是只读。
 * 与设置页的 listRemoteModels 打的是同一个端点，但用途不同：
 * 那边只要 id 清单给用户挑，且只按 openai 头鉴权；这里要状态码与协议差异，
 * 所以各留一份实现，不强行合并。
 */
async function probeApiEndpoint(baseUrl: string, protocol: string, key: string): Promise<ApiProbe> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), 10000)
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/models`, {
      headers: {
        ...(protocol === 'anthropic'
          ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
          : { Authorization: `Bearer ${key}` }),
      },
      signal: ac.signal,
    })
    const body = (await res.json().catch(() => null)) as { data?: unknown; models?: unknown } | null
    const raw = Array.isArray(body?.data) ? body.data : Array.isArray(body?.models) ? body.models : []
    const ids = raw
      .map((x) => {
        if (typeof x === 'string') return x
        if (x && typeof x === 'object') {
          const o = x as { id?: unknown; name?: unknown }
          return typeof o.id === 'string' ? o.id : typeof o.name === 'string' ? o.name : ''
        }
        return ''
      })
      .filter((s): s is string => s.length > 0)
    return { status: res.status, ids }
  } catch (e) {
    return { status: null, error: (e as Error).message, ids: [] }
  } finally {
    clearTimeout(timer)
  }
}

/** L2 API 接入通道：一个 API 模型的四跳 —— 配置 → Key → 端点 → 模型名 */
async function checkApiChannel(deps: DoctorDeps, m: ModelConfig, opts: DoctorOptions): Promise<CheckResult[]> {
  const api = m.api
  const out: CheckResult[] = []
  if (!api) {
    return [
      check('api', `api:cfg:${m.id}`, `${m.displayName} 没有 API 配置`, 'fail', ['transport=api 但 api 字段缺失'], {
        subject: m.id,
        fix: '补齐 baseUrl / model / apiKeyRef / 单价 —— 手工维护 models.json 时最容易漏其中之一',
      }),
    ]
  }

  let host = ''
  let insecure = false
  try {
    const u = new URL(api.baseUrl)
    host = u.hostname
    insecure = u.protocol !== 'https:'
  } catch {
    /* 解析失败交给下面的配置检查统一报 */
  }

  const cfgEv = [
    `baseUrl=${api.baseUrl}`,
    `model=${api.model}`,
    `protocol=${api.protocol ?? 'openai'}`,
    `单价=${api.pricePerMTokIn}/${api.pricePerMTokOut} USD per Mtok`,
    `maxContextTokens=${api.maxContextTokens}`,
  ]

  if (!host || !api.model) {
    out.push(
      check('api', `api:cfg:${m.id}`, `${m.displayName} 的 API 配置不完整`, 'fail', cfgEv, {
        subject: m.id,
        fix: 'baseUrl 要能解析出主机名、model 不能为空。二者之一缺失时请求会在发言之中才失败，错误信息很难读',
      }),
    )
    return out
  }
  if (insecure && !['localhost', '127.0.0.1', '::1'].includes(host)) {
    out.push(
      check('api', `api:tls:${m.id}`, `${m.displayName} 的 baseUrl 不是 https`, 'fail', cfgEv, {
        subject: m.id,
        fix: '明文 HTTP 会让 API Key 连同讨论内容一起被中间方读到。改成 https；自建在本机的服务（localhost）例外',
      }),
    )
    return out
  }
  if (!Number.isFinite(api.pricePerMTokIn) || !Number.isFinite(api.pricePerMTokOut) || api.pricePerMTokIn + api.pricePerMTokOut === 0) {
    out.push(
      check('api', `api:price:${m.id}`, `${m.displayName} 未配置单价`, 'warn', cfgEv, {
        subject: m.id,
        fix: '费用统计与预算熔断按单价折算；单价为 0 时无法判断这场讨论花了多少（不影响能否发言）',
      }),
    )
  } else {
    out.push(check('api', `api:cfg:${m.id}`, `${m.displayName} API 配置可用`, 'pass', cfgEv, { subject: m.id }))
  }

  if (!deps.secrets.has(api.apiKeyRef)) {
    out.push(
      check(
        'api',
        `api:key:${m.id}`,
        `${m.displayName} 缺少 API Key`,
        'fail',
        [`apiKeyRef=${api.apiKeyRef}`, `baseUrl=${api.baseUrl}`],
        { subject: m.id, fix: '在设置页「API 模型」里为该模型填入 Key。这是通道问题，与网页模型的登录态、适配器无关' },
      ),
    )
    return out
  }
  out.push(check('api', `api:key:${m.id}`, `${m.displayName} 已配置 Key`, 'pass', [`apiKeyRef=${api.apiKeyRef}`], { subject: m.id }))

  if (opts.probeApi === false) {
    out.push(
      check('api', `api:reach:${m.id}`, `${m.displayName} 端点连通性未探测`, 'skip', ['本次关闭了联网探测'], {
        subject: m.id,
        fix: '探测只发 GET /models：不计费、不产生对话。关掉后就查不出地址与 Key 写错',
      }),
    )
    return out
  }

  const t0 = Date.now()
  const probe = await probeApiEndpoint(api.baseUrl, api.protocol ?? 'openai', deps.secrets.get(api.apiKeyRef) ?? '')
  const ms = Date.now() - t0
  // 联网留痕：体检对远端只发这一个请求，日志是「确实只读」的凭证
  diag.log({
    ts: t0,
    layer: 'api',
    stage: 'probe-models',
    subject: m.id,
    ok: probe.status !== null && probe.status < 400,
    ms,
    detail: `status=${probe.status ?? 'error'} models=${probe.ids.length}`,
  })

  if (probe.status === null) {
    out.push(
      check('api', `api:reach:${m.id}`, `${m.displayName} 端点请求失败`, 'fail', [`耗时=${ms}ms`, `错误=${probe.error ?? 'unknown'}`], {
        subject: m.id,
        fix: '网络不可达、超时或域名解析失败。先确认 baseUrl 拼写与端口；本机走代理时注意代理未必覆盖主进程的 fetch',
      }),
    )
    return out
  }
  if (probe.status >= 400) {
    out.push(
      check('api', `api:reach:${m.id}`, `${m.displayName} 端点返回 ${probe.status}`, 'fail', [`GET ${api.baseUrl}/models -> ${probe.status}`], {
        subject: m.id,
        fix:
          probe.status === 401 || probe.status === 403
            ? 'Key 无效、过期，或与协议不匹配：anthropic 用 x-api-key + anthropic-version，openai 用 Bearer'
            : probe.status === 404
              ? '地址的路径段不对：多数网关要求 baseUrl 以 /v1 结尾，确认是否漏写或写重'
              : '状态由服务端给出（限流、额度、模型下线），按端点返回内容排查',
      }),
    )
    return out
  }
  out.push(
    check(
      'api',
      `api:reach:${m.id}`,
      `${m.displayName} 端点可达`,
      'pass',
      [`GET /models -> ${probe.status}`, `清单条数=${probe.ids.length}`, `耗时=${ms}ms`],
      { subject: m.id },
    ),
  )

  if (probe.ids.length === 0) {
    out.push(
      check('api', `api:model:${m.id}`, `${m.displayName} 无法核对模型名`, 'skip', ['清单为空或格式不识别'], {
        subject: m.id,
        fix: '部分网关不提供 /models 清单。此时模型名只能人工确认，发言之中报 400/404 再回来查',
      }),
    )
  } else {
    const listed = probe.ids.includes(api.model)
    out.push(
      check(
        'api',
        `api:model:${m.id}`,
        listed ? `${m.displayName} 的模型名在端点清单中` : `${m.displayName} 的模型名不在端点清单中`,
        listed ? 'pass' : 'warn',
        [`model=${api.model}`, `清单=${probe.ids.slice(0, 8).join(', ')}${probe.ids.length > 8 ? ' …' : ''}`],
        {
          subject: m.id,
          fix: listed
            ? undefined
            : '模型名写错会在发言之中才炸成 400/404，且很容易被当成「模型拒绝回答」。从清单里挑一个准确的 id',
        },
      ),
    )
  }
  return out
}

/**
 * L6 主持角色：只判「谁有资格当主持」。
 * 通道层面的 Key、端点、模型名由 api 层统一负责（见 checkApiChannel）；
 * 在这里重复一遍会产出两条 `moderator:key` 与 `api:key` 互相矛盾的结论，
 * 用户不知道先修哪条 —— 检查项一多，归因价值就开始倒退。
 */
async function checkModerator(deps: DoctorDeps): Promise<CheckResult[]> {
  const id = deps.moderatorId()
  if (!id) {
    return [
      check('moderator', 'moderator:none', '未指定主持模型（无主持降级模式）', 'skip', ['moderatorId=null'], {
        fix: '无主持时讨论照常进行，只是没有阶段性小结与议程干预',
      }),
    ]
  }
  const cfg = deps.models().find((m) => m.id === id)
  if (!cfg) {
    return [
      check('moderator', `moderator:cfg:${id}`, `主持模型 ${id} 不存在`, 'fail', [`moderatorId=${id}`], {
        fix: '在设置里换一个存在的模型作为主持',
      }),
    ]
  }
  if (!cfg.enabled) {
    return [
      check('moderator', `moderator:enabled:${id}`, `${cfg.displayName} 已被停用，却仍被指认为主持`, 'warn', ['enabled=false'], {
        subject: id,
        fix: '要么重新启用该模型，要么改指一个在用的模型；停用状态下的主持不参与发言',
      }),
    ]
  }
  if (!cfg.api) {
    return [
      check(
        'moderator',
        `moderator:transport:${id}`,
        `${cfg.displayName} 是网页通道，不能担任主持`,
        'fail',
        ['主持小结走 API 直连（独立 system prompt + JSON 输出），网页通道无法产出结构化结果'],
        { subject: id, fix: '在设置页新建一个 API 模型并指认为主持，或切换无主持降级模式' },
      ),
    ]
  }
  if (!cfg.supportsStructuredOutput) {
    return [
      check('moderator', `moderator:cap:${id}`, `${cfg.displayName} 不具备结构化输出资格`, 'fail', ['supportsStructuredOutput=false'], {
        subject: id,
        fix: '主持需要稳定输出 JSON，在设置页把该模型标记为支持结构化输出，或改用已标记的模型',
      }),
    ]
  }
  return [
    check('moderator', `moderator:role:${id}`, `${cfg.displayName} 具备主持资格`, 'pass', [
      'transport=api',
      'supportsStructuredOutput=true',
      `通道与 Key 见「API 接入」层的 ${cfg.id} 检查项`,
    ], { subject: id }),
  ]
}

/** L7 结果产出：最近一场会话能否解析、缺席占比、报告是否生成 */
async function checkOutput(deps: DoctorDeps): Promise<CheckResult[]> {
  let recs: Awaited<ReturnType<SessionStore['list']>> = []
  try {
    recs = await deps.store.list()
  } catch (e) {
    return [
      check('output', 'output:store', '会话存储读取失败', 'fail', [(e as Error).message], {
        fix: '检查 sessions 目录权限与磁盘空间',
      }),
    ]
  }
  if (recs.length === 0) {
    return [check('output', 'output:store', '尚无历史会话', 'skip', [`dir=${path.join(deps.rootDir, 'sessions')}`])]
  }
  const latest = recs[0]!
  const utterances = latest.utterances ?? []
  const absent = utterances.filter((u) => u.absent)
  const ev = [
    `latest=${latest.id}`,
    `createdAt=${new Date(latest.createdAt).toISOString()}`,
    `utterances=${utterances.length}`,
    `absent=${absent.length}`,
    `finishedReason=${latest.finishedReason ?? '-'}`,
  ]
  for (const u of absent.slice(0, 4)) {
    const who = deps.models().find((m) => m.id === u.agentId)?.displayName ?? u.agentId
    ev.push(`缺席：${who} · ${u.absentReason ?? '-'} · ${u.content.slice(0, 160)}`)
  }

  const report = await deps.store.loadReport(latest.id).catch(() => null)
  ev.push(`report=${report ? 'ok' : 'none'}`)

  if (utterances.length > 0 && absent.length === utterances.length) {
    return [
      check('output', 'output:last', '最近一场全员缺席', 'fail', ev, {
        fix: '全员缺席通常是通道级问题（未登录或视口/网络），先看上方登录态与通道层的结论，不要逐个改适配器',
      }),
    ]
  }
  if (absent.length > 0) {
    return [check('output', 'output:last', '最近一场存在缺席', 'warn', ev, {
      fix: '展开该条缺席可看到当时的现场快照；对应层的体检结论会指出真正原因',
    })]
  }
  return [check('output', 'output:last', '最近一场会话产出正常', 'pass', ev)]
}

/** 报告落盘：设置页与 CLI 共用，避免两套格式化代码漂移 */
export async function persistReport(report: DoctorReport, rootDir: string): Promise<{ json: string; md: string }> {
  const dir = path.join(rootDir, 'diagnose')
  await fs.mkdir(dir, { recursive: true })
  const stamp = new Date(report.startedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const json = path.join(dir, `doctor-${stamp}.json`)
  const md = path.join(dir, `doctor-${stamp}.md`)
  await fs.writeFile(json, JSON.stringify(report, null, 2), 'utf8')
  await fs.writeFile(md, renderDoctorMarkdown(report), 'utf8')
  await fs.writeFile(path.join(dir, 'latest.json'), JSON.stringify(report, null, 2), 'utf8')
  await fs.writeFile(path.join(dir, 'latest.md'), renderDoctorMarkdown(report), 'utf8')
  report.files = { json, md }
  return report.files
}

export function renderDoctorMarkdown(r: DoctorReport): string {
  const icon: Record<CheckResult['status'], string> = { pass: '✅', warn: '⚠️', fail: '❌', skip: '·' }
  const lines: string[] = [
    `# Torra 链路体检 ${new Date(r.startedAt).toLocaleString()}`,
    '',
    `- userData：\`${r.userData}\``,
    r.scope ? `- 范围：${r.scope}` : '',
    `- 结论：通过 ${r.summary.pass} / 提醒 ${r.summary.warn} / 失败 ${r.summary.fail} / 跳过 ${r.summary.skip}`,
    r.blockingLayer ? `- 最先阻断在：${LAYER_LABEL[r.blockingLayer]}` : '',
    '',
  ]
  for (const layer of LAYER_ORDER) {
    const items = r.checks.filter((c) => c.layer === layer)
    if (items.length === 0) continue
    lines.push('', `## ${LAYER_LABEL[layer]}`, '')
    for (const c of items) {
      lines.push(`- ${icon[c.status]} **${c.title}**${c.subject ? ` _(${c.subject})_` : ''}`)
      for (const e of c.evidence) lines.push(`    - \`${e}\``)
      if (c.fix) lines.push(`    - 修复：${c.fix}`)
      if (c.suggestion) lines.push(`    - 建议：\`${c.suggestion}\``)
    }
  }
  return lines.filter((l) => l !== '').join('\n') + '\n'
}
