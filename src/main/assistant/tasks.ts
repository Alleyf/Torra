/**
 * 定时任务：定义、到点判定、产出清理。
 *
 * 设计上的四个取舍：
 *
 * 1. **只有「每天 HH:MM」一种节奏**。cron 表达式对桌面用户来说是把配置当编程题，
 *    而这里真正需要的是「每天早上帮我看一眼」。多一种节奏就多一类没测过的分支。
 * 2. **只在应用运行期间触发**。Torra 没有常驻服务，也不该偷偷装系统级计划任务 ——
 *    那正是用户不想看到的那类「批处理脚本」。错过的那一天在下次启动时补跑一次，
 *    不连补多天（三天没开电脑就补三份日报，没有意义）。
 * 3. **产出清理按文件 mtime**，不靠模型；模型只负责写，删除由确定性代码做。
 * 4. **写盘串行**。定时器、手动「立即运行」、设置页改开关可能同时发生，
 *    两个 read-modify-write 交错会把刚建的任务吞掉。
 *
 * 本文件不 import Electron：时间判定、存储、清理都能在系统 Node 下离线回归。
 */

import { randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import {
  SCHEDULE_PROMPT_MAX,
  SCHEDULE_RETENTION_DEFAULT,
  SCHEDULE_RETENTION_MAX,
  SCHEDULE_TITLE_MAX,
  isScheduleTime,
  type ScheduledRunView,
  type ScheduledTaskInput,
  type ScheduledTaskResult,
  type ScheduledTaskView,
  type ScheduledTasksView,
} from '../../shared/assistant'

const DAY_MS = 24 * 60 * 60 * 1000
/** 单次清理的遍历上限：产出目录被用户改指到系统盘时，不能把整盘走一遍 */
const PRUNE_WALK_MAX = 5000

export interface StoredTask {
  id: string
  title: string
  prompt: string
  time: string
  enabled: boolean
  outDir: string
  retentionDays: number
  modelId?: string
  createdAt: number
  lastRun?: ScheduledRunView
}

interface TaskStore {
  version: 1
  tasks: StoredTask[]
}

export function tasksFileOf(dataDir: string): string {
  return path.join(dataDir, 'assistant-tasks.json')
}

/** 默认产出根：任务没指定 outDir 时落在它下面的一级子目录 */
export function tasksRootOf(dataDir: string): string {
  return path.join(dataDir, 'assistant-tasks')
}

function emptyStore(): TaskStore {
  return { version: 1, tasks: [] }
}

async function readStore(dataDir: string): Promise<TaskStore> {
  try {
    const raw = await fs.readFile(tasksFileOf(dataDir), 'utf8')
    const parsed = JSON.parse(raw) as Partial<TaskStore>
    const tasks = Array.isArray(parsed?.tasks) ? parsed.tasks : []
    return { version: 1, tasks: tasks.filter((t): t is StoredTask => isStoredTask(t)) }
  } catch {
    // 文件不存在、被手改坏、权限不足：都当成「还没有任务」。
    // 下一次写入会覆盖掉坏文件 —— 但至少不会让应用起不来。
    return emptyStore()
  }
}

/** 读盘时的形状校验：手改配置文件不该让调度器在半场崩掉 */
function isStoredTask(v: unknown): v is StoredTask {
  if (!v || typeof v !== 'object') return false
  const t = v as Record<string, unknown>
  return (
    typeof t.id === 'string' &&
    typeof t.title === 'string' &&
    typeof t.prompt === 'string' &&
    isScheduleTime(t.time) &&
    typeof t.enabled === 'boolean' &&
    typeof t.outDir === 'string' &&
    typeof t.retentionDays === 'number' &&
    typeof t.createdAt === 'number'
  )
}

/** 串行写盘：读-改-写之间不能被另一个 tick 插进来 */
const writeChains = new Map<string, Promise<unknown>>()

function serialize<T>(dataDir: string, task: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(dataDir) ?? Promise.resolve()
  const next = prev.then(task, task)
  writeChains.set(
    dataDir,
    next.catch(() => undefined),
  )
  return next
}

async function writeStore(dataDir: string, store: TaskStore): Promise<void> {
  const file = tasksFileOf(dataDir)
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

// ---------------------------------------------------------------------------
// 时间
// ---------------------------------------------------------------------------

function slotOfDay(day: Date, time: string): Date {
  const h = Number(time.slice(0, 2))
  const m = Number(time.slice(3, 5))
  const d = new Date(day)
  d.setHours(h, m, 0, 0)
  return d
}

/** 上一次已经跑过的时刻（没跑过就是 0） */
function lastRunAt(t: StoredTask): number {
  return t.lastRun?.startedAt ?? 0
}

/**
 * 这一格从什么时候开始算「该跑」。
 *
 * 只看 lastRun 会把「今天 08:00 建的任务」当成「错过了今天这一格」—— 下午建完立刻补跑，
 * 界面上还会显示一个已经过去的「下次」。建任务之前的那一格不属于它。
 */
function dueSince(t: StoredTask): number {
  return Math.max(lastRunAt(t), t.createdAt)
}

/**
 * 下一次触发时刻。
 *
 * 今天这一格已经跑过 → 明天；今天是启用后的今天但还没到点 → 今天。
 * 停用时不返回（界面显示「已停用」，不显示一个不会发生的时刻）。
 */
export function nextRunAtOf(t: StoredTask, now: number): number | undefined {
  if (!t.enabled) return undefined
  const today = slotOfDay(new Date(now), t.time).getTime()
  return dueSince(t) < today ? today : today + DAY_MS
}

/** 这一格是不是该跑了：过点了、还没跑过、且启用着 */
export function isDue(t: StoredTask, now: number): boolean {
  if (!t.enabled) return false
  const today = slotOfDay(new Date(now), t.time).getTime()
  return now >= today && dueSince(t) < today
}

// ---------------------------------------------------------------------------
// 视图与增删改
// ---------------------------------------------------------------------------

function toView(t: StoredTask, now: number): ScheduledTaskView {
  const next = nextRunAtOf(t, now)
  return {
    id: t.id,
    title: t.title,
    prompt: t.prompt,
    time: t.time,
    enabled: t.enabled,
    outDir: t.outDir,
    retentionDays: t.retentionDays,
    ...(t.modelId ? { modelId: t.modelId } : {}),
    createdAt: t.createdAt,
    ...(next !== undefined ? { nextRunAt: next } : {}),
    ...(t.lastRun ? { lastRun: t.lastRun } : {}),
  }
}

/** 给 UI / 工具读的清单：顺带把「只在应用运行时触发」这句话带回去 */
export async function viewScheduledTasks(dataDir: string, now = Date.now()): Promise<ScheduledTasksView> {
  const store = await readStore(dataDir)
  return {
    ok: true,
    file: tasksFileOf(dataDir),
    dir: tasksRootOf(dataDir),
    tasks: store.tasks.map((t) => toView(t, now)).sort((a, b) => a.time.localeCompare(b.time) || a.createdAt - b.createdAt),
    note: '定时任务只在 Torra 运行期间触发；错过的那一天会在下次启动时补跑一次。',
  }
}

function normalizeInput(input: ScheduledTaskInput): { ok: true; value: ScheduledTaskInput } | { ok: false; reason: string } {
  const title = String(input?.title ?? '').trim()
  const prompt = String(input?.prompt ?? '').trim()
  const time = String(input?.time ?? '').trim()
  if (!title) return { ok: false, reason: '任务名不能为空' }
  if (title.length > SCHEDULE_TITLE_MAX) return { ok: false, reason: `任务名最多 ${SCHEDULE_TITLE_MAX} 字` }
  if (!prompt) return { ok: false, reason: '任务指令不能为空' }
  if (prompt.length > SCHEDULE_PROMPT_MAX) return { ok: false, reason: `任务指令最多 ${SCHEDULE_PROMPT_MAX} 字` }
  if (!isScheduleTime(time)) return { ok: false, reason: '时间要写成 HH:MM（24 小时制）' }
  const retention = Math.round(Number(input.retentionDays ?? SCHEDULE_RETENTION_DEFAULT))
  if (!Number.isFinite(retention) || retention < 0 || retention > SCHEDULE_RETENTION_MAX) {
    return { ok: false, reason: `保留天数要在 0-${SCHEDULE_RETENTION_MAX} 之间（0 = 不清理）` }
  }
  const outDir = input.outDir ? String(input.outDir).trim() : ''
  if (outDir && !path.isAbsolute(outDir)) return { ok: false, reason: '产出目录必须是绝对路径；留空则用默认目录' }
  const modelId = input.modelId ? String(input.modelId).trim() : ''
  return {
    ok: true,
    value: {
      title,
      prompt,
      time,
      ...(outDir ? { outDir } : {}),
      retentionDays: retention,
      ...(modelId ? { modelId } : {}),
      enabled: input.enabled !== false,
    },
  }
}

export async function addScheduledTask(
  dataDir: string,
  input: ScheduledTaskInput,
  now = Date.now(),
): Promise<ScheduledTaskResult> {
  const checked = normalizeInput(input)
  if (!checked.ok) return { ok: false, reason: checked.reason }
  const v = checked.value
  return serialize(dataDir, async () => {
    const store = await readStore(dataDir)
    const id = `task-${randomUUID().slice(0, 8)}`
    const outDir = v.outDir ?? path.join(tasksRootOf(dataDir), id)
    try {
      await fs.mkdir(outDir, { recursive: true })
    } catch (e) {
      return { ok: false, reason: `产出目录不可用：${(e as Error).message}` }
    }
    const task: StoredTask = {
      id,
      title: v.title,
      prompt: v.prompt,
      time: v.time,
      enabled: v.enabled !== false,
      outDir,
      retentionDays: v.retentionDays ?? SCHEDULE_RETENTION_DEFAULT,
      ...(v.modelId ? { modelId: v.modelId } : {}),
      createdAt: now,
    }
    store.tasks.push(task)
    await writeStore(dataDir, store)
    return { ok: true, id, task: toView(task, now) }
  })
}

export async function removeScheduledTask(dataDir: string, id: string): Promise<ScheduledTaskResult> {
  return serialize(dataDir, async () => {
    const store = await readStore(dataDir)
    const next = store.tasks.filter((t) => t.id !== id)
    if (next.length === store.tasks.length) return { ok: false, reason: '任务不存在，可能已经被删除' }
    await writeStore(dataDir, { version: 1, tasks: next })
    return { ok: true, id }
  })
}

export async function setScheduledTaskEnabled(
  dataDir: string,
  id: string,
  enabled: boolean,
  now = Date.now(),
): Promise<ScheduledTaskResult> {
  return serialize(dataDir, async () => {
    const store = await readStore(dataDir)
    const task = store.tasks.find((t) => t.id === id)
    if (!task) return { ok: false, reason: '任务不存在，可能已经被删除' }
    task.enabled = enabled
    await writeStore(dataDir, store)
    return { ok: true, id, task: toView(task, now) }
  })
}

/** 一轮跑完的账：只更新这一条的 lastRun，别把别的任务的手改覆盖掉 */
export async function markScheduledRun(dataDir: string, id: string, run: ScheduledRunView): Promise<void> {
  await serialize(dataDir, async () => {
    const store = await readStore(dataDir)
    const task = store.tasks.find((t) => t.id === id)
    if (!task) return
    task.lastRun = run
    await writeStore(dataDir, store)
  })
}

/** 给调度器用：直接拿存盘形状，省一次视图转换 */
export async function readStoredTasks(dataDir: string): Promise<StoredTask[]> {
  return (await readStore(dataDir)).tasks
}

// ---------------------------------------------------------------------------
// 产出清理
// ---------------------------------------------------------------------------

/**
 * 删除 outDir 里超过保留期的文件（按 mtime）。
 *
 * 只删文件、不删目录树本身；删空的子目录顺手收掉，失败也不算错。
 * retentionDays=0 表示不清理 —— 「永久保留」是显式选择，不是漏配。
 */
export async function pruneOutput(outDir: string, retentionDays: number, now = Date.now()): Promise<number> {
  if (!retentionDays || retentionDays <= 0) return 0
  const cutoff = now - retentionDays * DAY_MS
  let removed = 0
  let seen = 0
  const dirs: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8 || seen >= PRUNE_WALK_MAX) return
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const ent of entries) {
      if (seen >= PRUNE_WALK_MAX) return
      seen++
      const abs = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        await walk(abs, depth + 1)
        dirs.push(abs)
        continue
      }
      if (!ent.isFile()) continue
      const st = await fs.stat(abs).catch(() => null)
      if (!st || st.mtimeMs >= cutoff) continue
      await fs.unlink(abs).catch(() => undefined)
      removed++
    }
  }
  await walk(outDir, 0)
  // 深到浅收空目录：先删子目录，父目录才可能变空
  for (const d of dirs.sort((a, b) => b.length - a.length)) {
    await fs.rmdir(d).catch(() => undefined)
  }
  return removed
}

