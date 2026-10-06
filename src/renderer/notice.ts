/**
 * 统一提示层：全应用同一时刻只有一枚提示 chip，住在标题栏中间那段空档里。
 *
 * 为什么不是浮层横幅：提示条曾经是 body-row 的兄弟节点，一出现就把整行往下顶；
 * 改成 fixed 浮层后它又压住了顶部菜单和标签行。原生网页视图永远画在渲染层之上，
 * 任何盖在内容区上沿的提示都可能既看不见又点不着。标题栏的 brand/导航在左、
 * 操作按钮在右，中间本来就是一条 flex 空档 —— 把提示放进流里而不是盖在上面，
 * 谁也不会被遮挡，`.body-row` 也一动不动。
 *
 * 两类提示共用同一个出口：
 * - 一次性（pushNotice）：登录结果、导出完成、刷新结果……带 TTL，新的顶掉旧的；
 * - 常驻（由 App 从状态推导后传进 chip）：暂停、共识停滞、预算封顶……
 *   一次只显示优先级最高的一条，其余靠分页按钮轮看，不做「藏起来」。
 */
import { useSyncExternalStore } from 'react'

export type NoticeTone = 'info' | 'success' | 'warn' | 'danger'

export interface NoticeAction {
  label: string
  run: () => void
}

export interface NoticeItem {
  /** 稳定标识：分页与去重靠它，别用文案当 key */
  key: string
  tone: NoticeTone
  text: string
  /** chip 只有一行，长文案靠悬停看全 */
  hint?: string
  action?: NoticeAction
}

type Transient = NoticeItem

let transient: Transient | null = null
const subs = new Set<() => void>()

function emit() {
  for (const fn of subs) fn()
}

/**
 * 推一条一次性提示。
 * @param ttl 停留时长；传 0 表示常驻到下一条把它顶掉（用于需要用户决策的场景）。
 */
export function pushNotice(
  text: string,
  opts?: { tone?: NoticeTone; hint?: string; action?: NoticeAction; ttl?: number; key?: string },
): void {
  const item: Transient = {
    key: opts?.key ?? `t${Date.now()}`,
    tone: opts?.tone ?? 'info',
    text,
    hint: opts?.hint ?? text,
    action: opts?.action,
  }
  transient = item
  emit()
  const ttl = opts?.ttl ?? 4200
  if (ttl <= 0) return
  setTimeout(() => {
    // 只收自己：等待期间若已被新提示顶掉，不该把新的抹了
    if (transient === item) {
      transient = null
      emit()
    }
  }, ttl)
}

/** 收掉当前这条一次性提示（chip 上的 × 与按钮点击后调用） */
export function clearNotice(): void {
  if (!transient) return
  transient = null
  emit()
}

export function useTransientNotice(): NoticeItem | null {
  return useSyncExternalStore(
    (fn) => {
      subs.add(fn)
      return () => subs.delete(fn)
    },
    () => transient,
    () => null,
  )
}
