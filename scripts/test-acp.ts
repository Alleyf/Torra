/**
 * ACP 接入的回归：协议对不对、边界守不守得住、兼容性能不能被测出来。
 *
 * 这一层的价值在于把「ACP 是标准，所以接谁都行」这句话换成可验证的东西。
 * 标准只保证方法名与消息形状，它不保证：
 *   - agent 一定会回来要授权（有的直接自己干了）；
 *   - agent 一定收 http 形态的 MCP（实测 pi-acp 不收）；
 *   - agent 的「模式」是权限（claude 是、codex 是沙箱档、pi 是思考档）。
 * 所以兼容性只能靠矩阵说话，而矩阵要有对端才成得了 —— 于是有了那个假 agent。
 *
 * 分三段：
 *   一、离线：注册表的校验、fs 通道的目录边界、设置项的分派依据；
 *   二、对端：拿仓库里的假 agent 跑完整往返（握手、一轮、授权、读写文件、取消）；
 *   三、活体（可选）：对着真的 Claude Code / Codex / pi / OpenCode 跑一遍预检，
 *      把协商结果打成矩阵。这一段要下 npm 包、慢、可能因为没登录而失败，
 *      所以默认不跑，用 `npm run test:acp -- --live` 打开。
 *
 * 运行：npm run test:acp · npm run test:acp -- --live
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AcpService } from '../src/main/acp'
import { AcpClient, pathWithinRoots, toolOutputParts } from '../src/main/acp/client'
import { buildAcpMcpTools, mcpDeclaration, startAcpMcpServer } from '../src/main/acp/mcp'
import { BUILTIN_ACP_AGENTS, listAgents, saveOverride, validateOverride } from '../src/main/acp/registry'
import { matrixCell, matrixStatus } from '../src/main/acp/matrix'
import { classifyProbeFailure, redactSecrets } from '../src/main/acp/diagnose'
import type { AssistantCaps } from '../src/main/assistant/tools'
import { applyAcpEvent, diffRows, diffStat, groupAcpLines, sessionEdits, type AcpLine } from '../src/renderer/acpLines'
import { loadSessions, parseSessions, pruneLines, sessionTitle, upsertSession, type AgentSession } from '../src/renderer/agentSessions'
import { isBlockedAcpOption } from '../src/shared/acp'
import type { AcpAgentEntry, AcpEvent, AcpMatrixCell } from '../src/shared/acp'

const ROOT = path.resolve(__dirname, '..')
const FIXTURE = path.join(ROOT, 'scripts', 'fixtures', 'acp-fixture-agent.js')
const LIVE = process.argv.includes('--live')
const LIVE_FULL = process.argv.includes('--live-full')
const WRITE_MATRIX = process.argv.includes('--write-matrix')

let pass = 0
let fail = 0

function it(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(
      () => {
        pass++
        console.log(`  [PASS] ${name}`)
      },
      (e) => {
        fail++
        console.log(`  [FAIL] ${name}`)
        console.log(`         ${(e as Error).message.split('\n').slice(0, 6).join('\n         ')}`)
      },
    )
}

function section(title: string): void {
  console.log(`\n${title}`)
}

/** 临时目录：每个用例自己一个，测完删 */
function tmpDir(tag: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `torra-acp-${tag}-`))
}

/** Windows 上经 cmd.exe 起进程，路径带空格要自己加引号 */
function spawnArg(p: string): string {
  return process.platform === 'win32' && p.includes(' ') ? `"${p}"` : p
}

const fixtureEntry: AcpAgentEntry = {
  id: 'fixture',
  title: '测试用假 agent',
  blurb: '仓库里那个只会说协议的最小对端',
  command: process.execPath,
  args: [spawnArg(FIXTURE)],
  notes: [],
  source: 'user',
}

/** 把一条用户自定义条目写进 <root>/torra/acp.json */
function writeOverride(root: string, agents: unknown[]): void {
  const dir = path.join(root, 'torra')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'acp.json'), JSON.stringify({ agents }, null, 2), 'utf8')
}

/**
 * 一份够用的假 caps。
 *
 * 只给「建工具时」与「跑那一个工具时」真正被用到的方法：建工具时要问
 * memoryStores / selfAuthoring / appPluginTools，其余能力都在各自的 execute
 * 里才问，跑别的工具时自然问不到。这样这份假 caps 是诚实的 ——
 * 它不假装自己有全套能力，只给得出这些。
 */
function stubCaps(): AssistantCaps {
  return {
    listModels: () => [
      {
        id: 'api-stub',
        displayName: '假 API 模型',
        transport: 'api',
        enabled: true,
        hasKey: true,
        status: 'ready',
      },
    ],
    memoryStores: () => [],
    selfAuthoring: () => false,
    appPluginTools: () => [],
    log: () => {},
  } as unknown as AssistantCaps
}

/** 一份最小的 MCP 客户端：只用来验服务端，验完就丢 */
async function mcpCall(
  url: string,
  headers: Record<string, string>,
  payload: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(payload),
  })
  const raw = await res.text()
  let json: any = null
  try {
    json = JSON.parse(raw)
  } catch {
    // 老方言可能用 SSE 回：event: message / data: {...}
    const line = raw.split('\n').reverse().find((l) => l.startsWith('data:'))
    if (line) {
      try {
        json = JSON.parse(line.slice(5).trim())
      } catch {
        json = null
      }
    }
  }
  return { status: res.status, json }
}

// ---------------------------------------------------------------------------
// 一、离线
// ---------------------------------------------------------------------------

