/**
 * 会话的对外投影（单写多读）
 *
 * 定位很清楚：**投影不是存档**。运行期的唯一真源仍是主进程内存里的编排器，
 * 终态存档仍是 FileSessionStore 的 `<id>.json`。这里只是把「此刻的结论」投影成
 * 两个只读文件，让外部工具/人在讨论还在跑的时候就能读到部分结论：
 *
 * - `<id>.events.jsonl` 追加式事件流（不含逐字流式增量：一秒几十条会淹没读者，
 *   也拖慢重写；每条发言的完整文本在 utterance-done 事件里）
 * - `<id>.digest.md`   结构性节点上整体原子重写（临时文件 + rename），
 *   读者任何时候打开都是完整的一份，不会看到半截
 *
 * 两条纪律：
 * 1. 只有一个写者。所有写操作串到一条 promise 链上，保证行的顺序就是发生顺序；
 *    多写者共享文件在 Windows 上既没有追加原子性也没有可见性保证，不做。
 * 2. 投影写失败绝不能影响讨论本身 —— 记一条失败计数就返回。
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { agreementDimNote, openOnly } from '../../shared/invariants'
import { atomicWrite } from './session-store'
import type {
  ConsensusPoint,
  ConsensusScore,
  OpenDispute,
  SessionConfig,
  Topic,
} from '../../shared/types'

export interface ProjectionMeta {
  sessionId: string
  topic: Topic
  config: SessionConfig
  /** agentId → 展示名。快照里的每一处模型引用都走它：外部读者不认识内部 id */
  names: Record<string, string>
  startedAt: number
}

/** 一次快照需要渲染的全部输入；由调用方（主进程）从编排器现取 */
export interface DigestSnapshot {
  state: string
  round: number
  confirmed: ConsensusPoint[]
  open: OpenDispute[]
  scores: Array<{ round: number; score: ConsensusScore }>
  /** 各模型最近一条发言（含缺席占位）；排序与截断由调用方负责 */
  latest: Array<{ round: number; agent: string; snippet: string; absent?: boolean }>
  spentUsd: number
  finishedReason?: string | null
}

const FINISH_LABEL: Record<string, string> = {
  converged: '结论收敛',
  'max-rounds': '轮次用尽',
  aborted: '用户中止',
  'no-moderator': '主持不可用',
  failed: '异常终止',
}

function esc(s: string): string {
  // 单行化，避免模型输出的换行/表格符号把快照结构打断
  return s.replace(/\s*\n\s*/g, ' ').trim()
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', { hour12: false })
}

