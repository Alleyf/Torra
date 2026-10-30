/**
 * 装载 @agentclientprotocol/sdk。
 *
 * 这个包是 ESM-only（exports 里只声明了 import），而 Torra 主进程编译目标是
 * CommonJS —— tsc 会把 `await import()` 降级成 require()，那就直接 ERR_REQUIRE_ESM。
 * 所以这里用 Function 构造一个不被降级的原生 import()，与 assistant/pi-sdk.ts 同一手法。
 *
 * 与 pi SDK 的差别值得记一笔：ACP SDK 只有一个 peer 依赖 zod（纯 JS，没有原生模块），
 * 不会像 undici 那样在模块加载期就摸 Node 20.18 没有的 API。也就是说它进主进程的
 * 代价是可控的 —— 真正不设防的是 agent 那一侧，而 agent 永远在别的进程里。
 *
 * 这里刻意**不**从包里 import 类型，而是自己声明用到的那一小块接口：
 * 协议包的类型定义跟着上游一起动，我们只依赖运行时真正用到的那几个函数，
 * 升级时炸的应该是「接口对不上」，而不是「某个上游类型文件改了个形状」。
 */

/** 我们用到的那一小块 SDK 接口 */
export interface AcpSdkSurface {
  /** 建一个客户端 */
  client(options?: { name?: string }): AcpClientApp
  /** 把字节流包成 JSON-RPC 消息流（协议用的是 NDJSON：一行一个 JSON） */
  ndJsonStream(
    output: WritableStream<Uint8Array>,
    input: ReadableStream<Uint8Array>,
    options?: unknown,
  ): AcpStream
}

/** 消息流：读出来是协议消息，写进去也是协议消息 */
export interface AcpStream {
  writable: WritableStream<unknown>
  readable: ReadableStream<unknown>
}

/** 请求处理器收到的上下文 */
export interface AcpHandlerContext<P> {
  method: string
  params: P
  signal: AbortSignal
}

export interface AcpClientApp {
  onRequest<P, R>(method: string, handler: (ctx: AcpHandlerContext<P>) => R | Promise<R>): AcpClientApp
  onNotification<P>(method: string, handler: (ctx: AcpHandlerContext<P>) => void | Promise<void>): AcpClientApp
  connect(stream: AcpStream): AcpConnection
}

/** 连接对象：agent 那一侧的方法都从这里发出去 */
export interface AcpConnection {
  readonly agent: {
    request<R = unknown>(method: string, params?: unknown): Promise<R>
    notify(method: string, params?: unknown): Promise<void>
  }
  close(error?: unknown): void
  readonly closed: Promise<void>
}

const nativeImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>

let cached: Promise<AcpSdkSurface> | undefined

/** 加载 SDK（首次 await 后复用同一实例） */
export function loadAcpSdk(): Promise<AcpSdkSurface> {
  cached ??= nativeImport('@agentclientprotocol/sdk') as Promise<AcpSdkSurface>
  return cached
}
