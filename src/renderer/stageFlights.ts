/**
 * 研讨屏的「飞光」事件 → 计划。
 *
 * 这里只做一件事：把两份快照的差算成几束光。真正的飞行、曲线、停帧、
 * 降级都在 `lancerLight.ts` —— 全项目只有那一套，这里不重画一遍。
 *
 * 三条纪律：
 *
 * 1. **光只跟着真实事件走**。三种来源，别的一个都不加：
 *    某家说完一条发言（它落进「观点提取」）、流水线某一段从「还没开始」
 *    变成「在跑 / 已完」、主持小结开始跑（它冲的是「共识发现」）。
 *    为了画面好看补一条「观点汇聚」之类的光，就是拿动画撒谎。
 * 2. **一次事件一束光**。快照里带着 id，同一件事重渲十次也只飞一次；
 *    事件 id 稳定，跨会话重放时不会串。
 * 3. **基线不放光**。第一次拿到快照、或切会话重读历史时，prev 为 null，
 *    这时只记基线 —— 否则一进研讨屏就是满屏光，等于把历史重播一遍。
 */

export interface SaidLine {
  /** 发言 id，作为事件 id 的一部分 */
  id: string
  agentId: string
}

export interface StageSnap {
  /** 场次 id：换场次时上一帧的快照不能拿来比差 */
  sid: string | null
  /**
   * 回放游标：null = 看现在，数字 = 倒回第 r 轮。
   * 没有它，走进回放的第一格（null → 1）会被当成普通换帧：那一格明明把 R1 的
   * 六条发言带回了画面，却因为它们是「旧数据」一束光都不放 —— 回放前半段全是静止的。
   */
  replay: number | null
  /** 已经说完的发言（有正文、非缺席、非人工） */
  said: SaidLine[]
  /** 四段流水线的 tone：pending / on / done */
  tones: string[]
  /** 主持小结的 startedAt；null = 没在跑 */
  mod: number | null
}

/** 一束待发的光：只带语义，不带坐标 —— 坐标由调用方按当时的 DOM 量 */
export interface StageFlight {
  eventId: string
  fromId: string
  toId: string
  /** model = 车道飞向阶段卡；stage = 阶段之间；mod = 主持小结飞向共识 */
  kind: 'model' | 'stage' | 'mod'
  /** 颜色口径：model 用那家模型的品牌色，其余用阶段语义色 */
  tone: 'model' | 'accent' | 'ok'
  agentId?: string
  /** 目标阶段下标（0-3） */
  stage: number
  /** 起点阶段下标；-1 表示起点是汇流口，不是某张卡 */
  fromStage: number
}

export const TRUNK = -1

/**
 * 两帧快照的差。
 *
 * `max` 是每帧最多放几束：一帧里同时冒出七八条发言是常事（并行作答），
 * 全放出去会糊成一片，而且真正要看的「谁落到哪」反而看不清。
 */
export function diffStage(prev: StageSnap | null, next: StageSnap, max = 4): StageFlight[] {
  // 没基线、或换了场次，都只当「第一次看到」：不放光，只记账
  if (!prev || prev.sid !== next.sid) return []

  /*
   * 走进回放的第一格（null → 1）算一次真事件，不算换基准：回放是从
   * 「还没有任何一轮」开始的，R1 这一格把六条发言带回画面就是它们落地。
   * 多数会话的发现集中在 R1，不这么算的话整场回放前半段就是一张静止图。
   * 其余方向仍静默：退出回放（→ null）画面只是变多，跨轮手动跳也不是「刚发生」。
   */
  const entered = prev.replay === null && next.replay === 1
  const leftOrJumped =
    !entered &&
    ((prev.replay !== null && next.replay === null) ||
      (prev.replay === null && next.replay !== null && next.replay !== 1) ||
      (prev.replay !== null && next.replay !== null && next.replay !== prev.replay + 1))
  if (leftOrJumped) return []
  /* 走进回放时上一帧当作「第 0 轮」：没有发言、四段都还没开始、主持没在跑 */
  const base: StageSnap = entered
    ? { sid: prev.sid, replay: prev.replay, said: [], tones: [], mod: null }
    : prev
  const out: StageFlight[] = []
  const seen = new Set(base.said.map((s) => s.id))

  for (const s of next.said) {
    if (out.length >= max) break
    if (seen.has(s.id)) continue
    out.push({
      eventId: `say:${s.id}`,
      fromId: `model:${s.agentId}`,
      toId: 'stage:0',
      kind: 'model',
      tone: 'model',
      agentId: s.agentId,
      stage: 0,
      fromStage: TRUNK,
    })
  }

  /*
   * 主持小结开跑 = 共识那一段真的开始了。这条光不是装饰：它交代
   * 「刚才那几十秒的黑箱」在冲哪一格。重试换一个 startedAt 就是新的一次；
   * 结束（回到 null）不是「开始」，不放光。
   *
   * 它和「第 3 格 pending → on」说的是同一件事，所以先算它，再让阶段那一支
   * 跳过同一格 —— 两束光打到同一个落点，看起来就是闪了两下。
   */
  const modRun = next.mod !== null && base.mod !== next.mod

  for (let i = 0; i < next.tones.length; i++) {
    const was = base.tones[i] ?? 'pending'
    const now = next.tones[i] ?? 'pending'
    // pending→on、pending→done、on→done 都是真事件；原地不动和退回 pending 不是
    if (now === was || now === 'pending') continue
    if (modRun && i === 2) continue
    if (out.length >= max) break
    out.push({
      eventId: `stage:${i}:${now}`,
      fromId: i === 0 ? 'trunk' : `stage:${i - 1}`,
      toId: `stage:${i}`,
      kind: 'stage',
      tone: now === 'done' ? 'ok' : 'accent',
      stage: i,
      fromStage: i === 0 ? TRUNK : i - 1,
    })
  }

  if (modRun && out.length < max) {
    out.push({
      eventId: `mod:${next.mod}`,
      fromId: 'moderator',
      toId: 'stage:2',
      kind: 'mod',
      tone: 'accent',
      stage: 2,
      fromStage: TRUNK,
    })
  }

  return out
}
