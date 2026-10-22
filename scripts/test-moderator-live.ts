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
  const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'styles.css'), 'utf8').replace(/\r\n/g, '\n')
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
    /*
     * 这一条有两个界，作用完全不同。下界 900 是真判据：闸门不许在 idleMs 之前掐（提前断流
     * 就是把还在吐字的连接误杀了）。上界原来到 3000，量的却是 runner 的手速而不是任何产品行为 ——
     * 服务器这侧 `close: false` 永远不关，闸门若失效这个 await 就永久挂起，上界的职责只是
     * 「把永久挂起变成一条会红的断言」。所以它要比 idleMs 大一个数量级、又比 infinity 小：
     * 15 秒既不会被机器快慢碰到，也照样兜得住那个真正的失效模式。
     */
    assert.ok(ms >= 900 && ms < 15_000, `断流时机不对：${ms}ms`)
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
  const progressTimeline: Array<{ t: number; round: number; attempt: number; chars: number; firstByteMs: number; tail: string }> = []
  let digestLen = 0
  /** 跑完的那台编排器留着，给「重载后接回」那条用例当真实快照来源 */
  let finishedOrch: Orchestrator | null = null

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
        progressTimeline.push({
          t: Date.now() - t0,
          round: e.round,
          attempt: e.attempt,
          chars: e.chars,
          firstByteMs: e.firstByteMs,
          tail: e.tail,
        })
      }
    })
    await orch.run()
    finishedOrch = orch
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
    /*
     * 节流的下界是「同一次小结里不许发得太密」，不是「整场任意相邻两条都隔得开」——
     * 编排器每起一次小结（每个 attempt）都把 lastEmit 归零，好让界面立刻出现第一条进度
     * （orchestrator.ts 的 onDelta：`let lastEmit = 0` 写在 attempt 体内）。于是轮次边界上
     * 必然可能出现一对间隔近于 0 的进度：上一场的最后一条与新一场的第一条。
     * 之前这条断言拿整条时间线一起 `every`，等于把产品故意留的缝判成缺陷；它能不能过，
     * 只看上一场最后一条落在那 150ms 窗口的哪个位置 —— 机器快慢一改结论就翻。
     * v0.5.0 那条红的 run 就是它：`进度发得太密，会淹掉走秒`（Annotations 实测，非推测）。
     * 分组判据按 (round, attempt)，一次断言都不多；违规时把到底是哪一段、隔了多少毫秒报出来。
     */
    const breaches: string[] = []
    for (let i = 1; i < progressTimeline.length; i += 1) {
      const cur = progressTimeline[i]!
      const prevEvent = progressTimeline[i - 1]!
      if (cur.round === prevEvent.round && cur.attempt === prevEvent.attempt && cur.t - prevEvent.t < 100) {
        breaches.push(`R${cur.round} 第 ${cur.attempt} 次：相邻两条只隔 ${cur.t - prevEvent.t}ms`)
      }
    }
    assert.ok(breaches.length === 0, `同一次小结里进度发得太密，会淹掉走秒：${breaches.join('；')}`)
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

  await it('渲染层重载后能靠 session:state 快照接回这一场', async () => {
    /*
     * 现场故障的第二半：事件是单向推送、不重播，渲染层一旦重载 store 就是空的，
     * 用户看到「0/N 已返回」加一张空画布，和「内容真的没了」分不出来。
     * 这里按主进程 session:state 的口径组一份真快照（同一个编排器、同一批 getter），
     * 把 store 清回初始态冒充刚重载，再走 adoptLiveSession 重建。
     */
    const H = loadRenderer()
    const orch = finishedOrch
    assert.ok(orch, '上一场没跑完，这条用例没有素材')
    const snap = {
      live: true,
      state: orch!.getState(),
      round: orch!.getRound(),
      spentUsd: orch!.getSpentUsd(),
      budgetLimited: orch!.isBudgetLimited(),
      moderatorUnavailable: orch!.isModeratorUnavailable(),
      topic,
      config: liveConfig,
      utterances: orch!.getAllUtterances(),
      consensus: orch!.getConsensusPoints(),
      disputes: orch!.getDisputes(),
      scores: orch!.getScores(),
      questions: orch!.getQuestions(),
      interventions: orch!.getInterventions(),
      moderatorAudit: orch!.getModeratorAudit(),
      stageTimings: orch!.getStageTimings(),
    }
    // 先把事件流喂满，拿到「没重载」时界面本该有的样子，作为对照
    H.applyAll(events)
    const before = H.useStore.getState()
    assert.ok(before.utterances.length >= 4, '前提不成立：事件流没把发言送进 store')
    H.useStore.setState(H.useStore.getInitialState())
    assert.equal(H.useStore.getState().utterances.length, 0, '没先清空就不算重载')

    H.useStore.getState().adoptLiveSession(snap)
    const after = H.useStore.getState()
    assert.equal(after.utterances.length, before.utterances.length, '重载后发言条数对不上')
    assert.equal(
      after.utterances.filter((u: { absent?: boolean }) => !u.absent).length,
      before.utterances.filter((u: { absent?: boolean }) => !u.absent).length,
      '真实发言被快照弄丢了 —— 画布空掉正是这个形状',
    )
    assert.deepEqual(
      after.consensus.map((c: { claim: string }) => c.claim),
      before.consensus.map((c: { claim: string }) => c.claim),
      '共识没接回来',
    )
    assert.deepEqual(after.scores.map((s: { score: number }) => s.score), before.scores.map((s: { score: number }) => s.score), '分数曲线没接回来')
    /**
     * state 取主进程给的当前值，不硬塞成 DONE：这一场跑完了所以两者恰好都是收工态，
     * 但进行中重载时把它写成收工态就是把还在跑的场次画成已结束，所以钉的是"等于快照"。
     */
    assert.equal(after.state, snap.state, 'state 被快照改写：进行中的场次不该被画成收工态')
    assert.equal(after.moderatorLive, null, '重载是一次新的接手，上一次的等待提示不该续上')
    assert.equal(after.participantIds.length, liveConfig.participantIds.length, '参会者没接回来：0/N 就是这么来的')

    // live:false（冷启动）不许把残留拽回来
    H.useStore.setState(H.useStore.getInitialState())
    H.useStore.getState().adoptLiveSession({ live: false } as never)
    assert.equal(H.useStore.getState().utterances.length, 0, '没有进行中的场次时不该重建任何东西')

    /**
     * 已结束的那场同样不许自动接回，而闸门在主进程那侧：跑完之后编排器并不会置空，
     * state 还停在 REPORT_GEN（终态由 done 事件表达），所以照「手里有没有编排器」判
     * live 会把「看完报告顺手刷新一下界面」误判成进行中场次。钉一下它走的是
     * discussionActive —— 再看那场有正路：历史 → 回放。
     */
    const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
    const handler = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('session:state'"))
    assert.ok(
      /if \(!orchestrator \|\| !currentTopic \|\| !currentConfig \|\| !discussionActive\)/.test(handler.slice(0, 900)),
      'session:state 的 live 没按 discussionActive 判：跑完的那场会被当成进行中场次拽回来',
    )
    H.useStore.setState(H.useStore.getInitialState())
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
    const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'components', 'TopicEvolution.tsx'), 'utf8').replace(/\r\n/g, '\n')
    assert.match(src, /发言 \$\{fmtSpan\(stat\.ms\)}/)
    assert.doesNotMatch(src, /⏱ \$\{fmtSpan\(stat\.ms\)\}/, '⏱ 那格还挂着被主持污染的耗时')
  })

  await it('常量没有被抄成第二份：界面与通道共用同一组闸门值', async () => {
    const main = fs.readFileSync(path.join(ROOT, 'src', 'main', 'index.ts'), 'utf8').replace(/\r\n/g, '\n')
    assert.ok(MODERATOR_IDLE_MS === 45_000 && MODERATOR_CEILING_MS === 180_000)
    assert.match(main, /createModeratorChannel\(/, '主进程没接真通道')
    assert.doesNotMatch(main, /MODERATOR_IDLE_MS/, '主进程里还留着一份常量')
  })

  await it('输出预算够写完一整份小结：4096 实测会把 JSON 切在半路', async () => {
    /*
     * 这条是现场事故换来的：一场 4 模型、议题较宽的第 1 轮，两次尝试分别吐了 553 字与
     * 2969 字就断在半个键名上（`"continues":` / callout 指令中间），流里连 stop_reason 都没有。
     * 截断的 JSON 读不通 → 判非法 → 重打一次仍被同样截断 → 整场 no-moderator 收场。
     * 4096 在真实负载下不够，所以这里把下限钉住，别哪天为了省成本又调回去。
     */
    assert.ok(
      MODERATOR_MAX_TOKENS >= 8_192,
      `主持输出上限 ${MODERATOR_MAX_TOKENS} 偏小：实测 4096 会把长小结切在半路，整场以 no-moderator 收场`,
    )
  })

  await it('小结被输出上限截断：已写完的那部分要被抢救回来，不整份丢弃', async () => {
    serverState.requests.length = 0
    /*
     * 复现现场那一次的形态：写到第二个共识点的 "continues" 就没了。
     * 整份 JSON.parse 必然失败 —— 但第一个共识点已经**完整写完**且合法，
     * 它不该跟着半截内容一起被丢掉。
     */
    const full = JSON.parse(DIGEST) as Record<string, unknown>
    const pts = full.consensus_points as Array<Record<string, unknown>>
    /**
     * 直接拼出被切开的原文：第一条共识完整（含它那个空的 continues），
     * 第二条只写到 evidence_ref，后面的键名悬在那儿没值。
     * 用拼装而不是切片：切片要在 JSON 里找一个子串位置，改一次摘要内容就会失效，
     * 而这里要的就是「明确的、只有第一条完整」这一种形态。
     */
    const truncated = [
      '{',
      '  "consensus_points": [',
      `    ${JSON.stringify({ ...pts[0]!, continues: null })},`,
      `    ${JSON.stringify({ ...pts[1]!, continues: undefined }).replace(/,"continues":undefined/, '')},`,
      '      "continues":',
    ].join('\n')
    serverState.responder = () => ({
      kind: 'sse',
      frames: [...digestHead('openai'), ...splitFrames(truncated, 20, 'openai'), openaiFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })],
      gapMs: 1,
    })

    const agents = new Map<string, Agent>([
      ['m_a', makeAgent('m_a', '甲模型', A_TEXT)],
      ['m_b', makeAgent('m_b', '乙模型', B_TEXT)],
    ])
    const evs: OrchestratorEvent[] = []
    const orch = new Orchestrator(topic, liveConfig, {
      getAgent: (id) => agents.get(id),
      getModerator: () => channel(),
      nameOf: (id) => agents.get(id)?.displayName,
    })
    orch.on('event', (e: OrchestratorEvent) => evs.push(e))
    await orch.run()

    const audit = evs.find((e) => e.type === 'moderator-audit') as Extract<OrchestratorEvent, { type: 'moderator-audit' }> | undefined
    assert.ok(audit, '没有主持审计记录')
    /*
     * 这一份抢救回来的内容**过不了机械校验**：它没有 score_dimensions（模型还没写到）。
     * 所以两次尝试都仍被驳回 —— 这正是要的：抢救只还原已经写出来的内容，
     * 不放宽任何判据。缺三维度分数的小结本来就不该被登记成落点。
     *
     * 要证明的是「抢救确实发生了」，而不是「它被接受了」：
     * 被驳回的那次尝试里，raw 是截断原文，而校验错误里应该出现
     * score_dimensions 缺失 —— 这条错误只可能来自成功解析出的那份抢救结果。
     * 若抢救没发生，errors 会是「主持输出不是合法 JSON」。
     */
    assert.equal(audit.audit.accepted, null, '缺三维度分数的小结不该被登记成落点')
    const rejected = evs.filter((e) => e.type === 'moderator-rejected') as Array<Extract<OrchestratorEvent, { type: 'moderator-rejected' }>>
    assert.ok(rejected.length >= 1)
    assert.equal(
      rejected[0]!.errors.join('；').includes('score_dimensions') || audit.audit.attempts[0]!.validation.errors.join('；').includes('score_dimensions'),
      true,
      '驳回理由说的是「不是合法 JSON」—— 说明抢救根本没发生，完整写出的共识被一起丢了',
    )
  })

  await it('截断正好落在可选字段之后：抢救出的内容本身合法就该被收下', async () => {
    serverState.requests.length = 0
    /**
     * 另一种落法：三维度分数、共识、分歧全都写完了，只有末尾可选字段
     * （callout）写到一半。这时候抢救出来的内容**本该通过**机械校验，
     * 整场就不该再以 no-moderator 收场 —— 用户跑完能拿到共识与分歧。
     */
    // evidence_ref 必须指向**本场真实存在的发言**。id 是编排器运行时生成的，
    // 所以从提示词里抄；否则分不清「抢救失败」与「校验正确地拦下了假引用」。
    serverState.responder = (body) => {
      const user = String(body.messages?.[1]?.content ?? '')
      const realId = user.match(/^-\s+\[(utt_[^\]]+)\]/m)?.[1]
      const pts = (JSON.parse(DIGEST) as { consensus_points: Array<Record<string, unknown>> }).consensus_points.map((p) => ({
        ...p,
        support: ['m_a'],
        evidence_ref: realId ? [realId] : [],
      }))
      const tail = [
        '{',
        '  "consensus_points": [',
        // 元素之间必须有逗号：漏了就不是合法数组，抢救会在第一个元素后就停
        pts.map((p) => `    ${JSON.stringify(p)}`).join(',\n'),
        '  ],',
        '  "open_disputes": [],',
        '  "score_dimensions": {"agreement":60,"overlap":35,"trend":55},',
        '  "score":52,',
        '  "callout":{"target_agent":"m_a","quote_from_agent":"m_a","instruction":"接着说',
      ].join('\n')
      return {
      kind: 'sse',
      frames: [...digestHead('openai'), ...splitFrames(tail, 20, 'openai'), openaiFrame({ choices: [{ index: 0, delta: {}, finish_reason: 'length' }] })],
      gapMs: 1,
      }
    }

    const agents = new Map<string, Agent>([
      ['m_a', makeAgent('m_a', '甲模型', A_TEXT)],
      ['m_b', makeAgent('m_b', '乙模型', B_TEXT)],
    ])
    const evs: OrchestratorEvent[] = []
    const orch = new Orchestrator(topic, liveConfig, {
      getAgent: (id) => agents.get(id),
      getModerator: () => channel(),
      nameOf: (id) => agents.get(id)?.displayName,
    })
    orch.on('event', (e: OrchestratorEvent) => evs.push(e))
    await orch.run()

    const audit = evs.find((e) => e.type === 'moderator-audit') as Extract<OrchestratorEvent, { type: 'moderator-audit' }> | undefined
    assert.ok(audit?.audit.accepted, '抢救出的内容本来合法，却仍被整份丢掉了')
    assert.equal(audit.audit.attempts.length, 1, '不该重打：第一次就靠抢救过了')
    const ok = evs.find((e) => e.type === 'moderator') as Extract<OrchestratorEvent, { type: 'moderator' }> | undefined
    assert.ok(ok, '抢救回来却没走正常的小结落地路径')
    assert.ok(evs.some((e) => e.type === 'done' && e.reason !== 'no-moderator'), '不该再以 no-moderator 收场')
  })

  await it('截断提示要说清是长度问题，别让模型当成格式错误原样重写', async () => {
    serverState.requests.length = 0
    /** 只吐半个对象就断：连一个完整键值对都没有，抢救不出来，只能靠提示语把重试引对方向 */
    serverState.responder = () => ({
      kind: 'sse',
      frames: [...digestHead('openai'), ...splitFrames('{"consensus_points": [{"claim": "半句', 20, 'openai')],
      gapMs: 1,
    })
    const agents = new Map<string, Agent>([
      ['m_a', makeAgent('m_a', '甲模型', A_TEXT)],
      ['m_b', makeAgent('m_b', '乙模型', B_TEXT)],
    ])
    const evs: OrchestratorEvent[] = []
    const orch = new Orchestrator(topic, liveConfig, {
      getAgent: (id) => agents.get(id),
      getModerator: () => channel(),
      nameOf: (id) => agents.get(id)?.displayName,
    })
    orch.on('event', (e: OrchestratorEvent) => evs.push(e))
    await orch.run()

    const rejected = evs.filter((e) => e.type === 'moderator-rejected') as Array<Extract<OrchestratorEvent, { type: 'moderator-rejected' }>>
    assert.ok(rejected.length >= 1, '截断没有落到驳回事件上')
    assert.match(
      rejected[0]!.errors.join('；'),
      /截断/,
      `用户看到的是「${rejected[0]!.errors.join('；')}」—— 没告诉他这是长度上限，重试也救不了`,
    )
    /*
     * 第二次请求的提示里必须带上压缩指令：只说「不是合法 JSON」的话，
     * 模型会当成格式错误，照样写那么长，再被切一次。
     */
    const retry = serverState.requests[1]?.body
    const prompt = String(retry?.messages?.[1]?.content ?? '')
    assert.match(prompt, /长度上限/, '重试提示没告诉模型是被长度上限切掉的')
    assert.match(prompt, /压缩/, '重试提示没给压缩方向')
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
