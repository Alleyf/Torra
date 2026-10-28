/**
 * 插件代码的运行入口：Electron utilityProcess 里的一份最小宿主。
 *
 * 它只做三件事：装载插件入口、把 ctx.* 的调用转给主进程、把主进程的工具调用转给插件。
 *
 * 边界要说清：这是**崩溃隔离**，不是安全沙箱 —— 插件仍然拿得到完整的 Node 能力。
 * 能力清单约束的是 ctx 这条受支持的通道（存储目录、域名白名单、密钥前缀），
 * 真正防恶意代码要靠「装之前人看着源码点启用」，和现有 JS 扩展同一口径。
 *
 * 另一个约束是协议：这一层不能 import electron，子进程里没有 electron 模块，
 * 只能走 process.parentPort。
 */

type Port = {
  postMessage(message: unknown): void
  on(event: 'message', listener: (event: { data: unknown }) => void): void
}

type PluginContext = {
  id: string
  version: string
  dataDir: string
  log(level: 'debug' | 'info' | 'warn' | 'error', message: string): void
  storage: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<boolean>
    list(): Promise<string[]>
  }
  fetch: (input: { url: string; method?: string; headers?: Record<string, string>; body?: string }) => Promise<{
    status: number
    headers: Record<string, string>
    body: string
  }>
  secret: (name: string) => Promise<string | null>
  /**
   * 借宿主已配置的 API 模型做一次性补全（清单里必须声明 ai 能力）。
   * 没有对话历史：多步流程由插件自己拼 prompt，宿主不替它记上下文。
   */
  ai: {
    complete(input: { system?: string; prompt: string; maxTokens?: number; modelId?: string }): Promise<{
      text: string
      modelId: string
      model: string
      usage: { promptTokens: number; completionTokens: number; costUsd: number }
    }>
  }
  tools: { handle(name: string, fn: (params: Record<string, unknown>) => unknown): void }
  rpc: { handle(name: string, fn: (params: Record<string, unknown>) => unknown): void }
}

function requirePort(): Port {
  const p = (process as unknown as { parentPort?: Port }).parentPort
  if (!p) {
    // 直接 `node runtime-entry.js` 跑起来是没有意义的：没有宿主可连
    console.error('torra plugin runtime must be started by Torra')
    process.exit(2)
    throw new Error('缺少宿主端口')
  }
  return p
}

const port = requirePort()

let seq = 0
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
const handlers = new Map<string, (params: Record<string, unknown>) => unknown>()
const rpcHandlers = new Map<string, (params: Record<string, unknown>) => unknown>()

function callHost(method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const id = ++seq
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`宿主调用 ${method} 超时（${timeoutMs}ms）`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      reject: (e) => {
        clearTimeout(timer)
        reject(e)
      },
    })
    port.postMessage({ t: 'call', id, method, params })
  })
}

/** 把任意抛出物变成一句能写进日志的话 */
function errText(error: unknown): string {
  if (error instanceof Error) return error.message
  try {
    return String(error)
  } catch {
    return '未知错误'
  }
}

port.on('message', (event) => {
  const msg = event.data
  if (!msg || typeof msg !== 'object') return
  const m = msg as Record<string, unknown>
  if (m.t === 'reply' && typeof m.id === 'number') {
    const waiter = pending.get(m.id)
    if (!waiter) return
    pending.delete(m.id)
    if (m.ok === true) waiter.resolve(m.value)
    else waiter.reject(new Error(String(m.error ?? '宿主调用失败')))
    return
  }
  if (m.t === 'call' && typeof m.id === 'number' && typeof m.method === 'string') {
    void dispatch(m.method, (m.params ?? {}) as Record<string, unknown>).then(
      (value) => port.postMessage({ t: 'reply', id: m.id, ok: true, value }),
      (error) => port.postMessage({ t: 'reply', id: m.id, ok: false, error: errText(error) }),
    )
  }
})