async function offline(): Promise<void> {
  section('一、离线：注册表与边界')

  await it('内置四家都在，适配器包版本钉死', () => {
    const ids = BUILTIN_ACP_AGENTS.map((a) => a.id)
    assert.deepEqual(ids, ['claude', 'codex', 'pi', 'opencode'])
    for (const a of BUILTIN_ACP_AGENTS) {
      if (!a.package) continue
      // 版本必须是精确的（没有 ^ ~），否则「这一家 + 这个版本」的矩阵就没意义
      assert.match(a.package.version, /^\d+\.\d+\.\d+$/, `${a.id} 的版本没有钉死`)
      assert.ok(
        a.args.some((arg) => arg.includes(a.package!.version)),
        `${a.id} 的启动参数里没有出现钉死的版本`,
      )
    }
  })

  await it('用户条目能盖掉内置那一条', () => {
    const root = tmpDir('override')
    writeOverride(root, [
      { id: 'claude', title: '我自己装的 Claude', command: 'claude-code-acp', args: [] },
    ])
    const { entries } = listAgents(root)
    const claude = entries.find((e) => e.id === 'claude')
    assert.ok(claude)
    assert.equal(claude.source, 'user')
    assert.equal(claude.command, 'claude-code-acp')
    fs.rmSync(root, { recursive: true, force: true })
  })

  await it('命令里带 shell 连接符的条目被拒', () => {
    // 这些字符串会被拼进一条命令行。参数里带 & 或 | 就能在用户机器上多跑一条命令。
    const bad = validateOverride({ id: 'evil', command: 'npx', args: ['-y', 'pkg&calc.exe'] })
    assert.equal(bad.ok, false)
    if (!bad.ok) assert.match(bad.reason, /shell/)
    const badCmd = validateOverride({ id: 'evil2', command: 'npx & calc' })
    assert.equal(badCmd.ok, false)
  })

  await it('id 不合法、参数过多、版本号乱的条目被拒', () => {
    assert.equal(validateOverride({ id: 'Bad Id', command: 'npx' }).ok, false)
    assert.equal(validateOverride({ id: 'ok', command: 'npx', args: new Array(20).fill('x') }).ok, false)
    assert.equal(
      validateOverride({ id: 'ok', command: 'npx', package: { name: 'p', version: 'latest' } }).ok,
      false,
    )
  })

  await it('坏掉的 acp.json 不会让整个列表塌掉', () => {
    const root = tmpDir('broken')
    fs.mkdirSync(path.join(root, 'torra'), { recursive: true })
    fs.writeFileSync(path.join(root, 'torra', 'acp.json'), '{ 这不是 JSON', 'utf8')
    const { entries, problems } = listAgents(root)
    assert.equal(entries.length, BUILTIN_ACP_AGENTS.length)
    assert.equal(problems.length, 1)
    fs.rmSync(root, { recursive: true, force: true })
  })

  await it('fs 通道只认会话目录与另外授权过的目录', () => {
    const roots = [path.resolve('/tmp/work'), path.resolve('/tmp/extra')]
    assert.equal(pathWithinRoots(path.resolve('/tmp/work/a.txt'), roots), true)
    assert.equal(pathWithinRoots(path.resolve('/tmp/extra/b.txt'), roots), true)
    assert.equal(pathWithinRoots(path.resolve('/tmp/work/sub/c.txt'), roots), true)
    // 兄弟目录不算：/tmp/work2 不是 /tmp/work 的子目录
    assert.equal(pathWithinRoots(path.resolve('/tmp/work2/d.txt'), roots), false)
    assert.equal(pathWithinRoots(path.resolve('/etc/passwd'), roots), false)
  })
}

// ---------------------------------------------------------------------------
// 一之二、离线：工具包这个 MCP 服务本身
// ---------------------------------------------------------------------------

/**
 * 顺着相对 import 走一遍，找出这条路上所有「运行时真的会装载」的依赖。
 *
 * 为什么盯这条：主进程编译成 CommonJS，要用一个只有 ESM 出口的包，
 * 就得留一条原生 import() 的后门（pi-sdk.ts 那套用 Function 构造的加载器）。
 * 那条后门害过一次 —— undici 在模块加载期就调 markAsUncloneable，
 * Electron 33 内置的 Node 20 没有这个函数，于是助手一条消息都发不出去。
 *
 * ACP 这一侧现在自己写了传输层（jsonrpc.ts），工具参数也是纯 JSON Schema，
 * 所以这条路上一格第三方 ESM 都不该再有。有的话，就是有人把依赖接回来了，
 * 而这种接回来通常看不出来：编译得过，跑起来才炸。
 */
