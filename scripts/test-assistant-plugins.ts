/**
 * 声明式插件清单层的离线回归（不联网、不需要 Electron，只起本地 http 服务）
 *
 * 这一层的全部承诺都在「解释器只有一个」：清单是数据、执行只走 runPlugin，
 * 所以最值得钉死的性质都是「什么算合法」和「跑起来到底发了什么」：
 *
 * 1. 默认确认策略 —— GET/HEAD 放行、写操作和 shell 必问。默认值放宽一格，
 *    助手自造的插件就多得一次静默执行；
 * 2. 名字 = 文件名、约束不静默忽略（format/pattern 判整条无效）——
 *    「作者以为加了 ^\d+$，实际传什么都行」比加载报错危险得多；
 * 3. secrets 只认 plugin: 前缀 —— 否则助手自造插件成了把模型 API Key 外送的通道；
 * 4. shell 只走 execFile + argv（shell:false），argv[0] 由清单定死 ——
 *    这两条防的是同一个东西：把 {{param}} 变成命令注入；
 * 5. 坏清单绝不静默消失：load 报原因、write 不落非法文件、remove 只删点名那个。
 *
 * 运行：npm run test:assistant-plugins
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import {
  PLUGIN_SECRET_RE,
  compileParameters,
  interpolate,
  loadPluginManifests,
  pluginsDirOf,
  removePluginManifest,
  runPlugin,
  validateManifest,
  writePluginManifest,
  type InvalidPlugin,
  type PluginEntry,
  type PluginManifest,
} from '../src/main/assistant/plugins'

let pass = 0
let fail = 0

async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`)
  } catch (e) {
    fail++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`)
    console.log(`       ${(e as Error).message.split('\n')[0]}`)
  }
}

/** typebox 是 ESM-only（见 pi-sdk.ts 的说明），校验编译产物要按路径拿原生 import */
const nativeImport = new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

const SUFFIX = '.plugin.json'

/** 一条最小合法清单：name 永远等于将要使用的文件名 */
function rawOf(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name,
    description: '测试用清单',
    kind: 'http',
    parameters: { type: 'object', properties: { q: { type: 'string' } } },
    http: { method: 'GET', url: `http://127.0.0.1:8041/p` },
    ...over,
  }
}