async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  if (method === 'tool.run') {
    const name = String(params.name ?? '')
    const handler = handlers.get(name)
    if (!handler) throw new Error(`插件没有实现工具「${name}」`)
    return await handler((params.params ?? {}) as Record<string, unknown>)
  }
  if (method === 'rpc.call') {
    const name = String(params.name ?? '')
    const handler = rpcHandlers.get(name)
    if (!handler) throw new Error(`插件没有实现接口「${name}」`)
    return await handler((params.params ?? {}) as Record<string, unknown>)
  }
  throw new Error(`未知方法：${method}`)
}

const id = String(process.env.TORRA_PLUGIN_ID ?? '')
const version = String(process.env.TORRA_PLUGIN_VERSION ?? '0.0.0')
const mainFile = String(process.env.TORRA_PLUGIN_MAIN ?? '')
const dataDir = String(process.env.TORRA_PLUGIN_DATA ?? '')

const ctx: PluginContext = {
  id,
  version,
  dataDir,
  log(level, message) {
    port.postMessage({ t: 'log', level, message: String(message).slice(0, 4000) })
  },
  storage: {
    get: (key) => callHost('storage.get', { key }).then((v) => (v === undefined ? undefined : v)),
    set: (key, value) =>
      callHost('storage.set', { key, value }).then(() => undefined),
    delete: (key) => callHost('storage.delete', { key }).then((v) => v === true),
    list: () => callHost('storage.list', {}).then((v) => (Array.isArray(v) ? (v as string[]) : [])),
  },
  fetch: async (input) => {
    const value = await callHost('net.fetch', {
      url: input.url,
      method: input.method ?? 'GET',
      headers: input.headers ?? {},
      ...(input.body !== undefined ? { body: input.body } : {}),
    }, 45_000)
    return value as { status: number; headers: Record<string, string>; body: string }
  },
  secret: (name) => callHost('secret.get', { name }).then((v) => (typeof v === 'string' ? v : null)),
  ai: {
    // 模型一次回答可能要一两分钟：宿主给 30s 默认值会把长答案拦腰截断
    complete: (input) => callHost('ai.complete', { ...input }, 240_000) as Promise<{
      text: string
      modelId: string
      model: string
      usage: { promptTokens: number; completionTokens: number; costUsd: number }
    }>,
  },
  tools: {
    handle(name, fn) {
      if (typeof name !== 'string' || !name) throw new Error('工具名不能为空')
      if (typeof fn !== 'function') throw new Error('工具处理器必须是函数')
      handlers.set(name, fn)
    },
  },
  rpc: {
    handle(name, fn) {
      if (typeof name !== 'string' || !/^[a-z][a-z0-9_.-]{0,63}$/.test(name)) {
        // 带上出事的名字：只有规则时，插件作者得逐个接口去猜是哪一条
        throw new Error(
          `接口名「${String(name)}」不合法：要以小写字母开头，只含小写字母/数字/点/下划线/连字符`,
        )
      }
      if (typeof fn !== 'function') throw new Error('接口处理器必须是函数')
      rpcHandlers.set(name, fn)
    },
  },
}

process.on('uncaughtException', (error) => {
  port.postMessage({ t: 'fatal', error: errText(error) })
  process.exit(1)
})
process.on('unhandledRejection', (reason) => {
  port.postMessage({ t: 'fatal', error: errText(reason) })
  process.exit(1)
})

/** 原生 import：CJS 产物里 `import()` 会被 tsc 改成 require，ESM 插件就装不进来 */
const nativeImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<unknown>

async function boot(): Promise<void> {
  if (!mainFile || !id) {
    port.postMessage({ t: 'fatal', error: '缺少插件入口配置' })
    process.exit(2)
    return
  }
  const { pathToFileURL } = await import('node:url')
  const mod = (await nativeImport(pathToFileURL(mainFile).href)) as {
    activate?: (ctx: PluginContext) => unknown
    default?: { activate?: (ctx: PluginContext) => unknown }
  }
  const activate = mod.activate ?? mod.default?.activate
  if (typeof activate !== 'function') {
    port.postMessage({ t: 'fatal', error: '插件入口没有导出 activate(ctx)' })
    process.exit(2)
    return
  }
  await activate(ctx)
  port.postMessage({ t: 'ready', tools: [...handlers.keys()] })
}

void boot().catch((error) => {
  port.postMessage({ t: 'fatal', error: errText(error) })
  process.exit(1)
})
