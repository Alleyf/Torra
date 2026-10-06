/**
 * 受限 read 闸门的离线回归（不联网、不需要 Electron）
 *
 * 这道闸门是「给助手开 read」的唯一前提，所以它比功能本身更值得测：
 *
 * 1. 拦得住跳出技能目录的路径（相对、绝对、.. 回溯、兄弟目录前缀陷阱）；
 * 2. 放行该放行的 —— 尤其是软链接技能：判定必须走词法包含，
 *    一旦改成 realpath，所有从别的应用导入的技能都会被判成越界，功能静默失效；
 * 3. 钩子只作用于 read，别的一个字都不改。
 *
 * 后半段验宿主的另一半 —— 插件注册与确认卡片：never/always/once 各自的弹窗次数、
 * 拒绝后绝不落盘、卡片上实参可见而钥匙串值不可见。注册只发生在 factory（组装期），
 * 这是「改清单必须重组会话」这条实测约束的正面照。
 *
 * 运行：npm run test:assistant-plugin-host
 */

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { capabilityHost, checkReadablePath } from '../src/main/assistant/plugin-host'

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

const LINK_TYPE = process.platform === 'win32' ? 'junction' : 'dir'

/** 这台机器允不允许建目录链接：不允许时依赖链接的断言跳过，别报成假失败 */
const LINKS_WORK = (() => {
  const d = mkdtempSync(path.join(os.tmpdir(), 'torra-host-probe-'))
  try {
    mkdirSync(path.join(d, 'src'), { recursive: true })
    symlinkSync(path.join(d, 'src'), path.join(d, 'link'), LINK_TYPE as 'junction')
    return true
  } catch {
    return false
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})()

/** 一套假目录：cwd 是 Torra 的 dataDir，技能目录在它下面 */
function fixture(): { cwd: string; skillsDir: string; cleanup: () => void } {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'torra-host-'))
  const skillsDir = path.join(cwd, 'pi', 'skills')
  mkdirSync(path.join(skillsDir, 'demo'), { recursive: true })
  writeFileSync(path.join(skillsDir, 'demo', 'SKILL.md'), '# demo\n')
  return { cwd, skillsDir, cleanup: () => rmSync(cwd, { recursive: true, force: true }) }
}

const allowed = (roots: string[], cwd: string, raw: unknown): boolean =>
  checkReadablePath(roots, cwd, raw).ok === true

