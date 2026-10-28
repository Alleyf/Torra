/**
 * 应用插件内核的离线回归（不需要 Electron、不联网、不启动应用）。
 *
 * 这一层最容易出的错不是「崩溃」，而是**边界被悄悄放宽**：
 * 清单多认一个字段、zip 少拦一条路径、面板 SDK 被插件脚本覆盖、能力清单
 * 升级后继续沿用旧授权。所以用例全部围着这些不变量写，而不是围着正常路径。
 *
 * 运行：npm run test:plugins
 */

import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { loadManifest } from '../src/main/plugins/manifest'
import { extractZip, ZipError } from '../src/main/plugins/zip'
import { PluginStorage } from '../src/main/plugins/storage'
import { PANEL_MAX_BYTES, injectPanel } from '../src/main/plugins/panel'
import { TORRA_UI_FRAME_MAX_BYTES, torraUiFrameUrl } from '../src/shared/ui-frame'
import { AI_PROMPT_MAX_CHARS, AI_SYSTEM_MAX_CHARS, pickPluginModel } from '../src/main/plugins/ai'
import { PluginRuntime } from '../src/main/plugins/host'
import type { PluginManifest } from '../src/shared/plugins'
import type { ModelConfig } from '../src/shared/types'

const localRequire = createRequire(__filename)
const ROOT = path.resolve(__dirname, '..')
const MANIFEST_DIR = path.join(ROOT, 'plugins', 'trajectory')
const SCHOLAR_DIR = path.join(ROOT, 'plugins', 'scholar')
const SERVER_DIR = path.join(ROOT, 'plugins', 'server')
const manifest = JSON.parse(readFileSync(path.join(MANIFEST_DIR, 'torra-plugin.json'), 'utf8')) as {
  contributes: { tools: Array<{ name: string }> }
}
const scholarManifest = JSON.parse(readFileSync(path.join(SCHOLAR_DIR, 'torra-plugin.json'), 'utf8')) as {
  contributes: { tools: Array<{ name: string }> }
}
const serverManifest = JSON.parse(readFileSync(path.join(SERVER_DIR, 'torra-plugin.json'), 'utf8')) as {
  contributes: { tools: Array<{ name: string }> }
}

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

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'torra-plugin-'))
}

