/**
 * 目录：把「接一家新的」从填表改成点选。
 *
 * 为什么不再让用户手填 command 与 args：填错一个字符就接不上，填对了但没装
 * 还是接不上 —— 而这两种「接不上」各有一句人话，那句话得由知道这一家的人来写。
 * 所以启动方式写死在目录里，用户的动作只有一个字：接。
 *
 * 一条铁律写在最显眼的地方：Torra 不替用户装任何东西。
 * 每一张卡先说清「本机有没有装」，没有就把装它的那一行原样给出来 ——
 * 复制、粘贴、自己在终端里敲。用户始终知道到底是谁装的。
 *
 * 两条来源并排放着：Torra 精选（离线就有，版本钉死）与官方目录
 * （运行时拉，四十来家，图标与规格是各家自己交的）。官方那一份只进候选区，
 * 接不接由用户点 —— 目录不替用户做决定。
 *
 * 官方图标由主进程取回来以 data URI 交给界面：渲染层的 CSP 不放行那个 CDN，
 * 界面自己引它的地址，图就永远出不来（见 main/acp/catalog.ts 的说明）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check, Copy, Info, Loader2, Plug, RefreshCw, Search, X } from 'lucide-react'
import { AgentMark } from '../agentMarks'
import { RegistryEditor } from './AgentRegistry'
import type { AcpCatalogItem, AcpCatalogView } from '@shared/acp'

/** 官方图标取回来的并发数：一次几十个请求会显得很吵，排成小队依次去 */
const ICON_WORKERS = 5

/** 一枚头像：官方图标取到了就画它，取不到就落回首字母牌 */
function CatalogMark({ item, icon }: { item: AcpCatalogItem; icon?: string }) {
  if (icon) {
    return (
      <span className="agx-cat-mark" aria-hidden>
        <img className="agx-cat-icon" src={icon} alt="" />
      </span>
    )
  }
  return <AgentMark id={item.id} title={item.title} size={26} />
}

/** 这一家眼下是什么状态：一句话，不留悬念 */
function stateOf(item: AcpCatalogItem): { cls: string; text: string } {
  if (item.registered) return { cls: 'on', text: '已接上' }
  if (item.installed) return { cls: 'ok', text: '本机已有' }
  if (item.mode === 'npx') return { cls: 'npx', text: 'npx 临时跑' }
  return { cls: 'off', text: '本机没装' }
}

/** 一张卡：一家 */
function CatalogCard({
  item,
  icon,
  busy,
  onAdd,
}: {
  item: AcpCatalogItem
  icon?: string
  busy: boolean
  onAdd: (item: AcpCatalogItem, mode?: 'local' | 'npx') => void
}) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const state = stateOf(item)
  const install = item.install.trim()

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(install)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1600)
    } catch {
      // 剪贴板不可用：那一行本来就能手动选中复制，不挡路
    }
  }

  return (
    <article className={`agx-cat-card${item.registered ? ' on' : ''}`} data-origin={item.origin ?? 'official'}>
      <header className="agx-cat-head">
        <CatalogMark item={item} icon={icon} />
        <div className="agx-cat-name">
          <b title={item.title}>{item.title}</b>
          <i>{item.vendor || item.blurb}</i>
        </div>
        <span className={`agx-cat-state ${state.cls}`}>{state.text}</span>
      </header>

      <p className="agx-cat-blurb">{item.blurb}</p>

      <p className="agx-cat-presence" title={item.presence}>
        {item.presence || '——'}
      </p>

      {install && !item.installed && (
        <div className="agx-cat-install">
          <code title={install}>{install}</code>
          <button
            type="button"
            className="agx-cat-copy"
            onClick={() => void copy()}
            title="复制这一行到剪贴板"
            aria-label="复制安装命令"
          >
            {copied ? <Check size={11} /> : <Copy size={11} />}
          </button>
        </div>
      )}

      {item.unsupported && <p className="agx-cat-bad">{item.unsupported}</p>}

      {item.notes.length > 0 && (
        <>
          <button type="button" className="agx-cat-more" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
            {open ? '收起说明' : `说明与坑（${item.notes.length}）`}
          </button>
          {open && (
            <ul className="agx-cat-notes">
              {item.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
              {item.authHint ? <li className="agx-cat-auth">登录：{item.authHint}</li> : null}
            </ul>
          )}
        </>
      )}

      <footer className="agx-cat-foot">
        {item.registered ? (
          <span className="agx-cat-done">
            <Check size={11} />
            已经在列表里了
          </span>
        ) : (
          <>
            <button
              type="button"
              className="btn sm primary"
              disabled={busy || !!item.unsupported}
              onClick={() => onAdd(item, 'local')}
              title={item.unsupported ?? '用本机这一份接上'}
            >
              {busy ? <Loader2 size={11} className="spin" /> : <Plug size={11} />}
              接上
            </button>
            {item.npx && (
              <button
                type="button"
                className="btn sm"
                disabled={busy}
                onClick={() => onAdd(item, 'npx')}
                title="不装全局包：第一次用会把这个包装下来"
              >
                用 npx 临时跑
              </button>
            )}
          </>
        )}
      </footer>
    </article>
  )
}

