/**
 * 一个插件 = 一个 utilityProcess + 一层能力闸门。
 *
 * 为什么不用 worker_threads / 主进程直跑：插件是第三方代码，死循环、OOM、未捕获异常
 * 都会把宿主一起带走。子进程的成本是一层 RPC，换来的是「插件坏了，Torra 还在」。
 *
 * 闸门只拦 ctx 通道（storage / net / secret / log）。插件仍可 require('node:fs') ——
 * 它本来就是可执行代码，装之前的源码审阅是最后一道防线，这里不假装自己是沙箱。
 */

import { utilityProcess, type UtilityProcess } from 'electron'
import path from 'node:path'
import type { PluginManifest, PluginRuntimeStatus } from '../../shared/plugins'
import { AI_PROMPT_MAX_CHARS, AI_SYSTEM_MAX_CHARS, type PluginAi } from './ai'
import { PluginStorage } from './storage'

const START_TIMEOUT_MS = 10_000
const HOST_CALL_TIMEOUT_MS = 30_000
const TOOL_TIMEOUT_MS = 120_000
const NET_TIMEOUT_MS = 45_000
/** 面板发起的 ai.* 会等一次模型补全（插件侧给它 240s），外框必须比它长，否则先被这里掐断 */
const AI_RPC_TIMEOUT_MS = 280_000
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024
const SECRET_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/
/** 单插件同时在跑的 AI 请求上限 */
const AI_MAX_INFLIGHT = 2

/**
 * 插件进程能拿到的系统环境。Windows OpenSSH 少了 ProgramData 会直接退出 255
 * 且不打印错误，所以它和 PATH、SystemRoot 一样属于必要项。
 */
export function pluginChildEnv(
  source: NodeJS.ProcessEnv,
  extra: Record<string, string>,
): Record<string, string> {
  return {
    PATH: source.PATH ?? '',
    SystemRoot: source.SystemRoot ?? '',
    ProgramData: source.ProgramData ?? '',
    TEMP: source.TEMP ?? '',
    TMP: source.TMP ?? '',
    USERPROFILE: source.USERPROFILE ?? '',
    HOME: source.HOME ?? '',
    ...(source.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: source.SSH_AUTH_SOCK } : {}),
    ...extra,
  }
}

export interface PluginRuntimeDeps {
  dataDir: string
  /** runtime-entry.js 的绝对路径（编译产物） */
  entryPath: string
  secrets: { get(ref: string): Promise<string | null> | string | null }
  log(event: { stage: string; subject: string; ok: boolean; detail: string }): void
  /** 插件借宿主模型；没传就是没接这条通道，声明了 ai 的插件会收到明确拒绝 */
  ai?: PluginAi
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class PluginRuntime {
  status: PluginRuntimeStatus = 'stopped'
  error: string | undefined
  private child: UtilityProcess | null = null
  private pending = new Map<number, Pending>()
  private seq = 0
  private storage: PluginStorage
  private stopping = false
  private readyWaiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = []
  private toolNames = new Set<string>()
  private aiInflight = 0

  constructor(
    readonly manifest: PluginManifest,
    readonly dir: string,
    private readonly deps: PluginRuntimeDeps,
  ) {
    this.storage = new PluginStorage(path.join(deps.dataDir, 'plugin-data', manifest.id, 'store.json'))
  }

  /** 已由插件在启动时报备的工具名：清单声明了但没实现的，宿主不注册 */
  get registeredTools(): string[] {
    return [...this.toolNames]
  }

  async start(): Promise<void> {
    if (this.status === 'ready' || this.status === 'starting') return
    if (!this.manifest.main) {
      this.status = 'failed'
      this.error = '插件没有 main 入口'
      return
    }
    this.stopping = false
    this.status = 'starting'
    this.error = undefined
    const mainFile = path.resolve(this.dir, this.manifest.main)
    this.child = utilityProcess.fork(this.deps.entryPath, [], {
      cwd: this.dir,
      // 只给插件它需要的：主进程环境里可能带着 token / 代理口令
      env: pluginChildEnv(process.env, {
        TORRA_PLUGIN_ID: this.manifest.id,
        TORRA_PLUGIN_VERSION: this.manifest.version,
        TORRA_PLUGIN_MAIN: mainFile,
        TORRA_PLUGIN_DATA: path.join(this.deps.dataDir, 'plugin-data', this.manifest.id),
      }),
    })
    this.child.on('message', (message: unknown) => {
      void this.onMessage(message)
    })
    this.child.on('exit', (code) => {
      this.child = null
      for (const waiter of this.readyWaiters.splice(0)) {
        waiter.reject(new Error(`插件进程退出了（code ${code}）`))
      }
      for (const [, p] of this.pending) {
        clearTimeout(p.timer)
        p.reject(new Error('插件进程已退出'))
      }
      this.pending.clear()
      if (this.stopping) {
        this.status = 'stopped'
        return
      }
      this.status = 'failed'
      this.error = this.error ?? `插件进程退出（code ${code}）`
      this.deps.log({ stage: 'plugin:exit', subject: this.manifest.id, ok: false, detail: this.error })
    })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.error = `插件在 ${START_TIMEOUT_MS}ms 内没有就绪`
        this.status = 'failed'
        this.child?.kill()
        reject(new Error(this.error))
      }, START_TIMEOUT_MS)
      this.readyWaiters.push({
        resolve: () => {
          clearTimeout(timer)
          resolve()
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
    })
  }