function runtimeDepsOnAcpPath(): string[] {
  const entry = path.join(ROOT, 'src', 'main', 'acp', 'index.ts')
  const seen = new Set<string>()
  const found: string[] = []
  const stack = [entry]
  while (stack.length) {
    const file = stack.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    if (!fs.existsSync(file)) continue
    const src = fs.readFileSync(file, 'utf8')
    // import type 是编译期擦除的，不算运行时依赖
    for (const m of src.matchAll(/import\s+(?!type\b)([^'"]*?)\s+from\s+'([^']+)'/g)) {
      const spec = m[2]!
      if (spec.startsWith('.')) {
        stack.push(resolveLocalModule(file, spec))
        continue
      }
      found.push(`${path.relative(ROOT, file)} → ${spec}`)
    }
    // 动态 import 也要算：它就是那条 ESM 后门的样子
    for (const m of src.matchAll(/[^.\w]import\(\s*'([^']+)'\s*\)/g)) {
      found.push(`${path.relative(ROOT, file)} → import(${m[1]})`)
    }
  }
  return [...new Set(found)]
}

/** 相对 import 落到哪个文件上：先按原样，再补 .ts，再找 index.ts */
function resolveLocalModule(from: string, spec: string): string {
  const base = path.resolve(path.dirname(from), spec)
  for (const candidate of [base, `${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return base
}

async function toolPackOffline(): Promise<void> {
  section('一之二、离线：Torra 的工具包端成 MCP')

  await it('ACP 这一侧不背任何第三方 ESM 的装载通道', () => {
    const deps = runtimeDepsOnAcpPath()
    const esmOnly = deps.filter((d) =>
      /@earendil-works\/pi-coding-agent|typebox|pi-sdk/.test(d),
    )
    assert.deepEqual(esmOnly, [], `ACP 这条路上又接回了 ESM-only 的依赖：\n${esmOnly.join('\n')}`)
    // 剩下的第三方依赖都得是 CommonJS 能 require 的（主进程编译成 CJS）。
    // MCP SDK 自带 cjs 出口，所以它在名单里是对的；多出来的每一个都要解释。
    const thirdParty = deps.filter((d) => !d.includes('src/') && !d.includes('→ node:'))
    for (const d of thirdParty) {
      const spec = d.split('→ ')[1]!.replace(/^import\((.*)\)$/, '$1').replace(/^'|'$/g, '')
      const pkg = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!
      const manifest = path.join(ROOT, 'node_modules', pkg, 'package.json')
      if (!fs.existsSync(manifest)) continue
      const json = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { exports?: unknown; main?: string }
      const hasRequire =
        typeof json.exports === 'object' && json.exports !== null
          ? JSON.stringify(json.exports).includes('"require"')
          : Boolean(json.main)
      assert.ok(hasRequire, `${pkg} 只有 ESM 出口，主进程 require 不动它`)
    }
  })

  const tools = await buildAcpMcpTools(stubCaps())

  await it('工具都端出去了，参数是能用的 JSON Schema', () => {
    assert.ok(tools.length > 0, '一个工具都没端出去')
    const names = tools.map((t) => t.name)
    assert.equal(new Set(names).size, names.length, '工具重名了')
    for (const t of tools) {
      assert.ok(t.name.length > 0)
      assert.ok(t.description.length > 0, `${t.name} 没有说明`)
      assert.equal(t.inputSchema.type, 'object', `${t.name} 的参数不是对象`)
    }
    // 认得出 Torra 那几个主力工具
    assert.ok(names.includes('torra_list_models'))
  })

  await it('参数说明是一份站得住的 JSON Schema：必填的名字都在，形状没有私货', () => {
    const kinds = ['string', 'number', 'integer', 'boolean', 'array', 'object']
    for (const t of tools) {
      const schema = t.inputSchema
      const props = schema.properties as Record<string, unknown>
      const required = Array.isArray(schema.required) ? (schema.required as unknown[]).map(String) : []
      for (const key of required) {
        assert.ok(key in props, `${t.name} 的必填项 ${key} 在 properties 里不存在`)
      }
      for (const [key, sub] of Object.entries(props)) {
        const node = sub as Record<string, unknown>
        if (node.type === undefined) continue
        assert.ok(kinds.includes(String(node.type)), `${t.name}.${key} 的 type 是个没听说过的 ${String(node.type)}`)
      }
      // JSON 之外没有别的东西：外部 agent 看到的只能是这份 JSON，
      // 有任何藏着的字段，就说明有一边的说法和另一边不一致。
      assert.deepEqual(
        JSON.parse(JSON.stringify(schema)),
        schema,
        `${t.name} 的参数说明里有 JSON 表达不了的东西`,
      )
    }
  })

  const handle = await startAcpMcpServer(tools)
  const decl = mcpDeclaration(handle)

  await it('声明的形状是 ACP 认的那种：http + 名字 + 地址 + 头', () => {
    assert.equal(decl.type, 'http')
    assert.equal(decl.name, 'torra')
    assert.match(decl.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    const auth = decl.headers.find((h) => h.name.toLowerCase() === 'authorization')
    assert.ok(auth, '声明里没有 Authorization')
    assert.match(auth!.value, /^Bearer \S+$/)
  })

  await it('没有令牌就当没这个服务', async () => {
    const res = await mcpCall(decl.url, {}, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    assert.equal(res.status, 401)
    const wrong = await mcpCall(decl.url, { authorization: 'Bearer nope' }, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    })
    assert.equal(wrong.status, 401)
  })

  const auth = { authorization: `Bearer ${handle.token}` }

  await it('老方言：initialize → tools/list → tools/call 走通', async () => {
    const init = await mcpCall(decl.url, auth, {
      jsonrpc: '2.0',
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'test', version: '0' },
      },
    })
    assert.equal(init.status, 200)
    const list = await mcpCall(decl.url, auth, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    assert.equal(list.status, 200)
    const listed = list.json?.result?.tools ?? []
    assert.ok(listed.length > 0, 'tools/list 是空的')
    assert.ok(listed.some((t: any) => t.name === 'torra_list_models'))

    const call = await mcpCall(decl.url, auth, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'torra_list_models', arguments: {} },
    })
    assert.equal(call.status, 200)
    const body = call.json?.result?.content?.[0]?.text ?? ''
    assert.match(body, /api-stub/, '工具真的跑起来了，但没拿到假 caps 的结果')
  })

  await it('新方言：server/discover 与 tools/call 走通（claude 走的就是这条）', async () => {
    const meta = {
      'io.modelcontextprotocol/protocolVersion': '2026-07-28',
      'io.modelcontextprotocol/clientInfo': { name: 'test', version: '0' },
      'io.modelcontextprotocol/clientCapabilities': {},
    }
    const disc = await mcpCall(
      decl.url,
      { ...auth, 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'server/discover' },
      { jsonrpc: '2.0', id: 'd1', method: 'server/discover', params: { _meta: meta } },
    )
    assert.equal(disc.status, 200)
    const call = await mcpCall(
      decl.url,
      {
        ...auth,
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': 'tools/call',
        'mcp-name': 'torra_list_models',
      },
      {
        jsonrpc: '2.0',
        id: 'c1',
        method: 'tools/call',
        params: { name: 'torra_list_models', arguments: {}, _meta: meta },
      },
    )
    assert.equal(call.status, 200)
    const body = call.json?.result?.content?.[0]?.text ?? ''
    assert.match(body, /api-stub/)
  })

  await it('服务收掉之后，端口不再应答', async () => {
    await handle.close()
    let reachable = true
    try {
      await mcpCall(decl.url, auth, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    } catch {
      reachable = false
    }
    assert.equal(reachable, false, '服务关了还应答')
  })
}

// ---------------------------------------------------------------------------
// 二、对端：假 agent 的完整往返
// ---------------------------------------------------------------------------

async function againstFixture(): Promise<void> {
  section('二、对端：拿假 agent 跑完整往返')

  const root = tmpDir('fixture')
  const work = path.join(root, 'work')
  fs.mkdirSync(work, { recursive: true })
  writeOverride(root, [fixtureEntry])

  const events: AcpEvent[] = []
  let permissionSeen: { id: string; title: string } | null = null
  const service = new AcpService({
    userDataRoot: root,
    clientName: 'Torra-test',
    clientVersion: '0.0.0',
    onEvent: (_agentId, event) => events.push(event),
    onPermission: (agentId, request) => {
      permissionSeen = { id: request.id, title: request.title }
      // 模拟用户点「这一次允许」：隔一拍再回，模拟界面真的往返了一次
      setTimeout(() => {
        service.respondPermission(request.id, { optionId: 'allow-once' })
      }, 10)
    },
    caps: stubCaps,
  })

  const started = await service.start('fixture', { cwd: work })
  await it('握手与建会话都成了，协商结果被读出来', () => {
    assert.equal(started.ok, true, started.error)
    const caps = started.capabilities
    assert.ok(caps)
    assert.equal(caps.protocolVersion, 1)
    assert.equal(caps.agentName, 'torra-acp-fixture')
    assert.equal(caps.mcpHttp, true)
    assert.equal(caps.loadSession, true)
    assert.deepEqual(caps.authMethods.map((m) => m.id), ['none'])
  })

  await it('工具包挂上去了：这一家收 http 形态的 MCP，声明就带出去了', () => {
    const pack = started.capabilities?.toolPack
    assert.ok(pack, '协商结果里没有工具包这一项')
    assert.equal(pack!.attached, true, pack!.reason)
    assert.ok(pack!.tools > 0, '工具条数是 0')
  })

  await it('modes 与 configOptions 归成通用下拉组，并记住来源', () => {
    const caps = started.capabilities!
    const mode = caps.selects.find((s) => s.id === 'mode')
    const effort = caps.selects.find((s) => s.id === 'effort')
    assert.ok(mode, '没有 mode 组')
    assert.ok(effort, '没有 effort 组')
    // 来源要分清：一个是协议里的 mode，一个是 config option
    assert.equal(mode.kind, 'mode')
    assert.equal(effort.kind, 'config')
    assert.equal(mode.currentValue, 'ask')
    assert.equal(effort.currentValue, 'mid')
    assert.deepEqual(mode.options.map((o) => o.value), ['ask', 'auto'])
  })

  events.length = 0
  const sent = await service.prompt('#text #tool')
  await it('一轮对话：文字、工具调用、工具结果都回来了', () => {
    assert.equal(sent.ok, true, sent.error)
    const text = events.filter((e) => e.kind === 'text').map((e) => (e as { delta: string }).delta).join('')
    assert.match(text, /假 agent/)
    const toolCall = events.find((e) => e.kind === 'tool-call')
    assert.ok(toolCall, '没有工具调用事件')
    assert.equal((toolCall as { id: string }).id, 'fixture-tool-1')
    const toolResult = events.find((e) => e.kind === 'tool-result')
    assert.ok(toolResult, '没有工具结果事件')
    assert.equal((toolResult as { status?: string }).status, 'completed')
    assert.ok(events.some((e) => e.kind === 'settled'))
  })

  events.length = 0
  await service.prompt('#permission')
  await it('授权往返：agent 要授权，用户的决定回到 agent 手里', () => {
    assert.ok(permissionSeen, '没有收到授权请求')
    assert.match(permissionSeen!.title, /写一个文件/)
    const text = events.filter((e) => e.kind === 'text').map((e) => (e as { delta: string }).delta).join('')
    assert.match(text, /选了 allow-once/)
  })

  events.length = 0
  fs.writeFileSync(path.join(work, 'fixture-read.txt'), '第一行\n第二行\n', 'utf8')
  await service.prompt('#read')
  await it('fs 读：agent 要读文件，内容经客户端取回', () => {
    const text = events.filter((e) => e.kind === 'text').map((e) => (e as { delta: string }).delta).join('')
    assert.match(text, /读到了/)
    assert.match(text, /第一行/)
  })

  events.length = 0
  await service.prompt('#write')
  await it('fs 写：落在会话目录里', () => {
    const written = path.join(work, 'fixture-write.txt')
    assert.ok(fs.existsSync(written), '文件没落地')
    assert.match(fs.readFileSync(written, 'utf8'), /假 agent 写的/)
  })

  await it('fs 写：落在会话目录外被挡住', async () => {
    // 让假 agent 去写会话目录之外的一个文件：客户端必须挡住，不能悄悄写出去
    const outside = path.join(root, 'outside.txt')
    events.length = 0
    await service.prompt(`#write:${outside}`)
    assert.equal(fs.existsSync(outside), false, '越界的文件不该被写出来')
    const text = events.filter((e) => e.kind === 'text').map((e) => (e as { delta: string }).delta).join('')
    assert.match(text, /写不了/)
  })

  await it('取消：session/cancel 走通', async () => {
    const client = new AcpClient({
      entry: fixtureEntry,
      cwd: work,
      clientName: 'Torra-test',
      clientVersion: '0.0.0',
      onEvent: () => {},
      onPermission: async () => ({ optionId: null }),
    })
    await client.start()
    await client.cancel()
    await client.stop()
  })

  events.length = 0
  await service.prompt('#mcp')
  await it('工具包真的到了 agent 手里：假 agent 当 MCP 客户端连上并调了工具', () => {
    const text = events.filter((e) => e.kind === 'text').map((e) => (e as { delta: string }).delta).join('\n')
    assert.match(text, /MCP 方言：(新方言|老方言)/, '假 agent 没连上 MCP')
    assert.match(text, /torra_list_models/, '假 agent 没看到 Torra 的工具')
    assert.match(text, /api-stub/, '工具调起来了，但没拿到 Torra 这一侧的结果')
  })

  await it('改设置：mode 走 session/set_mode，config 走 session/set_config_option', async () => {
    const okMode = await service.setOption('mode', 'auto')
    assert.equal(okMode.ok, true, okMode.error)
    const okCfg = await service.setOption('effort', 'low')
    assert.equal(okCfg.ok, true, okCfg.error)
    // 协议里没有的项要拒绝：agent 不认识的东西发过去只会报错或被它自己解释
    const bad = await service.setOption('not-a-real-option', 'x')
    assert.equal(bad.ok, false)
  })

  await service.stop()
  // 子进程的工作目录就是 work：进程还没退干净时 Windows 不让删它，所以带重试
  await new Promise((r) => setTimeout(r, 300))
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 })
}

// ---------------------------------------------------------------------------
// 二之二、工具包挂不上的时候
// ---------------------------------------------------------------------------

async function toolPackHandoff(): Promise<void> {
  section('二之二、工具包挂不上的时候要说清为什么')

  const root = tmpDir('nopack')
  const work = path.join(root, 'work')
  fs.mkdirSync(work, { recursive: true })
  writeOverride(root, [fixtureEntry])

  const mk = (): AcpService =>
    new AcpService({
      userDataRoot: root,
      clientName: 'Torra-test',
      clientVersion: '0.0.0',
      caps: stubCaps,
    })

  // 这一家握手时不报 http 形态的 MCP：工具包挂不上去，但会话照样要起得来
  process.env.FIXTURE_NO_HTTP_MCP = '1'
  try {
    const service = mk()
    const started = await service.start('fixture', { cwd: work })
    await it('这一家不收 http 形态的 MCP：会话起得来，工具包说清为什么挂不上', () => {
      assert.equal(started.ok, true, started.error)
      const pack = started.capabilities?.toolPack
      assert.ok(pack, '协商结果里没有工具包这一项')
      assert.equal(pack!.attached, false)
      assert.match(pack!.reason ?? '', /http/)
    })
    await service.stop()
  } finally {
    delete process.env.FIXTURE_NO_HTTP_MCP
  }

  // 这一家不认带声明的建会话请求（codex 的脾气）：客户端要退回不带声明再试一次
  process.env.FIXTURE_REJECT_MCP = '1'
  try {
    const service = mk()
    const started = await service.start('fixture', { cwd: work })
    await it('这一家不认带 MCP 声明的请求：退一步也接上了，工具包说清为什么挂不上', () => {
      assert.equal(started.ok, true, started.error)
      const pack = started.capabilities?.toolPack
      assert.ok(pack)
      assert.equal(pack!.attached, false)
      assert.match(pack!.reason ?? '', /不认/)
    })
    await service.stop()
  } finally {
    delete process.env.FIXTURE_REJECT_MCP
  }

  // Torra 这一侧还没有工具可交：也是挂不上，但原因不一样
  {
    const service = new AcpService({
      userDataRoot: root,
      clientName: 'Torra-test',
      clientVersion: '0.0.0',
      // 故意不给 caps：Torra 的工具还没就绪
    })
    const started = await service.start('fixture', { cwd: work })
    await it('Torra 这一侧还没就绪：挂不上，但 agent 照样能接上', () => {
      assert.equal(started.ok, true, started.error)
      const pack = started.capabilities?.toolPack
      assert.ok(pack)
      assert.equal(pack!.attached, false)
      assert.match(pack!.reason ?? '', /还没就绪/)
    })
    await service.stop()
  }

  await new Promise((r) => setTimeout(r, 300))
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 })
}

