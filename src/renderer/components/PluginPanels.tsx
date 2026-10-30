/**
 * 插件面板：入口住在顶部导航栏，面板本身占满内容区。
 *
 * 与「研讨 / 聊天 / 设置」同一排 —— 插件是一条屏，不是一块浮层；抽屉那种做法
 * 在窄窗里会盖住正文，而且换插件得先关当前面板。
 *
 * 文档仍来自主进程拼好的 torra-ui 沙箱帧（无网络、无 Node、独立源）。
 * 这里只做三件事：把 token 转发出去、把面板调用转给主进程、把主题变化通知进去。
 * 不 import 插件代码，也不给 iframe 任何 window.torra 引用 —— 沙箱帧里拿不到。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  AlertTriangle,
  BookOpen,
  ChartLine,
  Database,
  FlaskConical,
  GitBranch,
  Globe,
  Layers,
  ListTree,
  Microscope,
  Puzzle,
  RefreshCw,
  Server,
  Terminal,
} from 'lucide-react'
import type { PluginListResult, PluginPanelResult, PluginView } from '@shared/plugins'

const ICONS: Record<string, typeof Puzzle> = {
  puzzle: Puzzle,
  book: BookOpen,
  server: Server,
  'git-branch': GitBranch,
  microscope: Microscope,
  flask: FlaskConical,
  database: Database,
  terminal: Terminal,
  globe: Globe,
  list: ListTree,
  layers: Layers,
  chart: ChartLine,
}

function iconOf(name: string | undefined) {
  if (!name) return Puzzle
  return ICONS[name] ?? Puzzle
}

/** 只有声明了 panel 且已启用的插件才进导航；其余留在设置页的列表里 */
export function usePluginPanels(): { panels: PluginView[]; loaded: boolean } {
  const [list, setList] = useState<PluginListResult | null>(null)
  useEffect(() => {
    const refresh = () => {
      void window.torra.pluginsList().then(setList, () => setList(null))
    }
    refresh()
    // 设置页启停/安装插件后，导航与面板必须跟着变
    window.addEventListener('torra:plugins-changed', refresh)
    return () => window.removeEventListener('torra:plugins-changed', refresh)
  }, [])
  const panels = useMemo(
    () => (list?.plugins ?? []).filter((p) => p.enabled && p.panel),
    [list],
  )
  return { panels, loaded: list !== null }
}

export function PluginNav({
  panels,
  activeId,
  onOpen,
}: {
  panels: PluginView[]
  /** 当前停在哪个插件屏；null 表示在应用自己的分屏里 */
  activeId: string | null
  onOpen: (id: string) => void
}) {
  if (!panels.length) return null
  return (
    <>
      {/* 分隔线把「应用自己的分屏」和「插件屏」分开：图标同尺寸，没有它就成了一排 */}
      <span className="app-nav-sep" aria-hidden="true" />
      {panels.map((p) => {
        const Icon = iconOf(p.panel?.icon)
        const on = p.id === activeId
        const label = p.panel?.title ?? p.name
        return (
          <button
            key={p.id}
            role="tab"
            aria-selected={on}
            aria-label={label}
            className={`app-nav-item${on ? ' active' : ''}`}
            onClick={() => onOpen(p.id)}
          >
            <Icon size={15} />
            {p.status === 'failed' && <i className="plugin-nav-dot" aria-hidden="true" />}
            <span className="app-tip">{label}</span>
          </button>
        )
      })}
    </>
  )
}

export function PluginPage({
  plugin,
  theme,
}: {
  plugin: PluginView | undefined
  theme: 'light' | 'dark'
}) {
  return (
    <div className="plugin-page" aria-label={plugin?.panel?.title ?? plugin?.name ?? '插件面板'}>
      <PluginFrame plugin={plugin} theme={theme} />
    </div>
  )
}

/**
 * 每个 iframe 各自申请 token、各自监听消息。研究工作台会同时挂两个插件，
 * 若共用 PluginPage 的状态，第二个帧会拿到第一个插件的 token。
 */
function PluginFrame({
  plugin,
  theme,
}: {
  plugin: PluginView | undefined
  theme: 'light' | 'dark'
}) {
  const [panel, setPanel] = useState<PluginPanelResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const pluginId = plugin?.id

  useEffect(() => {
    if (!pluginId) return
    let alive = true
    setPanel(null)
    setError(null)
    setLoading(true)
    window.torra
      .pluginsPanel(pluginId, theme)
      .then((r) => {
        if (!alive) return
        if (r.ok) setPanel(r)
        else setError(r.reason ?? '面板打不开')
      })
      .catch((e: Error) => {
        if (alive) setError(e.message)
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
    // theme 不进依赖：切主题走下面的 postMessage，重新申请会白拿一枚 token 并重载面板
  }, [pluginId])

  /* 面板 → 宿主：只认这一枚 iframe 的来源，token 由主进程校验归属 */
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current?.contentWindow
      if (!frame || event.source !== frame) return
      const data = event.data as { type?: unknown; id?: unknown; token?: unknown; method?: unknown; params?: unknown } | null
      if (!data || data.type !== 'torra:call' || typeof data.method !== 'string') return
      const id = typeof data.id === 'number' ? data.id : 0
      void window.torra
        .pluginsInvoke(String(data.token ?? ''), data.method, data.params)
        .then((r) => {
          frame.postMessage(
            r.ok ? { type: 'torra:reply', id, ok: true, value: r.value } : { type: 'torra:reply', id, ok: false, error: r.error },
            '*',
          )
        })
        .catch((e: Error) => {
          frame.postMessage({ type: 'torra:reply', id, ok: false, error: e.message }, '*')
        })
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [])

  /* 主题切换要跟着进帧里：帧是独立文档，拿不到应用的 CSS 变量 */
  useEffect(() => {
    const frame = frameRef.current?.contentWindow
    if (!frame || !panel?.ok) return
    frame.postMessage({ type: 'torra:theme', theme }, '*')
  }, [theme, panel])

  if (!pluginId) {
    return <div className="plugin-state">插件已停用或卸载。</div>
  }

  return (
    <>
      {loading && (
        <div className="plugin-state">
          <RefreshCw size={13} className="spin" /> 正在启动插件…
        </div>
      )}
      {!loading && error && (
        <div className="plugin-state bad">
          <AlertTriangle size={13} /> {error}
        </div>
      )}
      {!loading && !error && panel?.url && (
        <iframe
          ref={frameRef}
          className="plugin-frame"
          title={panel.title ?? '插件面板'}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          src={panel.url}
          onLoad={() => {
            frameRef.current?.contentWindow?.postMessage({ type: 'torra:theme', theme }, '*')
          }}
        />
      )}
    </>
  )
}
