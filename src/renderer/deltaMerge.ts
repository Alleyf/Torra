/**
 * 流式增量的合并（纯函数）
 *
 * 研讨的三条流（正文 / 思考 / 执行过程）是逐 token 推来的。原样一次一更新有两个
 * 代价：每次都要把整条 utterances 数组重拷一遍（单条回答的复制量随长度平方增长），
 * 而且每次 set 都让整棵 React 树重排 —— 一条 1500 字的中文回答就是 750 次全树渲染。
 * 攒成一批再落，数组只拷一次。
 *
 * 单独成模块是为了能被离线回归直接 require：这里只有类型导入，运行时不牵 store
 * 与 `@shared` 的路径别名（ts-node 的 CommonJS 解析不了别名，那样就只能开 Electron 才验得了）。
 */

import type { UiUtterance } from './store'

/** 一个流式增量在合并窗口内累积的结果 */
export interface DeltaBatchItem {
  utteranceId: string
  agentId: string
  content?: string
  thinking?: string
  steps?: string
}

/** 合并所需的最小状态面 */
export interface DeltaState {
  utterances: UiUtterance[]
  round: number
}

/**
 * 把一批增量落成一次数组更新。
 *
 * 三条流各写各的字段：这批没带的字段保持原值，不能因为合并就抹掉已流出的思考或步骤。
 */
export function appendDeltas(s: DeltaState, batch: readonly DeltaBatchItem[]): { utterances: UiUtterance[] } {
  const next = [...s.utterances]
  for (const b of batch) {
    const idx = next.findIndex((u) => u.id === b.utteranceId)
    if (idx < 0) {
      // 推理模型常先流思考、agent 站常先流步骤，正文可能还没建出来
      next.push({
        id: b.utteranceId,
        round: s.round,
        agentId: b.agentId,
        content: b.content ?? '',
        ...(b.thinking !== undefined ? { thinking: b.thinking } : {}),
        ...(b.steps !== undefined ? { steps: b.steps } : {}),
        streaming: true,
        absent: false,
        targets: [],
      })
      continue
    }
    const u = next[idx]!
    next[idx] = {
      ...u,
      ...(b.content ? { content: u.content + b.content } : {}),
      ...(b.thinking ? { thinking: (u.thinking ?? '') + b.thinking } : {}),
      ...(b.steps ? { steps: (u.steps ?? '') + b.steps } : {}),
    }
  }
  return { utterances: next }
}
