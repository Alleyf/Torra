/**
 * 回合记账与磁盘会话读写的离线回归（不联网、不花 token、不需要 Electron）
 *
 * 覆盖两块只能靠假数据验证的逻辑：
 *
 * 1. recorder.ts 是纯函数 —— TTFT 只认第一个正文字符、token 按整轮累加、
 *    工具按「工具/技能/MCP」分组、历史恢复出来的统计不许编一个首字延迟。
 *    这些一旦只能起 app 来验，就没人验。
 * 2. sessions.ts 读的是 pi 写在盘上的 JSONL。这里手写一份最小会话文件来验
 *    「重启后还能翻到上次对话」，同时把删除的三道闸门（目录外、非 .jsonl、
 *    正在用的那场）钉死 —— 删除是唯一不可逆的动作。
 *
 * 运行：npm run test:assistant-stats
 */

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AssistantTurnStats } from '../src/shared/assistant'
import { TurnRecorder, classifyTool, entriesToMessages, messagesToHistory } from '../src/main/assistant/recorder'
import { assistantSessionDir } from '../src/main/assistant/session'
import { deleteSession, listSessions, readSessionHistory } from '../src/main/assistant/sessions'

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

/**
 * 手写一份最小会话文件（pi 的 JSONL 格式）。
 *
 * 三个必须对上的地方：首行是 type=session 的 header，且 `cwd` 要等于传给
 * SessionManager.list 的 cwd —— 非默认会话目录时 pi 会按 cwd 过滤，不匹配就列不出来；
 * 每条 entry 都要有 id，且 parentId 串成一条链，getBranch() 是从最后一个 id 往回走的。
 */
function writeSession(dir: string, name: string, cwd: string): string {
  const root = assistantSessionDir(dir)
  mkdirSync(root, { recursive: true })
  const t0 = Date.parse('2026-01-02T03:04:05.000Z')
  const entries: unknown[] = [
    { type: 'session', version: 3, id: 'sess-1', timestamp: new Date(t0).toISOString(), cwd },
    {
      id: 'e1',
      parentId: undefined,
      type: 'message',
      timestamp: new Date(t0).toISOString(),
      message: { role: 'user', content: '帮我看看 deepseek 的选择器', timestamp: t0 },
    },
    {
      id: 'e2',
      parentId: 'e1',
      type: 'message',
      timestamp: new Date(t0 + 900).toISOString(),
      message: {
        role: 'assistant',
        timestamp: t0 + 900,
        responseModel: 'glm-4.6',
        usage: { input: 1200, output: 180, cacheRead: 900, cacheWrite: 0, cost: { total: 0.0021 } },
        content: [
          { type: 'thinking', thinking: '先看模型清单，再读页面事实。' },
          { type: 'toolCall', id: 'call_1', name: 'torra_list_models', arguments: {} },
        ],
      },
    },
    {
      id: 'e3',
      parentId: 'e2',
      type: 'message',
      timestamp: new Date(t0 + 1400).toISOString(),
      message: {
        role: 'toolResult',
        toolCallId: 'call_1',
        isError: false,
        content: [{ type: 'text', text: '共 2 个模型：GLM、DeepSeek 网页' }],
      },
    },
    {
      id: 'e4',
      parentId: 'e3',
      type: 'message',
      timestamp: new Date(t0 + 2600).toISOString(),
      message: {
        role: 'assistant',
        timestamp: t0 + 2600,
        responseModel: 'glm-4.6',
        usage: { input: 1500, output: 320, cacheRead: 0, cacheWrite: 200, cost: { total: 0.0019 } },
        content: [{ type: 'text', text: '选择器指向 div.message 是可行的。' }],
      },
    },
  ]
  const file = path.join(root, name)
  writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  return file
}

