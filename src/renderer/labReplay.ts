/**
 * 研讨屏的回放游标：把这一场倒回第 r 轮，以及倒回时右栏哪几张判断是「刚落下来的」。
 *
 * 三个纯函数，各答一件不同的事：
 *   `replayMaxOf` —— 这一场的数据自己说到第几轮（回放只能到这里）；
 *   `asOfRound` / `asOfBorn` —— 按游标截断一份台账；
 *   `diffRailPoints` —— 游标前进一格，右栏多了哪几条结论。
 *
 * 为什么单独成文件：游标是**数据口径**（第几轮算存在），不是视图坐标（`labView.ts` 管
 * 「这一屏看哪儿」）。这两件事都必须被至少两个组件共用（中央观点视图 / 协作视图 / 右栏），
 * 各自抄一遍就会各答一次「第几轮算到哪」，然后总有一处答错。
 * 与 `stageFlights.ts` 同一条纪律：纯函数，不碰 store、不碰 DOM，离线可测。
 */

/**
 * 回放每格停留多久。
 *
 * 原来是一个死的 1400ms：光飞 1000–1200ms、落点再成形 900ms，于是下一格
 * 正好卡在「刚落地、卡片还没泛完光」的那一刻推进来 —— 上一格被下一格盖掉，
 * 读起来就是一闪而过，看不出演化过程。
 *
 * 现在拆成「一段固定的收尾」+「按这一格的件数加长」：
 *   固定那段 = 光飞完 + 落点成形（1000~1200 + 900），少一秒都会切在半路上；
 *   加长那段 = 这一轮说了几句、落了几条结论、开了几条争议，每件多给一点读的时间。
 * 上限只防「一轮八家同时开口」把一格拖到十秒，不是性能考虑。
 */
export const REPLAY_SETTLE_MS = 2400
export const REPLAY_PER_ITEM_MS = 140
export const REPLAY_MAX_EXTRA_MS = 1200
/**
 * 回放里结论的飞光要等中央那段流程演完再聚。
 *
 * 一格里「模型发言」和「主持确认的结论」是同时到达的，但结论是从发言演化出来的：
 * 四束发言落地要 1100ms，所以右栏的聚光从这一刻之后才开始，不能开头就聚。
 * 这个数同时进 `replayDwellMs`：有结论的那一格留得住「等 + 飞 + 成形」。
 */
export const REPLAY_RAIL_DELAY_MS = 1250
/** 多条结论依次成形，别一下子全砸在同一帧 */
export const REPLAY_RAIL_STAGGER_MS = 320
/** 右栏一束横跨整屏的光 */
export const REPLAY_RAIL_FLIGHT_MS = 1000
/** 判断卡落点成形（cl-form） */
export const REPLAY_RAIL_FORM_MS = 900
/** 尊重 reduced-motion：没有飞行要等，只需要读完新数字 */
export const REPLAY_CALM_MS = 1100
/** 一格里发生的件数：发言 + 新确认的结论 + 新开的争议 */
export interface StepContent {
  said: number
  born: number
  opened: number
}

/**
 * 第 `round` 这一格里发生了哪几件事。
 *
 * 口径与截断口径同源（`asOfRound` / `asOfBorn`）：发言按 `round`，
 * 结论按 `confirmedRound`、争议按 `openedRound`。缺轮次字段的旧条目**不计入**
 * 任何一格 —— 它们本来就不知道自己属于第几轮，算进某一格等于替它编一个。
 */
export function stepContentOf(
  round: number,
  data: {
    utterances: Array<{ round: number }>
    consensus: Array<{ confirmedRound?: number | null }>
    disputes: Array<{ openedRound?: number | null }>
  },
): StepContent {
  return {
    said: data.utterances.filter((u) => u.round === round).length,
    born: data.consensus.filter((c) => c.confirmedRound === round).length,
    opened: data.disputes.filter((d) => d.openedRound === round).length,
  }
}

/**
 * 第 i 张结论的光，相对这一格开始要等多久。
 *
 * 回放的一格里「模型发言」与「主持确认的结论」是同一帧到达的，
 * 但结论是从发言逐步演化出来的：先让中央四束发言落地（约 1100ms），
 * 右栏才一张一张聚过去。实时模式不走这里 —— 真事件本来就有先后。
 */
export function replayRailDelayMs(index: number): number {
  return REPLAY_RAIL_DELAY_MS + Math.max(0, index) * REPLAY_RAIL_STAGGER_MS
}

