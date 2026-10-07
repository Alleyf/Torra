/**
 * 主持小结的真实流式往返：用本地 SSE 假端点驱动真通道（不联网、不花 token、不开 Electron）
 *
 * 为什么要这一层：主持的「等」是整场讨论里最长的一段，上一版它什么也不显示 ——
 * 根因不在界面，在通道：非流式 fetch + 固定 180 秒死等。改动落在四处
 * （通道流式化、编排器节流进度、store 起表与收口、跟随条走秒），
 * 每一处单独看都对，串起来才算「看得见」。所以这里把真代码接满一遍：
 * 真通道 → 真编排器 → 真 store reducer → 真组件 SSR，四段都不替换。
 *
 * 覆盖的分支都是会被静默吞掉的那几条：网关不认流式参数、要了流式却回整包、
 * 半路掐断不再吐字节、限流不许退整包、钥匙串缺 key 不该等到超时。
 *
 * 运行：npm run test:moderator-live
 * 产物：output/moderator-live.html（跟随条在中途与重试两种等待下的真实markup）
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import Module from 'node:module'
import path from 'node:path'
import {
  createModeratorChannel,
  MODERATOR_CEILING_MS,
  MODERATOR_IDLE_MS,
  MODERATOR_MAX_TOKENS,
} from '../src/main/agents/moderator-channel'
import type { OrchestratorEvent } from '../src/main/orchestrator/orchestrator'
import { Orchestrator } from '../src/main/orchestrator/orchestrator'
import type { Agent, SendResult } from '../src/main/agents/agent'
import type { ApiConfig, SessionConfig, Topic, TurnContext } from '../src/shared/types'
import type { DiagEvent } from '../src/shared/diagnostics'

const ROOT = path.resolve(__dirname, '..')

let pass = 0
let fail = 0
async function it(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`)
  } catch (e) {
    fail++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`)
    console.log(`         ${(e as Error).message.split('\n').slice(0, 3).join('\n         ')}`)
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
const median = (xs: number[]): number => {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  return Math.round(s[Math.floor(s.length / 2)] ?? 0)
}

// ---------------------------------------------------------------------------
// 本地假端点：一个路由按当前 responder 决定回什么，帧与帧之间真的睡
// ---------------------------------------------------------------------------

type Reply =
  | { kind: 'sse'; frames: string[]; gapMs?: number; close?: boolean }
  | { kind: 'sse-loop'; frame: string; gapMs: number }
  | { kind: 'whole'; body: string; ctype?: string; delayMs?: number }
  | { kind: 'status'; code: number; text: string }
  /** 收下请求但什么都不回，连响应头都不给 —— 复现代理挂住 */
  | { kind: 'silent' }

const serverState = {
  requests: [] as Array<{ body: any; stream: boolean }>,
  open: new Set<http.ServerResponse>(),
  responder: (_body: any, _stream: boolean): Reply => ({ kind: 'status', code: 500, text: 'unset' }),
}

