/**
 * Torra 的工具契约：参数是一份纯 JSON Schema，执行体与是哪一家 agent 无关。
 *
 * 为什么不再用 pi SDK 带来的 TypeBox：
 *
 * 1. **主进程不该为了一份参数说明背一条 ESM 装载通道**。TypeBox 1.x 只有 ESM
 *    出口（exports 里只有 import/default 指向 index.mjs），而 Torra 主进程编译成
 *    CommonJS，要用它就得留一条原生 `import()` 的后门（pi-sdk.ts 那套用 Function
 *    构造出来的加载器）。这条后门已经害过一次：undici 在模块加载期就调
 *    `markAsUncloneable`，Electron 33 内置的 Node 20 没有这个函数，于是
 *    助手一条消息都发不出去。为一个 schema 生成器背这种风险不划算。
 *
 * 2. **Torra 的工具要同时喂给两种 agent**。一半走内嵌会话（pi 的自定义工具），
 *    一半走 MCP 通道给外面的 Claude Code / Codex / OpenCode。MCP 的原生形态就是
 *    JSON Schema，TypeBox 只是恰好能生成它 —— 既然如此，直接就说 JSON Schema。
 *
 * 3. **TypeBox 1.x 本来就已经在产出纯 JSON**。实测（2026-10，typebox 1.3.7）：
 *    `Type.Optional` 不带任何 symbol，`required` 在 `Type.Object` 那一刻就算好了，
 *    `JSON.stringify` 出来是一份普通 JSON Schema。下面这个构造器不是「仿个大概」，
 *    是照着它的输出逐条对齐的：同样的输入，两边产出同一份 JSON。
 *
 * 那边的校验还在吗？在。pi-ai 的 `validateToolArguments` 先看 schema 上有没有
 * TypeBox 的 Kind 标记：没有就走 JSON Schema 那一支（typebox/schema 的 Check），
 * 必填、类型、枚举照样拦。实测过：缺必填、类型不对、enum 外的值都被拒。
 */

/** 一份 JSON Schema。Torra 只用它能表达的那几种形状，多的不写。 */
export type JsonSchema = Record<string, unknown>

/** 工具执行完回给模型的内容块 */
export interface TorraToolResult {
  /** 回给模型的内容。现在只有文字一种。 */
  content: Array<{ type: 'text'; text: string }>
  /** 结构化的附带信息，给界面与日志看，不进模型上下文 */
  details?: unknown
}

/**
 * 一个工具。
 *
 * 刻意与任何一家 agent 的类型无关：这份定义要么被 pi 收下（内嵌会话），
 * 要么被端成 MCP 工具（外部 agent），两边都不需要认识对方。
 */
export interface TorraTool {
  /** 工具名：模型按它调用，不能重名 */
  name: string
  /** 展示名：给人看的 */
  label: string
  /** 说明：给模型看的 */
  description: string
  /** 参数说明：一份纯 JSON Schema */
  parameters: JsonSchema
  /**
   * 执行体。
   *
   * params 各工具各带各的形状，这里不替它们统一 —— 统一了就得写一堆
   * 泛型体操，而这份类型的作用只是「两边都接得上」，不是替模型推导参数。
   */
  execute(id: string, params: any, signal?: AbortSignal): Promise<TorraToolResult>
}

/**
 * 可选标记的账本。
 *
 * `Optional()` 不能把标记写进 JSON —— 那个字段是要原样发给模型和 agent 的，
 * 多一个自定义键就是多一份噪音。它记在这里，装配对象时才算 required。
 * 用 WeakSet 而不是 Set：这些 schema 是短命对象，记久了只是内存泄漏。
 */
const optionalSchemas = new WeakSet<object>()

/** 构造参数时可带的东西 */
export interface SchemaOptions {
  description?: string
  enum?: string[]
  [key: string]: unknown
}

/**
 * 参数构造器。
 *
 * 名字沿用 TypeBox 的 `Type`，是因为工具定义里已经写了一百多处 `Type.String(...)`
 * 这样的写法 —— 换构造器就等于把这 1.4k 行全部重排，而重排不会让工具更好。
 * 换的是**依赖**，不是写法。
 */
export const Type = {
  String(options?: SchemaOptions): JsonSchema {
    return { type: 'string', ...options }
  },
  Number(options?: SchemaOptions): JsonSchema {
    return { type: 'number', ...options }
  },
  Integer(options?: SchemaOptions): JsonSchema {
    return { type: 'integer', ...options }
  },
  Boolean(options?: SchemaOptions): JsonSchema {
    return { type: 'boolean', ...options }
  },
  /**
   * 任意值。
   *
   * JSON Schema 里「不写 type」就表示什么都收，所以这里连 type 键都不给，
   * 只留描述 —— 模型看得懂就行。
   */
  Any(options?: SchemaOptions): JsonSchema {
    return { ...options }
  },
  Array(items: JsonSchema, options?: SchemaOptions): JsonSchema {
    return { type: 'array', items, ...options }
  },
  /**
   * 一个对象。
   *
   * required 在这里算：没被 `Optional` 标过的键一律必填。空对象不写 required
   * 键（写了空数组有些客户端会当成「有一个必填项」）。
   *
   * options 里除 type/required/properties 之外的键原样带上 ——
   * 这一层的用法只有两个：additionalProperties（要不要放行未知字段）和
   * description（给这个对象本身一句说明）。
   */
  Object(
    shape: Record<string, JsonSchema>,
    options?: Record<string, unknown>,
  ): JsonSchema {
    const required: string[] = []
    const properties: Record<string, JsonSchema> = {}
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = value
      if (!optionalSchemas.has(value)) required.push(key)
    }
    const out: JsonSchema = { type: 'object' }
    if (required.length) out.required = required
    out.properties = properties
    if (options) {
      for (const [key, value] of Object.entries(options)) {
        if (key === 'type' || key === 'required' || key === 'properties') continue
        out[key] = value
      }
    }
    return out
  },
  /**
   * 把一个参数标成可选。
   *
   * 复制一份再标记：同一个 schema 对象可能同时出现在必填与可选的位置，
   * 原地标记会把两处一起改掉。
   */
  Optional(schema: JsonSchema): JsonSchema {
    const copy: JsonSchema = { ...schema }
    optionalSchemas.add(copy)
    return copy
  },
}

/**
 * 定义一个工具。
 *
 * 以前这里接的是 pi SDK 的 `defineTool`，它在运行时就是个原样返回的恒等函数
 * （类型层面的存在意义是保住参数的类型推断）。现在自己写一个，行为完全一样，
 * 但主进程不用为此装载任何 ESM。
 */
export function defineTool(tool: TorraTool): TorraTool {
  return tool
}