// ---------------------------------------------------------------------------
// 二之三、离线：界面怎么把协议事件画成一行行
// ---------------------------------------------------------------------------

/**
 * 这一段测的是「协议 → 界面」这一层，不是协议本身。
 *
 * 它容易坏在几个地方：文字分片被当成整段（每来一个字就另起一行）、
 * 工具结果找不到它对应的那一步（界面上多出一根没有上文的横杠）、
 * 思考与工具被拆散成一屏噪声。这几样在协议层都测不出来 ——
 * 协议只管消息合不合规，不管画出来好不好看。
 */
async function uiLines(): Promise<void> {
  section('二之三、离线：事件怎么折成界面上的行')
  let seq = 0
  const nextId = (): number => ++seq
  const feed = (events: AcpEvent[]): AcpLine[] => events.reduce((l, e) => applyAcpEvent(l, e, nextId), [] as AcpLine[])

  await it('分片的文字接在同一段里，不会每来一个字就另起一行', () => {
    const lines = feed([
      { kind: 'text', delta: '我先' },
      { kind: 'text', delta: '看' },
      { kind: 'text', delta: '一眼目录' },
    ])
    assert.equal(lines.length, 1)
    assert.equal(lines[0]!.kind, 'say')
    assert.equal((lines[0] as Extract<AcpLine, { kind: 'say' }>).text, '我先看一眼目录')
  })

  await it('被别的内容隔开的文字另起一段', () => {
    const lines = feed([
      { kind: 'text', delta: '第一段' },
      { kind: 'notice', text: '中途插了一句' },
      { kind: 'text', delta: '第二段' },
    ])
    assert.equal(lines.length, 3)
    assert.equal(lines[0]!.kind, 'say')
    assert.equal(lines[1]!.kind, 'notice')
    assert.equal(lines[2]!.kind, 'say')
  })

  await it('思考与文字分开：思考进步骤组，文字留在正文', () => {
    const lines = feed([
      { kind: 'thinking', delta: '先看目录' },
      { kind: 'text', delta: '目录里有三个文件' },
    ])
    const blocks = groupAcpLines(lines)
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0]!.kind, 'steps')
    assert.equal(blocks[1]!.kind, 'say')
  })

  await it('工具结果回到它对应的那一步上，不多出一根横杠', () => {
    const lines = feed([
      { kind: 'tool-call', id: 't1', title: '读文件' },
      { kind: 'tool-call', id: 't2', title: '列目录' },
      { kind: 'tool-result', id: 't1', status: 'completed', text: '内容在这' },
    ])
    assert.equal(lines.length, 2, '工具结果没有并回原来的那一步')
    const first = lines[0] as Extract<AcpLine, { kind: 'tool' }>
    assert.equal(first.toolId, 't1')
    assert.equal(first.out, '内容在这')
    assert.equal(first.running, false)
    // 第二步还在跑
    assert.equal((lines[1] as Extract<AcpLine, { kind: 'tool' }>).running, true)
  })

  await it('agent 先报结果、后报调用：不丢掉，也不挂错', () => {
    const lines = feed([
      { kind: 'tool-result', id: 't9', status: 'completed', text: '先到的结果' },
      { kind: 'tool-call', id: 't9', title: '读文件' },
    ])
    assert.equal(lines.length, 2)
    assert.equal((lines[0] as Extract<AcpLine, { kind: 'tool' }>).out, '先到的结果')
  })

  await it('用量与收尾各成一行小结，不混进正文', () => {
    const lines = feed([
      { kind: 'text', delta: '做完了' },
      { kind: 'usage', input: 120, output: 45 },
      { kind: 'settled', stopReason: 'end_turn' },
    ])
    assert.equal(lines.length, 3)
    assert.equal(lines[1]!.kind, 'tally')
    assert.match((lines[1] as Extract<AcpLine, { kind: 'tally' }>).text, /输入 120/)
    assert.equal(lines[2]!.kind, 'tally')
    assert.match((lines[2] as Extract<AcpLine, { kind: 'tally' }>).text, /end_turn/)
  })

  await it('报错单独成行，颜色由它自己的类名决定', () => {
    const lines = feed([{ kind: 'error', text: '这一家没登录' }])
    assert.equal(lines.length, 1)
    assert.equal(lines[0]!.kind, 'error')
  })

  await it('档位变了要留一句人话：改的什么、改成什么', () => {
    const lines = feed([{ kind: 'mode', optionId: 'mode', value: 'plan', name: '计划模式' }])
    assert.equal(lines.length, 1)
    assert.match((lines[0] as Extract<AcpLine, { kind: 'notice' }>).text, /计划模式/)
    assert.match((lines[0] as Extract<AcpLine, { kind: 'notice' }>).text, /plan/)
  })

  await it('不认识的档位不会被画出来（免掉全部授权的那一档）', () => {
    for (const bad of ['bypassPermissions', 'skip-permissions', 'danger-full-access', 'yolo']) {
      assert.equal(isBlockedAcpOption(bad), true, `${bad} 竟然没被挡下来`)
    }
    for (const good of ['default', 'acceptEdits', 'plan', 'read-only', 'workspace-write', 'high']) {
      assert.equal(isBlockedAcpOption(good), false, `${good} 竟然被当成了要挡的档位`)
    }
  })

  await it('diff 内容块拆成文本与改动两份，审查面板才有东西可画', () => {
    const r = toolOutputParts([
      { type: 'text', text: '改好了' },
      { type: 'diff', path: 'src/a.ts', oldText: 'a\nb', newText: 'a\nc' },
    ])
    assert.match(r.text, /改好了/)
    assert.equal(r.diffs.length, 1)
    assert.equal(r.diffs[0]!.path, 'src/a.ts')
    assert.equal(r.diffs[0]!.newText, 'a\nc')
  })

  await it('增删行数按内容重数算：改同样多行不能记成 +0 −0', () => {
    assert.deepEqual(diffStat('a\nb\nc', 'a\nb\nc\nd'), { added: 1, removed: 0 })
    assert.deepEqual(diffStat('a\nb\nc', 'a\nB\nc'), { added: 1, removed: 1 })
    assert.deepEqual(diffStat('', 'x\ny'), { added: 2, removed: 0 })
    assert.deepEqual(diffStat('x\ny', ''), { added: 0, removed: 2 })
    // 同一行重复出现时按重数算，而不是按集合算
    assert.deepEqual(diffStat('a\na', 'a\na\na'), { added: 1, removed: 0 })
  })

  await it('工具结果里的 diff 会留在那一步上，并算好增删', () => {
    const lines = feed([
      { kind: 'tool-call', id: 't1', title: '写文件', toolKind: 'edit' },
      {
        kind: 'tool-result',
        id: 't1',
        status: 'completed',
        diffs: [{ path: 'src/index.ts', oldText: 'a', newText: 'a\nb' }],
      },
    ])
    const step = lines[0] as Extract<AcpLine, { kind: 'tool' }>
    assert.equal(step.toolKind, 'edit')
    assert.equal(step.edits?.length, 1)
    assert.equal(step.edits?.[0]?.added, 1)
    assert.equal(step.edits?.[0]?.removed, 0)
  })

  await it('同一文件改了几次只留最后一次：审查面板给的是现在长什么样', () => {
    const lines = feed([
      { kind: 'tool-call', id: 't1', title: '写文件' },
      { kind: 'tool-result', id: 't1', diffs: [{ path: 'a.ts', oldText: '', newText: 'v1' }] },
      { kind: 'tool-call', id: 't2', title: '写文件' },
      { kind: 'tool-result', id: 't2', diffs: [{ path: 'a.ts', oldText: 'v1', newText: 'v2\nv3' }] },
    ])
    const edits = sessionEdits(lines)
    assert.equal(edits.length, 1)
    assert.equal(edits[0]!.newText, 'v2\nv3')
  })

  await it('审查对照保留相同的前后缀，中间整段摊开', () => {
    const rows = diffRows('a\nb\nc\nd', 'a\nB\nC\nd')
    assert.deepEqual(
      rows.map((r) => `${r.t}${r.text}`),
      [' a', '-b', '-c', '+B', '+C', ' d'],
    )
  })
}