const srv = http.createServer((req, res) => {
  const chunks: Buffer[] = []
  req.on('data', (c: Buffer) => chunks.push(c))
  req.on('end', () => {
    let body: any = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      /* 非 JSON 请求：按空体处理 */
    }
    const stream = body?.stream === true
    serverState.requests.push({ body, stream })
    const reply = serverState.responder(body, stream)
    void (async () => {
      if (reply.kind === 'status') {
        res.writeHead(reply.code, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end(reply.text)
        return
      }
      if (reply.kind === 'silent') {
        // 连接留着，一个字节都不写：复现代点收下请求却永远不返回
        serverState.open.add(res)
        res.on('close', () => serverState.open.delete(res))
        return
      }
      if (reply.kind === 'whole') {
        if (reply.delayMs) await sleep(reply.delayMs)
        res.writeHead(200, { 'Content-Type': `${reply.ctype ?? 'application/json'}; charset=utf-8` })
        res.end(reply.body)
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache' })
      serverState.open.add(res)
      let stopped = false
      res.on('close', () => {
        stopped = true
        serverState.open.delete(res)
      })
      if (reply.kind === 'sse-loop') {
        while (!stopped) {
          await sleep(reply.gapMs)
          if (stopped) break
          res.write(reply.frame)
        }
        return
      }
      for (const f of reply.frames) {
        await sleep(reply.gapMs ?? 5)
        if (stopped) return
        res.write(f)
      }
      if (reply.close !== false) res.end()
    })()
  })
})

const openaiFrame = (o: unknown) => `data: ${JSON.stringify(o)}\n\n`
const oaiDelta = (t: string) => openaiFrame({ choices: [{ index: 0, delta: { content: t } }] })
const OAI_TAIL = [
  openaiFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
  openaiFrame({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 240 } }),
  'data: [DONE]\n\n',
]
const anthDelta = (t: string) =>
  openaiFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: t } })

function oaiWhole(text: string, p = 90, c = 180): string {
  return JSON.stringify({ choices: [{ message: { content: text } }], usage: { prompt_tokens: p, completion_tokens: c } })
}

/** 单价 1/3（USD per 1M）下的期望费用，用来核对通道没有自己再抄一份算法 */
const EXPECTED_STREAM_COST = Math.round(((120 / 1e6) * 1 + (240 / 1e6) * 3) * 1e6) / 1e6

function apiConfig(protocol: 'openai' | 'anthropic'): ApiConfig {
  return {
    baseUrl: `http://127.0.0.1:${(srv.address() as any).port}/mock`,
    model: 'mock-moderator',
    apiKeyRef: 'k_mock',
    protocol,
    pricePerMTokIn: 1,
    pricePerMTokOut: 3,
    maxContextTokens: 32_000,
  }
}

const logs: DiagEvent[] = []
function channel(over?: { protocol?: 'openai' | 'anthropic'; secret?: string | null; idleMs?: number; ceilingMs?: number }) {
  return createModeratorChannel({
    id: 'm_mock',
    api: apiConfig(over?.protocol ?? 'openai'),
    getSecret: () => (over?.secret === null ? null : (over?.secret ?? 'sk-test')),
    log: (e) => logs.push(e),
    idleMs: over?.idleMs,
    ceilingMs: over?.ceilingMs,
  })
}

// ---------------------------------------------------------------------------
// 真通道：把主持小结的 JSON 一段段吐回去
// ---------------------------------------------------------------------------

const DIGEST = JSON.stringify({
  consensus_points: [
    { claim: '采用方案X', support: ['m_a'], confidence: 0.8, weight: 0.7, evidence_ref: ['utt_a1'] },
    { claim: '按服务分级设置告警阈值', support: ['m_b'], confidence: 0.7, weight: 0.6, evidence_ref: ['utt_b1'] },
  ],
  open_disputes: [],
  summary: '两轮下来成本与监控顺序的分歧被拆开，方案X 的成本优势有了可核对口径。',
  score_dimensions: { agreement: 60, overlap: 35, trend: 55 },
  score: 52,
  next_round_order: ['m_a', 'm_b'],
  agent_quality: [],
  explored_directions: [],
  callout: null,
})

function splitFrames(text: string, size: number, proto: 'openai' | 'anthropic'): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) {
    out.push(proto === 'anthropic' ? anthDelta(text.slice(i, i + size)) : oaiDelta(text.slice(i, i + size)))
  }
  return out
}

function digestHead(proto: 'openai' | 'anthropic'): string[] {
  return proto === 'anthropic'
    ? [
        openaiFrame({ type: 'message_start', message: { id: 'x', usage: { input_tokens: 120, output_tokens: 0 } } }),
        openaiFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
      ]
    : []
}
function digestTail(proto: 'openai' | 'anthropic'): string[] {
  return proto === 'anthropic'
    ? [
        openaiFrame({ type: 'content_block_stop', index: 0 }),
        openaiFrame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 240 } }),
        openaiFrame({ type: 'message_stop' }),
      ]
    : OAI_TAIL
}