/**
 * 目录浮层。
 *
 * 自绘的，不借原生 <dialog> 的默认皮 —— 跟兼容矩阵那一屏是同一套皮。
 */
export function AgentCatalogPanel({
  onClose,
  onAdded,
}: {
  onClose: () => void
  /** 接上之后通知外面刷新（左边那份列表得跟着变） */
  onAdded: () => void | Promise<void>
}) {
  const panelRef = useRef<HTMLDivElement>(null)
  const [view, setView] = useState<AcpCatalogView | null>(null)
  const [icons, setIcons] = useState<Record<string, string>>({})
  const iconsRef = useRef<Record<string, string>>({})
  const [adding, setAdding] = useState<string | null>(null)
  const [pulling, setPulling] = useState(false)
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null)
  const [query, setQuery] = useState('')
  const [onlyLocal, setOnlyLocal] = useState(false)
  const [manual, setManual] = useState(false)

  const load = useCallback(async () => {
    try {
      const v = await window.torra.acpCatalog()
      setView(v)
    } catch (e) {
      setNote({ ok: false, text: `目录没打开：${e instanceof Error ? e.message : String(e)}` })
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 焦点进面板；Tab 圈在里面，Esc 出去
  useEffect(() => {
    const root = panelRef.current
    root?.focus()
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        onClose()
        return
      }
      if (e.key !== 'Tab' || !root) return
      const nodes = [
        ...root.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ].filter((n) => !n.hasAttribute('disabled') && n.offsetParent !== null)
      if (nodes.length === 0) return
      const first = nodes[0]!
      const last = nodes[nodes.length - 1]!
      const cur = document.activeElement
      if (e.shiftKey && (cur === first || !root.contains(cur))) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && cur === last) {
        e.preventDefault()
        first.focus()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  /**
   * 取图标：排成小队依次去，别一次砸几十个请求过去。
   *
   * 取不到就落回首字母牌 —— 图标是锦上添花，不该挡住「接上」这件事。
   */
  useEffect(() => {
    if (!view) return
    const ids = [...view.curated, ...view.official.items]
      .map((i) => i.iconId)
      .filter((x): x is string => !!x)
    const missing = ids.filter((id) => !(id in iconsRef.current))
    if (missing.length === 0) return
    let cancelled = false
    const queue = [...missing]
    const worker = async () => {
      for (;;) {
        const id = queue.shift()
        if (!id) break
        try {
          const r = await window.torra.acpCatalogIcon(id)
          if (!r.ok || !r.dataUrl || cancelled) continue
          iconsRef.current = { ...iconsRef.current, [id]: r.dataUrl }
          setIcons({ ...iconsRef.current })
        } catch {
          // 取不到就算了，落回首字母牌
        }
      }
    }
    void Promise.all(Array.from({ length: Math.min(ICON_WORKERS, queue.length) }, worker))
    return () => {
      cancelled = true
    }
  }, [view])

  const add = async (item: AcpCatalogItem, mode?: 'local' | 'npx') => {
    setAdding(item.id)
    setNote(null)
    try {
      const r = await window.torra.acpCatalogAdd(item.id, mode)
      if (!r.ok) {
        setNote({ ok: false, text: r.reason ?? '没接上' })
      } else {
        setNote({ ok: true, text: `「${item.title}」接上了：回左边点它可以先预检一次` })
        await onAdded()
        await load()
      }
    } catch (e) {
      setNote({ ok: false, text: e instanceof Error ? e.message : String(e) })
    }
    setAdding(null)
  }

  const pull = async () => {
    setPulling(true)
    setNote(null)
    try {
      const r = await window.torra.acpCatalogOfficial()
      await load()
      if (r.error) setNote({ ok: false, text: r.error })
    } catch (e) {
      setNote({ ok: false, text: `官方目录没拉下来：${e instanceof Error ? e.message : String(e)}` })
    }
    setPulling(false)
  }

  const official = view?.official
  const officialItems = useMemo(() => {
    const items = official?.items ?? []
    const q = query.trim().toLowerCase()
    return items.filter((i) => {
      if (onlyLocal && !i.installed) return false
      if (!q) return true
      return (
        i.title.toLowerCase().includes(q) ||
        i.vendor.toLowerCase().includes(q) ||
        i.id.toLowerCase().includes(q) ||
        i.blurb.toLowerCase().includes(q)
      )
    })
  }, [official?.items, query, onlyLocal])

  return (
    <div
      className="agx-matrix-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="agx-cat-panel"
        role="dialog"
        aria-modal="true"
        aria-label="接一家新的编码智能体"
        ref={panelRef}
        tabIndex={-1}
      >
        <header className="agx-cat-head">
          <div className="agx-cat-head-text">
            <b>接一家新的</b>
            <span>Torra 不替你装任何东西 —— 每张卡先说清本机有没有装好，没有就把装它的那一行给你。</span>
          </div>
          <button type="button" className="agx-icon-btn" onClick={onClose} title="收起（Esc）" aria-label="收起目录">
            <X size={14} />
          </button>
        </header>

        {note && (
          <p className={`agx-cat-note${note.ok ? ' ok' : ' bad'}`}>
            {note.ok ? <Check size={11} /> : <Info size={11} />}
            {note.text}
          </p>
        )}

        <div className="agx-cat-body">
          <section className="agx-cat-sec">
            <div className="agx-cat-sec-head">
              <b>Torra 精选</b>
              <span>启动方式、登录提示与已知的坑都写清了；版本钉死，跟兼容矩阵同一套规矩。</span>
            </div>
            <div className="agx-cat-grid">
              {(view?.curated ?? []).map((item) => (
                <CatalogCard
                  key={item.id}
                  item={item}
                  icon={item.iconId ? icons[item.iconId] : undefined}
                  busy={adding === item.id}
                  onAdd={(i, m) => void add(i, m)}
                />
              ))}
            </div>
          </section>

          <section className="agx-cat-sec">
            <div className="agx-cat-sec-head">
              <b>官方目录</b>
              <span>
                ACP 官方登记的那四十来家，启动规格与图标都是各家自己交的。拉回来的只进候选区，接不接由你点。
              </span>
              <button type="button" className="btn sm" onClick={() => void pull()} disabled={pulling}>
                {pulling ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}
                {official?.fetched ? '再拉一次' : '拉官方目录'}
              </button>
            </div>

            {official?.error && <p className="agx-cat-bad">{official.error}</p>}

            {!official?.fetched && !official?.error && !official?.items.length && (
              <p className="agx-cat-empty">还没拉过 —— 拉一次要联网，几十 KB。</p>
            )}

            {official?.items.length ? (
              <>
                <div className="agx-cat-tools">
                  <label className="agx-cat-search">
                    <Search size={11} />
                    <input
                      value={query}
                      placeholder="按名字、厂商或标识筛"
                      onChange={(e) => setQuery(e.target.value)}
                      aria-label="筛选官方目录"
                    />
                  </label>
                  <button
                    type="button"
                    className={`agx-cat-filter${onlyLocal ? ' on' : ''}`}
                    onClick={() => setOnlyLocal((v) => !v)}
                    title="只看本机已经装好的那些"
                  >
                    只看本机已装
                  </button>
                  <span className="agx-cat-count">
                    {officialItems.length} / {official.items.length} 家
                    {official.fetchedAt ? ` · 拉于 ${new Date(official.fetchedAt).toLocaleString('zh-CN')}` : ''}
                  </span>
                </div>
                <div className="agx-cat-grid">
                  {officialItems.map((item) => (
                    <CatalogCard
                      key={item.id}
                      item={item}
                      icon={item.iconId ? icons[item.iconId] : undefined}
                      busy={adding === item.id}
                      onAdd={(i, m) => void add(i, m)}
                    />
                  ))}
                </div>
                {officialItems.length === 0 && <p className="agx-cat-empty">这一档里没有符合的。</p>}
              </>
            ) : null}
          </section>

          {/*
           * 手写一条：留着，但不是主路。
           * 目录收不了的那家（自家写的适配器、非公开的包）还得有一条路能走 ——
           * 只是它得排在「点一下就能接」后面。
           */}
          <section className="agx-cat-sec">
            <button type="button" className="agx-cat-manual-toggle" onClick={() => setManual((v) => !v)} aria-expanded={manual}>
              {manual ? '收起手写这一条' : '目录里没有？手写一条'}
            </button>
            {manual && <RegistryEditor onSaved={() => void load()} />}
          </section>
        </div>
      </div>
    </div>
  )
}
