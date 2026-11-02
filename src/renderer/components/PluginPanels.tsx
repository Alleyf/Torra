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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { clearHandoff, handoffFor, onHandoff } from '../handoff'

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

/**
 * 只有声明了 panel 且已启用的插件才进导航；其余留在设置页的列表里。
 *
 * 整份清单也一并交出去：导航只要「已启用且有面板的」，但别处（比如「把结论落进
 * 研究工作台」那一下）得知道插件到底有没有启用 —— 没启用时说清楚缺什么，
 * 而不是替用户悄悄打开。
 */
export function usePluginPanels(): { panels: PluginView[]; plugins: PluginView[]; loaded: boolean } {
  const [list, setList] = useState<PluginListResult | null>(null)
  useEffect(() => {
    const refresh = () => {
      void window.torra.pluginsList().then(setList, () => setList(null))
    }
    refresh()
    // 设置页启停/安装插件后，导航与面板必须跟着变
    window.addEventListener('torra:plugins-changed', refresh)
    // 主进程推的那条是权威来源：启用/停用不只发生在设置页里，
    // 主进程也会因为权限清单漂移自动停用插件 —— 那时设置页没有动作可发，
    // 清单要是不跟着变，界面就会一直说「插件还没启用」，而插件其实已经开了。
    const off = window.torra.on('plugins:changed', refresh)
    return () => {
      window.removeEventListener('torra:plugins-changed', refresh)
      off()
    }
  }, [])
  const panels = useMemo(
    () => (list?.plugins ?? []).filter((p) => p.enabled && p.panel),
    [list],
  )
  return { panels, plugins: list?.plugins ?? [], loaded: list !== null }
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
  /** 帧文档真的 onLoad 了：交接稿只在这之后才送得进去 */
  const [frameReady, setFrameReady] = useState(false)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const pluginId = plugin?.id

  useEffect(() => {
    if (!pluginId) return
    let alive = true
    setPanel(null)
    setError(null)
    setLoading(true)
    // 换插件就是换了一份文档：旧帧的「已就绪」不能算数
    setFrameReady(false)
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

  /**
   * 交接稿的送达：帧没起来之前先存着，起来了再送。
   *
   * 送完就清掉这份待送的稿子 —— 不然来回切标签页会把同一场结论再灌一遍主线。
   */
  const deliverHandoff = useCallback(() => {
    if (!pluginId || !frameReady) return
    const payload = handoffFor(pluginId)
    if (!payload) return
    const frame = frameRef.current?.contentWindow
    if (!frame) return
    frame.postMessage({ type: 'torra:handoff', payload }, '*')
    clearHandoff(pluginId)
  }, [pluginId, frameReady])

  /* 有新的交接稿进来了：这个插件的帧就绪就送 */
  useEffect(
    () =>
      onHandoff((staged) => {
        if (staged.pluginId === pluginId) deliverHandoff()
      }),
    [pluginId, deliverHandoff],
  )

  /* 帧刚刚就绪：把之前存着的那份补送出去 */
  useEffect(() => {
    if (frameReady) deliverHandoff()
  }, [frameReady, deliverHandoff])

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
            // 文档已经能收消息了：之前存着的交接稿现在送得进去
            setFrameReady(true)
          }}
        />
      )}
    </>
  )
}