// ---------------------------------------------------------------------------
// 二之三之二、离线：会话库
// ---------------------------------------------------------------------------

/**
 * 会话库这一段测的是「关掉再打开，上次那场还在不在」。
 *
 * 它容易坏在两处：一条脏记录把整库带崩；以及截断时从中间砍 ——
 * 前者让人丢掉全部历史，后者让最后那半场对话看起来像从头就是那样。
 */
async function agentLibrary(): Promise<void> {
  section('二之三之二、离线：会话怎么留、怎么读回来')

  const mk = (n: string, lines: AcpLine[] = [], now = 1000): AgentSession => ({
    id: n,
    agentId: 'claude',
    agentTitle: 'Claude Code',
    title: sessionTitle(lines),
    createdAt: now,
    updatedAt: now,
    lines,
  })

  await it('坏掉的一条记录丢掉，好的一条照读', () => {
    const raw = JSON.stringify([
      { id: 'ok', agentId: 'claude', agentTitle: 'Claude Code', lines: [{ id: 1, kind: 'say', text: 'hi' }] },
      { id: '', agentId: 'claude', agentTitle: 'x', lines: [] },
      { id: 'broken', agentId: 'claude', agentTitle: 'x', lines: 'nope' },
      null,
    ])
    const list = parseSessions(raw)
    assert.equal(list.length, 1)
    assert.equal(list[0]!.id, 'ok')
  })

  await it('JSON 坏了就当作没有，不让一场都读不出来', () => {
    assert.deepEqual(parseSessions('{not json'), [])
    assert.deepEqual(parseSessions(null), [])
  })

  await it('同一场再写一次是覆盖，并排到最前', () => {
    const a = mk('a')
    const b = mk('b')
    let list = [a]
    list = upsertSession(list, b)
    assert.deepEqual(list.map((s) => s.id), ['b', 'a'])
    list = upsertSession(list, { ...a, title: '改过' })
    assert.deepEqual(list.map((s) => s.id), ['a', 'b'])
    assert.equal(list[0]!.title, '改过')
  })

  await it('超出上限时从最旧的整场丢，不是从中间截', () => {
    let list: AgentSession[] = []
    for (let i = 0; i < 40; i++) list = upsertSession(list, mk(`s${i}`))
    assert.equal(list.length, 30)
    assert.equal(list[0]!.id, 's39')
    assert.equal(list[29]!.id, 's10')
  })

  await it('行太多时从头上截，并记下「更早的没留下」', () => {
    const lines: AcpLine[] = Array.from({ length: 300 }, (_, i) => ({ id: i, kind: 'say', text: `第 ${i} 行` }))
    const r = pruneLines(lines)
    assert.equal(r.lines.length, 240)
    assert.equal(r.truncated, true)
    assert.equal((r.lines[0] as Extract<AcpLine, { kind: 'say' }>).text, '第 60 行')
    assert.equal(pruneLines(lines.slice(0, 10)).truncated, false)
  })

  await it('会话名取第一句用户输入，没有就叫新会话', () => {
    assert.equal(sessionTitle([]), '新会话')
    assert.equal(
      sessionTitle([
        { id: 1, kind: 'say', text: '开场白' },
        { id: 2, kind: 'user', text: '  把  目录\n理一遍 ' },
      ]),
      '把 目录 理一遍',
    )
    const long = 'x'.repeat(60)
    assert.equal(sessionTitle([{ id: 1, kind: 'user', text: long }]).length, 37)
  })

  await it('localStorage 不可用时读回空库，而不是抛错', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
    }
    assert.deepEqual(loadSessions(throwing), [])
  })
}

