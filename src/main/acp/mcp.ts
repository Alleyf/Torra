/**
 * Torra 的工具包，改挂 MCP 通道。
 *
 * 为什么要这一层：外面那几家（Claude Code / Codex / OpenCode）自己就会读文件、
 * 会跑命令，缺的是「Torra 这一侧」的能力 —— 看模型清单、跑体检、读日志、
 * 联网搜索、读写记忆库。它们只认 MCP，所以这里把 Torra 的工具包端成一个 MCP 服务，
 * 建会话时报给它们，它们自己来取。
 *
 * 三件事不打算妥协：
 *
 * 1. **一份工具定义，两个出口**。工具还是原来那套（assistant/tools.ts），
 *    这里只换形状 —— 确认闸门、输出上限、白名单都在原处生效，不重写一遍语义。
 * 2. **只在本机可达，而且要令牌**。服务绑 127.0.0.1，路径里带一段随机数，
 *    每次会话换一枚令牌；令牌不对就当没这个服务。
 * 3. **两代方言都伺候**。实测（2026-10，本机）：
 *    claude 先试 2026-07-28 的 server/discover，失败才退回老方言；
 *    codex 说 2025-06-18，opencode 说 2025-11-25。
 *    官方 SDK 的 handler 默认两代都接，所以这里不替谁挑版本。
 */
import http from 'node:http'
import crypto from 'node:crypto'
import { Readable } from 'node:stream'
import { createMcpHandler, McpServer, fromJsonSchema } from '@modelcontextprotocol/server'
import type { AssistantCaps } from '../assistant/tools'
import { buildAssistantTools } from '../assistant/tools'

/** 一个工具在 MCP 这边的样子 */
export interface AcpMcpTool {
  /** 工具名：agent 那边按它调用，不能重名 */
  name: string
  /** 展示名：给人看的 */
  title: string
  /** 说明：给模型看的 */
  description: string
  /** 参数的 JSON Schema */
  inputSchema: Record<string, unknown>
  run(args: Record<string, unknown>, signal?: AbortSignal): Promise<AcpMcpToolResult>
}

/** 工具的结果：MCP 里就是一段内容块 */
export interface AcpMcpToolResult {
  content: Array<{ type: 'text'; text: string }>
}

/** 起好的 MCP 服务 */
export interface AcpMcpServerHandle {
  /** 报给 agent 的地址 */
  url: string
  /** 这次会话的令牌 */
  token: string
  /** 工具条数 */
  toolCount: number
  close(): Promise<void>
}

/** 报给 agent 的声明：ACP 里的 http 形态 MCP 服务 */
export interface AcpMcpDeclaration {
  type: 'http'
  name: string
  url: string
  headers: Array<{ name: string; value: string }>
}

/**
 * 把 Torra 的工具集端成 MCP 工具。
 *
 * 工具还是原来那套 —— 这里是换形状，不是重写：确认闸门、输出上限、
 * 自建工具的开关都在原来那层生效，换个出口不会让它们失效。
 */
export async function buildAcpMcpTools(caps: AssistantCaps): Promise<AcpMcpTool[]> {
  const defs = await buildAssistantTools(caps)
  const tools: AcpMcpTool[] = []
  for (const def of defs) {
    const inputSchema = toJsonSchema(def.parameters)
    // 参数说明不是一份合法 JSON Schema 的工具就不端出去：
    // 报上去会让 agent 照着一个残缺的 schema 调用，比不给这个工具更糟
    if (!inputSchema) continue
    tools.push({
      name: def.name,
      title: def.label,
      description: def.description,
      inputSchema,
      run: async (args, signal) => ({ content: await runTool(def, args, signal) }),
    })
  }
  return tools
}

/**
 * 起一个本机的 MCP 服务，把工具挂上去。
 *
 * 绑 127.0.0.1：agent 是本机另起的进程，走回环就够了。
 * 令牌每次会话换一枚 —— 服务活着不等于谁都该能调它。
 */
