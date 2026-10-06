/**
 * ESM-only 依赖的装载入口（目前是 pi SDK 与 typebox），同时是给 Node 20 打兼容补丁的地方。
 *
 * `@earendil-works/pi-coding-agent` 是 ESM-only —— 它的 exports 表只声明了
 * `"import"` 条件，所以 `require()` 它连模块解析都过不去（ERR_PACKAGE_PATH_NOT_EXPORTED），
 * 不是 Node 版本问题，升级到 36 也一样。`typebox@1.x` 同理，exports 里只有
 * import/default 指向 index.mjs，`require()` 直接 ERR_REQUIRE_ESM。
 *
 * 而 Torra 主进程编译目标是 CommonJS，tsc 会把 `await import('x')` 降级成
 * `Promise.resolve().then(() => require('x'))`，写动态 import 也照样炸。
 * 这里用 Function 构造出一个不被降级的原生 `import()`，让 Node 的 ESM 加载器真正加载包。
 *
 * 类型侧不受影响：`import type` 在编译期擦除，走的是 d.ts 解析，不需要运行时支持。
 * 所以本项目的其余文件一律 `import type { ... } from '@earendil-works/pi-coding-agent'`，
 * 取值只通过这里的 `loadPiSdk()` / `loadTypeBox()`。
 */

import type * as PiSdkNamespace from '@earendil-works/pi-coding-agent'
import workerThreads = require('node:worker_threads')

export type PiSdk = typeof PiSdkNamespace
export type TypeBox = { Type: typeof import('typebox').Type }

/**
 * Electron 33 内置的是 Node 20.18，没有 `worker_threads.markAsUncloneable`
 * （Node 22.4+ 才有）。pi SDK 依赖的 undici 8 在模块加载时就把这个函数解构走，
 * 并在每次构造 Headers/Response 时调用它 —— 取到 undefined 就是
 * 「webidl.util.markAsUncloneable is not a function」，助手一条消息都发不出去。
 *
 * 这里补一个空实现：该 API 只是给对象打上「禁止 structuredClone」的标记，
 * 本进程不做跨 worker 传递，空实现没有副作用。补丁必须在 undici 第一次被
 * require 之前生效，所以放在这个装载入口的模块顶层，而不是 loadPiSdk() 内部。
 */
const wt = workerThreads as unknown as Record<string, unknown>
if (typeof wt.markAsUncloneable !== 'function') {
  wt.markAsUncloneable = function markAsUncloneable(): void {
    /* Node < 22.4 没有这个能力，undici 只需要它别炸 */
  }
}

const nativeImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<unknown>

let cached: Promise<PiSdk> | undefined

/** 加载 SDK 模块命名空间（首次 await 后复用同一实例）。 */
export function loadPiSdk(): Promise<PiSdk> {
  cached ??= nativeImport('@earendil-works/pi-coding-agent') as Promise<PiSdk>
  return cached
}

let cachedTypeBox: Promise<TypeBox> | undefined

/** 加载 typebox 的 `Type` 构造器（首次 await 后复用同一实例）。 */
export function loadTypeBox(): Promise<TypeBox> {
  cachedTypeBox ??= nativeImport('typebox') as Promise<TypeBox>
  return cachedTypeBox
}
