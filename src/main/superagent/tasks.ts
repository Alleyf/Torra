/**
 * 超智能体（super agent）的任务层：Router 分派出去的每一个 Worker 都在这里登记。
 *
 * 为什么每个任务一个 Worker：dsh 的超智能体把「一个会话」降级成实现细节，
 * 模型侧要能同时推进几个互不干扰的任务，人侧要能一眼看见每一块活的状态。
 * 一个会话里串行跑，等于把多任务的上限又交回给人的注意力 —— 那正是这篇文章
 * 要跨过的那条线。
 *
 * 所以这里给每个任务独立一份 AcpService：独立的进程、独立的授权、独立的事件流。
 * 一个任务的权限请求不会挡另一个任务；一个任务崩了不会带走别的。
 */
import { AcpService } from '../acp'
import type { HostEvent } from '../../shared/host'
import type { AcpPermissionRequest } from '../../shared/acp'
import type { SuperTask as SharedSuperTask, TaskStage, TaskToolCall } from '../../shared/superagent'

export type { TaskStage, TaskToolCall }

/**
 * 任务本体。
 *
 * 与共享词表的差别只有一项：挂起的授权请求本体只留在主进程里 ——
 * 界面要的是它的一句摘要（waitingText），不该拿到整份 JSON。
 */
export interface SuperTask extends SharedSuperTask {
  /** 挂起的授权请求本体：允许/拒绝要按它给的选项回，不能自己编一个 optionId */
  pendingPermission?: AcpPermissionRequest
}

/** 每个 Worker 一个服务实例：AcpService 内部只有一个活动会话 */
export interface WorkerHooks {
  onEvent: (event: HostEvent) => void
  onPermission: (request: AcpPermissionRequest) => void
}

export interface SuperAgentDeps {
  service: (hooks: WorkerHooks) => AcpService
  agentTitleOf: (agentId: string) => string
  cwdOf: () => string
  log?: (e: { layer: string; stage: string; ok: boolean; detail: string; ts: number }) => void
  tailChars?: number
}

const DEFAULT_TAIL = 4000

export class SuperAgentTasks {
  private readonly deps: SuperAgentDeps
  private readonly tail: number
  private readonly tasks = new Map<string, SuperTask>()
  private readonly services = new Map<string, AcpService>()
  private readonly listeners = new Set<(task: SuperTask) => void>()
  private seq = 0

  constructor(deps: SuperAgentDeps) {
    this.deps = deps
    this.tail = deps.tailChars ?? DEFAULT_TAIL
  }

