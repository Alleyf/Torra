/**
 * 外观媒体的渲染层状态。
 *
 * 与 theme.ts 同一个形状：权威值在主进程（它持有文件与协议），这里只做
 * 「缓存一份 + 让界面订阅」。区别是主题冷启动有 preload 同步写好的 data-theme
 * 兜底，而背景/启动动画必须等一次 IPC —— 所以初值是「没设过」，
 * 问到之前不画任何媒体层，避免用一张错的图开场。
 */
import { useSyncExternalStore } from 'react'
import {
  APPEARANCE_VIEW_EMPTY,
  type AppearanceView,
  type MediaSlot,
} from '@shared/appearance'

let view: AppearanceView = APPEARANCE_VIEW_EMPTY

const subscribers = new Set<() => void>()

function notify(): void {
  for (const fn of subscribers) fn()
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

function replace(next: AppearanceView): void {
  // 引用变了就通知：调用方都是整份替换，不做深比较
  view = next
  notify()
}

export function useAppearance(): AppearanceView {
  return useSyncExternalStore(subscribe, () => view)
}

export function appearanceSnapshot(): AppearanceView {
  return view
}

/** 挂载时问一次权威值；主进程若已清空/文件丢失，这里拿到的是 null 而不是一条坏地址 */
export async function initAppearance(): Promise<void> {
  try {
    const r = await window.torra.appearanceGet()
    if (r?.view) replace(r.view)
  } catch {
    /* 问不到就保持空：没有背景比有一块打不开的黑屏好 */
  }
}

/**
 * 挑一个文件 → 收进数据目录。
 *
 * 两步是分开的 IPC：对话框由主进程弹，落盘是纯文件操作。渲染层只把它们串起来，
 * 所以「用户取消」与「文件不能用」在这里是两个不同的结果（前者不是错误）。
 */
export async function pickAppearanceMedia(slot: MediaSlot): Promise<{ ok: boolean; reason?: string }> {
  const picked = await window.torra.appearancePick(slot)
  if (!picked?.ok || !picked.path) return { ok: false }
  const r = await window.torra.appearanceSet(slot, picked.path)
  if (r?.view) replace(r.view)
  return { ok: r?.ok === true, reason: r?.reason }
}

export async function clearAppearanceMedia(slot: MediaSlot): Promise<void> {
  const r = await window.torra.appearanceClear(slot)
  if (r?.view) replace(r.view)
}

/** 遮罩浓度：先改本地（滑块要跟手），回执到了再以主进程为准 */
export async function setAppearanceDim(dim: number): Promise<void> {
  if (view.background) {
    view = { ...view, background: { ...view.background, dim } }
    notify()
  }
  const r = await window.torra.appearanceDim(dim)
  if (r?.view) replace(r.view)
}