  stop(): void {
    this.stopping = true
    this.child?.kill()
    this.child = null
    this.status = 'stopped'
    this.toolNames.clear()
  }

  async invokeTool(name: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.status !== 'ready') throw new Error(`插件「${this.manifest.id}」未就绪：${this.error ?? this.status}`)
    if (!this.toolNames.has(name)) throw new Error(`插件没有实现工具「${name}」`)
    return await this.callChild('tool.run', { name, params }, TOOL_TIMEOUT_MS)
  }

  /** 面板发起的接口调用：名字由插件自己定，宿主只保证「打到的是这个插件」 */
  async invokeRpc(name: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.status !== 'ready') throw new Error(`插件「${this.manifest.id}」未就绪：${this.error ?? this.status}`)
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(name)) throw new Error(`接口名不合法：${name}`)
    // 合并插件会把接口名加上模块前缀（scholar.ai.plan）：AI 调用照样要拿长超时
    const timeout = name.startsWith('ai.') || name.includes('.ai.') ? AI_RPC_TIMEOUT_MS : HOST_CALL_TIMEOUT_MS
    return await this.callChild('rpc.call', { name, params }, timeout)
  }

  private callChild(method: string, params: Record<string, unknown>, timeoutMs = HOST_CALL_TIMEOUT_MS): Promise<unknown> {
    const child = this.child
    if (!child) return Promise.reject(new Error('插件进程不在'))
    return new Promise((resolve, reject) => {
      const id = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`插件调用 ${method} 超时（${timeoutMs}ms）`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      child.postMessage({ t: 'call', id, method, params })
    })
  }

  private reply(id: number, ok: boolean, value: unknown, error: unknown): void {
    this.child?.postMessage(ok ? { t: 'reply', id, ok: true, value } : { t: 'reply', id, ok: false, error: String(error ?? '失败') })
  }

  private async onMessage(message: unknown): Promise<void> {
    if (!message || typeof message !== 'object') return
    const msg = message as Record<string, unknown>
    if (msg.t === 'ready') {
      const tools = Array.isArray(msg.tools) ? msg.tools.filter((x): x is string => typeof x === 'string') : []
      this.toolNames = new Set(tools)
      this.status = 'ready'
      this.error = undefined
      for (const waiter of this.readyWaiters.splice(0)) waiter.resolve()
      this.deps.log({ stage: 'plugin:ready', subject: this.manifest.id, ok: true, detail: `工具 ${tools.length} 个` })
      return
    }
    if (msg.t === 'fatal') {
      this.error = String(msg.error ?? '插件启动失败')
      this.status = 'failed'
      for (const waiter of this.readyWaiters.splice(0)) waiter.reject(new Error(this.error))
      this.deps.log({ stage: 'plugin:fatal', subject: this.manifest.id, ok: false, detail: this.error })
      this.child?.kill()
      return
    }
    if (msg.t === 'log') {
      const level = String(msg.level ?? 'info')
      this.deps.log({
        stage: 'plugin:log',
        subject: `${this.manifest.id}:${level}`,
        ok: level !== 'error',
        detail: String(msg.message ?? '').slice(0, 2000),
      })
      return
    }
    if (msg.t === 'reply' && typeof msg.id === 'number') {
      const waiter = this.pending.get(msg.id)
      if (!waiter) return
      this.pending.delete(msg.id)
      clearTimeout(waiter.timer)
      if (msg.ok === true) waiter.resolve(msg.value)
      else waiter.reject(new Error(String(msg.error ?? '调用失败')))
      return
    }
    if (msg.t === 'call' && typeof msg.id === 'number' && typeof msg.method === 'string') {
      try {
        const value = await this.handleHostCall(msg.method, (msg.params ?? {}) as Record<string, unknown>)
        this.reply(msg.id, true, value, null)
      } catch (error) {
        this.reply(msg.id, false, null, (error as Error).message)
      }
    }
  }

  /** 插件能调到的宿主能力，逐条对 permissions —— 没声明就是拒绝，不靠插件自觉 */
  private async handleHostCall(method: string, params: Record<string, unknown>): Promise<unknown> {
    const perms = this.manifest.permissions
    if (method === 'log.write') throw new Error('日志接口是 ctx.log')
    if (method.startsWith('storage.')) {
      this.requirePerm('storage')
      if (method === 'storage.get') return this.storage.get(params.key)
      if (method === 'storage.set') {
        this.storage.set(params.key, params.value)
        return null
      }
      if (method === 'storage.delete') return this.storage.delete(params.key)
      if (method === 'storage.list') return this.storage.list()
      throw new Error(`未知存储方法：${method}`)
    }
    if (method === 'net.fetch') {
      const url = String(params.url ?? '')
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        throw new Error(`URL 不合法：${url}`)
      }
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('只允许 http(s)')
      const host = parsed.hostname.toLowerCase()
      if (!perms.includes(`net:${host}`)) {
        throw new Error(`没有访问 ${host} 的权限：在清单的 permissions 里加 net:${host}`)
      }
      const rawMethod = String(params.method ?? 'GET').toUpperCase()
      const allowed = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE']
      if (!allowed.includes(rawMethod)) throw new Error(`不支持的方法：${rawMethod}`)
      const headers = params.headers && typeof params.headers === 'object' ? (params.headers as Record<string, string>) : undefined
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), NET_TIMEOUT_MS)
      try {
        const res = await fetch(url, {
          method: rawMethod,
          headers,
          ...(typeof params.body === 'string' && rawMethod !== 'GET' && rawMethod !== 'HEAD' ? { body: params.body } : {}),
          // 手动跟跳转：自动跟会把请求带到白名单之外的域名
          redirect: 'manual',
          signal: controller.signal,
        })
        if (res.status >= 300 && res.status < 400) {
          throw new Error(`不允许重定向到 ${res.headers.get('location') ?? '未知地址'}`)
        }
        // 先看声明的长度：几 GB 的响应不该等到读完再判超限
        const declared = Number(res.headers.get('content-length') ?? 0)
        if (declared > MAX_RESPONSE_BYTES) throw new Error(`响应超过 ${MAX_RESPONSE_BYTES / 1024 / 1024}MB`)
        const buffer = Buffer.from(await res.arrayBuffer())
        if (buffer.length > MAX_RESPONSE_BYTES) throw new Error(`响应超过 ${MAX_RESPONSE_BYTES / 1024 / 1024}MB`)
        const outHeaders: Record<string, string> = {}
        res.headers.forEach((value, key) => {
          outHeaders[key] = value
        })
        return { status: res.status, headers: outHeaders, body: buffer.toString('utf8') }
      } finally {
        clearTimeout(timer)
      }
    }
    if (method === 'ai.models') {
      this.requirePerm('ai')
      if (!this.deps.ai || typeof this.deps.ai.models !== 'function') {
        throw new Error('宿主没有接入 AI 模型清单，这次调用被拒绝')
      }
      return this.deps.ai.models()
    }
    if (method === 'ai.complete') {
      this.requirePerm('ai')
      if (!this.deps.ai) throw new Error('宿主没有接入 AI 通道，这次调用被拒绝')
      const prompt = String(params.prompt ?? '')
      if (!prompt.trim()) throw new Error('AI 请求缺少 prompt')
      if (prompt.length > AI_PROMPT_MAX_CHARS) {
        throw new Error(`AI 请求过长（${prompt.length} 字，上限 ${AI_PROMPT_MAX_CHARS}）：先裁摘要再问`)
      }
      const system = String(params.system ?? '')
      if (system.length > AI_SYSTEM_MAX_CHARS) {
        throw new Error(`AI 系统提示过长（${system.length} 字，上限 ${AI_SYSTEM_MAX_CHARS}）`)
      }
      // 一台机器上两个插件同时狂发请求时，先把并发按住了：模型端点通常按分钟限流，
      // 放行一串只会集体 429，不如让第三路排队
      if (this.aiInflight >= AI_MAX_INFLIGHT) {
        throw new Error(`这个插件已有 ${AI_MAX_INFLIGHT} 个 AI 请求在跑，等一个结束再试`)
      }
      this.aiInflight += 1
      try {
        return await this.deps.ai.complete({
          prompt,
          ...(system ? { system } : {}),
          ...(params.maxTokens !== undefined ? { maxTokens: Number(params.maxTokens) } : {}),
          ...(typeof params.modelId === 'string' && params.modelId.trim() ? { modelId: params.modelId.trim() } : {}),
        })
      } finally {
        this.aiInflight -= 1
      }
    }
    if (method === 'secret.get') {
      this.requirePerm('secrets')
      const name = String(params.name ?? '').trim()
      if (!SECRET_NAME_RE.test(name)) throw new Error('密钥名只能用字母、数字、点、下划线、连字符')
      // 前缀由宿主钉死：一个插件只能读到自己的密钥，不能借 ref 去读模型的 API Key
      const ref = `plugin:${this.manifest.id}:${name}`
      return (await this.deps.secrets.get(ref)) ?? null
    }
    throw new Error(`未知宿主方法：${method}`)
  }

  private requirePerm(perm: string): void {
    if (!(this.manifest.permissions as string[]).includes(perm)) {
      throw new Error(`插件没有声明「${perm}」能力：拒绝调用`)
    }
  }
}
