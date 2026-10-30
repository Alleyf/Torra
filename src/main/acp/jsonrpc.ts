/**
 * ACP 的传输层：stdio 上的 NDJSON，一行一个 JSON-RPC 2.0 消息。
 *
 * 为什么自己写，不装 @agentclientprotocol/sdk：
 *
 * 那个包是 ESM-only（exports 只声明 import），而 Torra 主进程编译目标是 CommonJS，
 * 装载它只能靠 Function 构造一个不被 tsc 降级的原生 import()。那条路走通过一次，
 * 但它的代价是「主进程从此要为第三方 ESM 留一条装载通道」—— 而这类包看着轻，
 * 依赖树里随时可能长出一个在模块加载期就摸 Node 版本 API 的东西
 * （pi SDK 那套 undici 就是这么把助手一条消息都发不出去的）。
 *
 * ACP 这一侧其实不需要那些：协议面就是 JSON-RPC over stdio，
 * NDJSON 的行分隔也没有二义性。自己写换来的是三样确定的东西 ——
 * 主进程不再有任何 ESM 装载通道、peer 依赖归零、升级面归零。
 *
 * 只实现用得上的那部分：请求、通知、答复、错误。不做批量、不做取消传播
 * （session/cancel 是协议自己的方法，走的是正常请求通道）。
 */

import type { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'

/** 收请求的方法 → 处理函数 */
export type RequestHandler<P = unknown, R = unknown> = (params: P) => R | Promise<R>
/** 收通知的方法 → 处理函数 */
export type NotificationHandler<P = unknown> = (params: P) => void | Promise<void>

/** JSON-RPC 错误码：方法不存在（我们自己没注册处理函数时用它回话） */
const METHOD_NOT_FOUND = -32601
/** 内部错误 */
const INTERNAL_ERROR = -32000

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: unknown) => void
}

/**
 * 一条 NDJSON 上的 JSON-RPC 连接。
 *
 * 生命周期：构造即开始读；stdin 写出去；进程退出或 close() 之后 closed 兑现，
 * 所有在等的请求都以错误收场 —— 不能让它们永远挂着，那会让调用方的 await 永远不返回。
 */
export class NdJsonRpc {
  private readonly input: Readable
  private readonly output: Writable
  /** 半行的余量：一次 data 事件给的不一定是一整行 */
  private buffer = ''
  /** UTF-8 解码器：一个多字节字符可能横跨两个 data 事件 */
  private readonly decoder = new StringDecoder('utf8')
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private readonly requestHandlers = new Map<string, RequestHandler<never, unknown>>()
  private readonly notificationHandlers = new Map<string, NotificationHandler<never>>()
  private ended = false
  private resolveClosed!: () => void
  /** 连接什么时候断的（断开即兑现） */
  readonly closed: Promise<void>

  constructor(input: Readable, output: Writable) {
    this.input = input
    this.output = output
    this.closed = new Promise<void>((resolve) => {
      this.resolveClosed = resolve
    })
    input.on('data', (chunk: Buffer | string) => {
      this.feed(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    })
    input.on('end', () => this.end())
    input.on('close', () => this.end())
    input.on('error', (e: unknown) => {
      this.failAll(e instanceof Error ? e : new Error(String(e)))
      this.end()
    })
  }

  /** 注册一个「对方发来的请求」的处理函数 */
  onRequest<P = unknown, R = unknown>(method: string, handler: RequestHandler<P, R>): this {
    this.requestHandlers.set(method, handler as RequestHandler<never, unknown>)
    return this
  }

  /** 注册一个「对方发来的通知」的处理函数 */
  onNotification<P = unknown>(method: string, handler: NotificationHandler<P>): this {
    this.notificationHandlers.set(method, handler as NotificationHandler<never>)
    return this
  }

  /** 发一个请求，等它的答复 */
  request<R = unknown>(method: string, params?: unknown): Promise<R> {
    if (this.ended) return Promise.reject(new Error('连接已经断了'))
    const id = this.nextId++
    const payload = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }
    return new Promise<R>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.write(payload)
    })
  }

  /** 发一个通知：不等答复 */
  notify(method: string, params?: unknown): Promise<void> {
    if (this.ended) return Promise.reject(new Error('连接已经断了'))
    this.write({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
    return Promise.resolve()
  }

  /** 断开：把在等的请求都以错误收场，然后兑现 closed */
  close(error?: unknown): void {
    this.failAll(error instanceof Error ? error : new Error('连接已关闭'))
    this.end()
    try {
      this.output.end()
    } catch {
      /* 管道可能已经断了 */
    }
  }

  // ------------------------------------------------------------------
  // 内部
  // ------------------------------------------------------------------

  private write(payload: unknown): void {
    try {
      this.output.write(JSON.stringify(payload) + '\n')
    } catch (e) {
      this.failAll(e instanceof Error ? e : new Error(String(e)))
    }
  }

  private feed(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk)
    let idx = this.buffer.indexOf('\n')
    while (idx >= 0) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (line) {
        try {
          this.handleLine(line)
        } catch (e) {
          // 一行坏消息不该掀掉整条连接：记下来，继续读下一行
          this.write({
            jsonrpc: '2.0',
            id: null,
            error: { code: INTERNAL_ERROR, message: `收到坏消息：${e instanceof Error ? e.message : String(e)}` },
          })
        }
      }
      idx = this.buffer.indexOf('\n')
    }
  }

  private handleLine(line: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(line) as Record<string, unknown>
    } catch {
      return // 不是 JSON 的行（比如适配器自己打的日志）直接丢
    }
    const id = msg.id
    const method = typeof msg.method === 'string' ? msg.method : undefined
    const params = (msg.params ?? {}) as never

    // 答复：id 回来找等它的那次请求
    if (method === undefined && id !== undefined && id !== null) {
      const pending = this.pending.get(Number(id))
      if (!pending) return
      this.pending.delete(Number(id))
      const err = msg.error as { code?: number; message?: string } | undefined
      if (err) {
        const e = new Error(err.message ?? '对方报了错')
        ;(e as Error & { code?: number }).code = err.code
        pending.reject(e)
      } else {
        pending.resolve(msg.result)
      }
      return
    }

    if (method === undefined) return

    // 通知：没有 id，不用回话
    if (id === undefined || id === null) {
      const handler = this.notificationHandlers.get(method)
      if (!handler) return
      void (async () => {
        try {
          await handler(params)
        } catch {
          /* 通知出错没有回话的地方 —— 记在别处 */
        }
      })()
      return
    }

    // 请求：必须回话，否则对方会一直等
    const handler = this.requestHandlers.get(method)
    void (async () => {
      if (!handler) {
        this.write({
          jsonrpc: '2.0',
          id,
          error: { code: METHOD_NOT_FOUND, message: `Torra 不处理这个请求：${method}` },
        })
        return
      }
      try {
        const result = await handler(params)
        this.write({ jsonrpc: '2.0', id, result: result ?? {} })
      } catch (e) {
        this.write({
          jsonrpc: '2.0',
          id,
          error: { code: INTERNAL_ERROR, message: e instanceof Error ? e.message : String(e) },
        })
      }
    })()
  }

  private failAll(e: Error): void {
    for (const [, pending] of this.pending) pending.reject(e)
    this.pending.clear()
  }

  private end(): void {
    if (this.ended) return
    this.ended = true
    this.failAll(new Error('连接已断开'))
    this.resolveClosed()
  }
}