// ---------------------------------------------------------------------------
// 真编排器 + 真 store + 真组件
// ---------------------------------------------------------------------------

const usage = { promptTokens: 20, completionTokens: 30, costUsd: 0.002 }
const A_TEXT: Record<number, string> = {
  1: '第1轮甲：应当采用方案X，理由是落地成本更低，迁移只需两周，回滚路径也清楚。',
  2: '第2轮甲：坚持方案X，成本差在迁移周期上；监控分级可以作为并行项。',
}
const B_TEXT: Record<number, string> = {
  1: '第1轮乙：先补齐监控与回滚预案，否则任何方案上线都是风险。',
  2: '第2轮乙：仍然主张先做监控分级，方案X 的成本优势要能核对才成立。',
}

function makeAgent(id: string, name: string, text: Record<number, string>): Agent {
  return {
    id,
    displayName: name,
    transport: 'api',
    color: '#888888',
    status: 'ready',
    send: async (ctx: TurnContext, onDelta): Promise<SendResult> => {
      await sleep(3)
      const content = text[ctx.round] ?? `第${ctx.round}轮${name}：维持此前判断。`
      onDelta(content.slice(0, 8))
      return { content, usage, targets: [] }
    },
    healthCheck: async () => true,
    dispose: () => undefined,
  }
}

const topic: Topic = {
  id: 'topic_live',
  title: '上线该选方案X还是先补监控',
  background: '现网只有一次发布窗口。',
  strategy: 'roundtable',
  attachments: [],
  createdAt: 1,
}

const liveConfig: SessionConfig = {
  maxRounds: 2,
  participantIds: ['m_a', 'm_b'],
  moderatorId: 'm_mock',
  budgetLimitUsd: 5,
  baseline: false,
  baselineCompare: false,
  verifyPass: 'off',
  timeBudgetMs: 120_000,
}

/** 主持小结的内容由假端点决定；编排器提示词里列出的发言 id 照原样抄进 evidence_ref */
function digestFor(userPrompt: string): string {
  const ids = [...userPrompt.matchAll(/^-\s+\[([^\]]+)\]/gm)].map((m) => m[1] as string)
  const real = ids.filter((x) => !x.startsWith('cp_'))
  const obj = JSON.parse(DIGEST) as Record<string, unknown>
  obj.consensus_points = (obj.consensus_points as Array<Record<string, unknown>>).map((p, i) => ({
    ...p,
    evidence_ref: [real[i % Math.max(1, real.length)] ?? 'utt_a1'],
  }))
  return JSON.stringify(obj)
}

type Store = {
  getState: () => any
  setState: (p: any) => void
  getInitialState: () => any
}
type Bundled = {
  useStore: Store
  applyAll: (events: any[]) => void
  renderLive: (patch: any, clockAt: number) => string
}

let bundled: Bundled | null = null

/**
 * 把渲染层打进内存再执行。zustand v5 的 SSR 走 getInitialState，
 * setState 的种子读不到，所以临时垫一个 react：useSyncExternalStore 直接取 getSnapshot。
 * 垫片必须在被 alias 之前落到磁盘上，别名指向它自己会成循环引用。
 */