// ---------------------------------------------------------------------------
// 二之四、离线：兼容矩阵这一层
// ---------------------------------------------------------------------------

/**
 * 矩阵这一层测的是「我们敢不敢说这一家能用」。
 *
 * 它最容易坏在两处：一是版本对不上还拿旧结果糊弄（适配器包会更新）；
 * 二是把「工具包挂不上」也算成不兼容（那是能力差异，不是兼容性问题）。
 * 这两处错一个，矩阵就从「证据」变成「广告」。
 */
async function matrixLayer(): Promise<void> {
  section('二之四、离线：兼容矩阵怎么判')

  const builtin = BUILTIN_ACP_AGENTS[0]!
  /**
   * 矩阵里没有的一家。
   *
   * 为什么单独造一个：矩阵文件里已经有实测出来的格子了，拿内置那家来当
   * 「没测过」的例子，只在矩阵还是空的时候成立 —— 数据一落地，
   * 那个例子就变成了「拿旧结论糊弄」。这里造一个真不在表里的条目。
   */
  const untested: AcpAgentEntry = {
    id: 'never-probed',
    title: '没验过的一家',
    blurb: '',
    command: 'npx',
    args: [],
    package: { name: 'never-probed', version: '9.9.9' },
    notes: [],
    source: 'builtin',
  }
  const userEntry: AcpAgentEntry = {
    id: 'mine',
    title: '我自己加的',
    blurb: '',
    command: 'x',
    args: [],
    notes: [],
    source: 'user',
  }

  await it('没测过的条目不绿 —— 宁可说没绿，不能说绿', () => {
    // 用一个矩阵里根本没有的条目：矩阵里已经有实测格了，
    // 拿内置那家来当「没测过」的例子，只在矩阵还是空的时候才成立。
    const s = matrixStatus(untested)
    assert.equal(s.tested, false)
    assert.equal(s.green, false)
    assert.ok(s.reason && s.reason.length > 0, '没测过也得说清为什么')
  })

  await it('测过但没测全的那一格不绿，只说接得上', () => {
    // 这一条是矩阵真正的价值：测到哪儿说到哪儿。
    // 拿实测数据里真实存在的那一家来判 —— 不绿，但不能装作没测过。
    const tested = BUILTIN_ACP_AGENTS.find((e) => matrixCell(e) !== undefined)
    if (!tested) return // 没跑过活体就没有这一格，跳过
    const s = matrixStatus(tested)
    assert.equal(s.tested, true)
    assert.equal(s.currentVersionTested, true)
    assert.equal(s.green, false, '只测到握手与建会话不该算绿')
    assert.match(s.reason ?? '', /没测/, '要说清是哪几步没测')
    assert.ok(s.cell, '得带上那一格，界面才知道该怎么画')
  })

  await it('用户自己加的条目永远不绿：Torra 没测过它', () => {
    const s = matrixStatus(userEntry)
    assert.equal(s.tested, false)
    assert.equal(s.green, false)
    assert.match(s.reason ?? '', /没测过/)
  })

  await it('矩阵里没有这一家时，取不到格子', () => {
    assert.equal(matrixCell(untested), undefined)
  })

  await it('写进去的条目能盖掉内置那一条，也能删掉', () => {
    const root = tmpDir('save')
    const ok = saveOverride(root, { id: 'mine', title: '我自己的', command: 'my-agent', args: ['--acp'] })
    assert.equal(ok.ok, true)
    const { entries } = listAgents(root)
    const mine = entries.find((e) => e.id === 'mine')
    assert.ok(mine)
    assert.equal(mine!.source, 'user')
    assert.equal(mine!.command, 'my-agent')
    fs.rmSync(root, { recursive: true, force: true })
  })

  await it('写进去的条目要过校验：带 shell 连接符的照样被拒', () => {
    const root = tmpDir('save-bad')
    const bad = saveOverride(root, { id: 'x', command: 'npx', args: ['pkg&calc.exe'] })
    assert.equal(bad.ok, false)
    fs.rmSync(root, { recursive: true, force: true })
  })
}