export async function startAcpMcpServer(tools: AcpMcpTool[]): Promise<AcpMcpServerHandle> {
  const token = crypto.randomBytes(24).toString('hex')
  const handler = createMcpHandler(() => buildServer(tools))
  const server = http.createServer((req, res) => {
    void serve(handler, req, res, token).catch(() => {
      try {
        res.end()
      } catch {
        /* 连接已经断了 */
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    toolCount: tools.length,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await handler.close()
    },
  }
}

/** 把起好的服务写成 ACP 的声明：会话里报给 agent 的那一条 */
export function mcpDeclaration(handle: AcpMcpServerHandle): AcpMcpDeclaration {
  return {
    type: 'http',
    name: 'torra',
    url: handle.url,
    headers: [{ name: 'Authorization', value: `Bearer ${handle.token}` }],
  }
}

/** 每次请求现建一个服务实例：SDK 的老方言按请求无状态地服务 */
function buildServer(tools: AcpMcpTool[]): McpServer {
  const server = new McpServer({ name: 'torra', version: '1.0.0' })
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: fromJsonSchema(tool.inputSchema),
      },
      async (args: unknown) => {
        const result = await tool.run((args ?? {}) as Record<string, unknown>)
        return { content: result.content }
      },
    )
  }
  return server
}

/**
 * Node 的 http 请求 → web 的 Request，答复再倒回去。
 *
 * 答复用流式转发而不是一次性读完：SSE 那种答复不会自己结束，
 * 一次性读完会一直等着。
 */
async function serve(
  handler: ReturnType<typeof createMcpHandler>,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string,
): Promise<void> {
  const auth = req.headers.authorization ?? ''
  if (auth !== `Bearer ${token}`) {
    res.writeHead(401, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message: '令牌不对' } }))
    return
  }
  // 只认本机的主机名：服务虽然绑在回环上，但 Host 头是可以伪造的
  const host = String(req.headers.host ?? '').split(':')[0]
  if (host && host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]') {
    res.writeHead(403, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32000, message: '只服务本机' } }))
    return
  }

  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const body = Buffer.concat(chunks)
  const method = req.method ?? 'POST'
  const hasBody = method !== 'GET' && method !== 'HEAD' && body.length > 0
  const request = new Request(`http://${req.headers.host ?? '127.0.0.1'}${req.url ?? '/mcp'}`, {
    method,
    headers: toWebHeaders(req.headers),
    body: hasBody ? body : undefined,
  })
  const response = await handler.fetch(request)
  res.writeHead(response.status, Object.fromEntries(response.headers.entries()))
  if (!response.body) {
    res.end()
    return
  }
  await new Promise<void>((resolve) => {
    const stream = Readable.fromWeb(response.body as never)
    stream.on('error', () => {
      res.end()
      resolve()
    })
    stream.on('end', () => resolve())
    stream.pipe(res)
  })
}

/**
 * Node 的请求头 → web 的 HeadersInit。
 *
 * 主进程不引 DOM 的 lib，所以这里不用 HeadersInit 这个名字（它不在全局作用域里），
 * 直接摊成 Record<string, string> —— 那本来就是 HeadersInit 允许的一种形态。
 */
function toWebHeaders(raw: http.IncomingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue
    out[name] = Array.isArray(value) ? value.join(', ') : value
  }
  return out
}

/**
 * 工具的参数说明 → 一份干净的 JSON Schema。
 *
 * 工具那边的参数本来就已经是纯 JSON Schema 了（见 shared/tool.ts），
 * 这里做的是最后一道体检：不是对象的、缺 properties 的，一律不端出去。
 * 报一个残缺的 schema 给 agent，比不给这个工具更糟 ——
 * 模型会照着它编出一个调用，然后卡在一个不存在的参数上。
 */
function toJsonSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return undefined
  const out = schema as Record<string, unknown>
  if (out.type !== 'object') return undefined
  if (!out.properties || typeof out.properties !== 'object') out.properties = {}
  // 空 required 数组在 JSON Schema 里合法，但有些客户端会当成「有一个必填项」
  if (Array.isArray(out.required) && out.required.length === 0) delete out.required
  return out
}

/** 工具的执行入口：只用到前三段（id、参数、取消信号） */
type TorraToolLike = {
  execute: (
    id: string,
    params: never,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: string; text?: string }> }>
}

async function runTool(
  def: unknown,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Array<{ type: 'text'; text: string }>> {
  const tool = def as TorraToolLike
  const result = await tool.execute('mcp', args as never, signal)
  const content: Array<{ type: 'text'; text: string }> = []
  for (const item of result?.content ?? []) {
    if (item && typeof item === 'object' && item.type === 'text' && typeof item.text === 'string') {
      content.push({ type: 'text', text: item.text })
      continue
    }
    // 非文字的内容块（图片之类）这里不接：Torra 的工具目前只回文字
    content.push({ type: 'text', text: JSON.stringify(item ?? null) })
  }
  if (!content.length) content.push({ type: 'text', text: '' })
  return content
}