function loadRenderer(): Bundled {
  if (bundled) return bundled
  const esbuild = require('esbuild') as typeof import('esbuild')
  const shimDir = path.join(ROOT, 'scripts', `.tmp-react-${process.pid}`)
  fs.mkdirSync(shimDir, { recursive: true })
  try {
    fs.writeFileSync(
      path.join(shimDir, 'index.js'),
      `const React = eval('require')('react')\nmodule.exports = Object.assign({}, React, { useSyncExternalStore: (_s, get) => get() })\n`,
    )
    fs.writeFileSync(path.join(shimDir, 'jsx-runtime.js'), `module.exports = eval('require')('react/jsx-runtime')\n`)
    fs.writeFileSync(path.join(shimDir, 'jsx-dev-runtime.js'), `module.exports = eval('require')('react/jsx-dev-runtime')\n`)
    const entry = [
      "import React from 'react'",
      "import { renderToStaticMarkup } from 'react-dom/server'",
      "import { TopicEvolution } from './src/renderer/components/TopicEvolution'",
      "import { useStore } from './src/renderer/store'",
      'export { useStore }',
      'export function applyAll(events) { for (const e of events) useStore.getState().applyEvent(e) }',
      'export function renderLive(patch, clockAt) {',
      '  useStore.setState(patch)',
      '  const real = Date.now',
      '  Date.now = () => clockAt',
      '  try {',
      '    return renderToStaticMarkup(React.createElement(TopicEvolution, { models: [], onFollowup: () => {}, onDuel: () => {} }))',
      '  } finally { Date.now = real }',
      '}',
    ].join('\n')
    const result = esbuild.buildSync({
      stdin: { contents: entry, loader: 'ts', resolveDir: ROOT, sourcefile: 'moderator-live-harness.tsx' },
      bundle: true,
      format: 'cjs',
      platform: 'node',
      target: 'es2022',
      jsx: 'automatic',
      write: false,
      absWorkingDir: ROOT,
      logLevel: 'silent',
      alias: { '@shared': path.join(ROOT, 'src', 'shared'), react: shimDir },
    })
    const code = result.outputFiles[0]?.text
    if (!code) throw new Error('esbuild 没有产出代码')
    const m = new Module('moderator-live-harness')
    m.filename = path.join(ROOT, 'scripts', 'moderator-live-harness.js')
    m.paths = (Module as any)._nodeModulePaths(path.dirname(m.filename))
    ;(m as any)._compile(code, m.filename)
    bundled = m.exports as unknown as Bundled
    return bundled
  } finally {
    fs.rmSync(shimDir, { recursive: true, force: true })
  }
}