// ---------------------------------------------------------------------------
// 二之五、离线：预检结论怎么分类
// ---------------------------------------------------------------------------

async function verdicts(): Promise<void> {
  section('二之五、离线：接不上的时候要说清是哪一种')

  await it('命令没找到 → 没装', () => {
    const v = classifyProbeFailure('spawn npx ENOENT', '', 'Claude Code')
    assert.equal(v.kind, 'not-installed')
    assert.match(v.text, /Claude Code/)
  })

  await it('起来但没登录 → 没登录', () => {
    const v = classifyProbeFailure('failed', 'Error: not logged in, run `claude login`', 'Claude Code')
    assert.equal(v.kind, 'not-logged-in')
    assert.ok(v.hint && v.hint.length > 0, '没登录也得说下一步做什么')
  })

  await it('协议对不上 → 对不上', () => {
    const v = classifyProbeFailure('invalid params', '', 'Codex')
    assert.equal(v.kind, 'incompatible')
  })

  await it('看不出是哪一种就归「接不上」，别硬套', () => {
    const v = classifyProbeFailure('something odd', '', 'pi')
    assert.equal(v.kind, 'unknown')
  })

  await it('预检的原文里不能带着凭据出去', () => {
    // agent 的适配器爱把环境变量整包打出来；贴到界面上之前要抹一遍
    const raw = 'API_KEY=sk-abcdef1234567890 Authorization: Bearer abcdef1234567890'
    const out = redactSecrets(raw)
    assert.ok(!out.includes('sk-abcdef1234567890'), '密钥没被抹掉')
    assert.ok(!out.includes('abcdef1234567890'), '令牌没被抹掉')
    assert.match(out, /API_KEY/, '键名要留着，用户才知道是哪一项')
  })
}

// ---------------------------------------------------------------------------
// 三、活体：对着真的 agent 跑预检
// ---------------------------------------------------------------------------

/**
 * 活体：对着真的 agent 跑一遍，看协议层到底通到哪一步。
 *
 * 三档开关，各管各的：
 *   --live          跑握手与建会话（不发 prompt，不花钱，慢在下载 npm 包）
 *   --live-full     再跑发一轮、授权、打断（要凭据，会花钱）
 *   --write-matrix  把结果写回 src/main/acp/matrix-data.json（兼容矩阵的数据源）
 *
 * 为什么分成三档：预检本身就该是廉价的 —— 「接不接得上」这件事要能随时问，
 * 一次要几分钟、还花钱的检查就没人愿意按第二遍。
 */