export function buildDigestMarkdown(meta: ProjectionMeta, snap: DigestSnapshot): string {
  const { topic, config } = meta
  const last = snap.scores[snap.scores.length - 1]
  const opens = openOnly(snap.open)
  // 快照是给不看代码的人读的，内部 id 一律换成展示名
  const disp = (id: string) => meta.names[id] ?? id
  const lines: string[] = []

  lines.push(`# ${esc(topic.title || '未命名议题')}`)
  lines.push('')
  lines.push(
    `> 会话 \`${meta.sessionId}\` · 状态 ${snap.finishedReason ? FINISH_LABEL[snap.finishedReason] ?? snap.finishedReason : snap.state} · 第 ${snap.round}/${config.maxRounds} 轮 · 已用 $${snap.spentUsd.toFixed(4)}`,
  )
  if (last) {
    const note = agreementDimNote(last.score)
    lines.push(
      `> 共识度 ${last.score.score}（主张 ${last.score.agreement} / 重合 ${last.score.overlap} / 趋势 ${last.score.trend}），阈值 ${config.consensusThreshold}${note ? ` —— ${note}` : ''}`,
    )
  }
  lines.push(
    `> 参与者：${config.participantIds.map(disp).join('、') || '—'} · 主持：${config.moderatorId ? disp(config.moderatorId) : '无'}`,
  )
  lines.push('>')
  lines.push(`> 本文件由 Torra 在每轮结论变化时整体原子重写，供外部只读消费。`)
  lines.push(`> 权威记录是同名会话的存档 JSON；更新时间 ${fmtTime(Date.now())}`)
  lines.push('')

  if (topic.background.trim()) {
    lines.push('## 背景材料')
    lines.push('')
    lines.push(topic.background.trim())
    lines.push('')
  }

  lines.push(`## 已达成共识（${snap.confirmed.length}）`)
  lines.push('')
  if (snap.confirmed.length === 0) {
    lines.push('（暂无）')
  } else {
    snap.confirmed.forEach((c, i) => {
      lines.push(`${i + 1}. **${esc(c.claim)}**`)
      lines.push(`   - 支持：${c.support.map(disp).join('、')} · 第 ${c.confirmedRound} 轮确认 · 置信 ${c.confidence}`)
    })
  }
  lines.push('')

  lines.push(`## 未决分歧（${opens.length}）`)
  lines.push('')
  if (opens.length === 0) {
    lines.push('（暂无）')
  } else {
    opens.forEach((d, i) => {
      lines.push(`${i + 1}. **${esc(d.claim)}**（始于第 ${d.openedRound} 轮）`)
      for (const s of d.sides) lines.push(`   - ${disp(s.agentId)}：${esc(s.argument)}`)
      if (d.lastProgress?.trim()) lines.push(`   - 进展：${esc(d.lastProgress)}`)
    })
  }
  lines.push('')

  lines.push('## 最新发言')
  lines.push('')
  if (snap.latest.length === 0) {
    lines.push('（还没有发言）')
  } else {
    for (const u of snap.latest) {
      lines.push(`- 第 ${u.round} 轮 · ${u.agent}：${u.absent ? `（缺席）${esc(u.snippet)}` : esc(u.snippet)}`)
    }
  }
  lines.push('')

  if (snap.scores.length > 0) {
    lines.push('## 共识度收敛')
    lines.push('')
    lines.push('| 轮次 | 综合 | 主张一致 | 论点重合 | 趋势 |')
    lines.push('| --- | --- | --- | --- | --- |')
    for (const s of snap.scores) {
      lines.push(`| ${s.round} | ${s.score.score} | ${s.score.agreement} | ${s.score.overlap} | ${s.score.trend} |`)
    }
    lines.push('')
  }

  lines.push('---')
  lines.push('')
  lines.push(`逐条发言原文、主持驳回、缺席等过程事件：\`${meta.sessionId}.events.jsonl\`（同目录）`)
  lines.push('')
  return lines.join('\n')
}

export class SessionProjection {
  readonly digestPath: string
  readonly eventsPath: string

  private queue: Promise<void> = Promise.resolve()
  private ready: Promise<void>
  private closed = false
  private writeFailures = 0

  constructor(
    dir: string,
    private readonly meta: ProjectionMeta,
  ) {
    const safe = meta.sessionId.replace(/[^A-Za-z0-9_-]/g, '') || 'session'
    this.digestPath = path.join(dir, `${safe}.digest.md`)
    this.eventsPath = path.join(dir, `${safe}.events.jsonl`)
    this.ready = fs.mkdir(dir, { recursive: true }).then(() => undefined).catch(() => undefined)
  }

  /** 追加一条事件。同步返回，写入排在串行队列尾部。 */
  append(event: { type: string } & Record<string, unknown>): void {
    const line = JSON.stringify({ ts: Date.now(), ...event }) + '\n'
    this.enqueue('append', async () => {
      await this.ready
      await fs.appendFile(this.eventsPath, line, 'utf8')
    })
  }

  /** 整体重写快照（原子 rename，读者不会看到半截文件） */
  writeDigest(snap: DigestSnapshot): void {
    const md = buildDigestMarkdown(this.meta, snap)
    this.enqueue('digest', async () => {
      await this.ready
      await atomicWrite(this.digestPath, md)
    })
  }

  /** 等队列排空（落盘完成），供会话收尾时调用 */
  async flush(): Promise<void> {
    await this.ready
    await this.queue
  }

  async close(): Promise<void> {
    await this.flush()
    this.closed = true
  }

  get failures(): number {
    return this.writeFailures
  }

  private enqueue(kind: string, task: () => Promise<void>): void {
    if (this.closed) return
    this.queue = this.queue
      .then(task)
      .catch((e) => {
        this.writeFailures += 1
        console.warn(`[projection] ${kind} 写入失败（不影响讨论）：${(e as Error).message}`)
      })
  }
}