// ---------------------------------------------------------------------------
// 调度循环
// ---------------------------------------------------------------------------

export interface TaskRunOutcome {
  ok: boolean
  error?: string
  sessionFile?: string
  files?: string[]
  note?: string
}

export interface TaskSchedulerDeps {
  dataDir: string
  /** 真正执行一轮：由桥接层用受限工具集跑 */
  run(task: ScheduledTaskView): Promise<TaskRunOutcome>
  notify?(input: { title: string; body: string }): void
  log?(entry: { subject?: string; ok: boolean; detail?: string }): void
  /** 任务清单或运行记录变了：界面据此重读 */
  onChange?(): void
  /** 测试用；默认 30 秒 */
  intervalMs?: number
}

export interface TaskScheduler {
  /** 跑一次到点检查（可注入 now，测试不等真实时钟） */
  tick(now?: number): Promise<void>
  /** 立即手动跑一条（不更新 lastRun 之外的调度语义，也不会补跑别的） */
  runNow(id: string): Promise<TaskRunOutcome>
  /** 正在跑的任务 id */
  running(): string[]
  stop(): void
}

export function startTaskScheduler(deps: TaskSchedulerDeps): TaskScheduler {
  const running = new Set<string>()
  let tickChain: Promise<void> = Promise.resolve()
  let stopped = false

  const execute = async (task: ScheduledTaskView, now: number): Promise<TaskRunOutcome> => {
    running.add(task.id)
    const startedAt = now
    let outcome: TaskRunOutcome
    try {
      outcome = await deps.run(task)
    } catch (e) {
      outcome = { ok: false, error: (e as Error).message || '运行失败' }
    }
    const ms = Date.now() - startedAt
    running.delete(task.id)
    // 清理不交给模型：产物目录里哪些该删，是保留期说了算
    const pruned = await pruneOutput(task.outDir, task.retentionDays).catch(() => 0)
    await markScheduledRun(deps.dataDir, task.id, {
      startedAt,
      ms,
      ok: outcome.ok,
      ...(outcome.error ? { error: outcome.error } : {}),
      ...(outcome.sessionFile ? { sessionFile: outcome.sessionFile } : {}),
      ...(outcome.note ? { note: outcome.note } : {}),
      files: outcome.files ?? [],
    })
    deps.log?.({
      subject: task.id,
      ok: outcome.ok,
      detail: `${task.title} ${outcome.ok ? '成功' : `失败：${outcome.error ?? '未知'}`} ${Math.round(ms / 1000)}s${
        pruned ? ` 清理 ${pruned} 个旧文件` : ''
      }`,
    })
    deps.notify?.({
      title: `定时任务 · ${task.title}`,
      body: outcome.ok
        ? `${outcome.files?.length ?? 0} 个文件 · ${Math.round(ms / 1000)}s`
        : `失败：${outcome.error ?? '未知原因'}`,
    })
    deps.onChange?.()
    return outcome
  }

  const tick = (now = Date.now()): Promise<void> => {
    // 同一时刻只跑一次检查：30 秒的 interval 不该叠在「上一轮还在跑」上面
    tickChain = tickChain.then(async () => {
      if (stopped) return
      const tasks = await readStoredTasks(deps.dataDir).catch(() => [])
      for (const t of tasks) {
        if (stopped) return
        if (!isDue(t, now) || running.has(t.id)) continue
        await execute(toView(t, now), now)
      }
    })
    return tickChain.catch(() => undefined)
  }

  const timer = setInterval(() => void tick(), deps.intervalMs ?? 30_000)
  // 不让这个定时器把进程钉住：测试和退出都不该被它拖住
  timer.unref?.()
  // 启动即检查一次：应用关掉了几小时，今天那一格可能已经过了
  queueMicrotask(() => void tick())

  return {
    tick,
    async runNow(id) {
      const tasks = await readStoredTasks(deps.dataDir)
      const t = tasks.find((x) => x.id === id)
      if (!t) return { ok: false, error: '任务不存在' }
      if (running.has(id)) return { ok: false, error: '这条任务正在运行，等它跑完再试' }
      return execute(toView(t, Date.now()), Date.now())
    },
    running: () => [...running],
    stop() {
      stopped = true
      clearInterval(timer)
    },
  }
}