async function live(): Promise<void> {
  section('三、活体：对着真的 agent 跑预检（不发 prompt，不花钱）')

  const root = tmpDir('live')
  const work = path.join(root, 'work')
  fs.mkdirSync(work, { recursive: true })
  const service = new AcpService({
    userDataRoot: root,
    clientName: 'Torra',
    clientVersion: '0.0.0',
    // 活体那一段要看到工具包真的能不能挂上，所以给它一份假 caps（离线可跑）
    caps: stubCaps,
    log: (level, message) => {
      if (level === 'error') console.log(`         ${message}`)
    },
  })

  const rows: string[] = []
  const cells: AcpMatrixCell[] = []
  for (const entry of BUILTIN_ACP_AGENTS) {
    const started = Date.now()
    const result = await service.probe(entry.id, { cwd: work })
    const caps = result.capabilities
    const line = [
      entry.id.padEnd(9),
      result.ok ? '接上了' : '接不上',
      `${Date.now() - started}ms`.padStart(7),
      caps ? `auth=${caps.authMethods.length}` : '-',
      caps ? `http-mcp=${caps.mcpHttp ? '是' : '否'}` : '-',
      caps?.toolPack
        ? `工具包=${caps.toolPack.attached ? `${caps.toolPack.tools}个` : '挂不上'}`
        : '工具包=-',
      caps ? `session=${caps.sessionCapabilities.join('/') || '无'}` : '-',
      caps ? `下拉组=${caps.selects.map((s) => `${s.id}(${s.kind})`).join(' ')}` : '-',
    ].join('  ')
    rows.push(line)
    console.log(`  ${line}`)
    if (!result.ok) console.log(`         ${(result.error ?? '').split('\n')[0]}`)

    // 兼容矩阵的格子：测到哪一步就记哪一步，没测的记成 false 并写明为什么。
    // 宁可空着说「没测」，也不要拿一次握手当成「接得上」。
    const notes: string[] = []
    let promptOk = false
    let cancelOk = false
    let permissionOk = false

    if (!result.ok) {
      notes.push(`接不上：${(result.error ?? '').split('\n')[0] ?? '原因不明'}`)
    } else {
      notes.push(`握手与建会话通过（${result.elapsedMs}ms）`)
      if (caps && !caps.mcpHttp) notes.push('这一家不收 http 形态的 MCP，工具包挂不上')
      if (caps && caps.toolPack?.attached) notes.push(`工具包挂上了：${caps.toolPack.tools} 个工具`)
      notes.push('发一轮与授权没测（要凭据，也花钱；跑 --live-full 才测）')
    }

    // 发一轮：只有显式要求时才做 —— 它要凭据，也要花钱
    if (LIVE_FULL && result.ok) {
      const seen = { permission: false }
      const live2 = new AcpService({
        userDataRoot: root,
        clientName: 'Torra',
        clientVersion: '0.0.0',
        caps: stubCaps,
        onEvent: () => {},
        onPermission: (_agentId, req) => {
          seen.permission = true
          // 这一家要授权时，给它最保守的那一项，不猜它想要什么
          const first = req.options.find((o) => o.optionId)
          void live2.respondPermission(req.id, { optionId: first?.optionId ?? null })
        },
      })
      const liveStarted = await live2.start(entry.id, { cwd: work })
      if (liveStarted.ok) {
        const sent = await live2.prompt('用一句话回答：你好。只回这两个字，不调用任何工具。')
        promptOk = sent.ok
        permissionOk = seen.permission
        await live2.cancel()
        cancelOk = true
        notes.push(
          promptOk
            ? '发一轮通了（agent 回话了）'
            : `发一轮没成：${(sent.error ?? '原因不明').split('\n')[0]}`,
        )
        if (permissionOk) notes.push('这一家会反过来要授权')
        else notes.push('这一家没要授权（自己干了）')
        notes.push(cancelOk ? '打断走通' : '打断没走通')
      } else {
        notes.push(`接上了但重连不上：${(liveStarted.error ?? '').split('\n')[0]}`)
      }
      await live2.stop()
    }

    cells.push({
      id: entry.id,
      version: entry.package?.version ?? 'self',
      agentVersion: caps?.agentVersion,
      checkedAt: new Date().toISOString().slice(0, 10),
      handshake: result.ok,
      session: result.ok,
      prompt: promptOk,
      cancel: cancelOk,
      permission: permissionOk,
      toolPack: result.ok ? (caps?.toolPack?.attached ?? false) : false,
      // 这一格是不是测了整轮往返：没测过的那几步要写「没测」，
      // 不能和「测了但没过」挤在一张表里 —— 那会把「没量」说成「不行」。
      full: LIVE_FULL && result.ok,
      notes,
    })
  }

  await it('至少有一家接得上（这一段证明的不是「都兼容」，是「接得上」）', () => {
    const okCount = rows.filter((r) => r.includes('接上了')).length
    assert.ok(okCount > 0, '一家都没接上')
  })

  if (WRITE_MATRIX) {
    // 数据文件叫 matrix-data.json：跟 matrix.ts 同名的话，
    // 无扩展名的 require 会先撞上 .json，模块就静悄悄地变成空壳。
    const file = path.join(ROOT, 'src', 'main', 'acp', 'matrix-data.json')
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          generatedBy: 'npm run test:acp -- --live --write-matrix',
          note: '每一行是一「家 + 一个版本」的实测结果。适配器包跟着上游走，用户本机随时可能换版本，所以键里带着版本号：换了版本这一格就不再作数。',
          cells,
        },
        null,
        2,
      ),
      'utf8',
    )
    console.log(`\n  矩阵写回 ${file}`)
  }

  // 临时目录：agent 的子进程可能还占着它当工作目录，删不掉就算了，
  // 犯不着为了收摊把整段测量判成失败。
  try {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 })
  } catch {
    console.log(`         （临时目录没删掉：${root}）`)
  }
}

async function main(): Promise<void> {
  console.log('ACP 接入回归')
  await offline()
  await toolPackOffline()
  await againstFixture()
  await toolPackHandoff()
  await uiLines()
  await agentLibrary()
  await matrixLayer()
  await verdicts()
  if (LIVE || LIVE_FULL) {
    await live()
  } else {
    console.log('\n（活体矩阵没跑：加 --live 打开。要下 npm 包，慢，而且没登录会失败）')
  }
  console.log(`\n通过 ${pass} · 失败 ${fail}`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
