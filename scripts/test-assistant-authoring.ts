/**
 * 「助手自建工具」的离线回归（假 caps + 临时目录，不需要 Electron，也不需要真实模型）。
 *
 * 这一层的失败全是同一类：不报错，但本机悄悄多了东西、或者多了个永远用不上的东西。
 * 所以断言只盯着三件事：
 * - 开关关着时那四个工具**连注册都没有**（提示词也不提）—— 否则模型会去调一个不存在的工具；
 * - 每一次写盘都必须在用户点过确认之后，且拒绝时盘上一点变化都没有；
 * - 一个工具就是一份 kind=js 的清单 + 同名源码，提交时卡片上放的是**源码本身**，
 *   而且它只能落进待审区 —— 启用是人在设置页点的那一下。
 *
 * 运行：npm run test:assistant-authoring
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  ASSISTANT_TOOL_NAMES,
  AUTHORING_TOOL_NAMES,
  buildAssistantTools,
  type AssistantCaps,
  type ApprovalRequest,
} from '../src/main/assistant/tools'
import { ASSISTANT_SYSTEM_PROMPT, SELF_AUTHORING_PROMPT } from '../src/main/assistant/prompt'
import {
  legacyExtensionsDirOf,
  listLegacyExtensions,
  listPendingPlugins,
  loadPluginManifests,
  pendingDirOf,
  pluginsDirOf,
  promotePendingPlugin,
  removePendingPlugin,
  removePluginManifest,
  toPluginView,
  writePendingPlugin,
  writePluginManifest,
} from '../src/main/assistant/plugins'
import { writeAuthoredSkill } from '../src/main/assistant/skills'

let pass = 0
let fail = 0

async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass += 1
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`)
  } catch (e) {
    fail += 1
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`)
    console.log(`       ${(e as Error).message.split('\n')[0]}`)
  }
}

/** 一次测试的现场：一个假的 dataDir + 可编排的确认结果 */
function fixture(approveResult: 'allow' | 'deny' = 'allow') {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'torra-authoring-'))
  const cards: ApprovalRequest[] = []
  const capsBase = {
    approve: async (req: ApprovalRequest) => {
      cards.push(req)
      return approveResult === 'allow' ? { approved: true } : { approved: false, reason: '用户想先看看别的做法' }
    },
    log: () => {},
    listModels: () => [],
    findModel: () => undefined,
    runDoctor: async () => ({}) as never,
    readLog: () => [],
    pageFacts: async () => ({}) as never,
    verifySelector: async () => ({}) as never,
    readAdapter: () => undefined,
    saveAdapter: async () => ({ ok: true }),
    probeApiModel: async () => ({ ok: true }),
    createApiModel: async () => ({ ok: true }),
    createWebModel: async () => ({ ok: true }),
    deleteModel: async () => ({ ok: true }),
    openLogin: async () => ({ ok: true }),
    scanSite: async () => ({}) as never,
    answerSiteQuestions: async () => ({}) as never,
    checkSiteSelectors: async () => ({}) as never,
    closeSiteScan: () => {},
  }

  /** 和 bridge 里那套一模一样：数据类直接写工具目录，kind=js 进待审区 */
  function caps(selfAuthoring: boolean): AssistantCaps {
    return {
      ...capsBase,
      selfAuthoring: () => selfAuthoring,
      listPlugins: () => {
        const dir = pluginsDirOf(dataDir)
        const { manifests, invalid } = loadPluginManifests(dir)
        return {
          dir,
          plugins: manifests.map((m) => toPluginView(m, false)),
          invalid: invalid.map((i) => ({ name: i.name, file: i.file, errors: i.errors })),
        }
      },
      authorTool: async (manifest: Record<string, unknown>, code?: string) =>
        manifest.kind === 'js'
          ? writePendingPlugin(pendingDirOf(dataDir), manifest, code)
          : writePluginManifest(pluginsDirOf(dataDir), manifest),
      removePlugin: async (name: string) => removePluginManifest(pluginsDirOf(dataDir), name),
      authorSkill: async (input: { name: string; description: string; body: string }) =>
        writeAuthoredSkill({ skillsDir: path.join(dataDir, 'pi', 'skills'), ...input }),
      capabilityNote: (verb: string) => `${verb}完成。下一次对话会重新装配技能与工具（这场对话的记录不丢）`,
    } as unknown as AssistantCaps
  }

  const call = async (tools: Awaited<ReturnType<typeof buildAssistantTools>>, name: string, params: Record<string, unknown>) => {
    const t = tools.find((x) => x.name === name)
    assert.ok(t, `工具 ${name} 不存在`)
    const r = await (
      t as unknown as {
        execute: (a: string, b: unknown, c: unknown, d: unknown, e: unknown) => Promise<{ content: Array<{ text?: string }>; details: unknown }>
      }
    ).execute('call-1', params, undefined, undefined, {})
    return { text: r.content.map((c) => c.text ?? '').join(' '), details: r.details }
  }

  return {
    dataDir,
    cards,
    caps,
    call,
    pluginsDir: pluginsDirOf(dataDir),
    pendingDir: pendingDirOf(dataDir),
    legacyDir: legacyExtensionsDirOf(dataDir),
    skillsDir: path.join(dataDir, 'pi', 'skills'),
    cleanup: () => rmSync(dataDir, { recursive: true, force: true }),
  }
}