/** 写一个最小的 zip：只为触发解包器的闸门，CRC 不参与校验（解包器不验它） */
function makeZip(entries: Array<{ name: string; data: Buffer; method?: number; mode?: number }>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const method = entry.method ?? 0
    const body = method === 8 ? deflateRawSync(entry.data) : entry.data
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, body)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(body.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += 30 + name.length + body.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

async function main(): Promise<void> {
  console.log('\n应用插件内核')

  await it('内置清单通过校验，工具名带插件前缀', () => {
    const r = loadManifest(MANIFEST_DIR)
    assert.equal(r.ok, true, r.ok ? '' : r.errors.join('；'))
    if (!r.ok) return
    assert.equal(r.manifest.id, 'trajectory')
    assert.deepEqual([...r.manifest.permissions].sort(), [
      'ai',
      'net:api.crossref.org',
      'net:export.arxiv.org',
      'panel',
      'storage',
      'tools',
    ])
    for (const tool of r.manifest.contributes?.tools ?? []) {
      assert.ok(tool.name.startsWith('trajectory_'), `工具名前缀：${tool.name}`)
    }
  })

  await it('第二个内置插件的清单与面板都在闸门之内', () => {
    const r = loadManifest(SCHOLAR_DIR)
    assert.equal(r.ok, true, r.ok ? '' : r.errors.join('；'))
    if (!r.ok) return
    assert.equal(r.manifest.id, 'scholar')
    assert.deepEqual([...r.manifest.permissions].sort(), [
      'ai',
      'net:api.crossref.org',
      'net:export.arxiv.org',
      'panel',
      'storage',
      'tools',
    ])
    for (const tool of r.manifest.contributes?.tools ?? []) {
      assert.ok(tool.name.startsWith('scholar_'), `工具名前缀：${tool.name}`)
    }
    const injected = injectPanel(readFileSync(path.join(SCHOLAR_DIR, 'ui.html'), 'utf8'), 'tok-s', 'scholar', 'dark')
    assert.ok(Buffer.byteLength(injected) <= TORRA_UI_FRAME_MAX_BYTES, `面板 ${Buffer.byteLength(injected)}B 超过帧上限`)
  })

  await it('服务器看板：只声明本机能力，面板同样在帧上限内', () => {
    const r = loadManifest(SERVER_DIR)
    assert.equal(r.ok, true, r.ok ? '' : r.errors.join('；'))
    if (!r.ok) return
    assert.equal(r.manifest.id, 'server')
    // 探测走本机 ssh 子进程，不需要 net；没有 secrets 就代表它拿不到钥匙串
    assert.deepEqual([...r.manifest.permissions].sort(), ['panel', 'storage', 'tools'])
    for (const tool of r.manifest.contributes?.tools ?? []) {
      assert.ok(tool.name.startsWith('server_'), `工具名前缀：${tool.name}`)
    }
    assert.ok(
      !(r.manifest.contributes?.tools ?? []).some((t) => /exec|run|command|shell/i.test(t.name)),
      '看板不能提供执行任意命令的工具',
    )
    const injected = injectPanel(readFileSync(path.join(SERVER_DIR, 'ui.html'), 'utf8'), 'tok-v', 'server', 'dark')
    assert.ok(Buffer.byteLength(injected) <= TORRA_UI_FRAME_MAX_BYTES, `面板 ${Buffer.byteLength(injected)}B 超过帧上限`)
  })

  await it('未知字段 / 没声明的能力 / 越界入口都被拒绝', () => {
    const cases: Array<{ patch: Record<string, unknown>; pattern: RegExp }> = [
      { patch: { hooks: {} }, pattern: /没实现的字段/ },
      { patch: { main: '../outside.js' }, pattern: /跳出插件目录/ },
      { patch: { main: 'C:outside.js' }, pattern: /相对插件目录/ },
      {
        patch: {
          // 深拷一份：fixture 会按目录名改写工具前缀，直接传引用会污染顶层 manifest
          contributes: { panel: { title: 'x' }, tools: JSON.parse(JSON.stringify(manifest.contributes.tools)) },
          permissions: ['storage', 'tools'],
        },
        pattern: /需要 permissions 里声明 'panel'/,
      },
    ]
    for (const item of cases) {
      const dir = tmpDir()
      try {
        const name = path.basename(dir)
        mkdirSync(path.join(dir, name))
        const base = JSON.parse(readFileSync(path.join(MANIFEST_DIR, 'torra-plugin.json'), 'utf8'))
        const merged = { ...base, ...item.patch }
        if (item.patch.contributes) merged.contributes = item.patch.contributes
        merged.id = name
        embeddedToolNames(merged, name)
        writeFileSync(path.join(dir, name, 'torra-plugin.json'), JSON.stringify(merged))
        writeFileSync(path.join(dir, name, 'main.js'), '')
        writeFileSync(path.join(dir, name, 'ui.html'), '')
        const r = loadManifest(path.join(dir, name))
        assert.equal(r.ok, false, `应被拒绝：${JSON.stringify(item.patch)}`)
        if (!r.ok) assert.match(r.errors.join('；'), item.pattern)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  await it('zip：store 与 deflate 都能解出来', () => {
    const dir = tmpDir()
    try {
      const zip = path.join(dir, 'a.zip')
      writeFileSync(
        zip,
        makeZip([
          { name: 'torra-plugin.json', data: Buffer.from('{}') },
          { name: 'nest/main.js', data: Buffer.from('hello'), method: 8 },
        ]),
      )
      const out = path.join(dir, 'out')
      mkdirSync(out)
      assert.equal(extractZip(zip, out).files, 2)
      assert.equal(readFileSync(path.join(out, 'nest/main.js'), 'utf8'), 'hello')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await it('zip：路径穿越 / 符号链接 / 未知压缩方式全部拒绝', () => {
    const cases: Array<{ entry: Parameters<typeof makeZip>[0][number]; pattern: RegExp }> = [
      { entry: { name: '../escape.txt', data: Buffer.from('x') }, pattern: /跳出目录/ },
      { entry: { name: 'C:/escape.txt', data: Buffer.from('x') }, pattern: /绝对路径/ },
      { entry: { name: 'link', data: Buffer.from('/etc/passwd'), mode: 0o120777 }, pattern: /符号链接/ },
      { entry: { name: 'x.bin', data: Buffer.from('x'), method: 12 }, pattern: /不支持的压缩方式/ },
    ]
    for (const item of cases) {
      const dir = tmpDir()
      try {
        const zip = path.join(dir, 'bad.zip')
        writeFileSync(zip, makeZip([item.entry]))
        const out = path.join(dir, 'out')
        mkdirSync(out)
        assert.throws(
          () => extractZip(zip, out),
          (e: unknown) => e instanceof ZipError && item.pattern.test(e.message),
          item.entry.name,
        )
        assert.deepEqual(readdirSync(out), [], '拒绝时不能留下半截文件')
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  await it('存储：坏键 / 单值超限被拒绝，写入是原子替换', () => {
    const dir = tmpDir()
    try {
      const store = new PluginStorage(path.join(dir, 'store.json'))
      store.set('a.b:c', { x: 1 })
      assert.deepEqual(store.get('a.b:c'), { x: 1 })
      assert.deepEqual(store.list(), ['a.b:c'])
      assert.equal(store.delete('a.b:c'), true)
      assert.equal(store.delete('a.b:c'), false)
      assert.throws(() => store.set('../x', 1), /存储键/)
      assert.throws(() => store.set('big', 'a'.repeat(1024 * 1024 + 8)), /单个值/)
      store.set('ok', 1)
      assert.deepEqual(readdirSync(dir), ['store.json'], '不能留下 .tmp')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await it('面板：注入 SDK 与主题，且仍在 torra-ui 帧上限内', () => {
    const html = readFileSync(path.join(MANIFEST_DIR, 'ui.html'), 'utf8')
    const injected = injectPanel(html, 'tok-123', 'trajectory', 'light')
    assert.match(injected, /<html[^>]*data-theme="light"/)
    assert.ok(injected.includes('data-torra-plugin="sdk"'))
    assert.ok(injected.indexOf('window.torraPlugin') < injected.indexOf('KINDS'))
    assert.ok(injected.includes('"tok-123"'))
    assert.equal((injected.match(/<html[^>]*data-theme=/g) ?? []).length, 1, '只应有一份 data-theme')
    const url = torraUiFrameUrl(injected)
    assert.ok(
      Buffer.byteLength(injected) <= Math.min(PANEL_MAX_BYTES, TORRA_UI_FRAME_MAX_BYTES),
      `面板 ${Buffer.byteLength(injected)}B 超过帧上限`,
    )
    assert.ok(url.startsWith('torra-ui://frame/'))
  })

  await it('面板脚本：顶层函数不重名，界面调用的 RPC 都有注册', () => {
    for (const dir of [MANIFEST_DIR, SCHOLAR_DIR, SERVER_DIR]) {
      const name = path.basename(dir)
      const ui = readFileSync(path.join(dir, 'ui.html'), 'utf8')
      const main = readFileSync(path.join(dir, 'main.js'), 'utf8')
      // 同一段 IIFE 里后声明的同名函数会静默覆盖前者：顶层声明按两空格缩进识别
      const declared = [...ui.matchAll(/^ {2}function\s+([A-Za-z_$][\w$]*)\s*\(/gm)].map((m) => m[1]!)
      const duplicated = declared.filter((fn, index) => declared.indexOf(fn) !== index)
      assert.deepEqual([...new Set(duplicated)], [], `${name}: 顶层函数重名，后者会覆盖前者`)

      const called = [...new Set([...ui.matchAll(/call\(\s*'([^']+)'/g)].map((m) => m[1]!))]
      const handled = new Set([...main.matchAll(/(?:rpc\.handle|rpc)\(\s*'([^']+)'/g)].map((m) => m[1]!))
      assert.deepEqual(called.filter((method) => !handled.has(method)), [], `${name}: 面板调用了后端没注册的 RPC`)
      // 两端名字一致也照样起不来：runtime-entry 的 rpc.handle 只认小写开头的写法，
      // 驼峰（ai.evidenceQueries）会让 activate 直接抛错、整个面板打不开
      const badName = [...handled, ...called].find((method) => !/^[a-z][a-z0-9_.-]{0,63}$/.test(method))
      assert.equal(
        badName,
        undefined,
        `${name}: 接口名「${badName}」会被宿主拒绝，必须小写开头、只含小写字母/数字/点/下划线/连字符`,
      )
    }
  })

  await it('插件逻辑：DAG 拒环、假设带证据、删节点清理下游', async () => {
    const backend = await loadBackend(MANIFEST_DIR, 'trajectory')
    const created = await backend.rpc['project.create']!({ title: 'T', question: 'Q' })
    const id = (created as { project: { id: string } }).project.id
    const a = (await backend.tools['trajectory_add_node']!({ projectId: id, title: 'A', kind: 'question' })) as { id: string }
    const b = (await backend.tools['trajectory_add_node']!({ projectId: id, title: 'B', kind: 'claim', parents: [a.id] })) as { id: string }
    await assert.rejects(
      backend.tools['trajectory_link_nodes']!({ projectId: id, from: b.id, to: a.id }),
      /环/,
    )
    const h = (await backend.tools['trajectory_add_hypothesis']!({ projectId: id, statement: 'S' })) as { id: string }
    await backend.tools['trajectory_update_hypothesis']!({ projectId: id, hypothesisId: h.id, status: 'supported', evidenceNodeId: b.id })
    await backend.rpc['node.remove']!({ projectId: id, nodeId: b.id })
    const view = (await backend.rpc['project.get']!({ projectId: id })) as { nodes: Array<{ parents: string[] }>; hypotheses: Array<{ evidence: string[] }> }
    assert.equal(view.nodes.length, 1)
    assert.deepEqual(view.hypotheses[0]!.evidence, [], '删掉的证据节点不能留在假设里')
    const registered = Object.keys(backend.tools).sort()
    assert.deepEqual(registered, manifest.contributes.tools.map((t) => t.name).sort())
  })

  await it('学者工作台：合并去重、精读笔记、Idea 关联、三种引用', async () => {
    const backend = await loadBackend(SCHOLAR_DIR, 'scholar')

    const found = (await backend.rpc['paper.search']!({ query: 'routing', limit: 6 })) as {
      results: Array<{ doi: string; arxivId: string; title: string }>
    }
    assert.equal(found.results.length, 2, '两个源按 DOI 合并后应剩两条')
    assert.equal(found.results[0]!.arxivId, '2401.00001')

    const added = (await backend.rpc['paper.add']!({ doi: '10.1000/test' })) as {
      duplicated: boolean
      paper: { id: string; title: string; year: string; authors: string[] }
    }
    assert.equal(added.duplicated, false)
    assert.equal(added.paper.title, 'Routing at Scale')
    assert.equal(added.paper.year, '2023')
    assert.deepEqual(added.paper.authors, ['Doe, Jane'])

    const dup = (await backend.rpc['paper.add']!({ arxivId: '2401.00001' })) as {
      duplicated: boolean
      paper: { id: string }
    }
    assert.equal(dup.duplicated, true, '同一篇换了标识也必须认出来')
    assert.equal(dup.paper.id, added.paper.id)

    const manual = (await backend.rpc['paper.add']!({
      title: '专家混合的路由容量',
      authors: ['李雷'],
      year: '2024',
      tags: ['MoE'],
    })) as { paper: { id: string } }
    const tagged = (await backend.rpc['paper.list']!({ tag: 'MoE' })) as { papers: Array<{ id: string }> }
    assert.deepEqual(tagged.papers.map((p) => p.id), [manual.paper.id])

    await backend.rpc['reading.save']!({
      paperId: manual.paper.id,
      conclusion: '容量因子决定弃 token 的比例',
      evidence: '表 3',
      question: 'top-k 换 2 会怎样？',
      status: 'reading',
    })
    const card = (await backend.rpc['paper.get']!({ paperId: manual.paper.id })) as {
      paper: { reading: { conclusion: string; questions: Array<{ text: string }> }; status: string }
    }
    assert.equal(card.paper.reading.conclusion, '容量因子决定弃 token 的比例')
    assert.equal(card.paper.reading.questions[0]!.text, 'top-k 换 2 会怎样？')
    assert.equal(card.paper.status, 'reading')

    const gbt = (await backend.rpc['cite']!({ paperIds: [added.paper.id], style: 'gbt' })) as {
      items: Array<{ text: string }>
    }
    assert.match(gbt.items[0]!.text, /\[J\]/)
    assert.match(gbt.items[0]!.text, /DOI: 10\.1000\/test/)
    const apa = (await backend.rpc['cite']!({ paperIds: [added.paper.id], style: 'apa' })) as {
      items: Array<{ text: string }>
    }
    assert.match(apa.items[0]!.text, /\(2023\)/)
    const bib = (await backend.rpc['cite']!({ paperIds: [added.paper.id], style: 'bibtex' })) as {
      items: Array<{ text: string }>
    }
    assert.match(bib.items[0]!.text, /^@article\{/)
    assert.match(bib.items[0]!.text, /doi = \{10\.1000\/test\}/)

    const idea = (await backend.rpc['idea.add']!({
      title: '先固定容量因子',
      paperIds: [manual.paper.id],
    })) as { idea: { id: string; papers: Array<{ title: string }> } }
    assert.equal(idea.idea.papers[0]!.title, '专家混合的路由容量')
    await backend.rpc['idea.update']!({ ideaId: idea.idea.id, status: 'confirmed' })
    const md = (await backend.rpc['export.ideas']!({})) as { markdown: string }
    assert.match(md.markdown, /- 状态：已证实/)
    assert.match(md.markdown, /专家混合的路由容量/)

    await assert.rejects(backend.rpc['compare']!({ paperIds: [added.paper.id] }), /至少选两篇/)
    const cmp = (await backend.rpc['compare']!({ paperIds: [added.paper.id, manual.paper.id] })) as {
      papers: Array<{ sections: unknown[] }>
    }
    assert.equal(cmp.papers.length, 2)
    assert.equal(cmp.papers[0]!.sections.length, 4)

    await backend.rpc['paper.remove']!({ paperId: manual.paper.id })
    const after = (await backend.rpc['idea.list']!({})) as { ideas: Array<{ paperIds: string[] }> }
    assert.deepEqual(after.ideas[0]!.paperIds, [], '删论文要把 Idea 里的关联摘掉')
    assert.deepEqual(Object.keys(backend.tools).sort(), scholarManifest.contributes.tools.map((t) => t.name).sort())
  })

  await it('服务器看板：配置校验挡注入，探测解析与失败原因能对上', async () => {
    const backend = await loadBackend(SERVER_DIR, 'server')
    const added = (await backend.rpc['server.add']!({ label: '构建机', host: 'build-01', user: 'ci' })) as {
      server: { id: string; label: string; port: number; keyPath: string; last: unknown }
    }
    assert.equal(added.server.port, 22, '端口缺省 22')
    assert.equal(added.server.keyPath, '')
    assert.equal(added.server.last, null)

    // 值会进 ssh 的 argv：以 - 开头的「主机」就是本机执行任意命令
    await assert.rejects(
      backend.rpc['server.add']!({ label: '坏', host: '-oProxyCommand=calc.exe', user: 'ci' }),
      /主机名/,
    )
    await assert.rejects(backend.rpc['server.add']!({ label: '坏', host: 'build-01', user: 'root -oProxy' }), /用户名/)
    await assert.rejects(backend.rpc['server.add']!({ label: '坏', host: 'build-01', user: 'ci', port: 70000 }), /端口/)
    await assert.rejects(
      backend.rpc['server.add']!({ label: '坏', host: 'build-01', user: 'ci', keyPath: 'id_ed25519' }),
      /绝对路径/,
    )
    await assert.rejects(backend.rpc['server.add']!({ label: '重复', host: 'BUILD-01', user: 'ci' }), /同一台机器/)

    const serverMod = localRequire(path.join(SERVER_DIR, 'main.js')) as {
      probeWith: (runner: unknown, server: Record<string, unknown>) => Promise<Record<string, any>>
      buildProbeArgs: (server: Record<string, unknown>) => string[]
      parseReport: (text: string) => Record<string, any>
    }
    const box = { id: 's1', label: '构建机', host: 'build-01', user: 'ci', port: 22, keyPath: '' }
    const args = serverMod.buildProbeArgs(box)
    assert.ok(args.includes('BatchMode=yes'), '必须禁掉密码交互，否则探测会挂在提示符上')
    assert.equal(args[args.length - 2], 'ci@build-01')
    const keyed = serverMod.buildProbeArgs({ ...box, keyPath: '/home/ci/.ssh/id_ed25519' })
    const at = keyed.indexOf('-i')
    assert.deepEqual(keyed.slice(at, at + 2), ['-i', '/home/ci/.ssh/id_ed25519'])
    assert.throws(() => serverMod.buildProbeArgs({ ...box, host: '-oProxyCommand=calc' }), /主机不合法/)

    const sample = [
      '@@host=build-01',
      '@@os=Ubuntu 22.04.4 LTS',
      '@@cpu=16',
      '@@uptime=1036800',
      '@@load=0.42 0.35 0.28',
      '@@mem=17179869184 9663676416 7516192768',
      '@@disk=257698037760 107374182400 150323855360 42%',
    ].join('\n')
    const good = await serverMod.probeWith(async () => ({ code: 0, stdout: sample, stderr: '' }), { ...box })
    assert.equal(good.ok, true)
    assert.equal(good.metrics.cpu, 16)
    assert.deepEqual(good.metrics.load, [0.42, 0.35, 0.28])
    assert.equal(good.metrics.mem.percent, 56)
    assert.equal(good.metrics.disk.percent, 42)
    assert.equal(good.metrics.os, 'Ubuntu 22.04.4 LTS')

    const denied = await serverMod.probeWith(
      async () => ({ code: 255, stdout: '', stderr: 'ci@build-01: Permission denied (publickey).' }),
      { ...box },
    )
    assert.equal(denied.ok, false)
    assert.match(denied.error, /认证失败/)
    const hung = await serverMod.probeWith(async () => {
      throw new Error('探测超时（10 秒）')
    }, { ...box })
    assert.match(hung.error, /超时/)
    assert.throws(() => serverMod.parseReport('@@host=x\n'), /Linux/)

    const renamed = (await backend.rpc['server.update']!({ serverId: added.server.id, label: '构建机 A' })) as {
      server: { label: string }
    }
    assert.equal(renamed.server.label, '构建机 A')
    await backend.rpc['server.remove']!({ serverId: added.server.id })
    const left = (await backend.rpc['server.list']!({})) as { servers: unknown[] }
    assert.equal(left.servers.length, 0)
    assert.deepEqual(Object.keys(backend.tools).sort(), serverManifest.contributes.tools.map((t) => t.name).sort())
  })

  await it('服务器看板：从 ~/.ssh/config 读出具体主机，通配与 Include 处理正确', async () => {
    const serverMod = localRequire(path.join(SERVER_DIR, 'main.js')) as {
      scanSshConfig: (opts: { homeDir: string; localUser?: string }) => {
        configExists: boolean
        entries: Array<{
          alias: string
          host: string
          user: string
          port: number
          keyPath: string
          keyNote: string
          valid: boolean
          problem: string
        }>
      }
    }
    const home = tmpDir()
    const sshDir = path.join(home, '.ssh')
    mkdirSync(path.join(sshDir, 'config.d'), { recursive: true })
    writeFileSync(path.join(sshDir, 'id_ed25519'), 'PRIVATE KEY FIXTURE', 'utf8')
    writeFileSync(
      path.join(sshDir, 'config'),
      [
        'Host *',
        '  User fallback',
        '  Port 2200',
        '',
        '# 一行多个别名共用一个 Host 块',
        'Host build prod',
        '  HostName 10.0.0.5',
        '  User ci',
        '  IdentityFile ~/.ssh/id_ed25519',
        '  Port = 2222',
        '',
        'Host prod-*',
        '  User produser',
        '',
        'Host prod-eu',
        '  HostName 10.0.0.6',
        '',
        'Host jump-*',
        '  HostName 10.0.0.9',
        '',
        'Match host db',
        '  User from-match',
        '',
        'Host db',
        '  HostName db.internal',
        '  ProxyJump bastion',
        '',
        'Host bad',
        '  HostName -oProxyCommand=calc.exe',
        '',
        'Host nokey',
        '  HostName nokey.internal',
        '  IdentityFile ~/.ssh/missing_key',
        '',
        'Include config.d/*',
      ].join('\n'),
      'utf8',
    )
    writeFileSync(
      path.join(sshDir, 'config.d', 'extra'),
      ['Host cache', '  HostName 10.0.0.7', '  User redis'].join('\n'),
      'utf8',
    )

    const scan = serverMod.scanSshConfig({ homeDir: home, localUser: 'localme' })
    assert.equal(scan.configExists, true)
    const byAlias = new Map(scan.entries.map((entry) => [entry.alias, entry]))
    assert.deepEqual([...byAlias.keys()], ['build', 'prod', 'prod-eu', 'db', 'bad', 'nokey', 'cache'], '通配不入选，Include 要读进来')
    assert.equal(byAlias.get('build')!.host, '10.0.0.5')
    assert.equal(byAlias.get('prod')!.user, 'ci', '同一 Host 行的多个别名共用配置')
    assert.equal(byAlias.get('build')!.port, 2222)
    assert.equal(byAlias.get('build')!.keyPath, path.join(sshDir, 'id_ed25519'))
    assert.equal(byAlias.get('db')!.port, 2200, 'Host 块没写的端口从 Host * 默认补')
    assert.equal(byAlias.get('db')!.user, 'fallback')
    assert.equal(byAlias.get('prod-eu')!.user, 'produser', 'Host prod-* 的通配默认只给匹配的别名')
    assert.equal(byAlias.get('prod-eu')!.port, 2200)
    assert.match(byAlias.get('db')!.keyNote, /ProxyJump/, '中转设置不能被静默当成已支持')
    assert.equal(byAlias.get('bad')!.valid, false, '以 - 开头的 HostName 不能变成 ssh 选项')
    assert.match(byAlias.get('bad')!.problem, /主机名/)
    assert.equal(byAlias.get('nokey')!.keyPath, '')
    assert.match(byAlias.get('nokey')!.keyNote, /密钥不存在/)
    assert.equal(byAlias.get('cache')!.user, 'redis')
    assert.equal(byAlias.get('cache')!.port, 2200)
    rmSync(home, { recursive: true, force: true })
  })

  await it('服务器看板：ssh.scan / ssh.import 只导入选中项，重复与非法项跳过', async () => {
    const home = tmpDir()
    const sshDir = path.join(home, '.ssh')
    mkdirSync(sshDir, { recursive: true })
    writeFileSync(
      path.join(sshDir, 'config'),
      [
        'Host web',
        '  HostName 10.1.0.2',
        '  User deploy',
        '  Port 2201',
        '',
        'Host broken',
        '  HostName -oProxyCommand=calc',
      ].join('\n'),
      'utf8',
    )
    const savedHome = process.env.HOME
    const savedProfile = process.env.USERPROFILE
    process.env.HOME = home
    process.env.USERPROFILE = home
    try {
      const backend = await loadBackend(SERVER_DIR, 'server')
      const scan = (await backend.rpc['ssh.scan']!({})) as {
        entries: Array<{ key: string; alias: string; valid: boolean; exists: boolean }>
      }
      const web = scan.entries.find((entry) => entry.alias === 'web')!
      const broken = scan.entries.find((entry) => entry.alias === 'broken')!
      assert.equal(web.valid, true)
      assert.equal(web.exists, false)
      assert.equal(broken.valid, false, '非法 HostName 不能出现在可导入候选里')

      const first = (await backend.rpc['ssh.import']!({ keys: [web.key, broken.key] })) as {
        added: Array<{ host: string; user: string; port: number }>
        skipped: Array<{ alias: string; reason: string }>
      }
      assert.equal(first.added.length, 1)
      assert.equal(first.added[0]!.host, '10.1.0.2')
      assert.equal(first.added[0]!.user, 'deploy')
      assert.equal(first.added[0]!.port, 2201)
      assert.equal(first.skipped[0]!.alias, 'broken')

      const after = (await backend.rpc['ssh.scan']!({})) as { entries: Array<{ alias: string; exists: boolean }> }
      assert.equal(after.entries.find((entry) => entry.alias === 'web')!.exists, true, '导入后要标成已在看板')

      const again = (await backend.rpc['ssh.import']!({ keys: [web.key] })) as {
        added: unknown[]
        skipped: Array<{ reason: string }>
      }
      assert.equal(again.added.length, 0)
      assert.match(again.skipped[0]!.reason, /已经在看板/)
    } finally {
      if (savedHome === undefined) delete process.env.HOME
      else process.env.HOME = savedHome
      if (savedProfile === undefined) delete process.env.USERPROFILE
      else process.env.USERPROFILE = savedProfile
      rmSync(home, { recursive: true, force: true })
    }
  })

  await it('AI 能力：清单认 ai，模型挑选只认带 Key 的 API 通道', () => {
    const mk = (id: string, patch: Partial<ModelConfig> = {}): ModelConfig => ({
      id,
      displayName: id,
      transport: 'api',
      api: { baseUrl: 'https://api.test', model: id, apiKeyRef: 'key:' + id },
      color: '#000000',
      supportsStructuredOutput: true,
      enabled: true,
      ...patch,
    })
    const models = [
      mk('web', { transport: 'webview', api: undefined }),
      mk('good'),
      mk('nokey'),
      mk('off', { enabled: false }),
    ]
    const hasKey = (ref: string) => ref === 'key:good'
    assert.equal(pickPluginModel(models, undefined, hasKey)?.id, 'good', '默认取第一个已启用且有 Key 的 API 模型')
    assert.equal(pickPluginModel(models, 'good', hasKey)?.id, 'good')
    assert.equal(pickPluginModel(models, 'nokey', hasKey), null, '指定了没 Key 的模型不能借道')
    assert.equal(pickPluginModel(models, 'web', hasKey), null, '网页通道不能借给插件')
    assert.equal(pickPluginModel(models, 'missing', hasKey), null)
    assert.equal(pickPluginModel([], undefined, hasKey), null)
  })

  await it('宿主 AI 闸门：没声明 / 超长 / 无通道 / 并发都被拒', async () => {
    const dir = tmpDir()
    const manifestOf = (permissions: string[]): PluginManifest => ({
      id: 'probe',
      name: 'probe',
      version: '0.0.0',
      apiVersion: 1,
      description: '',
      permissions: permissions as PluginManifest['permissions'],
    })
    const deps = (ai?: { complete(req: { prompt: string }): Promise<unknown> }) => ({
      dataDir: dir,
      entryPath: path.join(dir, 'runtime-entry.js'),
      secrets: { get: () => null },
      log() {},
      ...(ai ? { ai } : {}),
    })
    const gateOf = (runtime: PluginRuntime) => (method: string, params: Record<string, unknown>) => {
      const host = runtime as unknown as {
        handleHostCall(m: string, p: Record<string, unknown>): Promise<unknown>
      }
      return host.handleHostCall(method, params)
    }
    const reply = {
      text: 'ok',
      modelId: 'm',
      model: 'M',
      usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
    }
    try {
      const seen: Array<{ prompt: string }> = []
      const allowed = new PluginRuntime(manifestOf(['ai']), dir, deps({
        async complete(req) {
          seen.push(req)
          return reply
        },
      }))
      const out = (await gateOf(allowed)('ai.complete', { prompt: 'ping', system: 'sys' })) as { text: string }
      assert.equal(out.text, 'ok')
      assert.equal(seen.length, 1)
      assert.equal(seen[0]!.prompt, 'ping')

      const denied = new PluginRuntime(manifestOf(['storage']), dir, deps({ async complete() { return reply } }))
      await assert.rejects(gateOf(denied)('ai.complete', { prompt: 'x' }), /没有声明「ai」/)
      const noChannel = new PluginRuntime(manifestOf(['ai']), dir, deps())
      await assert.rejects(gateOf(noChannel)('ai.complete', { prompt: 'x' }), /没有接入/)
      await assert.rejects(gateOf(allowed)('ai.complete', { prompt: '   ' }), /缺少 prompt/)
      await assert.rejects(
        gateOf(allowed)('ai.complete', { prompt: 'x'.repeat(AI_PROMPT_MAX_CHARS + 1) }),
        /过长/,
      )
      await assert.rejects(
        gateOf(allowed)('ai.complete', { prompt: 'x', system: 's'.repeat(AI_SYSTEM_MAX_CHARS + 1) }),
        /系统提示过长/,
      )

      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let active = 0
      let peak = 0
      const bounded = new PluginRuntime(manifestOf(['ai']), dir, deps({
        async complete() {
          active += 1
          peak = Math.max(peak, active)
          await gate
          active -= 1
          return reply
        },
      }))
      const first = gateOf(bounded)('ai.complete', { prompt: 'a' })
      const second = gateOf(bounded)('ai.complete', { prompt: 'b' })
      const third = gateOf(bounded)('ai.complete', { prompt: 'c' })
      await assert.rejects(third, /2 个 AI 请求/)
      release()
      await Promise.all([first, second])
      assert.equal(peak, 2, '并发上限 2 要真生效')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  await it('研究主线图 AI：起草/推演/评审先预览，accept 才落库', async () => {
    const backend = await loadBackend(MANIFEST_DIR, 'trajectory')
    const created = (await backend.rpc['project.create']!({ title: 'MoE', question: '容量因子怎么调' })) as {
      project: { id: string }
    }
    const pid = created.project.id
    const seed = (await backend.rpc['node.add']!({ projectId: pid, title: '已有种子节点', kind: 'claim' })) as {
      id: string
    }

    const status = (await backend.rpc['ai.status']!({})) as { available: boolean; model: string }
    assert.equal(status.available, true)
    assert.equal(status.model, '')

    const draft = (await backend.rpc['ai.plan']!({ projectId: pid, question: '容量因子怎么调', goal: '找方法' })) as {
      nodes: Array<{ key: string; title: string; parents: string[] }>
      hypotheses: Array<{ statement: string; evidence: string[] }>
      summary: string
      model: string
    }
    assert.equal(draft.nodes.length, 3)
    assert.deepEqual(draft.nodes[1]!.parents, ['a1', seed.id], '只保留本次 key 或已有 id，编出来的上游丢掉')
    assert.deepEqual(draft.hypotheses[0]!.evidence, ['a2'], '不存在的证据 id 不能进草案')
    assert.equal(draft.model, '测试模型')
    assert.ok(draft.summary.includes('对照实验'))

    const accepted = (await backend.rpc['ai.accept.plan']!({ projectId: pid, draft })) as {
      added: Array<{ key: string; id: string }>
      links: number
      hypotheses: number
      warnings: string[]
      project: { nodes: Array<{ id: string; parents: string[] }>; hypotheses: Array<{ id: string; evidence: string[] }> }
    }
    assert.equal(accepted.added.length, 3)
    assert.ok(accepted.links >= 3)
    assert.equal(accepted.hypotheses, 1)
    assert.deepEqual(accepted.warnings, [])
    const a1 = accepted.added.find((n) => n.key === 'a1')!
    const a2 = accepted.added.find((n) => n.key === 'a2')!
    assert.deepEqual(
      accepted.project.nodes.find((n) => n.id === a2.id)!.parents,
      [a1.id, seed.id],
    )

    const partial = (await backend.rpc['ai.accept.plan']!({
      projectId: pid,
      draft: {
        nodes: [
          { key: 'x1', title: '补充节点', kind: 'claim', parents: ['ghost'] },
          { key: 'x2', title: '', kind: 'claim' },
        ],
        hypotheses: [],
      },
    })) as { added: unknown[]; links: number; warnings: string[] }
    assert.equal(partial.added.length, 1, '空标题节点不能写入')
    assert.equal(partial.links, 0, '不认识的上游不能连边')
    assert.match(partial.warnings[0]!, /标题不能为空/)

    const step = (await backend.rpc['ai.next']!({ projectId: pid, focus: '推进实验' })) as {
      proposals: Array<Record<string, unknown>>
    }
    assert.equal(step.proposals.length, 3, '认不出的假设 id 在预览阶段就被丢掉')
    const update = step.proposals.find((p) => p.type === 'update_node') as { nodeId: string; status: string }
    assert.equal(update.nodeId, seed.id)
    assert.equal(update.status, 'doing')
    const added = step.proposals.find((p) => p.type === 'add_node') as { parents: string[] }
    assert.deepEqual(added.parents, [])

    const applied = (await backend.rpc['ai.accept.proposals']!({
      projectId: pid,
      proposals: [...step.proposals, { type: 'update_node', nodeId: 'n_ghost', status: 'done' }],
    })) as { applied: Array<{ type: string }>; warnings: string[] }
    assert.equal(applied.applied.length, 3)
    assert.match(applied.warnings[0]!, /n_ghost/)

    const review = (await backend.rpc['ai.critique']!({ projectId: pid })) as {
      issues: Array<{ severity: string; target: string; topic: string }>
      facts: Array<{ label: string }>
    }
    assert.equal(review.issues[0]!.severity, 'high', '按严重度排序')
    assert.equal(review.issues.find((i) => i.topic === '结论早于实验')!.target, seed.id)
    assert.equal(review.issues.find((i) => i.topic === '假设无证据')!.target, '', '编出来的 target 要清空')
    assert.ok(review.facts.some((f) => f.label === '没有上游的节点'), '本地结构信号要随评审一起给')

    const hypothesisId = accepted.project.hypotheses[0]!.id
    const q = (await backend.rpc['ai.evidence.queries']!({ projectId: pid, hypothesisId })) as { queries: string[] }
    assert.equal(q.queries.length, 2)
    const found = (await backend.rpc['ai.evidence.search']!({ queries: q.queries, perQuery: 4 })) as {
      candidates: Array<{ key: string; title: string }>
    }
    assert.equal(found.candidates.length, 2, 'arXiv 与 Crossref 的同一篇按 DOI 合并')
    assert.equal(found.candidates[0]!.key, 'doi:10.1000/test')
    const screened = (await backend.rpc['ai.evidence.screen']!({
      projectId: pid,
      hypothesisId,
      candidates: found.candidates,
    })) as { picks: Array<{ key: string; stance: string }> }
    assert.deepEqual(screened.picks.map((p) => p.key), found.candidates.map((c) => c.key), '只保留候选表里的 id')
    assert.equal(screened.picks[1]!.stance, 'neutral')

    const evidenceInput = { projectId: pid, hypothesisId, candidates: found.candidates, picks: screened.picks }
    const ev = (await backend.rpc['ai.accept.evidence']!(evidenceInput)) as {
      added: Array<{ title: string; stance: string }>
      duplicated: number
      total: number
    }
    assert.equal(ev.added.length, 2)
    assert.equal(ev.total, 2)
    const again = (await backend.rpc['ai.accept.evidence']!(evidenceInput)) as {
      added: unknown[]
      duplicated: number
      total: number
    }
    assert.equal(again.added.length, 0)
    assert.equal(again.duplicated, 2)
    assert.equal(again.total, 2)

    const toolAdd = (await backend.tools['trajectory_add_source']!({
      projectId: pid,
      hypothesisId,
      title: '另一篇',
      doi: '10.1000/third',
      stance: 'refutes',
      why: '结果相反',
    })) as { added: string[]; total: number }
    assert.deepEqual(toolAdd.added, ['另一篇'])
    assert.equal(toolAdd.total, 3)
    const dupTool = (await backend.tools['trajectory_add_source']!({
      projectId: pid,
      hypothesisId,
      title: '同 DOI 换写法',
      doi: 'https://doi.org/10.1000/THIRD',
      stance: 'neutral',
    })) as { added: string[]; total: number }
    assert.deepEqual(dupTool.added, [], 'DOI 换了写法也是同一篇')
    assert.equal(dupTool.total, 3)

    const offline = await loadBackend(MANIFEST_DIR, 'trajectory', { ai: false })
    assert.equal(((await offline.rpc['ai.status']!({})) as { available: boolean }).available, false)
    const offProject = (await offline.rpc['project.create']!({ title: 'T' })) as { project: { id: string } }
    await assert.rejects(offline.rpc['ai.plan']!({ projectId: offProject.project.id, question: 'Q' }), /AI 通道/)
    const offSearch = (await offline.rpc['ai.evidence.search']!({ queries: ['routing'] })) as {
      candidates: unknown[]
    }
    assert.equal(offSearch.candidates.length, 2, '检索不依赖模型：AI 通道断了也能先取回候选')
  })

  await it('学者工作台 AI：检索式→筛选→精读→对比→Idea→入库全链路', async () => {
    const backend = await loadBackend(SCHOLAR_DIR, 'scholar')
    const status = (await backend.rpc['ai.status']!({})) as { available: boolean }
    assert.equal(status.available, true)

    const plan = (await backend.rpc['ai.plan']!({ question: 'MoE 路由容量怎么调', goal: '综述' })) as {
      queries: string[]
      include: string[]
      note: string
      model: string
    }
    assert.equal(plan.queries.length, 2)
    assert.equal(plan.include[0], '实证研究')
    assert.equal(plan.model, '测试模型')

    const gather = (await backend.rpc['ai.gather']!({ queries: plan.queries, perQuery: 4 })) as {
      candidates: Array<{ key: string; title: string }>
    }
    assert.equal(gather.candidates.length, 2)

    const screen = (await backend.rpc['ai.screen']!({ question: 'MoE', candidates: gather.candidates })) as {
      picks: Array<{ key: string; relevance: string }>
    }
    assert.deepEqual(screen.picks.map((p) => p.key), gather.candidates.map((c) => c.key))
    assert.equal(screen.picks[0]!.relevance, 'high')

    const notes = (await backend.rpc['ai.notes']!({ question: 'MoE', papers: gather.candidates })) as {
      notes: Array<{ key: string; conclusion: string; experiments: string }>
    }
    assert.equal(notes.notes.length, 2, '编出来的论文 id 不能进精读卡片')
    assert.match(notes.notes[0]!.experiments, /摘要未提/)

    const noteOf = new Map(notes.notes.map((n) => [n.key, n]))
    const synth = (await backend.rpc['ai.synthesize']!({
      question: 'MoE',
      papers: gather.candidates.map((c) => ({ ...c, ...noteOf.get(c.key) })),
    })) as {
      dimensions: string[]
      rows: Array<{ key: string; cells: string[] }>
      summary: string
      gaps: string[]
    }
    assert.equal(synth.dimensions.length, 2)
    assert.equal(synth.rows.length, 2)
    assert.ok(synth.rows.every((r) => r.cells.length === 2), '单元格数补齐到维度数')

    const ideas = (await backend.rpc['ai.ideas']!({
      question: 'MoE',
      papers: gather.candidates,
      gaps: synth.gaps,
    })) as { ideas: Array<{ title: string; paperKeys: string[] }> }
    assert.deepEqual(ideas.ideas[0]!.paperKeys, [gather.candidates[0]!.key], '编出来的论文 id 不能进 Idea 关联')

    const accepted = (await backend.rpc['ai.accept']!({
      candidates: gather.candidates,
      keys: gather.candidates.map((c) => c.key),
      notes: notes.notes,
      tag: 'AI 调研',
    })) as {
      added: string[]
      duplicated: string[]
      saved: Array<{ key: string; id: string }>
      notesWritten: number
    }
    assert.equal(accepted.added.length, 2)
    assert.equal(accepted.duplicated.length, 0)
    assert.equal(accepted.notesWritten, 2)

    const firstId = accepted.saved[0]!.id
    await backend.rpc['reading.save']!({ paperId: firstId, conclusion: '人手写的结论' })
    const again = (await backend.rpc['ai.accept']!({
      candidates: gather.candidates,
      keys: [gather.candidates[0]!.key],
      notes: [{ key: gather.candidates[0]!.key, conclusion: 'AI 想覆盖', evidence: '证据' }],
      tag: 'AI 调研',
    })) as { added: string[]; duplicated: string[]; notesWritten: number }
    assert.deepEqual(again.duplicated, [firstId])
    assert.equal(again.notesWritten, 0, '已有人工笔记时不能再写')
    const card = (await backend.rpc['paper.get']!({ paperId: firstId })) as {
      paper: { reading: { conclusion: string; evidence: string } }
    }
    assert.equal(card.paper.reading.conclusion, '人手写的结论')
    assert.ok(card.paper.reading.evidence.length > 0)

    const offline = await loadBackend(SCHOLAR_DIR, 'scholar', { ai: false })
    assert.equal(((await offline.rpc['ai.status']!({})) as { available: boolean }).available, false)
    await assert.rejects(offline.rpc['ai.plan']!({ question: 'Q' }), /AI 通道/)
    const offGather = (await offline.rpc['ai.gather']!({ queries: ['routing'] })) as { candidates: unknown[] }
    assert.equal(offGather.candidates.length, 2, '检索不依赖模型：AI 通道断了也能先取回候选')
  })

  await it('学者工作台：项目/会话/文件随会话持久，删项目只把会话退到未归类', async () => {
    const backend = await loadBackend(SCHOLAR_DIR, 'scholar')

    const project = (await backend.rpc['project.create']!({ title: 'MoE 调研' })) as { project: { id: string } }
    await assert.rejects(backend.rpc['project.create']!({ title: 'MoE 调研' }), /同名项目/)
    const session = (await backend.rpc['session.create']!({ projectId: project.project.id, goal: '综述' })) as {
      session: { id: string; title: string; goal: string }
    }
    assert.equal(session.session.title, '新会话')
    await assert.rejects(backend.rpc['session.create']!({ projectId: 'prj_missing' }), /项目不存在/)
    await assert.rejects(backend.rpc['session.append']!({ sessionId: 's_missing', kind: 'question', text: 'x' }), /找不到这个会话/)

    const asked = (await backend.rpc['session.append']!({
      sessionId: session.session.id,
      role: 'user',
      kind: 'question',
      text: 'MoE 路由容量怎么调',
    })) as { message: { role: string; kind: string }; session: { title: string } }
    assert.equal(asked.message.role, 'user')
    assert.equal(asked.session.title, 'MoE 路由容量怎么调', '第一个问题成为会话标题')

    const planned = (await backend.rpc['session.append']!({
      sessionId: session.session.id,
      role: 'ai',
      kind: 'plan',
      data: { queries: ['moe routing'] },
    })) as { session: { messages: number } }
    assert.equal(planned.session.messages, 2)

    const huge = (await backend.rpc['session.append']!({
      sessionId: session.session.id,
      role: 'ai',
      kind: 'gather',
      data: { candidates: [{ key: 'k', title: 'x'.repeat(70000) }] },
    })) as { message: { data: { truncated?: boolean; preview?: string } } }
    assert.equal(huge.message.data.truncated, true, '单条消息过大时退化成预览，别撑爆存储')

    const file = (await backend.rpc['session.attach']!({
      sessionId: session.session.id,
      name: '检索计划.md',
      kind: 'note',
      text: '# 计划',
    })) as { file: { id: string }; session: { files: number } }
    assert.equal(file.session.files, 1)

    const got = (await backend.rpc['session.get']!({ sessionId: session.session.id })) as {
      session: { messages: Array<{ kind: string }>; files: Array<{ id: string; text: string }> }
      project: { id: string } | null
    }
    assert.deepEqual(got.session.messages.map((m) => m.kind), ['question', 'plan', 'gather'])
    assert.equal(got.session.files[0]!.text, '# 计划')
    assert.equal(got.project!.id, project.project.id)

    await backend.rpc['session.detach']!({ sessionId: session.session.id, fileId: file.file.id })
    const listed = (await backend.rpc['session.list']!({ projectId: project.project.id })) as {
      sessions: Array<{ id: string; files: number }>
    }
    assert.equal(listed.sessions[0]!.files, 0)

    const removed = (await backend.rpc['project.remove']!({ projectId: project.project.id })) as { detached: number }
    assert.equal(removed.detached, 1)
    const orphan = (await backend.rpc['session.get']!({ sessionId: session.session.id })) as {
      session: { projectId: string }
      project: null
    }
    assert.equal(orphan.session.projectId, '')
    assert.equal(orphan.project, null)
    const loose = (await backend.rpc['session.list']!({ projectId: '' })) as { sessions: unknown[] }
    assert.equal(loose.sessions.length, 1, '未归类按空 projectId 过滤，不是「不过滤」')
    assert.equal(((await backend.rpc['session.list']!({})) as { sessions: unknown[] }).sessions.length, 1)
  })

  await it('学者工作台：文档写作 + [CITE:] 标注 + 多格式导出', async () => {
    const backend = await loadBackend(SCHOLAR_DIR, 'scholar')

    const project = (await backend.rpc['project.create']!({ title: '写作项目' })) as { project: { id: string } }
    const p1 = (await backend.rpc['paper.add']!({
      title: 'Routing at Scale',
      authors: ['Doe, Jane'],
      year: '2023',
      venue: 'SIGIR',
      impactFactor: 9.5,
    })) as { paper: { id: string; impactFactor: number } }
    const p2 = (await backend.rpc['paper.add']!({
      title: '专家混合的路由容量',
      authors: ['李雷'],
      year: '2024',
      venue: '计算机学报',
      impactFactor: 3.2,
    })) as { paper: { id: string } }
    const p3 = (await backend.rpc['paper.add']!({
      title: 'Unrated Preprint',
      authors: ['Smith, Ann'],
      year: '2022',
      impactFactor: -1,
    })) as { paper: { id: string; impactFactor: string } }
    assert.equal(p1.paper.impactFactor, 9.5)
    assert.equal(p3.paper.impactFactor, '', '非法影响因子留空，不拿 0 冒充')

    const byImpact = (await backend.rpc['paper.list']!({ minImpact: 5 })) as { papers: Array<{ id: string }> }
    assert.deepEqual(byImpact.papers.map((p) => p.id), [p1.paper.id])
    const byYear = (await backend.rpc['paper.list']!({ yearFrom: '2024' })) as { papers: Array<{ id: string }> }
    assert.deepEqual(byYear.papers.map((p) => p.id), [p2.paper.id])
    const byVenue = (await backend.rpc['paper.list']!({ venue: 'sigir' })) as { papers: Array<{ id: string }> }
    assert.deepEqual(byVenue.papers.map((p) => p.id), [p1.paper.id])

    await assert.rejects(backend.rpc['doc.create']!({ projectId: 'prj_missing' }), /项目不存在/)
    const doc = (await backend.rpc['doc.create']!({ projectId: project.project.id, title: 'MoE 综述' })) as {
      doc: { id: string; title: string; history: Array<{ kind: string }> }
    }
    assert.equal(doc.doc.title, 'MoE 综述')
    assert.equal(doc.doc.history[0]!.kind, 'create')

    const body =
      '路由容量是核心问题 [CITE:Routing at Scale]；中文路线 [CITE:专家混合 2024]；再提一次 [CITE:Routing at Scale]。'
    const saved = (await backend.rpc['doc.update']!({ docId: doc.doc.id, body })) as {
      doc: { pending: number; citations: { unresolved: Array<{ hint: string; count: number }> } }
    }
    assert.equal(saved.doc.pending, 3)
    assert.deepEqual(
      saved.doc.citations.unresolved.map((u) => [u.hint, u.count]),
      [['Routing at Scale', 2], ['专家混合 2024', 1]],
    )

    const hinted = (await backend.rpc['doc.suggest']!({ hint: 'Routing at Scale' })) as {
      items: Array<{ paper: { id: string }; why: string }>
    }
    assert.equal(hinted.items[0]!.paper.id, p1.paper.id)
    assert.ok(hinted.items[0]!.why.length > 0)
    await assert.rejects(backend.rpc['doc.suggest']!({ hint: '   ' }), /标记是空的/)
    await assert.rejects(
      backend.rpc['doc.annotate']!({ docId: doc.doc.id, hint: '不存在', paperId: p1.paper.id }),
      /找不到这个标记/,
    )

    const first = (await backend.rpc['doc.annotate']!({
      docId: doc.doc.id,
      hint: 'Routing at Scale',
      paperId: p1.paper.id,
    })) as { doc: { body: string; cites: number } }
    assert.equal(
      (first.doc.body.match(new RegExp('\\[CITE:#' + p1.paper.id + '\\]', 'g')) || []).length,
      2,
      '同一提示的重复标记一起替换',
    )
    assert.equal(first.doc.cites, 1)

    const second = (await backend.rpc['doc.annotate']!({
      docId: doc.doc.id,
      hint: '专家混合 2024',
      paperId: p2.paper.id,
    })) as { doc: { body: string; pending: number; cites: number } }
    assert.equal(second.doc.pending, 0)
    assert.equal(second.doc.cites, 2)

    const md = (await backend.rpc['doc.export']!({ docId: doc.doc.id, format: 'markdown' })) as {
      text: string
      filename: string
    }
    assert.match(md.text, /\[1\]/)
    assert.match(md.text, /\[2\]/)
    assert.match(md.text, /## 参考文献/)
    assert.match(md.filename, /MoE 综述-\d{4}-\d{2}-\d{2}\.md$/)

    const html = (await backend.rpc['doc.export']!({ docId: doc.doc.id, format: 'html' })) as { text: string }
    assert.match(html.text, /<ol>/)
    assert.match(html.text, /<li>/)

    const bib = (await backend.rpc['doc.export']!({ docId: doc.doc.id, format: 'bibtex' })) as {
      text: string
      filename: string
    }
    assert.match(bib.text, /@(article|misc)\{/)
    assert.match(bib.filename, /\.bib$/)

    const ris = (await backend.rpc['doc.export']!({ docId: doc.doc.id, format: 'ris' })) as {
      text: string
      filename: string
    }
    assert.match(ris.text, /TY {2}- JOUR/)
    assert.match(ris.text, /ER {2}- /)
    assert.match(ris.filename, /\.ris$/)

    const reopened = (await backend.rpc['doc.get']!({ docId: doc.doc.id })) as {
      doc: { history: Array<{ kind: string }> }
    }
    assert.equal(reopened.doc.history[0]!.kind, 'export', '导出会写进历史')

    await backend.rpc['doc.update']!({ docId: doc.doc.id, body: second.doc.body + '\n待补 [CITE:冷启动]' })
    const pendingDoc = (await backend.rpc['doc.export']!({ docId: doc.doc.id, format: 'markdown' })) as { text: string }
    assert.match(pendingDoc.text, /\[\?\]/, '没标完的提示在导出里显示 [?]，不假装已解决')

    const risStyle = (await backend.rpc['cite']!({ paperIds: [p1.paper.id, p2.paper.id], style: 'ris' })) as {
      items: Array<{ text: string }>
    }
    assert.match(risStyle.items[0]!.text, /^TY {2}- JOUR/)
    const mdStyle = (await backend.rpc['cite']!({ paperIds: [p1.paper.id], style: 'markdown' })) as {
      items: Array<{ text: string }>
    }
    assert.match(mdStyle.items[0]!.text, /^1\. /)
    const htmlStyle = (await backend.rpc['cite']!({ paperIds: [p1.paper.id], style: 'html' })) as {
      items: Array<{ text: string }>
    }
    assert.match(htmlStyle.items[0]!.text, /^<li>/)

    const listed = (await backend.rpc['doc.list']!({ projectId: project.project.id })) as { docs: Array<{ id: string }> }
    assert.equal(listed.docs.length, 1)
    const removed = (await backend.rpc['project.remove']!({ projectId: project.project.id })) as { detached: number }
    assert.equal(removed.detached, 1)
    const loose = (await backend.rpc['doc.list']!({ projectId: '' })) as { docs: Array<{ id: string; projectId: string }> }
    assert.equal(loose.docs.length, 1)
    assert.equal(loose.docs[0]!.projectId, '', '删项目只把文档退到未归类')

    await backend.rpc['doc.remove']!({ docId: doc.doc.id })
    assert.equal(((await backend.rpc['doc.list']!({})) as { docs: unknown[] }).docs.length, 0)
  })

  console.log(`${'-'.repeat(46)}\n${pass} passed, ${fail} failed\n`)

  if (fail > 0) process.exit(1)
}

/** 清单 fixture 里的 id 改成目录名后，工具前缀也要跟着改，否则会先撞上前缀校验 */
function embeddedToolNames(m: Record<string, any>, id: string): void {
  const contributes = m.contributes
  if (!contributes || !Array.isArray(contributes.tools)) return
  for (const tool of contributes.tools) {
    tool.name = String(tool.name).replace(/^trajectory_/, `${id}_`)
  }
}

/** 用内存存储把真入口跑起来：工具与面板接口共用同一份状态 */
async function loadBackend(
  dir: string,
  id: string,
  opts: { ai?: boolean } = {},
): Promise<{
  tools: Record<string, (params: Record<string, unknown>) => Promise<unknown>>
  rpc: Record<string, (params: Record<string, unknown>) => Promise<unknown>>
}> {
  const store = new Map<string, unknown>()
  const tools: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {}
  const rpc: Record<string, (params: Record<string, unknown>) => Promise<unknown>> = {}
  const mod = localRequire(path.join(dir, 'main.js')) as { activate(ctx: unknown): Promise<void> }
  const ctx = {
    id,
    version: '0.1.0',
    dataDir: 'memory',
    log() {},
    storage: {
      async get(key: string) {
        return store.get(key)
      },
      async set(key: string, value: unknown) {
        store.set(key, JSON.parse(JSON.stringify(value)))
      },
      async delete(key: string) {
        return store.delete(key)
      },
      async list() {
        return [...store.keys()]
      },
    },
    /** 假元数据服务：只认 arXiv / Crossref 两个域名，形状与真响应一致 */
    async fetch(input: { url: string }) {
      return fakeMetadata(input.url)
    },
    // 默认给一个确定性的假模型：只按 system 提示词分发 JSON，测试里不联网、不花钱
    ...(opts.ai === false ? {} : { ai: fakeAi() }),
    tools: { handle(name: string, fn: (params: Record<string, unknown>) => Promise<unknown>) { tools[name] = fn } },
    rpc: { handle(name: string, fn: (params: Record<string, unknown>) => Promise<unknown>) { rpc[name] = fn } },
  }
  await mod.activate(ctx)
  return { tools, rpc }
}

const ARXIV_ENTRY = (id: string, title: string, doi: string) => `
  <entry>
    <id>http://arxiv.org/abs/${id}v2</id>
    <published>2024-01-02T00:00:00Z</published>
    <title>${title}</title>
    <summary>We study routing &amp; balance.</summary>
    <author><name>Jane Doe</name></author>
    <author><name>李雷</name></author>
    <arxiv:doi>${doi}</arxiv:doi>
  </entry>`

function fakeMetadata(url: string): { status: number; headers: Record<string, string>; body: string } {
  const ok = (body: string) => ({ status: 200, headers: {}, body })
  if (url.includes('export.arxiv.org')) {
    return ok(
      `<?xml version="1.0"?><feed>${ARXIV_ENTRY('2401.00001', 'Mixture of Experts Routing', '10.1000/test')}</feed>`,
    )
  }
  const work = {
    title: ['Routing at Scale'],
    author: [{ family: 'Doe', given: 'Jane' }],
    issued: { 'date-parts': [[2023]] },
    'container-title': ['Journal of Tests'],
    DOI: '10.1000/test',
    URL: 'https://doi.org/10.1000/test',
    abstract: '<jats:p>Big &amp; small.</jats:p>',
  }
  if (url.includes('/works/10.')) return ok(JSON.stringify({ message: work }))
  return ok(
    JSON.stringify({
      message: {
        items: [work, { ...work, title: ['Sparse Routing'], DOI: '10.1000/other', URL: '' }],
      },
    }),
  )
}


/** 假模型：把 system 提示词当路由键，回一份确定性的 JSON；不联网、不花钱 */
function fakeAi(): { complete(req: { system?: string; prompt: string }): Promise<{
  text: string
  modelId: string
  model: string
  usage: { promptTokens: number; completionTokens: number; costUsd: number }
}> } {
  return {
    async complete(req) {
      const prompt = String(req.prompt ?? '')
      const system = String(req.system ?? '')
      const ids = [...prompt.matchAll(/id=(\S+)/g)].map((m) => m[1]!)
      const nodeIds = [...new Set(prompt.match(/\bn_[0-9a-z]{10}\b/g) ?? [])]
      let payload: unknown = {}
      if (system.includes('检索规划助手')) {
        payload = {
          queries: ['mixture of experts routing', 'sparse gate'],
          include: ['实证研究'],
          exclude: ['纯综述'],
          note: '覆盖路由与稀疏门控',
        }
      } else if (system.includes('研究规划助手')) {
        payload = {
          nodes: [
            { key: 'a1', title: '把问题拆成研究节点', kind: 'question', parents: [] },
            {
              key: 'a2',
              title: '验证容量因子对弃 token 的影响',
              kind: 'experiment',
              note: '固定 top-k',
              parents: ['a1', ...(nodeIds[0] ? [nodeIds[0]] : []), 'ghost'],
            },
            { key: 'a3', title: '汇总成结论', kind: 'conclusion', parents: ['a2'] },
          ],
          hypotheses: [{ statement: '容量因子是可调的关键旋钮', evidence: ['a2', 'n_ghost'] }],
          summary: '先拆问题，再做对照实验，最后收束。',
        }
      } else if (system.includes('研究推进助手')) {
        payload = {
          proposals: [
            { type: 'update_node', why: '种子节点该推进了', nodeId: nodeIds[0], status: 'doing' },
            {
              type: 'add_node',
              why: '缺对照',
              title: '补一个对照实验',
              kind: 'experiment',
              parents: ['n_ghost'],
            },
            { type: 'update_hypothesis', why: '编的', hypothesisId: 'h_ghost', status: 'supported' },
            { type: 'ledger', why: '记录进度', text: '跑完对照实验', result: '' },
          ],
          summary: '把主线推到实验阶段。',
        }
      } else if (system.includes('研究评审')) {
        payload = {
          issues: [
            {
              severity: 'low',
              target: 'ghost',
              topic: '假设无证据',
              detail: '这条假设没有外部来源',
              suggestion: '先补两篇',
            },
            {
              severity: 'high',
              target: nodeIds[0],
              topic: '结论早于实验',
              detail: '结论节点没有实验支撑',
              suggestion: '补对照实验',
            },
            { severity: 'medium', topic: '缺少结论', detail: '整体还停在问题层', suggestion: '推进到实验' },
          ],
          summary: '主线有推进空间。',
        }
      } else if (system.includes('学术检索助手')) {
        payload = { queries: ['mixture of experts capacity factor', 'expert dropout routing'], note: '找支持与反驳' }
      } else if (system.includes('文献筛选助手')) {
        payload = {
          picks: [
            { id: ids[0], relevance: 'high', why: '直接研究路由' },
            { id: ids[1], relevance: 'medium', why: '提供基线' },
            { id: 'doi:ghost', relevance: 'high', why: '编的' },
          ],
          note: '筛掉纯背景',
        }
      } else if (system.includes('论文精读助手')) {
        payload = {
          notes: [
            ...ids.map((id, index) => ({
              id,
              conclusion: '结论 ' + (index + 1),
              evidence: '证据 ' + (index + 1),
              experiments: '摘要未提',
              limitations: '摘要未提',
              relation: '提供方法',
            })),
            { id: 'doi:ghost', conclusion: '编的', evidence: '', experiments: '', limitations: '', relation: '' },
          ],
        }
      } else if (system.includes('研究综述助手')) {
        payload = {
          dimensions: ['方法', '结论'],
          rows: [
            ...ids.map((id, index) => ({ id, cells: ['方法 ' + (index + 1)] })),
            { id: 'doi:ghost', cells: ['x', 'y'] },
          ],
          summary: '这些工作把路由容量推进到可调阶段。',
          gaps: ['缺少端到端基准', '容量因子与吞吐的联合约束'],
        }
      } else if (system.includes('研究选题助手')) {
        payload = {
          ideas: [
            {
              title: '把容量因子做成可学习参数',
              innovation: '现有工作固定容量',
              evidence: '暂无直接证据，属推断',
              test: '同算力下扫容量因子',
              paperIds: [ids[0], 'doi:ghost'],
            },
          ],
        }
      } else if (system.includes('证据筛选助手')) {
        payload = {
          picks: [
            { id: ids[0], stance: 'supports', why: '摘要结论一致' },
            { id: ids[1], stance: 'neutral', why: '相关但无法判定' },
            { id: 'doi:ghost', stance: 'supports', why: '编的' },
          ],
          note: '两篇够用',
        }
      }
      return {
        text: JSON.stringify(payload),
        modelId: 'test',
        model: '测试模型',
        usage: { promptTokens: 1, completionTokens: 1, costUsd: 0 },
      }
    },
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