  list(): SuperTask[] {
    return [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  detail(id: string): SuperTask | undefined {
    return this.tasks.get(id)
  }

  /** 订阅任务变化；返回取消订阅 */
  onEvent(fn: (task: SuperTask) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private touch(task: SuperTask, patch: Partial<SuperTask>): void {
    Object.assign(task, patch, { updatedAt: Date.now() })
    for (const fn of this.listeners) fn(task)
  }

  /**
   * 分派一个任务。
   *
   * 失败要落到任务的 error 上而不是抛出：Router 是「按工具结果决定下一步」的，
   * 抛回去它看到的就是一次调用异常，分不清「这个 Worker 起不来」和「网络断了」。
   */
  async spawn(input: { title: string; goal: string; agentId: string; cwd?: string }): Promise<SuperTask> {
    const now = Date.now()
    const id = `tk-${(++this.seq).toString(36)}-${Math.random().toString(36).slice(2, 7)}`
    const task: SuperTask = {
      id,
      title: input.title,
      goal: input.goal,
      agentId: input.agentId,
      agentTitle: this.deps.agentTitleOf(input.agentId),
      cwd: input.cwd ?? this.deps.cwdOf(),
      stage: 'pending',
      createdAt: now,
      updatedAt: now,
      outputTail: '',
      toolCalls: [],
      rounds: 0,
    }
    this.tasks.set(id, task)
    this.emit(task)

    const service = this.deps.service({
      onEvent: (event) => this.feed(task, event),
      onPermission: (request) =>
        this.touch(task, {
          stage: 'waiting_input',
          waitingText: describePermission(request),
          pendingPermission: request,
        }),
    })
    this.services.set(id, service)

    const started = await service.start(input.agentId, { cwd: task.cwd })
    if (!started.ok) {
      this.fail(task, `这一家没起来：${started.error ?? '未知原因'}`)
      return task
    }
    this.touch(task, { stage: 'working' })
    const sent = await service.prompt(task.goal)
    if (!sent.ok) this.fail(task, sent.error ?? '第一句话没送进去')
    return task
  }

  /** 向一个任务插话（Router 转达人的追问） */
  async intervene(id: string, text: string): Promise<{ ok: boolean; error?: string }> {
    const task = this.tasks.get(id)
    const service = task ? this.services.get(id) : undefined
    if (!task || !service) return { ok: false, error: '没有这个任务' }
    const r = await service.prompt(text)
    if (r.ok) this.touch(task, { stage: 'working', waitingText: undefined, rounds: task.rounds + 1 })
    return r
  }

  /** 回一个挂起的授权请求 */
  respondPermission(id: string, requestId: string, decision: 'allow' | 'deny'): boolean {
    const service = this.services.get(id)
    const task = this.tasks.get(id)
    if (!service || !task) return false
    // 只收「正挂着的那一个、而且就是这一个号」：回错号等于替另一个请求拍板
    if (task.stage !== 'waiting_input' || task.pendingPermission?.id !== requestId) return false
    // 允许就是选它给的第一项，拒绝就是不选 —— 选项名要照它自己给的回，不能自己编
    const ok = service.respondPermission(requestId, {
      optionId: decision === 'allow' ? (task.pendingPermission.options[0]?.optionId ?? null) : null,
    })
    if (ok) this.touch(task, { stage: 'working', waitingText: undefined, pendingPermission: undefined })
    return ok
  }

  cancel(id: string): void {
    const task = this.tasks.get(id)
    if (!task) return
    void this.services.get(id)?.stop().catch(() => undefined)
    this.services.delete(id)
    // 挂起的授权也要一起撤：不然取消之后界面上还留着一张等你点头的卡
    this.touch(task, { stage: 'cancelled', waitingText: undefined, pendingPermission: undefined })
  }

  /** 失败的任务留着：Router 要能看见它为什么失败，而不是只有「没了」 */
  fail(task: SuperTask, error: string): void {
    this.deps.log?.({
      layer: 'superagent',
      stage: 'task-failed',
      ok: false,
      ts: Date.now(),
      detail: `${task.title}：${error}`,
    })
    this.touch(task, { stage: 'failed', error })
  }

  /** 已经收摊的阶段：迟到的活事件不许把它们改回去 */
  private static readonly SETTLED: readonly TaskStage[] = ['cancelled', 'failed', 'done']

  private feed(task: SuperTask, event: HostEvent): void {
    /*
     * 取消是异步的：`stop()` 杀掉进程树要一会儿，被杀那一家在死之前还会把
     * 缓冲区里的几条事件吐出来。那些事件到这里时任务已经收摊了 ——
     * 照常处理就会把 `cancelled` 改回 `working`，界面上看着像「取消没生效」。
     * 所以终态一律不再受理活事件；输出尾巴与工具轨迹已经定格，不再追加。
     */
    if (SuperAgentTasks.SETTLED.includes(task.stage)) return
    switch (event.kind) {
      case 'turn.started':
        this.touch(task, { rounds: task.rounds + 1 })
        break
      case 'message.delta':
        if (event.channel === 'text') {
          this.touch(task, { outputTail: (task.outputTail + event.delta).slice(-this.tail) })
        }
        break
      case 'item.started':
        this.touch(task, {
          toolCalls: [...task.toolCalls, { id: event.itemId, title: event.title, status: event.status ?? 'running' }],
        })
        break
      case 'item.completed': {
        this.touch(
          task,
          {
            toolCalls: task.toolCalls.map((c) =>
              c.id === event.itemId ? { ...c, status: event.status ?? 'done', text: event.text } : c,
            ),
          },
        )
        break
      }
      case 'turn.completed':
        // 一轮结束就是这一块活干完了。早先这里写的是 working —— 于是任务
        // 永远停在「进行中」，取消键一直在，看着像停不下来。
        this.touch(task, { stage: 'done' })
        break
      case 'session.faulted':
        this.fail(task, event.text)
        break
      default:
        break
    }
  }

  private emit(task: SuperTask): void {
    for (const fn of this.listeners) fn(task)
  }
}

/**
 * 授权请求的一句话：界面与 Router 都只该看到「它在问什么」，不该看到整份 JSON。
 */
export function describePermission(request: AcpPermissionRequest): string {
  const tool = request.toolKind ?? '工具'
  return request.title ? `${tool} · ${request.title}` : tool
}