const GOOD_MANIFEST = {
  name: 'echo-word',
  label: '念一个词',
  description: '把传入的词交给本机 echo 程序打印出来，用来验证插件链路',
  kind: 'shell',
  parameters: { type: 'object', properties: { word: { type: 'string', description: '要打印的词' } }, required: ['word'] },
  shell: { argv: [process.execPath, '-e', 'console.log(process.argv[1])', '{{word}}'] },
}

const JS_MANIFEST = {
  name: 'word-count',
  label: '统计字数',
  description: '统计一段文字的字数，用来验证 kind=js 的清单与源码是同一个工具',
  kind: 'js',
  parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
}

const JS_CODE = [
  'module.exports = async function run(params, ctx) {',
  '  return { words: String(params.text || "").trim().split(/\\s+/).length, name: ctx.tool.name }',
  '}',
  '',
].join('\n')

async function main(): Promise<void> {
  console.log('assistant authoring tools（助手自建工具）')

  const f = fixture('allow')

  await it('开关关着时：四个自建工具连注册都没有', async () => {
    const tools = await buildAssistantTools(f.caps(false))
    const names = tools.map((t) => t.name)
    assert.deepEqual(names.slice().sort(), [...ASSISTANT_TOOL_NAMES].sort())
    for (const n of AUTHORING_TOOL_NAMES) assert.ok(!names.includes(n), `${n} 不该存在`)
  })

  await it('开关打开时：四个都注册，且名字表与定义没有漂移', async () => {
    const tools = await buildAssistantTools(f.caps(true))
    const names = tools.map((t) => t.name)
    for (const n of AUTHORING_TOOL_NAMES) assert.ok(names.includes(n), `${n} 缺注册`)
    // buildAssistantTools 里的同步检查会抛错；走到这里就说明白名单和定义同源
    assert.equal(names.length, ASSISTANT_TOOL_NAMES.length + AUTHORING_TOOL_NAMES.length)
  })

  await it('提示词：关着时不提自建工具，免得模型去调不存在的东西', () => {
    for (const n of AUTHORING_TOOL_NAMES) {
      assert.ok(!ASSISTANT_SYSTEM_PROMPT.includes(n), `主提示词里出现了 ${n}`)
    }
    // 打开后追加的那段必须把四个名字都列出来，并且讲清「写完不等于生效」
    for (const n of AUTHORING_TOOL_NAMES) assert.ok(SELF_AUTHORING_PROMPT.includes(n), `${n} 没写进追加段`)
    assert.match(SELF_AUTHORING_PROMPT, /下一次对话/)
    // 只有一份格式：脚本不再单列一条工具，而是同一条工具清单的 kind=js
    assert.match(SELF_AUTHORING_PROMPT, /kind.?js/)
    assert.ok(!SELF_AUTHORING_PROMPT.includes('torra_propose_extension'), '旧的扩展工具不该还留在提示词里')
  })

  const tools = await buildAssistantTools(f.caps(true))

  await it('torra_author_tool：确认过才落盘，并如实说「下一次对话才生效」', async () => {
    const r = await f.call(tools, 'torra_author_tool', { manifest: GOOD_MANIFEST })
    assert.equal(f.cards.length, 1, '少了一张确认卡片')
    assert.equal(f.cards[0].action, 'author_tool')
    assert.match(f.cards[0].detail, /echo-word/, '卡片上得让人看到清单本身')
    assert.ok(existsSync(path.join(f.pluginsDir, 'echo-word.plugin.json')), '清单没落盘')
    assert.match(r.text, /下一次对话/)
    const { manifests } = loadPluginManifests(f.pluginsDir)
    assert.equal(manifests.length, 1)
    assert.equal(manifests[0].confirm, 'always', 'shell 的默认确认策略必须是每次问')
  })

  await it('拒绝时：盘上一点变化都没有', async () => {
    const g = fixture('deny')
    const t = await buildAssistantTools(g.caps(true))
    const before = existsSync(path.join(g.pluginsDir, 'echo-word.plugin.json'))
    const r = await g.call(t, 'torra_author_tool', { manifest: GOOD_MANIFEST })
    assert.equal(before, false)
    assert.ok(!existsSync(path.join(g.pluginsDir, 'echo-word.plugin.json')), '用户拒绝了却还是写了清单')
    assert.match(r.text, /拒绝/)
    g.cleanup()
  })

  await it('非法清单不落盘，原因原样回给模型', async () => {
    const g = fixture('allow')
    const t = await buildAssistantTools(g.caps(true))
    const bad = { ...GOOD_MANIFEST, name: 'bad-tool', shell: { argv: ['{{program}}', 'x'] } }
    const r = await g.call(t, 'torra_author_tool', { manifest: bad })
    assert.match(r.text, /写入失败/)
    assert.match(r.text, /argv\[0\]/, '要把「哪个程序不能由模型定」这条原因带回去')
    assert.ok(!existsSync(path.join(g.pluginsDir, 'bad-tool.plugin.json')))
    g.cleanup()
  })

  await it('torra_list_plugins：有效的和读不出来的都列出来', async () => {
    mkdirSync(f.pluginsDir, { recursive: true })
    writeFileSync(path.join(f.pluginsDir, 'broken.plugin.json'), '{ not json', 'utf-8')
    const r = await f.call(tools, 'torra_list_plugins', {})
    assert.match(r.text, /echo-word/)
    assert.match(r.text, /broken/, '坏清单也要出现在列表里')
    assert.match(r.text, /JSON 解析失败/)
    unlinkSync(path.join(f.pluginsDir, 'broken.plugin.json'))
  })

  await it('torra_author_skill：写出带 frontmatter 的 SKILL.md，同名不覆盖', async () => {
    const r = await f.call(tools, 'torra_author_skill', {
      name: 'Check Plugin',
      description: '验证一个插件是否真的注册进下一次对话',
      body: '## 步骤\n先 torra_list_plugins，再发一条消息看工具列表。',
    })
    assert.match(r.text, /下一次对话/)
    const file = path.join(f.skillsDir, 'Check-Plugin', 'SKILL.md')
    assert.ok(existsSync(file), 'SKILL.md 没落盘')
    const src = readFileSync(file, 'utf-8')
    assert.match(src, /^---\nname: Check-Plugin\n/)
    assert.match(src, /description: "验证一个插件/)
    const again = await f.call(tools, 'torra_author_skill', { name: 'Check Plugin', description: '同名再来一次', body: '正文' })
    assert.match(again.text, /不覆盖|已有/, '同名技能应该被拒绝而不是覆盖')
  })

  await it('torra_remove_plugin：确认过才删那一个文件', async () => {
    const cards = f.cards.length
    const r = await f.call(tools, 'torra_remove_plugin', { name: 'echo-word' })
    assert.equal(f.cards.length, cards + 1)
    assert.equal(f.cards[f.cards.length - 1].action, 'remove_plugin')
    assert.ok(!existsSync(path.join(f.pluginsDir, 'echo-word.plugin.json')))
    assert.match(r.text, /删除|下一次对话/)
  })

  await it('kind=js：卡片上是源码本身，清单和源码一起进待审区，工具目录一点不碰', async () => {
    const r = await f.call(tools, 'torra_author_tool', { manifest: JS_MANIFEST, code: JS_CODE })
    const card = f.cards[f.cards.length - 1]
    assert.equal(card.action, 'propose_extension', '脚本这一步的卡片要单独一档')
    // 审查的依据必须是代码：卡片里要能逐行看到这段源码，而不是「一个统计字数的脚本」这种描述
    assert.ok(card.detail.includes('module.exports'), '卡片里没有源码原文')
    assert.ok(!card.detail.includes('一个统计'), '卡片写成了描述')
    assert.match(card.detail, new RegExp(`源码 ${JS_CODE.split('\n').length} 行`))
    assert.match(card.risk ?? '', /主进程/)
    assert.ok(existsSync(path.join(f.pendingDir, 'word-count.plugin.json')), '清单没进待审区')
    assert.ok(existsSync(path.join(f.pendingDir, 'word-count.js')), '源码没进待审区')
    assert.ok(!existsSync(path.join(f.pluginsDir, 'word-count.plugin.json')), '待审阶段绝不能碰工具目录')
    assert.match(r.text, /现在还不会运行|设置页/)
  })

  await it('kind=js 缺源码：写入失败，待审区一个文件都不留', async () => {
    const g = fixture('allow')
    const t = await buildAssistantTools(g.caps(true))
    const r = await g.call(t, 'torra_author_tool', { manifest: { ...JS_MANIFEST, name: 'no-code' } })
    assert.match(r.text, /写入失败/)
    assert.match(r.text, /源码/)
    assert.deepEqual(listPendingPlugins(g.pendingDir).pending, [])
    g.cleanup()
  })

  await it('待审区读盘：预览就是源码前几行，行数/字节数读得到', () => {
    const { pending, invalid } = listPendingPlugins(f.pendingDir)
    assert.deepEqual(invalid, [])
    assert.equal(pending.length, 1)
    const p = pending[0]
    assert.equal(p.name, 'word-count')
    assert.equal(p.kind, 'js')
    assert.match(p.preview, /module\.exports/, '设置页要能直接看到源码')
    assert.equal(p.lines, JS_CODE.split('\n').length)
    assert.ok(p.bytes > 0)
    assert.equal(p.truncated, false)
    assert.ok(p.codeFile?.endsWith(path.join('pi', 'pending', 'word-count.js')))
  })

  await it('启用 = 清单与源码一起从待审区搬进工具目录；搬完就能装载', () => {
    const r = promotePendingPlugin(f.pendingDir, f.pluginsDir, 'word-count')
    assert.equal(r.ok, true, r.reason)
    assert.ok(existsSync(path.join(f.pluginsDir, 'word-count.plugin.json')))
    assert.ok(existsSync(path.join(f.pluginsDir, 'word-count.js')), '源码没跟着搬，工具会缺一半')
    assert.ok(!existsSync(path.join(f.pendingDir, 'word-count.plugin.json')), '搬完还留在待审区，列表会重复出现同一条')
    const { manifests, invalid } = loadPluginManifests(f.pluginsDir)
    assert.deepEqual(invalid, [])
    const js = manifests.find((m) => m.name === 'word-count')
    assert.ok(js, '启用后应该能装载')
    assert.equal(js.kind, 'js')
    assert.ok(js.codeFile && js.lines! > 0, '装载时要把源码路径与行数补上')
    const again = promotePendingPlugin(f.pendingDir, f.pluginsDir, 'word-count')
    assert.equal(again.ok, false, '同名不许覆盖')
  })

  await it('旧版扩展目录：只报告不再加载，不从这里搬任何东西', () => {
    mkdirSync(f.legacyDir, { recursive: true })
    writeFileSync(path.join(f.legacyDir, 'old-ext.js'), 'export default () => {}\n')
    writeFileSync(path.join(f.legacyDir, 'notes.txt'), 'x')
    const legacy = listLegacyExtensions(f.legacyDir)
    assert.deepEqual(legacy.map((l) => l.name), ['old-ext'], '非 .js 文件不算')
    assert.ok(legacy[0].file.endsWith(path.join('pi', 'extensions', 'old-ext.js')))
    assert.deepEqual(listLegacyExtensions(path.join(f.dataDir, 'not-created')), [], '目录不存在当空，不抛')
  })

  await it('丢弃待审工具：清单与源码一起删，只删那一个', () => {
    writePendingPlugin(f.pendingDir, { ...JS_MANIFEST, name: 'spare' }, 'module.exports = async () => 1\n')
    const r = removePendingPlugin(f.pendingDir, 'spare')
    assert.equal(r.ok, true)
    assert.ok(!existsSync(path.join(f.pendingDir, 'spare.plugin.json')))
    assert.ok(!existsSync(path.join(f.pendingDir, 'spare.js')))
    assert.ok(existsSync(path.join(f.pluginsDir, 'word-count.plugin.json')), '别人的工具不许被顺手删')
    assert.equal(removePendingPlugin(f.pendingDir, 'spare').ok, false, '重复删除要如实说没有')
  })

  await it('名字不合法的写入请求一律拒绝，不落任何文件', () => {
    assert.equal(writePluginManifest(f.pluginsDir, { ...GOOD_MANIFEST, name: '../escape' }).ok, false)
    assert.equal(writePendingPlugin(f.pendingDir, { ...JS_MANIFEST, name: 'a b' }, 'module.exports = async () => 1\n').ok, false)
    assert.ok(!existsSync(path.join(f.pluginsDir, '..', '..', 'escape.plugin.json')))
    assert.ok(!existsSync(path.join(f.pendingDir, 'a b.plugin.json')))
  })

  f.cleanup()
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail > 0) process.exit(1)
}

void main()