/** 这一格该停多久。`reduced` 为真时不等飞行，只留读完新数字的时间 */
export function replayDwellMs(content: StepContent, reduced = false): number {
  if (reduced) return REPLAY_CALM_MS
  const items = content.said + content.born + content.opened
  const extra = Math.min(REPLAY_MAX_EXTRA_MS, Math.max(0, items) * REPLAY_PER_ITEM_MS)
  /* 一帧最多放 3 张（diffRailPoints 的 max）；第 3 张成形完，这一格才算演完 */
  const cards = Math.min(3, Math.max(0, content.born))
  const staged = cards > 0
    ? replayRailDelayMs(cards - 1) + REPLAY_RAIL_FLIGHT_MS + REPLAY_RAIL_FORM_MS
    : 0
  return Math.max(REPLAY_SETTLE_MS, staged) + extra
}

/**
 * 回放的上限 = 数据里最远的一轮。
 * 不取「计划轮数」：计划 5 轮、实际跑到 3 轮就收束的场次，回放到 5 会多出两格什么都没有。
 */
export function replayMaxOf(rounds: Iterable<number>): number {
  let max = 0
  for (const r of rounds) if (r > max) max = r
  return max
}

/**
 * 按轮次截断一份带 `round` 的台账（发言）。
 * 游标为 null（不在回放）时**原样返回同一个引用**：调用方拿它当 memo 依赖，
 * 回放结束时若换成一个新数组，整张图会白重排一次。
 */
export function asOfRound<T extends { round: number }>(list: T[], upTo: number | null): T[] {
  if (upTo === null) return list
  return list.filter((x) => x.round <= upTo)
}

/**
 * 按「出生轮次」截断一份台账（共识 / 分歧）：它们的轮次字段可能缺失（旧存档），
 * 也可能为 0（基线那一段）。
 *
 * 缺字段的条目**不因为回放而消失**：它不知道自己在第几轮，把它藏起来等于
 * 凭空删掉一条真结论 —— 回放该做的是「倒回过去」，不是「删掉不认识的」。
 */
export function asOfBorn<T>(list: T[], upTo: number | null, born: (x: T) => number | null): T[] {
  if (upTo === null) return list
  return list.filter((x) => {
    const b = born(x)
    return b === null || b <= upTo
  })
}

/** 右栏一帧的快照：哪一场、游标在哪、当前列着哪几张判断卡（按呈现顺序） */
export interface RailSnap {
  sid: string | null
  replay: number | null
  ids: string[]
}

/**
 * 两帧快照的差 → 该放光的判断卡 id（最多 `max` 条）。
 *
 * 什么时候放光，只有三种口径：
 *   实时（两边游标都是 null）—— 主持刚确认下来的那条结论是新出现的；
 *   走进回放的第一格（null → 1）—— 回放是从「还没有任何一轮」开始的，
 *     R1 这一格带回的结论就是「第 1 轮形成的」；
 *   回放（游标恰好前进一格）—— 那一格把它的结论带回了画面上。
 *
 * 其余一律当换基准，不放光：
 *   第一次拿快照（prev 为 null）、换场次、退出回放（游标变 null）、
 *   手动跳到任意一轮（跨了不止一格）。
 * 那些时刻画面会一次多出好几条结论，逐个放光就是满屏乱飞，等于把「刚落下」演成「全都在落」。
 *
 * 走进回放这一条必须是「一格」，不能归进换基准：多数会话的结论集中在 R1，
 * 若入口静默，整场回放里右栏一束光都不会有 —— 用户看到的就是「回放没有动画」。
 * 这也与真实操作一致：回放是从头演，不是从终局往回翻。
 */
export function diffRailPoints(prev: RailSnap | null, next: RailSnap, max = 3): string[] {
  if (!prev || prev.sid !== next.sid) return []
  const live = prev.replay === null && next.replay === null
  const entered = prev.replay === null && next.replay === 1
  const stepped = prev.replay !== null && next.replay === prev.replay + 1
  if (!live && !entered && !stepped) return []

  /* 走进回放时，上一帧当作「第 0 轮」：一条结论都还没有 */
  const seen = new Set(entered ? [] : prev.ids)
  const out: string[] = []
  for (const id of next.ids) {
    if (seen.has(id)) continue
    out.push(id)
    if (out.length >= max) break
  }
  return out
}
