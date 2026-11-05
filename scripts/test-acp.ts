/**
 * ACP 接入的回归：协议对不对、边界守不守得住、兼容性能不能被测出来。
 *
 * 这一层的价值在于把「ACP 是标准，所以接谁都行」这句话换成可验证的东西。
 * 标准只保证方法名与消息形状，它不保证：
 *   - agent 一定会回来要授权（有的直接自己干了）；
 *   - agent 一定收 http 形态的 MCP（实测 pi-acp 不收）；
 *   - agent 的「模式」是权限（claude 是、codex 是沙箱档、pi 是思考档）；
 *   - agent 留下的历史在重开之后还对得上原来那一轮（有的给序号，指不回去）。
 * 所以兼容性只能靠矩阵说话，而矩阵要有对端才成得了 —— 于是有了那个假 agent。
 *
 * 分三段：
 *   一、离线：注册表的校验、fs 通道的目录边界、设置项的分派依据、
 *      身份闸门的判据（哪些标识算持久、能不能接着聊分几档）；
 *   二、对端：拿仓库里的假 agent 跑完整往返（握手、一轮、授权、读写文件、取消），
 *      再关掉进程读回一遍（真源在它自己那儿，Torra 不另存一份正文）；
 *   三、活体（可选）：对着真的 Claude Code / Codex / pi / OpenCode 跑一遍预检，
 *      把协商结果打成矩阵。这一段要下 npm 包、慢、可能因为没登录而失败，
 *      所以默认不跑，用 `npm run test:acp -- --live` 打开。
 *
 * 运行：npm run test:acp · npm run test:acp -- --live
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { AcpService } from '../src/main/acp'
import { AcpClient, killTree, pathWithinRoots } from '../src/main/acp/client'
import { AcpHostProjector, readNativeTurnRef, toolOutputParts } from '../src/main/acp/host'
import { buildAcpMcpTools, mcpDeclaration, startAcpMcpServer } from '../src/main/acp/mcp'
import { BUILTIN_ACP_AGENTS, listAgents, saveOverride, validateOverride } from '../src/main/acp/registry'
import { matrixCell, matrixStatus } from '../src/main/acp/matrix'
import {
  CURATED_CATALOG,
  OFFICIAL_ID_TO_TORRA_ID,
  curatedView,
  fetchOfficialCatalog,
  fetchOfficialIcon,
  findOnPath,
  officialCachePath,
  officialItem,
  parseOfficialRegistry,
  platformKey,
  readCachedOfficial,
  splitPkgVersion,
} from '../src/main/acp/catalog'
import { classifyProbeFailure, redactSecrets } from '../src/main/acp/diagnose'
import type { AssistantCaps } from '../src/main/assistant/tools'
import {
  applyHostEvent,
  judgeResume,
  looksUnstableTurnRef,
  type HostEvent,
  type HostItem,
  type HostSnapshot,
} from '../src/shared/host'
import {
  diffRows,
  diffStat,
  groupAcpLines,
  linesFromItems,
  sessionEdits,
  sessionTouches,
  type AcpLine,
} from '../src/renderer/acpLines'
import {
  canResume,
  loadSessions,
  parseSessions,
  pruneItems,
  sessionTitle,
  upsertSession,
  type AgentSession,
} from '../src/renderer/agentSessions'
import { isBlockedAcpOption } from '../src/shared/acp'
import type { AcpAgentEntry, AcpMatrixCell } from '../src/shared/acp'

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

/** Host 事件里的正文：把一片一片的正文接起来 */
function textOf(events: HostEvent[]): string {
  return events
    .filter((e) => e.kind === 'message.delta' && e.channel === 'text')
    .map((e) => (e as Extract<HostEvent, { kind: 'message.delta' }>).delta)
    .join('')
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

  /*
   * 收进程树：Windows 上 `shell: true` 拉起来的是 cmd.exe 壳，agent 是它的孙进程。
   * 只 kill 壳的话，孙进程会被重挂到别处继续跑 —— 界面上就是「点了取消它还在动」。
   * 这条用例起一棵真的树（壳 → node 孙进程），验 killTree 收得干净。
   */
  await it('收进程树：壳拉起来的孙进程也要一起收掉', async () => {
    const mark = `torra-killtree-${Date.now()}`
    const child = spawn(`node -e "setInterval(()=>{},1000)" ${mark}`, {
      shell: true,
      windowsHide: true,
      stdio: 'ignore',
    })
    const survivors = (): number => {
      if (process.platform !== 'win32') return 0
      const ps = spawnSync(
        'powershell',
        [
          '-NoProfile',
          '-Command',
          `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*${mark}*' } | Measure-Object | Select-Object -ExpandProperty Count`,
        ],
        { encoding: 'utf8', windowsHide: true },
      )
      return Number((ps.stdout ?? '0').trim() || 0)
    }
    // 等孙进程起来
    await new Promise((r) => setTimeout(r, 900))
    assert.ok(child.pid, '壳要拿到 pid')
    assert.equal(survivors(), 1, '前提：孙进程已经起来了（否则这条用例是空转）')
    killTree(child.pid!)
    await new Promise((r) => setTimeout(r, 800))
    assert.equal(survivors(), 0, 'killTree 之后孙进程不许还活着')
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

  const events: HostEvent[] = []
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

  await it('这一家给了跨重启稳定的会话号 —— 接着聊全靠它', () => {
    assert.ok(started.sessionId, '没拿到 agent 那边的会话号')
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
    const text = textOf(events)
    assert.match(text, /假 agent/)
    const toolCall = events.find((e) => e.kind === 'item.started')
    assert.ok(toolCall, '没有工具调用事件')
    assert.equal((toolCall as { itemId: string }).itemId, 'fixture-tool-1')
    const toolResult = events.find((e) => e.kind === 'item.completed')
    assert.ok(toolResult, '没有工具结果事件')
    assert.equal((toolResult as { status?: string }).status, 'completed')
    assert.ok(events.some((e) => e.kind === 'turn.completed'))
  })

  await it('用户那一句只出现一次：实时时 agent 的回声要被略过', () => {
    const userLines = events.filter((e) => e.kind === 'turn.started')
    assert.equal(userLines.length, 1, '用户那一句重复了')
    assert.equal((userLines[0] as { text: string }).text, '#text #tool')
  })

  events.length = 0
  await service.prompt('#permission')
  await it('授权往返：agent 要授权，用户的决定回到 agent 手里', () => {
    assert.ok(permissionSeen, '没有收到授权请求')
    assert.match(permissionSeen!.title, /写一个文件/)
    assert.match(textOf(events), /选了 allow-once/)
  })

  events.length = 0
  fs.writeFileSync(path.join(work, 'fixture-read.txt'), '第一行\n第二行\n', 'utf8')
  await service.prompt('#read')
  await it('fs 读：agent 要读文件，内容经客户端取回', () => {
    const text = textOf(events)
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
    assert.match(textOf(events), /写不了/)
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
    const text = textOf(events)
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
// 二之三、离线：Host 账本怎么折成界面上的行
// ---------------------------------------------------------------------------

/**
 * 这一段测的是「账本 → 界面」这一层，不是协议本身。
 *
 * 它容易坏在几个地方：文字分片被当成整段（每来一个字就另起一行）、
 * 工具结果找不到它对应的那一步（界面上多出一根没有上文的横杠）、
 * 思考与工具被拆散成一屏噪声。这几样在协议层都测不出来 ——
 * 协议只管消息合不合规，不管画出来好不好看。
 */
async function uiLines(): Promise<void> {
  section('二之三、离线：账本怎么折成界面上的行')

  /** Host 事件流 → 账本 → 界面上的一行行 */
  const feed = (events: HostEvent[]): AcpLine[] =>
    linesFromItems(events.reduce((items, e) => applyHostEvent(items, e), [] as HostItem[]))

  await it('分片的文字接在同一段里，不会每来一个字就另起一行', () => {
    const lines = feed([
      { kind: 'message.delta', turnId: 't1', channel: 'text', delta: '我先' },
      { kind: 'message.delta', turnId: 't1', channel: 'text', delta: '看' },
      { kind: 'message.delta', turnId: 't1', channel: 'text', delta: '一眼目录' },
    ])
    assert.equal(lines.length, 1)
    assert.equal(lines[0]!.kind, 'say')
    assert.equal((lines[0] as Extract<AcpLine, { kind: 'say' }>).text, '我先看一眼目录')
  })

  await it('被别的内容隔开的文字另起一段', () => {
    const lines = feed([
      { kind: 'message.delta', turnId: 't1', channel: 'text', delta: '第一段' },
      { kind: 'notice', text: '中途插了一句' },
      { kind: 'message.delta', turnId: 't1', channel: 'text', delta: '第二段' },
    ])
    assert.equal(lines.length, 3)
    assert.equal(lines[0]!.kind, 'say')
    assert.equal(lines[1]!.kind, 'notice')
    assert.equal(lines[2]!.kind, 'say')
  })

  await it('思考与文字分开：思考进步骤组，文字留在正文', () => {
    const lines = feed([
      { kind: 'message.delta', turnId: 't1', channel: 'thinking', delta: '先看目录' },
      { kind: 'message.delta', turnId: 't1', channel: 'text', delta: '目录里有三个文件' },
    ])
    const blocks = groupAcpLines(lines)
    assert.equal(blocks.length, 2)
    assert.equal(blocks[0]!.kind, 'steps')
    assert.equal(blocks[1]!.kind, 'say')
  })

  await it('工具结果回到它对应的那一步上，不多出一根横杠', () => {
    const lines = feed([
      { kind: 'item.started', turnId: 't1', itemId: 't1', title: '读文件' },
      { kind: 'item.started', turnId: 't1', itemId: 't2', title: '列目录' },
      { kind: 'item.completed', turnId: 't1', itemId: 't1', status: 'completed', text: '内容在这' },
    ])
    assert.equal(lines.length, 2, '工具结果没有并回原来的那一步')
    const first = lines[0] as Extract<AcpLine, { kind: 'tool' }>
    assert.equal(first.toolId, 't1')
    assert.equal(first.out, '内容在这')
    assert.equal(first.running, false)
    // 第二步还在跑
    assert.equal((lines[1] as Extract<AcpLine, { kind: 'tool' }>).running, true)
  })

  await it('工具结果并回那一步时，编号不变：展开状态不能被打断', () => {
    const lines = feed([
      { kind: 'item.started', turnId: 't1', itemId: 't1', title: '读文件' },
      { kind: 'item.completed', turnId: 't1', itemId: 't1', status: 'completed', text: '内容在这' },
    ])
    assert.equal(lines.length, 1)
    assert.equal(lines[0]!.id, 0)
  })

  await it('agent 先报结果、后报调用：不丢掉，也不挂错', () => {
    const lines = feed([
      { kind: 'item.completed', turnId: 't1', itemId: 't9', status: 'completed', text: '先到的结果' },
      { kind: 'item.started', turnId: 't1', itemId: 't9', title: '读文件' },
    ])
    assert.equal(lines.length, 2)
    assert.equal((lines[0] as Extract<AcpLine, { kind: 'tool' }>).out, '先到的结果')
  })

  await it('用量与收尾各成一行小结，不混进正文', () => {
    const lines = feed([
      { kind: 'message.delta', turnId: 't1', channel: 'text', delta: '做完了' },
      { kind: 'usage.updated', turnId: 't1', input: 120, output: 45 },
      { kind: 'turn.completed', turnId: 't1', stopReason: 'end_turn' },
    ])
    assert.equal(lines.length, 3)
    assert.equal(lines[1]!.kind, 'tally')
    assert.match((lines[1] as Extract<AcpLine, { kind: 'tally' }>).text, /输入 120/)
    assert.equal(lines[2]!.kind, 'tally')
    assert.match((lines[2] as Extract<AcpLine, { kind: 'tally' }>).text, /end_turn/)
  })

  await it('报错单独成行，颜色由它自己的类名决定', () => {
    const lines = feed([{ kind: 'session.faulted', text: '这一家没登录' }])
    assert.equal(lines.length, 1)
    assert.equal(lines[0]!.kind, 'error')
  })

  await it('档位变了要留一句人话：改的什么、改成什么', () => {
    const lines = feed([{ kind: 'option.changed', optionId: 'mode', value: 'plan', name: '计划模式' }])
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
      { kind: 'item.started', turnId: 't1', itemId: 't1', title: '写文件', toolKind: 'edit' },
      {
        kind: 'item.completed',
        turnId: 't1',
        itemId: 't1',
        status: 'completed',
        edits: [{ path: 'src/index.ts', oldText: 'a', newText: 'a\nb' }],
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
      { kind: 'item.started', turnId: 't1', itemId: 't1', title: '写文件' },
      { kind: 'item.completed', turnId: 't1', itemId: 't1', edits: [{ path: 'a.ts', oldText: '', newText: 'v1' }] },
      { kind: 'item.started', turnId: 't1', itemId: 't2', title: '写文件' },
      { kind: 'item.completed', turnId: 't1', itemId: 't2', edits: [{ path: 'a.ts', oldText: 'v1', newText: 'v2\nv3' }] },
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

  await it('只给路径不给 diff 的那一步：路径得留下，但不能算成改动', () => {
    // 有的 agent 只给 locations：路径是有的，改动内容没有。
    // 把它折进审查面板的「改过的文件」里，就等于替它编了一次改动。
    const lines = feed([
      { kind: 'item.started', turnId: 't1', itemId: 't1', title: '重写文件' },
      {
        kind: 'item.completed',
        turnId: 't1',
        itemId: 't1',
        status: 'completed',
        locations: ['src/a.ts', 'src/b.ts'],
      },
    ])
    const step = lines[0] as Extract<AcpLine, { kind: 'tool' }>
    assert.deepEqual(step.locations, ['src/a.ts', 'src/b.ts'])
    assert.equal(step.edits, undefined, '没有 diff 却算出了改动')
    assert.deepEqual(sessionEdits(lines), [], '只给路径的步骤混进了改动清单')
    assert.deepEqual(sessionTouches(lines), ['src/a.ts', 'src/b.ts'])
  })

  await it('同一个文件既有 diff 又被点名：按改动算，不再重复说「只动过」', () => {
    const lines = feed([
      { kind: 'item.started', turnId: 't1', itemId: 't1', title: '写文件' },
      {
        kind: 'item.completed',
        turnId: 't1',
        itemId: 't1',
        status: 'completed',
        edits: [{ path: 'a.ts', oldText: 'x', newText: 'y' }],
      },
      { kind: 'item.started', turnId: 't1', itemId: 't2', title: '读文件' },
      { kind: 'item.completed', turnId: 't1', itemId: 't2', status: 'completed', locations: ['a.ts', 'b.ts'] },
    ])
    assert.deepEqual(
      sessionEdits(lines).map((e) => e.path),
      ['a.ts'],
    )
    assert.deepEqual(sessionTouches(lines), ['b.ts'])
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

  const mk = (n: string, items: HostItem[] = [], now = 1000): AgentSession => ({
    id: n,
    agentId: 'claude',
    agentTitle: 'Claude Code',
    title: sessionTitle(items),
    createdAt: now,
    updatedAt: now,
    items,
  })

  await it('正文坏掉只丢正文，索引还在；索引本身坏掉才整条丢', () => {
    // 会话库现在存的是索引 + 一份可选的兜底正文。索引坏了整条没法用；
    // 正文坏了只是少一份兜底 —— 「接着聊」靠的是索引与 agent 那边的会话号，
    // 把整场丢掉反而是白丢一次能接上的会话。
    const raw = JSON.stringify([
      {
        id: 'ok',
        agentId: 'claude',
        agentTitle: 'Claude Code',
        items: [{ id: 0, kind: 'message', role: 'agent', turnId: 't1', text: 'hi' }],
      },
      { id: '', agentId: 'claude', agentTitle: 'x', items: [] },
      { id: 'broken', agentId: 'claude', agentTitle: 'x', items: 'nope' },
      null,
    ])
    const list = parseSessions(raw)
    assert.equal(list.length, 2)
    assert.equal(list[0]!.id, 'ok')
    assert.equal(list[0]!.items?.length, 1)
    const broken = list.find((s) => s.id === 'broken')
    assert.ok(broken, '正文坏掉就把索引一起丢了')
    assert.equal(broken!.items, undefined, '坏掉的正文没被丢掉')
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

  await it('条目太多时从头上截，并记下「更早的没留下」', () => {
    const items: HostItem[] = Array.from({ length: 300 }, (_, i) => ({
      id: i,
      kind: 'message',
      role: 'agent',
      turnId: 't1',
      text: `第 ${i} 行`,
    }))
    const r = pruneItems(items)
    assert.equal(r.items.length, 240)
    assert.equal(r.truncated, true)
    assert.equal((r.items[0] as Extract<HostItem, { kind: 'message' }>).text, '第 60 行')
    assert.equal(pruneItems(items.slice(0, 10)).truncated, false)
  })

  await it('会话名取第一句用户输入，没有就叫新会话', () => {
    assert.equal(sessionTitle([]), '新会话')
    assert.equal(
      sessionTitle([
        { id: 0, kind: 'message', role: 'agent', turnId: 't1', text: '开场白' },
        { id: 1, kind: 'message', role: 'user', turnId: 't1', text: '  把  目录\n理一遍 ' },
      ]),
      '把 目录 理一遍',
    )
    const long = 'x'.repeat(60)
    assert.equal(
      sessionTitle([{ id: 0, kind: 'message', role: 'user', turnId: 't1', text: long }]).length,
      37,
    )
  })

  await it('localStorage 不可用时读回空库，而不是抛错', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {},
    }
    assert.deepEqual(loadSessions(throwing), [])
  })

  await it('能不能接着聊：得有 agent 那边的会话号，而且这一家得给得出历史', () => {
    const base = mk('s')
    assert.equal(canResume(base), false, '没有会话号却说有得接着聊')
    assert.equal(
      canResume({ ...base, nativeSessionId: 'n1', resume: { level: 'none', identity: 'none', reason: '' } }),
      false,
      '这一家压根不给历史，却说有得接着聊',
    )
    assert.equal(
      canResume({ ...base, nativeSessionId: 'n1', resume: { level: 'history', identity: 'ephemeral', reason: '' } }),
      true,
    )
    assert.equal(
      canResume({ ...base, nativeSessionId: 'n1', resume: { level: 'durable', identity: 'durable', reason: '' } }),
      true,
    )
  })
}

// ---------------------------------------------------------------------------
// 二之三之三、离线：持久身份闸门
// ---------------------------------------------------------------------------

/**
 * 身份闸门测的是「这一轮能不能被认回来」。
 *
 * 这是「接着聊」的根：Torra 自己编的号只在本进程里成立，重开之后对不上任何东西。
 * 拿它当持久身份，就是在承诺一件验不了的事 —— 所以这里把三种来源分开：
 *   - agent 自己给的（_meta 里的原生标识）→ 算数，但形状上像位置编号的仍然不认；
 *   - Torra 自己编的（t1、t2）→ 只在本进程里成立，不算持久身份；
 *   - 位置编号（3、replay-1）→ 一次执行里唯一，重启后指不回去，直接不认。
 */
async function identityGate(): Promise<void> {
  section('二之三之三、离线：持久身份闸门')

  await it('原生轮标识只认 agent 自己给的那些字段名', () => {
    assert.equal(readNativeTurnRef({ 'x.fixture/turnId': 'abc' }), 'abc')
    assert.equal(readNativeTurnRef({ turn_id: 'abc' }), 'abc')
    assert.equal(readNativeTurnRef({ 'acp/turnId': 'abc' }), 'abc')
    assert.equal(readNativeTurnRef({ nativeTurnRef: 'abc' }), 'abc')
    // 别的字段名不算：请求 id、消息 id 都不是轮的身份
    assert.equal(readNativeTurnRef({ requestId: 'abc' }), undefined)
    assert.equal(readNativeTurnRef({ messageId: 'abc' }), undefined)
    // 非字符串不算
    assert.equal(readNativeTurnRef({ 'x.fixture/turnId': 42 }), undefined)
    assert.equal(readNativeTurnRef({ 'x.fixture/turnId': '' }), undefined)
    assert.equal(readNativeTurnRef(null), undefined)
  })

  await it('位置编号那种标识不认：重启之后指不回原来那一轮', () => {
    assert.equal(looksUnstableTurnRef('3'), true)
    assert.equal(looksUnstableTurnRef('replay-1'), true)
    assert.equal(looksUnstableTurnRef('turn_7'), true)
    assert.equal(looksUnstableTurnRef('seq12'), true)
    assert.equal(looksUnstableTurnRef('index0'), true)
    assert.equal(looksUnstableTurnRef(''), true)
    assert.equal(looksUnstableTurnRef(undefined), true)
    // UUID 形状上不排除：它可能是持久存下来的，也可能是现生成的，
    // 分出来的是跨进程比对那一步，不是这一层
    assert.equal(looksUnstableTurnRef('4f1c2b6e-8a1d-4f2a-9c3b-7d5e6f0a1b2c'), false)
    assert.equal(looksUnstableTurnRef('conv-2026-10-30-abc'), false)
  })

  await it('能不能接着聊分三档，每一档都有出处', () => {
    const cell = (session: boolean, identity: boolean): AcpMatrixCell => ({
      id: 'x',
      version: '1.0.0',
      checkedAt: '2026-10-30',
      handshake: true,
      session: true,
      prompt: true,
      cancel: true,
      permission: false,
      toolPack: false,
      resume: { session, identity, checkedAt: '2026-10-30' },
      notes: [],
    })

    const none = judgeResume({ loadSession: false })
    assert.equal(none.level, 'none')
    assert.equal(none.identity, 'none')
    assert.match(none.reason, /不提供历史/)

    const durable = judgeResume({ loadSession: true, cell: cell(true, true) })
    assert.equal(durable.level, 'durable')
    assert.equal(durable.identity, 'durable')

    const history = judgeResume({ loadSession: true })
    assert.equal(history.level, 'history')
    assert.match(history.reason, /还没验过/)

    const mismatch = judgeResume({ loadSession: true, cell: cell(true, false) })
    assert.equal(mismatch.level, 'history')
    assert.match(mismatch.reason, /对不上/)

    const broken = judgeResume({ loadSession: true, cell: cell(false, false) })
    assert.equal(broken.level, 'none')
    assert.match(broken.reason, /读不回来/)
  })

  await it('没量过就是没量过：矩阵里没这一格时不能替它说行', () => {
    const r = judgeResume({ loadSession: true, cell: undefined })
    assert.equal(r.level, 'history')
    assert.equal(r.identity, 'none')
  })

  await it('实时那一轮里标识变了 = 漂移，回放时标识变了 = 换了一轮', () => {
    const chunk = (text: string): Record<string, unknown> => ({
      _meta: { 'x.f/turnId': text },
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    })

    const live = new AcpHostProjector()
    live.beginTurn('问一句')
    live.project(chunk('A'))
    live.project(chunk('B'))
    assert.equal(live.refDrifted, true, '同一轮里换了标识却没记漂移')
    assert.equal(live.turns.length, 1, '实时的一轮被拆成了两轮')

    const replay = new AcpHostProjector({ replay: true })
    replay.project(chunk('A'))
    replay.project(chunk('B'))
    assert.equal(replay.turns.length, 2, '回放的两轮没按标识切开')
    assert.equal(replay.turns[0]!.nativeTurnRef, 'A')
    assert.equal(replay.turns[1]!.nativeTurnRef, 'B')
  })

  await it('实时时用户那句只留一份：agent 的回声不并进来', () => {
    const live = new AcpHostProjector()
    live.beginTurn('我问了什么')
    live.project({
      _meta: { 'x.f/turnId': 'A' },
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '我问了什么' } },
    })
    const users = live.items.filter((i) => i.kind === 'message' && i.role === 'user')
    assert.equal(users.length, 1, '用户那一句被记了两遍')
  })

  await it('回放时用户那半边只能从回声里找回来', () => {
    const replay = new AcpHostProjector({ replay: true })
    replay.project({
      _meta: { 'x.f/turnId': 'A' },
      update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '我问了什么' } },
    })
    const users = replay.items.filter((i) => i.kind === 'message' && i.role === 'user')
    assert.equal(users.length, 1)
    assert.equal((users[0] as Extract<HostItem, { kind: 'message' }>).text, '我问了什么')
  })

  await it('接着聊的轮次从旧账之后接着编，不跟旧的重号', () => {
    const p = new AcpHostProjector()
    const old: HostSnapshot = {
      nativeSessionId: 'n1',
      items: [],
      turns: [{ turnId: 't1' }, { turnId: 't2' }],
    }
    p.continueAfter(old)
    p.beginTurn('新的')
    assert.equal(p.turns[0]!.turnId, 't3', '新轮次跟旧账重号了')
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
// 二之六、对端：关掉进程再接着聊
// ---------------------------------------------------------------------------

/**
 * 这一段是「真源在谁手里」的落点。
 *
 * 测法很笨，但只有这一种测法：跑一轮 → 关掉进程 → 换一个进程读回那一场 →
 * 比对两边看到的内容与轮次标识。
 *
 * 对不上就是真源丢了 —— 那时界面必须说「只能看 Torra 自己留下的记录」，
 * 而不是拿本地那份顶替。
 */
async function resumeAgainstFixture(): Promise<void> {
  section('二之六、对端：关掉进程再接着聊（真源在它自己那儿）')

  const root = tmpDir('resume')
  const work = path.join(root, 'work')
  fs.mkdirSync(work, { recursive: true })
  writeOverride(root, [fixtureEntry])

  const events: HostEvent[] = []
  const mk = (): AcpService =>
    new AcpService({
      userDataRoot: root,
      clientName: 'Torra-test',
      clientVersion: '0.0.0',
      caps: stubCaps,
      onEvent: (_agentId, event) => events.push(event),
      onPermission: async () => ({ optionId: null, reason: '测试不请求授权' }),
    })

  const first = mk()
  const started = await first.start('fixture', { cwd: work })
  await it('第一场接上了，agent 那边的会话号拿到了', () => {
    assert.equal(started.ok, true, started.error)
    assert.ok(started.sessionId, '没拿到 agent 那边的会话号')
  })

  await it('这一家没进矩阵，所以只能说到「有历史」这一档', () => {
    const resume = started.capabilities?.resume
    assert.ok(resume, '协商结果里没有「能不能接着聊」这一项')
    assert.equal(resume!.level, 'history', '没实测过却说了更硬的话')
  })

  events.length = 0
  await first.prompt('#text #tool')
  const liveTurn = [...events].reverse().find((e) => e.kind === 'turn.completed')
  const liveRef = liveTurn && liveTurn.kind === 'turn.completed' ? liveTurn.nativeTurnRef : undefined

  await it('那一轮带回了 agent 自己给的原生标识', () => {
    assert.ok(liveRef, '这一轮没有原生标识')
    assert.equal(looksUnstableTurnRef(liveRef), false, '那个标识是位置编号那种，重启后指不回去')
  })

  await first.stop()
  await new Promise((r) => setTimeout(r, 300))

  const second = mk()
  const resumed = await second.resume('fixture', started.sessionId!, { cwd: work })

  await it('换一个进程读回来：历史是这一家自己留下的那份', () => {
    assert.equal(resumed.ok, true, resumed.error)
    const snap = resumed.snapshot
    assert.ok(snap, '读回来没有快照')
    assert.ok(snap!.items.length > 0, '读回来是空的')
    const texts = snap!.items
      .filter((i) => i.kind === 'message')
      .map((i) => (i as Extract<HostItem, { kind: 'message' }>).text)
      .join('\n')
    assert.match(texts, /假 agent/, '读回来的不是那一轮的话')
    assert.match(texts, /#text/, '用户那半边没读回来')
  })

  await it('轮次标识跨进程对得上：这一轮能被认回来', () => {
    const snap = resumed.snapshot!
    const refs = snap.turns.map((t) => t.nativeTurnRef).filter(Boolean)
    assert.equal(refs.length, 1, '读回来的轮数不对')
    assert.equal(refs[0], liveRef, '读回来的标识跟当时那一轮对不上')
  })

  await it('工具那一步也在：结果回到原来那一步上', () => {
    const snap = resumed.snapshot!
    const tools = snap.items.filter((i) => i.kind === 'tool')
    assert.equal(tools.length, 1, '工具步骤没读回来')
    const tool = tools[0] as Extract<HostItem, { kind: 'tool' }>
    assert.equal(tool.out, '工具跑完了')
    assert.equal(tool.status, 'completed')
  })

  await it('读回来的不是 Torra 自己那份：Torra 这边此时一个字都没存', () => {
    // 真源交回 harness 之后，Torra 存的只是索引 —— 这一段验的就是
    // 「读回来的内容确实来自那一家，而不是本地兜底顶上来的」
    const snap = resumed.snapshot!
    const firstText = snap.items.find((i) => i.kind === 'message')
    assert.ok(firstText, '读回来是空的')
    assert.equal((firstText as Extract<HostItem, { kind: 'message' }>).role, 'user')
  })

  await second.stop()
  await new Promise((r) => setTimeout(r, 300))
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 })
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
      caps?.resume ? `续聊=${caps.resume.level}` : '续聊=-',
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
    /** 接着聊那一格：测过才有，没测就整个不写 */
    let resumeCell: AcpMatrixCell['resume']

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
      const seen = { permission: false, turnRef: undefined as string | undefined }
      const live2 = new AcpService({
        userDataRoot: root,
        clientName: 'Torra',
        clientVersion: '0.0.0',
        caps: stubCaps,
        onEvent: (_agentId, event) => {
          if (event.kind === 'turn.completed' && event.nativeTurnRef) seen.turnRef = event.nativeTurnRef
        },
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
        await live2.stop()

        /*
         * 接着聊：关掉，再换一个新进程读回来。
         *
         * 「读得回历史」和「读回来的那一轮跟当时那一轮对得上」是两件事，
         * 后者只能这样测 —— 一次运行里根本验不出来。
         */
        if (liveStarted.sessionId) {
          const reader = new AcpService({
            userDataRoot: root,
            clientName: 'Torra',
            clientVersion: '0.0.0',
            caps: stubCaps,
            onEvent: () => {},
            onPermission: async () => ({ optionId: null }),
          })
          const back = await reader.resume(entry.id, liveStarted.sessionId, { cwd: work })
          const snap = back.snapshot
          const sessionOk = back.ok && !!snap && snap.items.length > 0
          const refs = (snap?.turns ?? []).map((t) => t.nativeTurnRef).filter(Boolean)
          const identityOk =
            sessionOk && !!seen.turnRef && refs.length > 0 && refs.includes(seen.turnRef!)
          resumeCell = {
            session: sessionOk,
            identity: identityOk,
            checkedAt: new Date().toISOString().slice(0, 10),
            note: sessionOk
              ? identityOk
                ? '关掉进程换一个新进程读回来，轮次标识对得上'
                : '读得回历史，但轮次标识跨重启对不上'
              : '读不回那一场的历史',
          }
          notes.push(
            sessionOk
              ? identityOk
                ? '关掉进程再读回来：接得上'
                : '关掉进程再读回来：历史在，但轮次标识对不上'
              : '关掉进程再读回来：读不回来',
          )
          await reader.stop()
        } else {
          notes.push('这一家没给跨重启稳定的会话号，接着聊无从谈起')
        }
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
      resume: resumeCell,
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

/**
 * 目录：能不能一键接上，接上的那一条是不是真的起得来。
 *
 * 这一段守三件事：
 *   一、精选目录里每一条的启动规格都能被注册表校验放行 —— 目录说能接，接不上
 *      就是目录说错了话；
 *   二、本机检测按 PATH 判，不按别的猜；
 *   三、官方目录拉到的东西落进候选区，接不接由用户点，且不跟精选的那份重复。
 */
async function catalog(): Promise<void> {
  section('一·五、目录与本机检测')

  await it('精选目录覆盖了用户点名的那几家', () => {
    const ids = CURATED_CATALOG.map((c) => c.id)
    for (const want of ['dsh', 'qodercn', 'codebuddy', 'kimi']) {
      assert.ok(ids.includes(want), `精选目录里没有「${want}」`)
    }
    // 目录不能只有空壳：每一条都得有启动命令
    for (const c of CURATED_CATALOG) {
      assert.ok(c.command, `${c.id} 没有启动命令`)
      assert.ok(c.install, `${c.id} 没给装它的那一行`)
    }
  })

  await it('精选目录的每一条都过得了注册表校验', () => {
    // 这一条最要紧：目录说「点一下就能接」，那它拼出来的命令行必须被放行。
    for (const c of CURATED_CATALOG) {
      const v = validateOverride({
        id: c.id,
        title: c.title,
        blurb: c.blurb,
        command: c.command,
        args: c.args,
        package: c.package,
        authHint: c.authHint,
        notes: c.notes,
      })
      assert.equal(v.ok, true, `${c.id} 过不了校验：${v.ok ? '' : v.reason}`)
    }
  })

  await it('版本钉死：npm 包那一支，版本号是精确的一串', () => {
    for (const c of CURATED_CATALOG) {
      if (!c.package) continue
      assert.match(c.package.version, /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/, `${c.id} 的版本没钉死`)
      assert.ok(
        c.npx ? c.npx.package.includes(c.package.version) : true,
        `${c.id} 的 npx 那条路没有钉住同一个版本`,
      )
    }
  })

  await it('本机检测只认 PATH：找得到就是找得到', () => {
    // node 一定在 PATH 上（本进程就是它起的）
    assert.ok(findOnPath('node'), '连 node 都没在 PATH 上找到')
    assert.equal(findOnPath('torra-绝不可能存在-这个名字'), undefined)
    // 带路径的不算「在 PATH 上」
    assert.equal(findOnPath(path.join(os.tmpdir(), 'whatever')), undefined)
  })

  await it('精选视图每一条都说清本机有没有装', () => {
    const view = curatedView()
    assert.equal(view.length, CURATED_CATALOG.length)
    for (const item of view) {
      assert.equal(typeof item.installed, 'boolean')
      assert.ok(item.presence.length > 0, `${item.id} 没说自己装没装`)
      if (item.installed) assert.match(item.presence, /本机已有/)
      else assert.match(item.presence, /本机没装/)
    }
  })

  await it('没装的那家，给出的是这个平台跑得通的那一行', () => {
    // 抄错平台的那行，用户粘到终端里跑不通 —— 比不给还坏。
    for (const item of curatedView()) {
      assert.ok(item.install.trim(), `${item.id} 没给装它的那一行`)
      if (process.platform === 'win32') {
        assert.doesNotMatch(item.install, /\bcurl\b/, `${item.id} 在 Windows 上给了 curl 那条`)
      } else {
        assert.doesNotMatch(item.install, /\birm\b/, `${item.id} 在非 Windows 上给了 irm 那条`)
      }
    }
  })

  await it('包名与版本拆得开，拆不出就只给包名', () => {
    assert.deepEqual(splitPkgVersion('@scope/name@1.2.3'), { name: '@scope/name', version: '1.2.3' })
    assert.deepEqual(splitPkgVersion('name@1.2.3'), { name: 'name', version: '1.2.3' })
    assert.deepEqual(splitPkgVersion('name'), { name: 'name' })
    // 版本号不合规的，就当整个串都是包名（不硬塞一个坏版本进去）
    assert.deepEqual(splitPkgVersion('name@latest'), { name: 'name@latest' })
  })

  await it('官方目录的一条能翻成目录项：npx 那条与二进制那条各是一种', () => {
    const npxItem = officialItem({
      id: 'demo-npx',
      name: 'Demo npx',
      version: '1.2.3',
      description: '走 npm 的那一种',
      authors: ['某厂'],
      distribution: { npx: { package: '@demo/cli@1.2.3', args: ['--acp'] } },
    })
    assert.ok(npxItem)
    assert.equal(npxItem.mode, 'npx')
    assert.equal(npxItem.command, 'npx')
    assert.deepEqual(npxItem.args, ['-y', '@demo/cli@1.2.3', '--acp'])
    assert.equal(npxItem.package?.name, '@demo/cli')
    assert.equal(npxItem.package?.version, '1.2.3')
    assert.equal(npxItem.origin, 'official')

    const binItem = officialItem({
      id: 'demo-bin',
      name: 'Demo bin',
      distribution: {
        binary: {
          [platformKey()]: { cmd: './dist-package\\demo-agent.cmd', args: ['acp'], archive: 'https://x/y.zip' },
        },
      },
    })
    assert.ok(binItem)
    // 命令名要剥掉路径与后缀 —— Torra 起进程靠的是 PATH 上的那个名字
    assert.ok(['demo-agent', 'demo-agent.cmd'].includes(binItem.command))
    assert.deepEqual(binItem.args, ['acp'])
  })

  await it('平台键用的是官方目录自己的词：Windows 那边叫 windows，不叫 win32', () => {
    // 官方目录里的分发键只有这六个。Node 的 process.platform 在 Windows 上是
    // win32 —— 直接拼出来官方目录不认，于是 Windows 上每一家二进制分发的
    // 官方 agent 都会被误判成「这一版没有安装包」。
    const registryKeys = [
      'windows-x86_64',
      'windows-aarch64',
      'darwin-x86_64',
      'darwin-aarch64',
      'linux-x86_64',
      'linux-aarch64',
    ]
    assert.ok(registryKeys.includes(platformKey()), `平台键 ${platformKey()} 不在官方目录的词表里`)
  })

  await it('官方目录没给启动方式的，如实说接不了', () => {
    const item = officialItem({ id: 'demo-none', name: 'Demo none', distribution: {} })
    assert.ok(item)
    assert.ok(item.unsupported, '没给启动方式却没说不支持')
    assert.equal(item.command, '')
  })

  await it('官方目录的 id 映射到 Torra 的 id：同一家不出现两条', () => {
    assert.equal(OFFICIAL_ID_TO_TORRA_ID['claude-acp'], 'claude')
    assert.equal(OFFICIAL_ID_TO_TORRA_ID['codebuddy-code'], 'codebuddy')
    assert.equal(OFFICIAL_ID_TO_TORRA_ID['pi-acp'], 'pi')
  })

  await it('从目录接一家：落盘的那条就是启动规格本身', () => {
    const root = tmpDir('catalog-add')
    const service = new AcpService({
      userDataRoot: root,
      clientName: 'Torra-test',
      clientVersion: '0.0.0',
    })
    const r = service.addFromCatalog('kimi', 'local')
    assert.equal(r.ok, true, r.ok ? '' : r.reason)
    const { entries } = listAgents(root)
    const kimi = entries.find((e) => e.id === 'kimi')
    assert.ok(kimi, '落盘之后没有这一家')
    assert.equal(kimi.command, 'kimi')
    assert.deepEqual(kimi.args, ['acp'])
    assert.equal(kimi.source, 'user')
    fs.rmSync(root, { recursive: true, force: true })
  })

  await it('本机没装的，接上去也会写明「先装上再开会话」', () => {
    const root = tmpDir('catalog-missing')
    const service = new AcpService({
      userDataRoot: root,
      clientName: 'Torra-test',
      clientVersion: '0.0.0',
    })
    const r = service.addFromCatalog('dsh', 'local')
    assert.equal(r.ok, true, r.ok ? '' : r.reason)
    const { entries } = listAgents(root)
    const dsh = entries.find((e) => e.id === 'dsh')
    assert.ok(dsh)
    assert.ok(
      dsh.notes.some((n) => n.includes('还没装')),
      '本机没装却没写明',
    )
    fs.rmSync(root, { recursive: true, force: true })
  })

  await it('目录里没有的接不上；已经接上的不重复接', () => {
    const root = tmpDir('catalog-dup')
    const service = new AcpService({
      userDataRoot: root,
      clientName: 'Torra-test',
      clientVersion: '0.0.0',
    })
    const bad = service.addFromCatalog('根本没这一家', 'local')
    assert.equal(bad.ok, false)
    const first = service.addFromCatalog('kimi', 'local')
    assert.equal(first.ok, true)
    const again = service.addFromCatalog('kimi', 'local')
    assert.equal(again.ok, false)
    assert.match(again.ok ? '' : again.reason, /已经接上/)
    fs.rmSync(root, { recursive: true, force: true })
  })

  await it('目录视图：官方那一份里，精选已有的不重复列，内置那四家标成已接上', async () => {
    const root = tmpDir('catalog-view')
    // 塞一份假的官方目录进去：一条与精选重合（codebuddy-code），一条内置里有的（claude-acp），一条新的
    const fake = {
      agents: [
        {
          id: 'codebuddy-code',
          name: 'Codebuddy Code',
          version: '2.179.1',
          distribution: { npx: { package: '@tencent-ai/codebuddy-code@2.179.1', args: ['--acp'] } },
        },
        {
          id: 'claude-acp',
          name: 'Claude Agent',
          version: '0.99.1',
          distribution: { npx: { package: '@agentclientprotocol/claude-agent-acp@0.99.1' } },
        },
        {
          id: 'brand-new',
          name: 'Brand New',
          version: '0.1.0',
          distribution: { npx: { package: 'brand-new-cli@0.1.0', args: ['--acp'] } },
        },
      ],
    }
    // 用假 fetch 把它缓存下来 —— 这一步不联网
    const fetchImpl = (async () =>
      new Response(JSON.stringify(fake), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    await fetchOfficialCatalog(root, { fetchImpl })

    const service = new AcpService({
      userDataRoot: root,
      clientName: 'Torra-test',
      clientVersion: '0.0.0',
    })
    const items = parseOfficialRegistry(fake)
    assert.equal(items.length, 3)

    const view = service.catalogView()
    const ids = view.official.items.map((i) => i.torraId)
    // 与精选重合的那一条不在候选区重复列
    assert.ok(!ids.includes('codebuddy'), '与精选重合的那一条不该在候选区再列一遍')
    // 官方 id 映射到 Torra 的 id，内置那四家因此认得出「已经接上了」
    assert.ok(ids.includes('claude'), '内置那四家之一该带着 Torra 的 id 列出来')
    assert.equal(view.official.items.find((i) => i.torraId === 'claude')?.registered, true)
    // 全新的一家列出来，但还没接上
    assert.ok(ids.includes('brand-new'))
    assert.equal(view.official.items.find((i) => i.torraId === 'brand-new')?.registered, false)
    // 精选那一份每一条都说清自己是不是已经接上了
    assert.ok(view.curated.every((c) => typeof c.registered === 'boolean'))
    fs.rmSync(root, { recursive: true, force: true })
  })

  await it('官方目录拉到就缓存；拉不到就退回上一次那份并说明原因', async () => {
    const root = tmpDir('catalog-fetch')
    const good = {
      agents: [
        {
          id: 'demo',
          name: 'Demo',
          version: '0.1.0',
          distribution: { npx: { package: 'demo-cli@0.1.0' } },
        },
      ],
    }
    const okFetch = (async () =>
      new Response(JSON.stringify(good), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch
    const first = await fetchOfficialCatalog(root, { fetchImpl: okFetch })
    assert.equal(first.fetched, true)
    assert.equal(first.items.length, 1)
    assert.ok(fs.existsSync(officialCachePath(root)), '拉到了却没落盘')

    const badFetch = (async () => new Response('nope', { status: 503 })) as unknown as typeof fetch
    const second = await fetchOfficialCatalog(root, { fetchImpl: badFetch })
    assert.equal(second.fetched, false)
    assert.ok(second.error, '拉不到却没说明原因')
    // 拉不到时退回上一次那份，而不是把候选区清空
    assert.equal(second.items.length, 1)

    const cached = readCachedOfficial(root)
    assert.equal(cached.items.length, 1)
    fs.rmSync(root, { recursive: true, force: true })
  })

  await it('官方图标取回来是 data URI —— 界面自己引 CDN 会被 CSP 挡下', async () => {
    const root = tmpDir('catalog-icon')
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1v1H0z"/></svg>'
    const fetchImpl = (async () => new Response(svg, { status: 200 })) as unknown as typeof fetch
    const r = await fetchOfficialIcon(root, 'demo', { fetchImpl })
    assert.equal(r.ok, true)
    if (r.ok) assert.match(r.dataUrl, /^data:image\/svg\+xml;base64,/)
    // 标识不合法的一律不给取（那是拼路径的那一步）
    const bad = await fetchOfficialIcon(root, '../etc/passwd', { fetchImpl })
    assert.equal(bad.ok, false)
    fs.rmSync(root, { recursive: true, force: true })
  })
}

async function main(): Promise<void> {
  console.log('ACP 接入回归')
  await offline()
  await catalog()
  await toolPackOffline()
  await againstFixture()
  await toolPackHandoff()
  await uiLines()
  await agentLibrary()
  await identityGate()
  await matrixLayer()
  await verdicts()
  await resumeAgainstFixture()
  if (LIVE || LIVE_FULL) {
    await live()
  } else {
    console.log('\n（活体矩阵没跑：加 --live 打开。要下 npm 包，慢，而且没登录会失败）')
  }
  console.log(`\n通过 ${pass} · 失败 ${fail}`)
  process.exit(fail > 0 ? 1 : 0)
}

void main()