async function main(): Promise<void> {
  console.log('\n回合记账 + 磁盘会话回归\n' + '='.repeat(44))

  // ---- 分组 ----

  await it('工具分组：torra_ 前缀算内置工具，MCP 与技能各归各', () => {
    assert.equal(classifyTool('torra_run_doctor'), 'tool')
    assert.equal(classifyTool('bash'), 'tool')
    assert.equal(classifyTool('mcp__github__create_issue'), 'mcp')
    assert.equal(classifyTool('server__mcp__tool'), 'mcp')
    assert.equal(classifyTool('skill_pdf'), 'skill')
    assert.equal(classifyTool('use_skill'), 'skill')
  })

  await it('通用读文件工具只要在读某个技能的 SKILL.md，就算一次技能调用', () => {
    assert.equal(classifyTool('read', { path: 'C:/users/x/.claude/skills/pdf/SKILL.md' }), 'skill')
    assert.equal(classifyTool('read', { path: 'C:/skills/pdf/SKILL.md' }), 'skill')
    assert.equal(classifyTool('read', { path: 'src/main/index.ts' }), 'tool')
    assert.equal(classifyTool('read'), 'tool')
  })

  // ---- 实时回合 ----

  await it('TTFT 只认第一个正文字符，后续增量不把它往后推', () => {
    const r = new TurnRecorder('GLM')
    r.begin(1_000)
    r.noteText(1_800)
    r.noteText(2_400)
    r.noteModel('glm-4.6')
    const s = r.finish({}, 3_000)
    assert.equal(s.ttftMs, 800)
    assert.equal(s.ms, 2_000)
    assert.equal(s.model, 'glm-4.6')
  })

  await it('一轮里多条消息的 token 与费用按整轮累加', () => {
    const r = new TurnRecorder()
    r.begin(0)
    r.noteModel('glm-4.6')
    r.addUsage({ input: 1200, output: 180, cacheRead: 900, cost: { total: 0.0021 } })
    r.addUsage({ input: 1500, output: 320, cacheWrite: 200, cost: 0.0019 })
    const s = r.finish({ contextTokens: 5000, contextWindow: 128000 }, 4200)
    assert.equal(s.input, 2700)
    assert.equal(s.output, 500)
    assert.equal(s.cacheRead, 900)
    assert.equal(s.cacheWrite, 200)
    assert.equal(s.totalTokens, 4300)
    assert.ok(Math.abs(s.cost - 0.004) < 1e-9, `cost=${s.cost}`)
    assert.equal(s.contextTokens, 5000)
    assert.equal(s.contextWindow, 128000)
    // 模型名要从响应里取；取不到就退回展示名，界面不会出现空标签
    assert.equal(new TurnRecorder('GLM').finish({}, 1).model, 'GLM')
  })

  await it('没说过话的一轮不给 ttftMs：界面显示「—」而不是 0 毫秒', () => {
    const s = new TurnRecorder('GLM').finish({}, 1_500)
    assert.equal('ttftMs' in s, false)
    assert.equal(s.ttftMs, undefined)
    assert.equal(s.model, 'GLM')
  })

  await it('步数按来源分组累计，供界面写「3 步 · 技能 1 · MCP 1」', () => {
    const r = new TurnRecorder('GLM')
    r.begin(0)
    r.noteTool('tool')
    r.noteTool('tool')
    r.noteTool('skill')
    r.noteTool('mcp')
    const s = r.finish({}, 1)
    assert.equal(s.steps, 4)
    assert.deepEqual(s.byGroup, { tool: 2, skill: 1, mcp: 1 })
  })

  await it('begin 会清空上一轮的账，两轮之间不会互相污染', () => {
    const r = new TurnRecorder('GLM')
    r.begin(0)
    r.noteText(10)
    r.addUsage({ input: 100 })
    r.noteTool('tool')
    r.begin(1_000)
    const s = r.finish({}, 1_200)
    assert.equal(s.ttftMs, undefined)
    assert.deepEqual([s.input, s.steps], [0, 0])
  })

  // ---- 历史还原 ----

  await it('磁盘消息还原成分类历史：思考/工具步/正文分开，统计挂在正文上', () => {
    const messages = [
      { role: 'user', content: '帮我看看 deepseek 的选择器', timestamp: 1_000 },
      {
        role: 'assistant',
        timestamp: 1_900,
        responseModel: 'glm-4.6',
        usage: { input: 1200, output: 180, cacheRead: 900, cost: { total: 0.0021 } },
        content: [
          { type: 'thinking', thinking: '先看清单' },
          { type: 'toolCall', id: 'call_1', name: 'torra_list_models', arguments: {} },
        ],
      },
      {
        role: 'toolResult',
        toolCallId: 'call_1',
        isError: false,
        content: [{ type: 'text', text: '共 2 个模型' }],
      },
      {
        role: 'assistant',
        timestamp: 3_600,
        responseModel: 'glm-4.6',
        usage: { input: 1500, output: 320, cacheWrite: 200, cost: { total: 0.0019 } },
        content: [{ type: 'text', text: '可行' }],
      },
    ]
    const h = messagesToHistory(messages)
    assert.deepEqual(h.map((x) => x.role), ['user', 'thinking', 'tool', 'assistant'])
    assert.equal(h[2].toolName, 'torra_list_models')
    assert.equal(h[2].group, 'tool')
    assert.equal(h[2].ok, true, 'toolResult 要回填到对应那一步')
    assert.equal(h[2].excerpt, '共 2 个模型')
    const stats = h[3].stats as AssistantTurnStats
    assert.equal(stats.totalTokens, 1200 + 180 + 900 + 1500 + 320 + 200)
    assert.equal(stats.steps, 1)
    assert.equal(stats.model, 'glm-4.6')
    assert.ok(Math.abs(stats.cost - 0.004) < 1e-9, `cost=${stats.cost}`)
    assert.equal(stats.ttftMs, undefined, '首字延迟只有直播时观测得到，不许编')
  })

  await it('失败的那一步给出 ok:false，正文之外的轮次也能挂上统计', () => {
    const h = messagesToHistory([
      { role: 'user', content: '跑一下体检' },
      {
        role: 'assistant',
        timestamp: 5_000,
        usage: { input: 10, output: 2, cost: { total: 0.001 } },
        content: [{ type: 'toolCall', id: 'a', name: 'skill_pdf', arguments: {} }],
      },
      { role: 'toolResult', toolCallId: 'a', isError: true, content: 'boom' },
    ])
    assert.equal(h.length, 2)
    assert.equal(h[1].ok, false)
    assert.equal(h[1].group, 'skill')
    assert.equal(h[1].excerpt, 'boom')
    assert.equal((h[1].stats as AssistantTurnStats).steps, 1)
  })

  await it('没有内容的消息不产出条目，也不会留下半截的历史', () => {
    assert.deepEqual(messagesToHistory([{ role: 'user', content: [] }]), [])
    assert.deepEqual(messagesToHistory([]), [])
  })

  await it('entriesToMessages 只留 message 条目，模型切换/压缩条目不参与还原', () => {
    const msgs = entriesToMessages([
      { type: 'session', id: 's' },
      { type: 'message', message: { role: 'user', content: 'hi' } },
      { type: 'model_change', id: 'm', model: 'glm-4.6' },
      { type: 'compaction', id: 'c' },
      { type: 'message', message: undefined },
    ])
    assert.equal(msgs.length, 1)
  })

  // ---- 磁盘会话列表 / 删除 ----

  await it('列出盘上的历史会话，字段够界面用', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'torra-stats-'))
    const file = writeSession(dir, '2026-01-02T03-04-05-000Z_sess-1.jsonl', dir)
    const list = await listSessions(dir)
    assert.equal(list.length, 1)
    assert.equal(list[0]?.id, 'sess-1')
    assert.equal(list[0]?.path, path.resolve(file))
    assert.equal(list[0]?.current, false)
    assert.equal(list[0]?.messageCount, 4)
    assert.match(list[0]?.firstMessage ?? '', /deepseek/)
    assert.equal(list[0]?.modified > 0, true)
  })

  await it('会话没建立时也能从盘上还原历史，且带着统计', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'torra-stats-'))
    const file = writeSession(dir, 'a.jsonl', dir)
    const h = await readSessionHistory(dir, file)
    assert.deepEqual(h.map((x) => x.role), ['user', 'thinking', 'tool', 'assistant'])
    assert.equal((h[3].stats as AssistantTurnStats).totalTokens > 0, true)
  })

  await it('当前那场的标记只跟着真正在用的文件', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'torra-stats-'))
    const file = writeSession(dir, 'b.jsonl', dir)
    const list = await listSessions(dir, file)
    assert.equal(list[0]?.current, true)
    const other = await listSessions(dir, path.join(assistantSessionDir(dir), '缺失.jsonl'))
    assert.equal(other[0]?.current, false)
  })

  await it('旧版按作用域分子目录存的会话会被提上来，历史列表不丢', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'torra-stats-'))
    const scoped = path.join(assistantSessionDir(dir), 'scope-old')
    mkdirSync(scoped, { recursive: true })
    const inside = path.join(scoped, 'old.jsonl')
    writeSession(dir, 'fresh.jsonl', dir)
    const head = readFileSync(path.join(assistantSessionDir(dir), 'fresh.jsonl'), 'utf8')
    writeFileSync(inside, head.replace('sess-1', 'sess-old'), 'utf8')
    const list = await listSessions(dir)
    assert.equal(list.length, 2)
    assert.equal(readdirSync(assistantSessionDir(dir)).includes('scope-old'), false, '空的作用域目录要清掉')
  })

  await it('删除只允许助手目录里的 .jsonl，越界一律拒绝', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'torra-stats-'))
    const file = writeSession(dir, 'c.jsonl', dir)
    const outside = path.join(dir, 'other.jsonl')
    writeFileSync(outside, '{}\n', 'utf8')
    assert.equal((await deleteSession(dir, outside)).ok, false)
    assert.equal((await deleteSession(dir, path.join(assistantSessionDir(dir), 'note.txt'))).ok, false)
    assert.equal((await deleteSession(dir, file, file)).ok, false, '正在用的那场不能直接删')
    assert.equal(readdirSync(assistantSessionDir(dir)).includes('c.jsonl'), true)
    assert.equal((await deleteSession(dir, file)).ok, true)
    assert.equal(readdirSync(assistantSessionDir(dir)).includes('c.jsonl'), false)
  })

  console.log(`${'-'.repeat(44)}\n${pass} passed, ${fail} failed\n`)
  if (fail > 0) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