function pageShell(body: string, caption: string): string {
  const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles.css'), 'utf8')
  return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>主持进度 · ${caption}</title>
<style>${css}
/* 脱机预览没有 Electron 窗口：给一个真实宽度，否则 flex 容器塌成一列看不出口径 */
body { margin:0; padding:16px; background:var(--bg-0); color-scheme:dark }
.frame { width:1180px; max-width:100%; height:760px; overflow:auto; border:1px solid var(--border); border-radius:12px; background:var(--bg-1) }
.cap { font:12px var(--font-mono); color:var(--text-3); margin:0 0 8px }</style>
</head><body><p class="cap">${caption}</p><div class="frame">${body}</div></body></html>`
}

async function main() {
  console.log('\n主持小结的真实流式往返（本地 SSE 假端点）')
  console.log('='.repeat(46))

  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r))
  const port = (srv.address() as any).port as number
  console.log(`  本地端点 http://127.0.0.1:${port}/mock（不联网，帧间真睡）`)

  // ---- 通道层 --------------------------------------------------------------

  await it('OpenAI 流式：逐段拼出整份 JSON，用量按端点回传的 usage 计费', async () => {
    serverState.requests.length = 0
    logs.length = 0
    serverState.responder = () => ({
      kind: 'sse',
      frames: [...digestHead('openai'), ...splitFrames(DIGEST, 24, 'openai'), ...digestTail('openai')],
      gapMs: 2,
    })
    const pieces: string[] = []
    const r = await channel().send({ system: '只输出 JSON', user: '请小结' }, (c) => pieces.push(c))
    assert.equal(r.content, DIGEST, '拼回来的正文与流里发的不一致')
    assert.equal(pieces.join(''), DIGEST, 'onDelta 漏了段落或顺序错了')
    assert.equal(r.usage.promptTokens, 120)
    assert.equal(r.usage.completionTokens, 240, 'openai 的 completion_tokens 在末尾帧，要收到')
    assert.equal(r.usage.costUsd, EXPECTED_STREAM_COST, '费用没按通道自己的单价算')
    assert.equal(logs.filter((l) => l.stage === 'http' && l.ok).length, 1, '成功该留一条带耗时的日志')
    assert.equal(new Set(logs.map((l) => l.layer)).size, 1, 'layer 该由通道自己补齐')
  })

  await it('Anthropic 流式：delta.text 与 message_start/message_delta 的用量都要收到', async () => {
    serverState.responder = () => ({
      kind: 'sse',
      frames: [...digestHead('anthropic'), ...splitFrames(DIGEST, 24, 'anthropic'), ...digestTail('anthropic')],
      gapMs: 2,
    })
    const r = await channel({ protocol: 'anthropic' }).send({ system: '只输出 JSON', user: '请小结' })
    assert.equal(r.content, DIGEST)
    assert.equal(r.usage.promptTokens, 120, 'anthropic 的输入量在 message_start 里')
    assert.equal(r.usage.completionTokens, 240, 'anthropic 的输出量在 message_delta 里')
  })

  await it('半路不再吐字节：空闲到点就断成一条能上屏的原因', async () => {
    serverState.responder = () => ({
      kind: 'sse',
      frames: [...digestHead('openai'), oaiDelta('{"con')],
      gapMs: 2,
      close: false,
    })
    const t0 = Date.now()
    await assert.rejects(
      channel({ idleMs: 1_000 }).send({ system: 's', user: 'u' }),
      /主持模型 1 秒没有任何返回/,
      '空闲闸门没生效',
    )
    const ms = Date.now() - t0
    assert.ok(ms >= 900 && ms < 3_000, `断流时机不对：${ms}ms`)
  })

  await it('一直吐字但收不了场：总时长封顶照样兜底', async () => {
    serverState.responder = () => ({ kind: 'sse-loop', frame: oaiDelta('x'), gapMs: 30 })
    await assert.rejects(
      channel({ idleMs: 60_000, ceilingMs: 1_000 }).send({ system: 's', user: 'u' }),
      /主持模型请求超过 1 秒/,
      '有字节就不该无限等',
    )
  })

  await it('网关不认流式参数：4xx 退一次整包，这一轮没有逐字进度但主持照出', async () => {
    serverState.requests.length = 0
    logs.length = 0
    serverState.responder = (_b, stream) =>
      stream ? { kind: 'status', code: 400, text: 'stream not supported' } : { kind: 'whole', body: oaiWhole(DIGEST, 60, 120) }
    const r = await channel().send({ system: 's', user: 'u' })
    assert.equal(r.content, DIGEST, '整包退路没拼出正文')
    assert.equal(serverState.requests.length, 2, `该是流式一次 + 整包一次，实际 ${serverState.requests.length}`)
    assert.equal(logs.filter((l) => l.stage === 'stream-fallback').length, 1, '退路要留痕，否则日志里像凭空多了一次往返')
    assert.equal(r.usage.costUsd, Math.round(((60 / 1e6) * 1 + (120 / 1e6) * 3) * 1e6) / 1e6)
  })

  await it('限流不退整包：429 照原样冒泡，交给编排层按失败计次', async () => {
    serverState.requests.length = 0
    serverState.responder = () => ({ kind: 'status', code: 429, text: 'rate limited' })
    await assert.rejects(channel().send({ system: 's', user: 'u' }), /HTTP 429/)
    assert.equal(serverState.requests.length, 1, '429 重发只会更糟')
  })

  await it('要了流式却回整包：慢一点的整包不算断流', async () => {
    // 首字节之前两种回包长得一模一样，闸门只有在确认是事件流之后才有资格计时
    serverState.responder = () => ({ kind: 'whole', body: oaiWhole(DIGEST), delayMs: 250 })
    const r = await channel({ idleMs: 80 }).send({ system: 's', user: 'u' })
    assert.equal(r.content, DIGEST, '整包成功被自己的空闲闸门断了')
  })

  await it('端点连响应头都不给：总时长封顶兜底，不是无限等', async () => {
    serverState.responder = () => ({ kind: 'silent' })
    await assert.rejects(
      channel({ idleMs: 1_000, ceilingMs: 2_000 }).send({ system: 's', user: 'u' }),
      /主持模型请求超过 2 秒/,
    )
  })

  await it('钥匙串没有这条 key：不等网络就报出可操作的错', async () => {
    serverState.requests.length = 0
    logs.length = 0
    await assert.rejects(channel({ secret: null }).send({ system: 's', user: 'u' }), /缺少 API Key/)
    assert.equal(serverState.requests.length, 0, '没有密钥也该先发请求？不该')
    assert.equal(logs.filter((l) => l.stage === 'key-missing').length, 1)
  })

  await it('请求体口径：max_tokens 两条分支都带，stream 只在流式那条', async () => {
    serverState.requests.length = 0
    // 第一次流式被拒 → 触发整包退路，两条分支的请求体才会都落到 requests 里
    let rejectedOnce = false
    serverState.responder = (_b, stream) => {
      if (!stream) return { kind: 'whole', body: oaiWhole(DIGEST) }
      if (!rejectedOnce) {
        rejectedOnce = true
        return { kind: 'status', code: 400, text: 'stream not supported' }
      }
      return {
        kind: 'sse',
        frames: [...digestHead('openai'), ...splitFrames(DIGEST, 40, 'openai'), ...digestTail('openai')],
      }
    }
    await channel().send({ system: 's', user: 'u' })
    const [a, b] = serverState.requests.map((x) => x.body)
    assert.equal(a.max_tokens, MODERATOR_MAX_TOKENS)
    assert.equal(b.max_tokens, MODERATOR_MAX_TOKENS, '整包分支也不能裸跑，否则长小结被端点截断')
    assert.equal(a.stream, true)
    assert.deepEqual(a.stream_options, { include_usage: true }, '不带 include_usage 就拿不到用量，费用永远是 0')
    assert.equal(b.stream, undefined)
    assert.equal(b.stream_options, undefined)
    assert.equal(JSON.stringify(b).includes('stream_options'), false, '整包分支不该带流式字段')
  })

  // ---- 编排器 + store ------------------------------------------------------

  const events: OrchestratorEvent[] = []
  const progressTimeline: Array<{ t: number; round: number; chars: number; firstByteMs: number; tail: string }> = []
  let digestLen = 0

  await it('真通道接进真编排器：小结还没落回来，进度事件就在往外发', async () => {
    serverState.responder = (body) => {
      const user = body.system
        ? String(body.messages?.[0]?.content ?? '')
        : String(body.messages?.[1]?.content ?? '')
      const content = digestFor(user)
      digestLen = content.length
      return {
        kind: 'sse',
        frames: [...digestHead('openai'), ...splitFrames(content, 20, 'openai'), ...digestTail('openai')],
        gapMs: 12,
      }
    }
    const agents = new Map<string, Agent>([
      ['m_a', makeAgent('m_a', '甲模型', A_TEXT)],
      ['m_b', makeAgent('m_b', '乙模型', B_TEXT)],
    ])
    // 主持只建一次：真通道自己不发进度，进度由编排器按 onDelta 节流
    const moderator = channel()
    const orch = new Orchestrator(topic, liveConfig, {
      getAgent: (id) => agents.get(id),
      getModerator: () => moderator,
      nameOf: (id) => agents.get(id)?.displayName,
    })
    const t0 = Date.now()
    orch.on('event', (e: OrchestratorEvent) => {
      events.push(e)
      if (e.type === 'moderator-progress') {
        progressTimeline.push({ t: Date.now() - t0, round: e.round, chars: e.chars, firstByteMs: e.firstByteMs, tail: e.tail })
      }
    })
    await orch.run()
    assert.ok(progressTimeline.length >= 6, `两次小结总共才 ${progressTimeline.length} 条进度，界面等于没有`)
    const gaps = progressTimeline.slice(1).map((p, i) => p.t - progressTimeline[i]!.t)
    const nonNeg = gaps.filter((g) => g >= 0)
    console.log(
      `\n  实测进度事件 ${progressTimeline.length} 条 · 相邻间隔中位 ${median(nonNeg)}ms（节流常量 150ms）· 整份小结 ${digestLen} 字`,
    )
    for (const p of progressTimeline) {
      console.log(`    +${String(p.t).padStart(5)}ms  R${p.round}  首字 ${String(p.firstByteMs).padStart(4)}ms  已收 ${String(p.chars).padStart(4)} 字  …${p.tail.slice(-30)}`)
    }
  })

  await it('进度口径自洽：字数单调、尾巴是原文末尾 220 字内、首字延迟不为负', async () => {
    const round1 = progressTimeline.filter((p) => p.round === 1)
    assert.ok(round1.length >= 3, `一轮小结至少该有 3 条进度，实际 ${round1.length}`)
    let prev = 0
    for (const p of round1) {
      assert.ok(p.chars > prev || p.chars === digestLen, `字数倒退了：${prev} → ${p.chars}`)
      prev = p.chars
      assert.ok(p.firstByteMs >= 0, '首字延迟不能是负数')
      assert.ok(p.tail.length <= 220, `尾巴该被截在 220 字内，实际 ${p.tail.length}`)
    }
    const last = round1[round1.length - 1]!
    assert.ok(last.chars <= digestLen, `进度里的字数超过正文总长：${last.chars} > ${digestLen}`)
    assert.ok(
      progressTimeline.every((p, i) => i === 0 || p.t - progressTimeline[i - 1]!.t >= 100),
      '进度发得太密，会淹掉走秒',
    )
  })

  await it('真 store 收得住这一场事件：进度期间 moderatorLive 有值，出小结后清空', async () => {
    const H = loadRenderer()
    const initial = H.useStore.getInitialState()
    let progressSeen = 0
    let clearedAt = 0
    for (const e of events) {
      H.applyAll([e])
      if (e.type === 'moderator-progress') {
        const live = H.useStore.getState().moderatorLive
        assert.ok(live, `进度事件到了却没起表：R${e.round}`)
        assert.equal(live!.chars, e.chars, 'store 里的字数与事件不一致')
        progressSeen++
      }
      if (e.type === 'moderator') {
        assert.equal(H.useStore.getState().moderatorLive, null, '小结落地后进度条该收，否则一直转圈')
        clearedAt++
      }
    }
    assert.ok(progressSeen >= 6, `store 只收到 ${progressSeen} 条进度`)
    assert.ok(clearedAt >= 1, '该有小结落地事件把进度收掉')
    assert.ok(H.useStore.getState().utterances.length >= 4, '发言没进 store')
    H.useStore.setState(initial)
  })

  await it('跟随条真的画出「已等 / 首字 / 已收 x 字 / 原文尾巴」', async () => {
    const H = loadRenderer()
    const prog = progressTimeline[progressTimeline.length - 1]!
    const startedAt = 1_760_000_000_000
    const html = H.renderLive(
      {
        state: 'MODERATOR_SUMMARY',
        round: 1,
        maxRounds: 2,
        participantIds: ['m_a', 'm_b'],
        moderatorLive: { round: 1, attempt: 1, startedAt, firstByteMs: prog.firstByteMs, chars: prog.chars, tail: prog.tail },
      },
      startedAt + 8_400,
    )
    assert.ok(html.includes('te-hostlive'), '进度行没渲染出来')
    assert.ok(html.includes('小结已等 8.4s'), `走秒不对：${html.match(/小结已等[^<]*/)?.[0] ?? '无'}`)
    assert.ok(html.includes(`已收 ${prog.chars} 字`), '已收字数没上屏')
    assert.ok(html.includes('te-live-tail'), '原文尾巴没上屏')
    const fb = prog.firstByteMs < 1_000 ? `${Math.round(prog.firstByteMs)}ms` : `${(prog.firstByteMs / 1000).toFixed(1)}s`
    assert.ok(html.includes(`首字 ${fb}`), `首字延迟显示不对：${html.match(/首字 [^ ·]*/)?.[0] ?? '无'}`)
    assert.ok(!html.includes('首字 0.0s'), '亚秒延迟被四舍五入成 0.0s，看着像坏了')
    fs.mkdirSync(path.join(ROOT, 'output'), { recursive: true })
    fs.writeFileSync(path.join(ROOT, 'output', 'moderator-live.html'), pageShell(html, `主持小结进行中 · 已等 8.4s · 已收 ${prog.chars} 字`), 'utf8')
  })

  await it('还没等到首字：如实写「还在等首字…」，不编一个字数出来', async () => {
    const H = loadRenderer()
    const startedAt = 1_760_000_000_000
    const html = H.renderLive(
      { state: 'MODERATOR_RETRY', round: 2, moderatorLive: { round: 2, attempt: 2, startedAt, firstByteMs: 0, chars: 0, tail: '' } },
      startedAt + 47_000,
    )
    assert.ok(html.includes('还在等首字'), '没收到字节却报字数')
    assert.ok(html.includes('小结已等 47s'), `超过 1 分钟该换成分秒：${html.match(/小结已等[^<]*/)?.[0] ?? '无'}`)
    assert.ok(html.includes('第 2 次'), '重试次数要看得见，否则用户以为卡在同一轮')
    assert.ok(!html.includes('已收'), '一条字节都没收到就不该报已收')
    const first = H.renderLive(
      { state: 'MODERATOR_SUMMARY', round: 1, moderatorLive: { round: 1, attempt: 1, startedAt, firstByteMs: 1_200, chars: 88, tail: DIGEST.slice(0, 88) } },
      startedAt + 3_000,
    )
    assert.ok(first.includes('首字 1.2s'), `超过一秒该换成秒：${first.match(/首字 [^ ·]*/)?.[0] ?? '无'}`)
    fs.appendFileSync(
      path.join(ROOT, 'output', 'moderator-live.html'),
      pageShell(first, '主持小结刚开始 · 首字 1.2s · 已收 88 字'),
      'utf8',
    )
  })

  await it('⏱ 只属于发言批次：总时长那格不再被主持等待冒充', async () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'components', 'TopicEvolution.tsx'), 'utf8')
    assert.match(src, /发言 \$\{fmtSpan\(stat\.ms\)}/)
    assert.doesNotMatch(src, /⏱ \$\{fmtSpan\(stat\.ms\)\}/, '⏱ 那格还挂着被主持污染的耗时')
  })

  await it('常量没有被抄成第二份：界面与通道共用同一组闸门值', async () => {
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8')
    assert.ok(MODERATOR_IDLE_MS === 45_000 && MODERATOR_CEILING_MS === 180_000)
    assert.match(main, /createModeratorChannel\(/, '主进程没接真通道')
    assert.doesNotMatch(main, /MODERATOR_IDLE_MS/, '主进程里还留着一份常量')
  })

  // ---- 收尾 ----------------------------------------------------------------

  for (const res of serverState.open) res.end()
  await new Promise<void>((r) => srv.close(() => r()))
  console.log(`\n通过 ${pass} · 失败 ${fail}`)
  console.log(`  预览：${path.join(ROOT, 'output', 'moderator-live.html')}`)
  if (fail) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
