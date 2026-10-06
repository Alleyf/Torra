/**
 * 主题状态（渲染进程）
 *
 * 真正的来源是主进程：它持有偏好文件、nativeTheme 与系统切换事件。
 * 这里只做两件事 —— 把解析出的明暗写进 <html data-theme>，以及让 UI 订阅它。
 * 冷启动那一帧由 preload 提前写好 data-theme，所以这里接手时不会看到闪白。
 */
import { useSyncExternalStore } from 'react'
import { DEFAULT_THEME_MODE, isThemeMode, type ThemeMode, type ThemeResolved } from '@shared/theme'

let mode: ThemeMode = DEFAULT_THEME_MODE

/**
 * 初值优先用 preload 写好的 data-theme。
 * 属性还不在（preload 正在等 <html> 出现）时退回它问到的明暗，
 * 免得把「来不及写」误当成「用户就在黑夜」，导致白天模式开场先黑一下。
 */
function initialResolved(): ThemeResolved {
  const attr = document.documentElement.dataset.theme
  if (attr === 'light' || attr === 'dark') return attr
  return window.torra?.bootTheme?.() === 'light' ? 'light' : 'dark'
}

let resolved: ThemeResolved = initialResolved()

const subscribers = new Set<() => void>()

function notify(): void {
  for (const fn of subscribers) fn()
}

function subscribe(fn: () => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

export function applyResolved(next: ThemeResolved): void {
  if (resolved === next) return
  resolved = next
  document.documentElement.dataset.theme = next
  notify()
}

/** 用户点了就立刻变色，不等 IPC 回来；失败再按主进程的结果纠正 */
export async function chooseTheme(next: ThemeMode): Promise<ThemeMode> {
  mode = next
  if (next !== 'system') applyResolved(next)
  notify()
  const r = await window.torra.setTheme(next)
  if (isThemeMode(r.mode)) mode = r.mode
  if (r.resolved) applyResolved(r.resolved)
  notify()
  return mode
}

export function toggleTheme(): void {
  void chooseTheme(resolved === 'dark' ? 'light' : 'dark')
}

/** 挂载时向主进程要权威值，并订阅系统深色的后续变化；返回取消订阅 */
export function initTheme(): () => void {
  // 无条件补写一次：万一 preload 没写成，CSS 会停在默认的白天，而状态却认为是黑夜
  document.documentElement.dataset.theme = resolved
  void window.torra.getTheme().then((t) => {
    if (isThemeMode(t.mode)) mode = t.mode
    applyResolved(t.resolved)
    notify()
  })
  return window.torra.on('theme:resolved', (payload) => {
    applyResolved(payload === 'light' ? 'light' : 'dark')
  })
}

export function useThemeMode(): ThemeMode {
  return useSyncExternalStore(subscribe, () => mode)
}

export function useResolvedTheme(): ThemeResolved {
  return useSyncExternalStore(subscribe, () => resolved)
}