function shellRawOf(name: string, argv: string[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return rawOf(name, { kind: 'shell', http: undefined, shell: { argv }, ...over })
}

async function main(): Promise<void> {
  console.log('\n声明式插件清单层\n' + '='.repeat(46))

  const tmp = mkdtempSync(path.join(os.tmpdir(), 'torra-plugins-'))
  const pluginsDir = pluginsDirOf(tmp)
  mkdirSync(pluginsDir, { recursive: true })
  const fileOf = (name: string) => path.join(pluginsDir, `${name}${SUFFIX}`)

  /** 校验并取出清单；不合法时把全部原因摊进断言消息，一次看全 */
  function mustOk(raw: unknown, name: string): PluginManifest {
    const e = validateManifest(raw, fileOf(name))
    assert.equal(e.ok, true, `应合法却报错：${e.ok ? '' : e.errors.join('；')}`)
    return (e as { manifest: PluginManifest }).manifest
  }
  /** 校验并取出原因列表 */
  function mustFail(raw: unknown, name: string): string[] {
    const e: PluginEntry = validateManifest(raw, fileOf(name))
    assert.equal(e.ok, false, `应报错却通过了：${JSON.stringify(raw)}`)
    return (e as InvalidPlugin).errors
  }

  // -------------------------------------------------------------------------
  // validateManifest：默认值是安全边界的一部分
  // -------------------------------------------------------------------------

  await it('合法 GET 清单通过，confirm 默认 never（只读不打扰，但下面全是默认值快照）', () => {
    const m = mustOk(rawOf('weather'), 'weather')
    assert.equal(m.confirm, 'never', 'GET 默认不该弹窗')
    assert.equal(m.kind, 'http')
    assert.equal(m.timeoutMs, 15_000, '默认超时')
    assert.equal(m.enabled, true)
    assert.equal(m.label, 'weather', 'label 缺省等于 name')
    assert.equal(m.file, fileOf('weather'), 'file 要带上：报错和设置页都靠它定位')
  })

  await it('POST 默认 confirm=always（写操作必须问）', () => {
    const m = mustOk(rawOf('poster', { http: { method: 'POST', url: 'http://127.0.0.1:8041/p' } }), 'poster')
    assert.equal(m.confirm, 'always')
  })

  await it('shell 默认 confirm=always（本机执行外部程序必须问）', () => {
    const m = mustOk(shellRawOf('runner', [process.execPath, '-e', 'console.log(1)']), 'runner')
    assert.equal(m.confirm, 'always')
    assert.deepEqual(m.shell!.argv, [process.execPath, '-e', 'console.log(1)'])
  })

  await it('显式 confirm 覆盖默认值（GET 也能要求每次确认）', () => {
    const m = mustOk(rawOf('polite', { confirm: 'always' }), 'polite')
    assert.equal(m.confirm, 'always')
  })

  // -------------------------------------------------------------------------
  // validateManifest：身份与来源
  // -------------------------------------------------------------------------

  await it('name 和文件名不一致：无效 —— 一个插件的身份只能有一个来源', () => {
    const errs = mustFail(rawOf('other-name'), 'solo')
    assert.ok(errs.some((x) => /文件名/.test(x)), errs.join('；'))
  })

  await it('缺 description：无效 —— 模型全靠这句话决定用不用这个工具', () => {
    const errs = mustFail(rawOf('nodesc', { description: '' }), 'nodesc')
    assert.ok(errs.some((x) => /description/.test(x)), errs.join('；'))
  })

  await it('kind 不是 http/shell：无效', () => {
    const errs = mustFail(rawOf('weird', { kind: 'grpc', http: undefined }), 'weird')
    assert.ok(errs.some((x) => /kind/.test(x)), errs.join('；'))
  })

  await it('清单不是 JSON 对象（数组）：无效', () => {
    const e = validateManifest([1, 2], fileOf('arr'))
    assert.equal(e.ok, false)
    assert.ok((e as InvalidPlugin).errors.some((x) => /JSON 对象/.test(x)))
  })

  await it('confirm 拼错值：无效（不能悄悄按默认走）', () => {
    const errs = mustFail(rawOf('typo', { confirm: 'sometimes' }), 'typo')
    assert.ok(errs.some((x) => /confirm/.test(x)), errs.join('；'))
  })

  await it('enabled 非布尔：无效', () => {
    const errs = mustFail(rawOf('tricky', { enabled: 'yes' }), 'tricky')
    assert.ok(errs.some((x) => /enabled/.test(x)), errs.join('；'))
  })

  // -------------------------------------------------------------------------
  // validateManifest：命令注入的三道闸
  // -------------------------------------------------------------------------

  await it('argv[0] 含占位符：无效 —— 执行哪个程序由清单定死，不由模型定', () => {
    const errs = mustFail(shellRawOf('swap', ['{{prog}}', 'x']), 'swap')
    assert.ok(errs.some((x) => /argv\[0\]/.test(x)), errs.join('；'))
  })

  await it('argv[1] 之后可以用占位符，argv[0] 不行（同一条只改落点）', () => {
    const m = mustOk(shellRawOf('fine', [process.execPath, '{{arg}}']), 'fine')
    assert.equal(m.confirm, 'always')
  })

  await it('shell.argv 里有空参：无效（空串会让 execFile 错位）', () => {
    const errs = mustFail(shellRawOf('gappy', [process.execPath, '   ']), 'gappy')
    assert.ok(errs.some((x) => /空参数/.test(x)), errs.join('；'))
  })

  await it("shell.cwd 只认 'plugin'/'data'", () => {
    const errs = mustFail(shellRawOf('wdir', [process.execPath, 'x'], { shell: { argv: [process.execPath], cwd: '/etc' } }), 'wdir')
    assert.ok(errs.some((x) => /cwd/.test(x)), errs.join('；'))
  })

  // -------------------------------------------------------------------------
  // validateManifest：schema 子集 —— 没实现的约束宁可判整条无效
  // -------------------------------------------------------------------------

  await it('属性上的 format 没实现：整条清单无效 —— 静默放宽比报错危险', () => {
    const errs = mustFail(rawOf('fmt', {
      parameters: { type: 'object', properties: { q: { type: 'string', format: 'date' } } },
    }), 'fmt')
    assert.ok(errs.some((x) => /没实现/.test(x)), errs.join('；'))
  })

  await it('属性上的 pattern 同样整条无效（作者以为有 ^\\d+$，实际传什么都行）', () => {
    const errs = mustFail(rawOf('pat', {
      parameters: { type: 'object', properties: { n: { type: 'integer', pattern: '^\\d+$' } } },
    }), 'pat')
    assert.ok(errs.some((x) => /没实现/.test(x)), errs.join('；'))
  })

  await it('parameters 缺 properties / 空 properties：无效', () => {
    assert.ok(mustFail(rawOf('p0', { parameters: { type: 'object' } }), 'p0').some((x) => /properties/.test(x)))
    const errs = mustFail(rawOf('p1', { parameters: { type: 'object', properties: {} } }), 'p1')
    assert.ok(errs.some((x) => /至少要有一个字段/.test(x)), errs.join('；'))
  })

  await it('array 不给 items：无效', () => {
    const errs = mustFail(rawOf('arr2', {
      parameters: { type: 'object', properties: { tags: { type: 'array' } } },
    }), 'arr2')
    assert.ok(errs.some((x) => /items/.test(x)), errs.join('；'))
  })

  await it('不支持的 type（null）：无效', () => {
    const errs = mustFail(rawOf('badt', {
      parameters: { type: 'object', properties: { v: { type: 'null' } } },
    }), 'badt')
    assert.ok(errs.some((x) => /type/.test(x)), errs.join('；'))
  })

  // -------------------------------------------------------------------------
  // validateManifest：secrets 只认 plugin: 前缀
  // -------------------------------------------------------------------------

  await it('{{secrets:models:key}} 引用模型的 Key：无效 —— 插件不许成为外送通道', () => {
    const errs = mustFail(rawOf('leak', {
      http: { method: 'GET', url: 'http://127.0.0.1:8041/p', headers: { 'x-key': '{{secrets:models:key}}' } },
    }), 'leak')
    assert.ok(errs.some((x) => /plugin: 前缀/.test(x)), errs.join('；'))
  })

  await it('{{secrets:plugin:ok_ref}} 合法；带空格的写法也认', () => {
    const m = mustOk(rawOf('oksec', {
      http: { method: 'GET', url: 'http://127.0.0.1:8041/p', headers: { 'x-key': '{{ secrets:plugin:ok_ref }}' } },
    }), 'oksec')
    assert.equal(m.confirm, 'never')
  })

  await it('PLUGIN_SECRET_RE：plugin: 前缀 + 1~64 个安全字符', () => {
    assert.equal(PLUGIN_SECRET_RE.test('plugin:a'), true)
    assert.equal(PLUGIN_SECRET_RE.test('plugin:A-1_2.x'), true)
    assert.equal(PLUGIN_SECRET_RE.test('plugin:'), false)
    assert.equal(PLUGIN_SECRET_RE.test('models:key'), false)
    assert.equal(PLUGIN_SECRET_RE.test('plugin:' + 'x'.repeat(65)), false)
  })

  await it('timeoutMs 越界：无效（100 到 120000 的边界本身要合法）', () => {
    assert.ok(mustFail(rawOf('fast', { timeoutMs: 50 }), 'fast').some((x) => /timeoutMs/.test(x)))
    assert.ok(mustFail(rawOf('slow', { timeoutMs: 120_001 }), 'slow').some((x) => /timeoutMs/.test(x)))
    assert.equal(mustOk(rawOf('lo', { timeoutMs: 100 }), 'lo').timeoutMs, 100)
    assert.equal(mustOk(rawOf('hi', { timeoutMs: 120_000 }), 'hi').timeoutMs, 120_000)
  })

  await it('http.url 必须是不合法的地址就拦：非 URL 与 ftp 都拒绝', () => {
    const errs = mustFail(rawOf('nourl', { http: { url: 'nota-url' } }), 'nourl')
    assert.ok(errs.some((x) => /绝对地址/.test(x)), errs.join('；'))
    const errs2 = mustFail(rawOf('ftp', { http: { url: 'ftp://example.com/x' } }), 'ftp')
    assert.ok(errs2.some((x) => /http\(s\)/.test(x)), errs2.join('；'))
  })

  await it('http.method 白名单外（TRACE）：无效', () => {
    const errs = mustFail(rawOf('trace', { http: { method: 'TRACE', url: 'http://127.0.0.1:8041/p' } }), 'trace')
    assert.ok(errs.some((x) => /method/.test(x)), errs.join('；'))
  })

  // -------------------------------------------------------------------------
  // loadPluginManifests / write / remove
  // -------------------------------------------------------------------------

  await it('loadPluginManifests：enabled:false 跳过、坏 JSON 带原因、排序确定、非清单文件忽略', () => {
    writeFileSync(fileOf('bb'), JSON.stringify(rawOf('bb')), 'utf-8')
    writeFileSync(fileOf('aa'), JSON.stringify(rawOf('aa')), 'utf-8')
    writeFileSync(fileOf('cc'), JSON.stringify(rawOf('cc', { enabled: false })), 'utf-8')
    writeFileSync(fileOf('broken'), '{不是 JSON', 'utf-8')
    writeFileSync(path.join(pluginsDir, 'notes.txt'), '别理我', 'utf-8')
    const { manifests, invalid } = loadPluginManifests(pluginsDir)
    assert.deepEqual(manifests.map((m) => m.name), ['aa', 'bb'], '按文件名排序，加载顺序要确定')
    assert.equal(manifests.some((m) => m.name === 'cc'), false, 'enabled:false 不注册')
    assert.equal(manifests.some((m) => m.name === 'broken'), false)
    assert.equal(invalid.length, 1, '只有坏 JSON 那条进 invalid')
    assert.equal(invalid[0]!.name, 'broken')
    assert.match(invalid[0]!.errors.join('；'), /JSON 解析失败/)
  })

  await it('名字只有一字母：无效 —— NAME_RE 至少两位，注册表里的名字不能是单字', () => {
    const errs = mustFail(rawOf('a'), 'a')
    assert.ok(errs.some((x) => /不合法/.test(x)), errs.join('；'))
  })

  await it('同名重复：第二条以无效上报（name≠文件名），绝不出现两个同名工具', () => {
    const dir2 = path.join(tmp, 'dup')
    mkdirSync(dir2, { recursive: true })
    const f = (n: string) => path.join(dir2, `${n}${SUFFIX}`)
    writeFileSync(f('p1'), JSON.stringify(rawOf('p1')), 'utf-8')
    // 身份只能来自文件名（上一轮已测），所以「撞名」的唯一表达就是 name 和文件名不一致：
    // 第二条被判无效，去重分支只是兜底
    writeFileSync(f('p2'), JSON.stringify(rawOf('p1')), 'utf-8')
    const { manifests, invalid } = loadPluginManifests(dir2)
    assert.deepEqual(manifests.map((m) => m.name), ['p1'])
    assert.equal(invalid.length, 1)
    assert.equal(invalid[0]!.name, 'p1')
    assert.match(invalid[0]!.errors.join('；'), /文件名/)
  })

  await it('目录不存在：返回空结构而不是炸 —— 首轮启动还没有 plugins 目录', () => {
    const r = loadPluginManifests(path.join(tmp, 'nope'))
    assert.deepEqual(r.manifests, [])
    assert.deepEqual(r.invalid, [])
  })

  await it('writePluginManifest：合法清单才落盘，写进去就能原样读回来', () => {
    const dir = path.join(tmp, 'wr')
    const r = writePluginManifest(dir, rawOf('fresh'))
    assert.equal(r.ok, true, r.reason)
    const { manifests } = loadPluginManifests(dir)
    assert.deepEqual(manifests.map((m) => m.name), ['fresh'])
    assert.equal(JSON.parse(readFileSync(r.file!, 'utf-8')).name, 'fresh')
  })

  await it('writePluginManifest 拒绝覆盖已有插件，原文件一个字节不动', () => {
    const dir = path.join(tmp, 'over')
    writePluginManifest(dir, rawOf('dup1', { description: '第一版' }))
    const before = readFileSync(path.join(dir, `dup1${SUFFIX}`), 'utf-8')
    const r = writePluginManifest(dir, rawOf('dup1', { description: '想顶掉别人' }))
    assert.equal(r.ok, false)
    assert.match(r.reason, /已经存在/)
    assert.equal(readFileSync(path.join(dir, `dup1${SUFFIX}`), 'utf-8'), before, '拒绝就不许碰磁盘')
  })

  await it('writePluginManifest 拒绝非法清单：什么都没写到盘上', () => {
    const dir = path.join(tmp, 'bad-write')
    const r = writePluginManifest(dir, rawOf('badw', { description: '' }))
    assert.equal(r.ok, false)
    assert.match(r.reason, /description/)
    assert.equal(existsSync(path.join(dir, `badw${SUFFIX}`)), false)
    assert.equal(existsSync(dir), false, '连目录都不该建出来')
  })

  await it('removePluginManifest 只删点名的文件；缺名和不合法名字都报错', () => {
    const dir = path.join(tmp, 'rm')
    writePluginManifest(dir, rawOf('gone'))
    writePluginManifest(dir, rawOf('stay'))
    const r = removePluginManifest(dir, 'gone')
    assert.equal(r.ok, true, r.reason)
    assert.equal(existsSync(path.join(dir, `gone${SUFFIX}`)), false)
    assert.equal(existsSync(path.join(dir, `stay${SUFFIX}`)), true, '别人的清单不许被顺手删')
    assert.match(removePluginManifest(dir, 'gone').reason, /没有叫/)
    assert.match(removePluginManifest(dir, 'Bad Name').reason, /不合法/)
  })

  // -------------------------------------------------------------------------
  // interpolate：三种写法，以及「宁可 missing 也不发空串」
  // -------------------------------------------------------------------------

  await it('interpolate 原样替换 {{x}}（含空格写法），不做多余编码 —— 编码会破坏 body 里的 JSON', () => {
    const r = interpolate('a{{q}}b 和 {{ q }}', { q: 'x&y' }, () => null)
    assert.equal(r.text, 'ax&yb 和 x&y')
    assert.deepEqual(r.missing, [])
  })

  await it('interpolate {{x|urlencode}}：显式写了才编码', () => {
    const r = interpolate('{{q|urlencode}}', { q: '你好 &x' }, () => null)
    assert.equal(r.text, encodeURIComponent('你好 &x'))
    assert.notEqual(r.text, '你好 &x')
  })

  await it('interpolate {{secrets:REF}}：命中取值，未命中进 missing 而不是原样漏出占位符', () => {
    const hit = interpolate('{{secrets:plugin:token}}', {}, (ref) => (ref === 'plugin:token' ? 'V-1' : null))
    assert.equal(hit.text, 'V-1')
    const miss = interpolate('{{secrets:plugin:absent}}', {}, () => null)
    assert.deepEqual(miss.missing, ['secrets:plugin:absent'])
    assert.equal(miss.text, '')
  })

  await it('interpolate 参数缺失：missing 点名，替换成空串由调用方决定是否拒绝', () => {
    const r = interpolate('{{nope}}|{{obj}}|{{n}}', { obj: { a: 1 }, n: 5 }, () => null)
    assert.deepEqual(r.missing, ['nope'])
    assert.equal(r.text, '|{"a":1}|5', '对象走 JSON、数字走 String —— 卡片和实参不至于两副面孔')
  })

  // -------------------------------------------------------------------------
  // compileParameters：JSON Schema 子集 → TypeBox，schema 要真的能校验
  // -------------------------------------------------------------------------

  await it('compileParameters 产物能放行好载荷、拦下坏载荷（含必填/枚举/整数/数组/未知字段）', async () => {
    const { Check } = await nativeImport('typebox/value')
    const schema = (await compileParameters({
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名' },
        days: { type: 'integer' },
        metric: { type: 'string', enum: ['c', 'f'] },
        tags: { type: 'array', items: { type: 'string' } },
        flag: { type: 'boolean' },
      },
      required: ['city'],
    })) as object
    assert.equal(Check(schema, { city: '上海' }), true, '只给必填的要能过')
    assert.equal(Check(schema, { city: '上海', days: 3, metric: 'c', tags: ['a'], flag: true }), true)
    assert.equal(Check(schema, { days: 3 }), false, '缺必填必须拦：漏了等于工具收不到关键参数')
    assert.equal(Check(schema, { city: '上海', days: 'oops' }), false, 'integer 收到字符串要拦')
    assert.equal(Check(schema, { city: '上海', metric: 'kelvin' }), false, 'enum 外的值要拦')
    assert.equal(Check(schema, { city: '上海', tags: [1] }), false, 'array items 类型要拦')
    // 未知字段默认拦：清单没显式写 additionalProperties: true 时，模型多塞一个参数就是 schema 错，
    // 而不是让作者以为参数生效了。想放行得自己在 parameters 上写 true。
    assert.equal(Check(schema, { city: '上海', extra: 1 }), false, '未知字段必须拦')
    const open = (await compileParameters({
      type: 'object',
      properties: { city: { type: 'string' } },
      additionalProperties: true,
    })) as object
    assert.equal(Check(open, { city: '上海', extra: 1 }), true, '显式开了就该放行')
  })

  // -------------------------------------------------------------------------
  // runPlugin(http)：对着本地真服务器，看「实际发出去的到底是什么」
  // -------------------------------------------------------------------------

  interface Seen {
    method: string
    url: string
    headers: Record<string, string | string[] | undefined>
    body: string
  }
  let requests = 0
  let last: Seen | undefined
  const SECRET = 'SEC-plain-9E3'

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      requests++
      last = {
        method: req.method!,
        url: req.url!,
        headers: req.headers as Record<string, string | string[] | undefined>,
        body: Buffer.concat(chunks).toString('utf-8'),
      }
      const url = new URL(req.url!, 'http://x')
      if (url.pathname === '/echo') {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`got body=${last.body}`)
      } else if (url.pathname === '/big') {
        res.writeHead(200)
        res.end('x'.repeat(10_000))
      } else if (url.pathname === '/slow') {
        setTimeout(() => {
          res.writeHead(200)
          res.end('too late')
        }, 400)
      } else if (url.pathname === '/nf') {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('no such thing')
      } else {
        res.writeHead(500)
        res.end('unexpected path')
      }
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const port = (server.address() as { port: number }).port
  const base_ = `http://127.0.0.1:${port}`
  const ctx = { cwd: tmp, secrets: (ref: string) => (ref === 'plugin:token' ? SECRET : null) }

  try {
    await it('runPlugin(http)：方法/头/体按清单原样发到服务器；返回文本以 HTTP 200 开头', async () => {
      const m = mustOk(rawOf('echo', {
        http: {
          method: 'POST',
          url: `${base_}/echo?q={{q}}`,
          headers: { 'x-key': '{{secrets:plugin:token}}', 'x-agent': 'torra-test' },
          body: '{"text":"{{q}}"}',
        },
      }), 'echo')
      const r = await runPlugin(m, { q: 'hello' }, ctx)
      assert.ok(last, '服务器要收到过请求')
      assert.equal(last!.method, 'POST')
      assert.equal(last!.url, '/echo?q=hello', '原样替换：不替用户编码 URL')
      assert.equal(last!.headers['x-key'], SECRET, '钥匙串的值确实发到了目标地址')
      assert.equal(last!.headers['x-agent'], 'torra-test')
      assert.equal(last!.headers['content-type'], 'application/json', '带 body 时自动补 JSON 头')
      assert.equal(last!.body, '{"text":"hello"}')
      assert.match(r.text, /^HTTP 200 /, '状态行给模型看：失败不能伪装成成功')
      assert.match(r.text, /got body=/)
      assert.equal(r.text.includes(SECRET), false, '密钥值绝不回流进上下文')
      assert.equal(r.details.kind, 'http')
      assert.equal(r.details.status, 200)
    })

    await it('runPlugin(http)：urlencode 修饰符让带空格参数的 URL 走得出去', async () => {
      const m = mustOk(rawOf('enc', {
        http: { method: 'GET', url: `${base_}/echo?q={{q|urlencode}}` },
      }), 'enc')
      await runPlugin(m, { q: 'a b&c' }, ctx)
      assert.equal(last!.url, '/echo?q=a%20b%26c')
    })

    await it('runPlugin(http)：占位符没有对应参数 → throw 而不是带着空串打后端', async () => {
      const m = mustOk(rawOf('hole', { http: { method: 'GET', url: `${base_}/echo?q={{nope}}` } }), 'hole')
      const before = requests
      await assert.rejects(() => runPlugin(m, { q: 'x' }, ctx), /占位符没有对应参数/)
      assert.equal(requests, before, '清单写错了就一个请求都不许发出去')
    })

    await it('runPlugin(http)：钥匙串里没有的 REF 同样拒绝出发', async () => {
      const m = mustOk(rawOf('nosec', {
        http: { method: 'GET', url: `${base_}/echo`, headers: { 'x-key': '{{secrets:plugin:absent}}' } },
      }), 'nosec')
      await assert.rejects(() => runPlugin(m, { q: 'x' }, ctx), /secrets:plugin:absent/)
    })

    await it('runPlugin(http)：超长响应截到上限 —— 一个接口不能把上下文窗口灌满', async () => {
      const m = mustOk(rawOf('big', { http: { method: 'GET', url: `${base_}/big` } }), 'big')
      const r = await runPlugin(m, { q: 'x' }, ctx)
      assert.equal(r.text.length, 8001, '8000 字符 + 省略号')
      assert.ok(r.text.endsWith('…'))
      assert.equal(r.details.bytes, 10_000, '截断要说实话：原始字节数照记')
    })

    await it('runPlugin(http)：非 2xx 不 throw，把状态交回回合里判断', async () => {
      const m = mustOk(rawOf('nf', { http: { method: 'GET', url: `${base_}/nf` } }), 'nf')
      const r = await runPlugin(m, { q: 'x' }, ctx)
      assert.match(r.text, /^HTTP 404 /)
      assert.equal(r.details.status, 404)
    })

    await it('runPlugin(http)：timeoutMs 到点真掐断，报成请求失败', async () => {
      const m = mustOk(rawOf('tmo', { timeoutMs: 100, http: { method: 'GET', url: `${base_}/slow` } }), 'tmo')
      const t0 = Date.now()
      await assert.rejects(() => runPlugin(m, { q: 'x' }, ctx), /请求失败/)
      assert.ok(Date.now() - t0 < 1000, '要在 100ms 超时附近就失败，不能等服务器')
    })

    // -----------------------------------------------------------------------
    // runPlugin(shell)：execFile + argv + shell:false
    // -----------------------------------------------------------------------

    await it('runPlugin(shell)：返回 stdout（argv 占位符按模型实参填进去）', async () => {
      const m = mustOk(shellRawOf('pong', [
        process.execPath, '-e', "console.log('pong:'+process.argv[1])", '{{msg}}',
      ]), 'pong')
      const r = await runPlugin(m, { msg: 'ok' }, ctx)
      assert.equal(r.text, 'pong:ok')
      assert.equal(r.details.kind, 'shell')
    })

    await it('runPlugin(shell)：非 0 退出码要说成「退出码非 0」而不是当成功', async () => {
      const m = mustOk(shellRawOf('exit3', [
        process.execPath, '-e', "console.error('boom');process.exit(3)",
      ]), 'exit3')
      const r = await runPlugin(m, { q: 'x' }, ctx)
      assert.match(r.text, /^退出码非 0/, '模型要能从文本分辨出这一步没成')
      assert.match(r.text, /boom/)
      assert.equal(r.details.status, 3)
    })

    await it('runPlugin(shell)：shell:false —— 分号和重定向符原样进 argv，不产生副作用文件', async () => {
      const owned = path.join(tmp, 'owned-by-shell.txt')
      const nasty = `& echo PWNED > ${owned}`
      const m = mustOk(shellRawOf('literal', [
        process.execPath, '-e', "console.log('got:'+process.argv[1])", '{{p}}',
      ]), 'literal')
      const r = await runPlugin(m, { p: nasty }, ctx)
      assert.equal(r.text, 'got:' + nasty, '整个字符串是一个 argv 元素，没被 shell 拆开')
      assert.equal(existsSync(owned), false, '要是走了 shell，这个文件就凭空出现了')
    })

    await it('runPlugin(shell)：cwd 默认清单目录；cwd=data 时用 Torra 的 dataDir', async () => {
      const sub = path.join(tmp, 'cwdcase')
      mkdirSync(sub, { recursive: true })
      const script = 'console.log(process.cwd())'
      const norm = (p: string) => {
        const r = path.resolve(p)
        return process.platform === 'win32' ? r.toLowerCase() : r
      }
      const mkShell = (over: Record<string, unknown>, file: string): PluginManifest => {
        const e = validateManifest(shellRawOf(path.basename(file).replace(SUFFIX, ''), [process.execPath, '-e', script], over), file)
        assert.equal(e.ok, true, `应合法却报错：${e.ok ? '' : e.errors.join('；')}`)
        return (e as { manifest: PluginManifest }).manifest
      }
      const r1 = await runPlugin(mkShell({}, path.join(sub, `dflt${SUFFIX}`)), { q: 'x' }, ctx)
      assert.equal(norm(r1.text), norm(sub), '默认落在清单旁边：脚本相对路径找得到同伴文件')
      const r2 = await runPlugin(mkShell({ shell: { argv: [process.execPath, '-e', script], cwd: 'data' } }, path.join(sub, `data${SUFFIX}`)), { q: 'x' }, ctx)
      assert.equal(norm(r2.text), norm(tmp), "cwd:'data' 走 ctx.cwd")
    })
  } finally {
    await new Promise<void>((r) => {
      server.closeAllConnections?.()
      server.close(() => r())
    })
    rmSync(tmp, { recursive: true, force: true })
  }

  console.log(`${'-'.repeat(46)}\n${pass} passed, ${fail} failed\n`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