async function main(): Promise<void> {
  console.log('\n受限 read 闸门\n' + '='.repeat(46))
  const f = fixture()
  const roots = [f.skillsDir]
  const rel = (p: string) => path.relative(f.cwd, p)

  await it('技能目录里的 SKILL.md 放行', () => {
    assert.equal(allowed(roots, f.cwd, path.join(f.skillsDir, 'demo', 'SKILL.md')), true)
  })

  await it('相对路径按 cwd 解析（和 pi 内置 read 同一个基准）', () => {
    assert.equal(allowed(roots, f.cwd, rel(path.join(f.skillsDir, 'demo', 'SKILL.md'))), true)
  })

  await it('技能自己带的附属文件也在目录内，放行', () => {
    const ref = path.join(f.skillsDir, 'demo', 'references', 'api.md')
    assert.equal(allowed(roots, f.cwd, ref), true)
  })

  await it('.. 回溯跳出技能目录：拦', () => {
    const sneaky = path.join(f.skillsDir, 'demo', '..', '..', '..', 'secret.txt')
    assert.equal(allowed(roots, f.cwd, sneaky), false)
  })

  await it('绝对路径指向别处：拦，且理由里说清能读哪儿', () => {
    const v = checkReadablePath(roots, f.cwd, path.join(f.cwd, 'pi', 'auth.json'))
    assert.equal(v.ok, false)
    if (!v.ok) {
      assert.match(v.reason, /技能目录/)
      assert.match(v.reason, /auth\.json/)
    }
  })

  await it('兄弟目录前缀陷阱：skillsEvil 不能算在 skills 里面', () => {
    // 这条是「用 path.relative 而不是 startsWith」的全部理由
    assert.equal(allowed(roots, f.cwd, path.join(f.cwd, 'pi', 'skillsEvil', 'SKILL.md')), false)
    assert.equal(allowed(roots, f.cwd, path.join(f.cwd, 'pi', 'skills', '..', 'skillsEvil', 'x.md')), false)
  })

  await it('技能目录本身放行，交给 read 自己去报「这是个目录」', () => {
    assert.equal(allowed(roots, f.cwd, f.skillsDir), true)
  })

  await it('空 path / 非字符串 / 含 NUL：一律拦，不放行到磁盘', () => {
    assert.equal(allowed(roots, f.cwd, ''), false)
    assert.equal(allowed(roots, f.cwd, '   '), false)
    assert.equal(allowed(roots, f.cwd, undefined), false)
    assert.equal(allowed(roots, f.cwd, 42), false)
    assert.equal(allowed(roots, f.cwd, path.join(f.skillsDir, 'de\0mo', 'SKILL.md')), false)
  })

  if (process.platform === 'win32') {
    await it('Windows 上大小写不同仍是同一个目录', () => {
      const upper = f.skillsDir.toUpperCase()
      assert.equal(allowed([upper], f.cwd, path.join(f.skillsDir, 'demo', 'SKILL.md')), true)
      assert.equal(allowed(roots, f.cwd, path.join(upper, 'demo', 'SKILL.md')), true)
    })
  }

  await it('多个根目录：任一命中即放行', () => {
    const extra = path.join(f.cwd, 'pi', 'plugins')
    mkdirSync(extra, { recursive: true })
    assert.equal(allowed([f.skillsDir, extra], f.cwd, path.join(extra, 'a.json')), true)
    assert.equal(allowed([f.skillsDir, extra], f.cwd, path.join(f.cwd, 'pi', 'x.json')), false)
  })

  await it('软链接技能：按链接路径读放行（判定不能走 realpath，否则导入的技能全废）', () => {
    if (!LINKS_WORK) {
      console.log('       跳过：这台机器建不了目录链接')
      return
    }
    const realHome = mkdtempSync(path.join(os.tmpdir(), 'torra-host-src-'))
    try {
      const target = path.join(realHome, 'from-claude')
      mkdirSync(target, { recursive: true })
      writeFileSync(path.join(target, 'SKILL.md'), '# from claude\n')
      const link = path.join(f.skillsDir, 'from-claude')
      symlinkSync(target, link, LINK_TYPE as 'junction')
      assert.equal(existsSync(path.join(link, 'SKILL.md')), true)
      // 链接的真实落点在技能目录之外 —— 这正是刻意不去 realpath 的场景
      assert.equal(allowed(roots, f.cwd, path.join(link, 'SKILL.md')), true)
    } finally {
      rmSync(realHome, { recursive: true, force: true })
    }
  })

  // -------------------------------------------------------------------------
  // 钩子本身：闸门挂在扩展的 tool_call 上，只作用于 read
  // -------------------------------------------------------------------------

  interface Captured {
    event: string
    handler: (ev: unknown, ctx: unknown) => Promise<{ block?: boolean; reason?: string } | undefined>
  }

  function install(hostRoots: string[], cwd: string): Captured {
    const host = capabilityHost({
      readRoots: hostRoots,
      cwd,
      // 这一组用例只验 read 闸门：不给 pluginsDir 就不该注册任何插件工具
      approve: async () => ({ approved: true }),
      secrets: () => null,
    })
    const captured: Captured[] = []
    const fakePi = {
      on(event: string, handler: Captured['handler']) {
        captured.push({ event, handler })
      },
    }
    void (host as { factory: (pi: unknown) => unknown }).factory(fakePi)
    assert.equal(captured.length, 1, '宿主应该只挂一个钩子')
    assert.equal(captured[0]!.event, 'tool_call')
    return captured[0]!
  }

  const call = (c: Captured, toolName: string, input: unknown) =>
    c.handler({ type: 'tool_call', toolName, toolCallId: 't1', input }, {})

  await it('宿主只挂一个 tool_call 钩子', () => {
    assert.equal(install(roots, f.cwd).event, 'tool_call')
  })

  await it('read 越界 → block 且带理由', async () => {
    const c = install(roots, f.cwd)
    const r = await call(c, 'read', { path: path.join(f.cwd, 'pi', 'auth.json') })
    assert.equal(r?.block, true)
    assert.match(String(r?.reason), /技能目录/)
  })

  await it('read 在界内 → 不干预（返回 undefined，工具照常执行）', async () => {
    const c = install(roots, f.cwd)
    assert.equal(await call(c, 'read', { path: path.join(f.skillsDir, 'demo', 'SKILL.md') }), undefined)
  })

  await it('别的工具一概不动：内置工具名和 torra_* 都原样放过', async () => {
    const c = install(roots, f.cwd)
    assert.equal(await call(c, 'torra_list_models', {}), undefined)
    assert.equal(await call(c, 'bash', { command: 'rm -rf /' }), undefined)
    assert.equal(await call(c, 'write', { path: path.join(f.cwd, 'x.txt'), content: 'x' }), undefined)
  })

  // -------------------------------------------------------------------------
  // 宿主的另一半：把声明式插件注册成 pi 工具，确认策略与卡片在这一刻生效
  //
  // 注册时机不是细节而是全部：pi 的显式 tools 白名单只认会话组装时就存在的名字，
  // 所以「清单 → 工具」必须发生在 factory 里，运行期再注册会被静默吞掉。
  // -------------------------------------------------------------------------

  /** 假 pi：宿主只用到 on 和 registerTool 这两个口子 */
  interface RegisteredTool {
    name: string
    label: string
    description: string
    parameters: Record<string, unknown>
    execute: (
      id: string,
      params: Record<string, unknown>,
      signal?: AbortSignal,
    ) => Promise<{ content: Array<{ type: 'text'; text: string }>; details: Record<string, unknown> }>
  }

  /** 每条用例一个独立目录：manifest 是扫目录得来的，共用会互相污染计数 */
  let caseSeq = 0
  function hostDir(): string {
    const dir = path.join(f.cwd, 'pi', `plugins-case-${caseSeq++}`)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  /** 写一条清单到 dir：给足合法的默认段，用例只覆盖自己在意的那几笔 */
  function putPlugin(dir: string, name: string, over: Record<string, unknown>): void {
    const raw = {
      name,
      description: '宿主用例清单',
      kind: 'http',
      parameters: { type: 'object', properties: { q: { type: 'string' } } },
      http: { method: 'GET', url: 'http://127.0.0.1:9/p' },
      ...over,
    }
    writeFileSync(path.join(dir, `${name}.plugin.json`), JSON.stringify(raw))
  }

  /** 让宿主在假 pi 上跑一遍 factory，拿回注册到的工具、确认卡片和加载结果 */
  async function loadHost(
    dir: string,
    cfg: {
      approve?: (req: any) => Promise<{ approved: boolean; reason?: string }>
      secrets?: (ref: string) => string | null
    } = {},
  ): Promise<{ tools: RegisteredTool[]; approvals: any[]; plugins: any[]; invalid: any[] }> {
    const tools: RegisteredTool[] = []
    const approvals: any[] = []
    const loaded = { plugins: [] as any[], invalid: [] as any[] }
    const fakePi = {
      on: (_event: string, _handler: unknown) => undefined,
      registerTool: (t: RegisteredTool) => tools.push(t),
    }
    const host = capabilityHost({
      readRoots: [],
      cwd: f.cwd,
      pluginsDir: dir,
      approve: async (req) => {
        approvals.push(req)
        return cfg.approve ? await cfg.approve(req) : { approved: true }
      },
      secrets: cfg.secrets ?? (() => null),
      onPlugins: (p, inv) => {
        loaded.plugins = p
        loaded.invalid = inv
      },
    })
    await (host as { factory: (pi: unknown) => Promise<void> }).factory(fakePi)
    return { tools, approvals, plugins: loaded.plugins, invalid: loaded.invalid }
  }

  /** 一条会往 marker 写文件的 shell 清单：验证「拒绝即什么都没发生」的探针 */
  const markerArgv = (marker: string) => [
    process.execPath,
    '-e',
    "require('fs').writeFileSync(process.argv[1],'ran');console.log('ran')",
    marker,
  ]

  await it('每个合法清单注册成一个 pi 工具：名字/描述/schema 都来自清单', async () => {
    const dir = hostDir()
    putPlugin(dir, 'wxget', {})
    putPlugin(dir, 'runit', { kind: 'shell', http: undefined, shell: { argv: markerArgv(path.join(dir, 'never-used.txt')) } })
    const { tools, plugins } = await loadHost(dir)
    assert.deepEqual(tools.map((t) => t.name).sort(), ['runit', 'wxget'], '工具名=清单名：白名单合并靠它对上')
    const wx = tools.find((t) => t.name === 'wxget')!
    assert.equal(wx.description, '宿主用例清单', '模型全靠这句话决定用不用')
    assert.equal(wx.label, 'wxget', 'label 缺省等于 name')
    assert.equal(String(wx.parameters.type), 'object', 'parameters 得是编译好的 TypeBox schema，pi 拿它校验模型实参')
    assert.deepEqual(plugins.map((p) => [p.name, p.confirm]).sort(), [['runit', 'always'], ['wxget', 'never']])
  })

  await it('坏清单进 onPlugins 的 errors 而不是注册成半成品工具', async () => {
    const dir = hostDir()
    putPlugin(dir, 'goodun', {})
    putPlugin(dir, 'badone', { description: '' })
    const { tools, plugins, invalid } = await loadHost(dir)
    assert.deepEqual(tools.map((t) => t.name), ['goodun'], '无效清单绝不能混进注册表')
    assert.equal(invalid.length, 1)
    assert.equal(invalid[0].name, 'badone')
    assert.match(invalid[0].errors.join('；'), /description/, '原因要带出来：静默丢掉一条清单最难查')
    assert.equal(plugins.length, 1, '视图里只该有有效的')
  })

  await it('object 不写 properties：在校验层就判无效，不留到注册阶段', async () => {
    const dir = hostDir()
    // 以前这条会「过了结构校验、编译时才炸」，于是同一份清单同时出现在已加载和无效里；
    // 校验改成递归后它在读盘阶段就被拦下，视图里不会有一个没有工具对应的插件。
    putPlugin(dir, 'obad', { parameters: { type: 'object', properties: { nested: { type: 'object' } } } })
    const { tools, plugins, invalid } = await loadHost(dir)
    assert.equal(tools.length, 0, '编译不了的清单不该注册')
    assert.equal(plugins.length, 0, '设置页不该显示一个其实用不了的插件')
    assert.match(invalid.map((e) => e.errors.join('；')).join('；'), /nested 声明是 object 却没有 properties/)
  })

  await it('confirm:never 直接执行，一次确认都不弹', async () => {
    const dir = hostDir()
    const marker = path.join(dir, 'marker.txt')
    putPlugin(dir, 'neversh', { kind: 'shell', http: undefined, shell: { argv: markerArgv(marker) }, confirm: 'never' })
    const { tools, approvals } = await loadHost(dir)
    const r = await tools[0]!.execute('c1', { q: 'x' }, undefined)
    assert.equal(approvals.length, 0, 'never 的插件碰 approve 就是策略被吃掉')
    assert.equal(r.content[0]!.text, 'ran')
    assert.equal(existsSync(marker), true, '没弹窗也得真执行')
  })

  await it('confirm:always 每次都问；拒绝=返回「用户拒绝」文本且命令一步没跑', async () => {
    const dir = hostDir()
    const marker = path.join(dir, 'marker.txt')
    putPlugin(dir, 'alwayssh', { kind: 'shell', http: undefined, shell: { argv: markerArgv(marker) } })
    const { tools, approvals } = await loadHost(dir, { approve: async () => ({ approved: false, reason: '先别跑' }) })
    const run = () => tools[0]!.execute('c1', { q: 'x' }, undefined)
    const r1 = await run()
    const r2 = await run()
    assert.equal(approvals.length, 2, 'always 是每次都问，不是每会话一次')
    assert.match(r1.content[0]!.text, /用户拒绝/)
    assert.match(r2.content[0]!.text, /用户拒绝.*先别跑/s, '拒绝理由要回传给模型，它才解释得清')
    assert.equal(r1.details.approved, false)
    assert.equal(existsSync(marker), false, '拒绝后绝不能落盘 —— 这条卡片是唯一的闸')
    assert.equal(approvals[0].action, 'run_plugin')
  })

  await it('confirm:once 第一次问，批过之后同一会话不再弹', async () => {
    const dir = hostDir()
    const marker = path.join(dir, 'marker.txt')
    putPlugin(dir, 'oncesh', { kind: 'shell', http: undefined, shell: { argv: markerArgv(marker) }, confirm: 'once' })
    const { tools, approvals } = await loadHost(dir)
    const r1 = await tools[0]!.execute('c1', { q: 'x' }, undefined)
    const r2 = await tools[0]!.execute('c2', { q: 'x' }, undefined)
    assert.equal(approvals.length, 1, '批过一次就该安静下来')
    assert.equal(r1.content[0]!.text, 'ran')
    assert.equal(r2.content[0]!.text, 'ran')
    assert.equal(existsSync(marker), true)
  })

  await it('确认卡片：实参插进目标地址，钥匙串只显示引用名 —— 值绝不进卡片', async () => {
    const dir = hostDir()
    putPlugin(dir, 'cardsec', {
      http: {
        method: 'GET',
        url: 'http://127.0.0.1:9/p?q={{q}}',
        headers: { 'x-key': '{{secrets:plugin:token}}' },
        body: '{"s":"{{secrets:plugin:token}}"}',
      },
      confirm: 'always',
    })
    const { tools, approvals } = await loadHost(dir, {
      approve: async () => ({ approved: false }),
      secrets: (ref) => (ref === 'plugin:token' ? 'SEC-CARD-VALUE' : null),
    })
    await tools[0]!.execute('c1', { q: '上海天气' }, undefined)
    const detail = String(approvals[0].detail)
    assert.match(detail, /GET http:\/\/127\.0\.0\.1:9\/p\?q=上海天气/, '用户要看真去了哪儿才能做判断')
    assert.match(detail, /‹钥匙串 plugin:token›/, '显示引用名：够定位是哪个条目')
    assert.equal(detail.includes('SEC-CARD-VALUE'), false, '值印在卡片上等于交给了渲染层和日志')
    assert.match(detail, /入参/, '模型填的完整实参要在卡片上看全')
    assert.match(detail, /cardsec\.plugin\.json/, '清单文件路径：出问题时能翻到原文')
  })

  f.cleanup()
  console.log(`${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main()
