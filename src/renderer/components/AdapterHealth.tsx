/**
 * 适配器体检 —— 站点集成的健康总表。
 *
 * 适配器是「Torra 怎么跟某个 AI 网站对话」的那层声明式 YAML：输入框、发送按钮、
 * 回复容器各是什么选择器。主进程早就把这些算好了（adapters:list / adapters:check），
 * 界面上却没有一处能看 —— 站点改版导致「模型不回答」时，用户只能自己猜是哪个站点坏了。
 *
 * 这一块只做四件事：把主进程给的结论摆出来、把坏在哪说清楚、让人能就地重测、
 * 以及把 YAML 里的选择器原样摊开供人核对。判定逻辑一律不重算 ——
 * 界面另算一套，同一个适配器就会有两个结论，而用户只会信屏幕上那个。
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ADAPTER_STALE_DAYS } from '@shared/adapter'
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleDashed,
  Clock,
  Code2,
  Globe,
  Info,
  Loader2,
  Package,
  Pencil,
  RefreshCw,
  Scale,
  Stethoscope,
} from 'lucide-react'

/** 适配器清单的一行：直接取自 preload 暴露的 API 形状，不另写一份 */
type AdapterRow = Awaited<ReturnType<typeof window.torra.listAdapters>>[number]

/** 主进程 checkAdapter 的回包：ok / health（状态）/ reason（一句话解释） */
type CheckReply = Awaited<ReturnType<typeof window.torra.checkAdapter>>

type Tone = 'ok' | 'warn' | 'bad' | 'idle'

interface HealthMeta {
  /** 给人看的中文状态词 */
  text: string
  /** 一句话说清「这意味着什么」 */
  detail: string
  tone: Tone
}

/**
 * 主进程 `AdapterHealth` 的五种取值，逐个翻译成人话。
 * 没有直译的不要编：原样显示外加一句「这是什么」。
 */
const HEALTH_META: Record<string, HealthMeta> = {
  ok: {
    text: '正常',
    detail: '探测命中了页面里声明的元素，这个站点集成现在可用。',
    tone: 'ok',
  },
  'selector-missing': {
    text: '选择器失效',
    detail: '页面里找不到 YAML 声明的元素 —— 多半是站点改版了，需要更新 selectors。',
    tone: 'bad',
  },
  'login-required': {
    text: '需要登录',
    detail: '站点要求先登录才能探测；到「网页模型」里登录完再重测。',
    tone: 'warn',
  },
  'entry-unreachable': {
    text: '站点打不开',
    detail: '入口地址连不上：可能是网络问题，也可能站点地址变了。',
    tone: 'bad',
  },
  unknown: {
    text: '未体检',
    detail: '这个适配器还没有探测过。点「重测」跑一次。',
    tone: 'idle',
  },
}

function healthMeta(raw: string | undefined): HealthMeta {
  const key = raw ?? 'unknown'
  const known = HEALTH_META[key]
  if (known) return known
  return {
    text: key,
    detail: '这是主进程返回的原始状态值，暂时没有对应的中文解释。',
    tone: 'idle',
  }
}

const TONE_ICON: Record<Tone, typeof CheckCircle2> = {
  ok: CheckCircle2,
  warn: AlertTriangle,
  bad: CircleAlert,
  idle: CircleDashed,
}

/** 「有问题」= 明确坏了或需要登录；「未体检」单算一档，因为它不是故障 */
function isBroken(tone: Tone): boolean {
  return tone === 'bad' || tone === 'warn'
}

/** 距上次核验过了多少天；日期认不出来就返回 null */
function daysSince(stamp: string | undefined): number | null {
  if (!stamp) return null
  const t = Date.parse(stamp)
  if (Number.isNaN(t)) return null
  return Math.max(0, Math.floor((Date.now() - t) / 86_400_000))
}

/**
 * 只给日期，不给时分秒。
 * 主进程给的是 ISO 串，带毫秒和 Z —— 那一串占掉半行，却没人看得进去；
 * 真正要看的是「哪一天核验的」，精确到秒对「多久之前过期」这件事没有增量。
 * 完整串留在 title 里，要较真的人点得到。
 */
function stampDay(stamp: string | undefined): string {
  if (!stamp) return ''
  const t = Date.parse(stamp)
  if (Number.isNaN(t)) return stamp
  const d = new Date(t)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function verifiedText(stamp: string | undefined, days: number | null): string {
  if (!stamp) return '未记录'
  const day = stampDay(stamp)
  if (days === null) return day
  if (days === 0) return `${day}（今天）`
  return `${day}（${days} 天前）`
}

/** 重测之后这一行额外记一笔：结论 + 语气 */
interface RowNote {
  text: string
  tone: Tone
}

type Filter = 'all' | 'bad' | 'idle'

export function AdapterHealthPanel() {
  const [list, setList] = useState<AdapterRow[] | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [checking, setChecking] = useState<Record<string, boolean>>({})
  const [notes, setNotes] = useState<Record<string, RowNote>>({})
  const [health, setHealth] = useState<Record<string, string>>({})
  const [openSel, setOpenSel] = useState<Set<string>>(new Set())
  const [filter, setFilter] = useState<Filter>('all')
  const [allRunning, setAllRunning] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const raw = await window.torra.listAdapters()
      setList(Array.isArray(raw) ? raw : [])
      setError(null)
    } catch (e) {
      setError((e as Error).message || '读取失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // 适配器 YAML 是热更新的：有人改了 adapters/ 或用户目录里的文件，主进程会推一条变更，
  // 这里跟着重读，省得用户自己再点一次「重新体检」。
  useEffect(() => {
    let off: (() => void) | null = null
    try {
      off = window.torra.on('adapters:changed', () => {
        void load()
      })
    } catch {
      /* 老版本 preload 没有这个通道：忽略即可，页面还有手动刷新 */
    }
    return () => off?.()
  }, [load])

  /** 单个适配器重测：结果就地写回这一行，不动其它行 */
  const checkOne = useCallback(async (adapterId: string) => {
    setChecking((p) => ({ ...p, [adapterId]: true }))
    try {
      const res: CheckReply = await window.torra.checkAdapter(adapterId)
      if (res.reason === 'no model bound') {
        setNotes((p) => ({
          ...p,
          [adapterId]: { text: '这个适配器还没绑模型 —— 先在「模型管理」里建一个网页模型并选它，才能探。', tone: 'idle' },
        }))
        return
      }
      const meta = healthMeta(res.health ?? (res.ok ? 'ok' : 'selector-missing'))
      if (res.health) setHealth((p) => ({ ...p, [adapterId]: res.health as string }))
      setNotes((p) => ({
        ...p,
        [adapterId]: {
          text: res.ok ? '重测通过：页面元素都找得到。' : `重测没通过：${meta.text} —— ${meta.detail}`,
          tone: meta.tone,
        },
      }))
    } catch (e) {
      setNotes((p) => ({
        ...p,
        [adapterId]: { text: `重测没跑成：${(e as Error).message}`, tone: 'bad' },
      }))
    } finally {
      setChecking((p) => {
        const next = { ...p }
        delete next[adapterId]
        return next
      })
    }
  }, [])

  /**
   * 全部重测：逐个跑，不并发。
   * 每次探测都会真的去打开那个站点，并发打过去既容易把自己的会话挤掉，
   * 也让站点侧看到一堆同时到达的请求 —— 顺序跑慢一点，但结果可读。
   */
  const checkAll = async () => {
    const items = list ?? []
    if (items.length === 0) return
    setAllRunning(true)
    setProgress({ done: 0, total: items.length })
    try {
      let done = 0
      for (const item of items) {
        await checkOne(item.id)
        done += 1
        setProgress({ done, total: items.length })
      }
    } finally {
      setAllRunning(false)
      setProgress(null)
    }
  }

  const toggleSel = (id: string) => {
    setOpenSel((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 这一行当前该显示的健康值：重测结果优先于清单里的快照 */
  const effHealth = (a: AdapterRow): string => health[a.id] ?? a.health ?? 'unknown'

  const rows = useMemo(() => (list ?? []).map((a) => ({ a, meta: healthMeta(effHealth(a)) })), [list, health])

  const counts = useMemo(() => {
    let bad = 0
    let idle = 0
    let ok = 0
    for (const r of rows) {
      if (r.meta.tone === 'idle') idle += 1
      else if (isBroken(r.meta.tone)) bad += 1
      else ok += 1
    }
    return { bad, idle, ok }
  }, [rows])

  const visible = useMemo(() => {
    if (filter === 'bad') return rows.filter((r) => isBroken(r.meta.tone))
    if (filter === 'idle') return rows.filter((r) => r.meta.tone === 'idle')
    return rows
  }, [rows, filter])

  return (
    <section className="st-section ah" data-testid="adapter-health">
      <div className="st-sec-head">
        <h3 className="st-sec-title">
          <Stethoscope size={13} />
          适配器体检
          {list && list.length > 0 && (
            <span className="ah-tally">
              共 {list.length} 个 · {counts.ok} 正常 · {counts.bad} 有问题 · {counts.idle} 未体检
            </span>
          )}
        </h3>
        <div className="st-sec-actions">
          <button
            className="st-btn"
            onClick={() => void load()}
            disabled={loading}
            title="重新读取适配器清单与当前状态（不访问网站）"
          >
            <RefreshCw size={11} className={loading ? 'spin' : ''} />
            {loading ? '读取中…' : '重新体检'}
          </button>
          <button
            className="st-btn"
            onClick={() => void checkAll()}
            disabled={allRunning || (list?.length ?? 0) === 0}
            title="逐个重新探测所有适配器：会依次访问真实站点，比较慢"
          >
            {allRunning ? <Loader2 size={11} className="spin" /> : <Stethoscope size={11} />}
            {allRunning ? '重测中…' : '全部重测'}
          </button>
        </div>
      </div>

      <p className="st-desc">
        适配器是「Torra 怎么跟某个网站对话」的那层声明式 YAML —— 输入框、发送按钮、回复容器各是什么选择器。
        这一页只摆结论：哪个站点的选择器还准、哪个已经过期，坏在哪一行当场可查，不必再对着 YAML 猜。
      </p>

      {error && (
        <div className="ah-error">
          <AlertTriangle size={12} />
          <span>读不到适配器清单：{error}</span>
          <button className="st-btn" onClick={() => void load()}>
            <RefreshCw size={11} />
            再试一次
          </button>
        </div>
      )}

      {loading && !list && (
        <div className="ah-loading">
          <Loader2 size={12} className="spin" />
          正在读取适配器清单…
        </div>
      )}

      {!loading && list && list.length === 0 && !error && (
        <div className="ah-empty">
          <Info size={13} />
          <div>
            <strong>还没有适配器</strong>
            <p>
              内置适配器在程序目录的 <code>adapters/</code> 下（每个站点一个 YAML），
              自建的在用户数据目录里。装好适配器并重启 Torra 后，这一页就会列出它们。
            </p>
          </div>
        </div>
      )}

      {list && list.length > 0 && (
        <>
          <div className="ah-filter" role="group" aria-label="筛选适配器状态">
            <button
              type="button"
              className={`ah-filter-item${filter === 'all' ? ' on' : ''}`}
              aria-pressed={filter === 'all'}
              onClick={() => setFilter('all')}
            >
              全部 <span className="ah-n">{rows.length}</span>
            </button>
            <button
              type="button"
              className={`ah-filter-item${filter === 'bad' ? ' on' : ''}`}
              aria-pressed={filter === 'bad'}
              onClick={() => setFilter('bad')}
            >
              有问题 <span className="ah-n">{counts.bad}</span>
            </button>
            <button
              type="button"
              className={`ah-filter-item${filter === 'idle' ? ' on' : ''}`}
              aria-pressed={filter === 'idle'}
              onClick={() => setFilter('idle')}
            >
              未体检 <span className="ah-n">{counts.idle}</span>
            </button>
            {progress && (
              <span className="ah-progress">
                {allRunning && <Loader2 size={11} className="spin" />}
                重测中 {progress.done}/{progress.total}
              </span>
            )}
          </div>

          {visible.length === 0 ? (
            <div className="ah-empty ah-empty-inline">
              <Info size={13} />
              <div>
                <strong>这一档里没有适配器</strong>
                <p>换个筛选看看，或点「全部重测」把所有站点挨个探一遍。</p>
              </div>
            </div>
          ) : (
            <div className="ah-grid">
              {visible.map(({ a, meta }) => {
                const Icon = TONE_ICON[meta.tone]
                const busy = !!checking[a.id]
                const selOpen = openSel.has(a.id)
                const selectors = a.selectors ?? {}
                const selEntries = Object.entries(selectors)
                const days = daysSince(a.verifiedAt)
                const note = notes[a.id]
                return (
                  <article className="ah-card" key={a.id} data-adapter-id={a.id}>
                    <header className="ah-card-head">
                      <span className="ah-ico" aria-hidden="true">
                        <Globe size={14} />
                      </span>
                      <div className="ah-card-id">
                        <h4 className="ah-card-name">{a.name}</h4>
                        <code className="ah-card-key">{a.id}</code>
                      </div>
                      <span className={`ah-pill tone-${meta.tone}`} title={meta.detail}>
                        <Icon size={11} />
                        {meta.text}
                      </span>
                    </header>

                    <dl className="ah-kv">
                      <div className="ah-kv-row">
                        <dt>
                          <Clock size={10} />
                          上次核验
                        </dt>
                        <dd>
                          <span title={a.verifiedAt}>{verifiedText(a.verifiedAt, days)}</span>
                          {a.stale && (
                            <span
                              className="ah-stale"
                              title={`距上次核验已超过 ${ADAPTER_STALE_DAYS} 天，站点可能改版了，选择器未必还准`}
                            >
                              已过期
                            </span>
                          )}
                        </dd>
                      </div>
                      <div className="ah-kv-row">
                        <dt>
                          {a.origin === 'user' ? <Pencil size={10} /> : <Package size={10} />}
                          来源
                        </dt>
                        <dd>{a.origin === 'user' ? '用户自建' : '内置'}</dd>
                      </div>
                      <div className="ah-kv-row">
                        <dt>
                          <Globe size={10} />
                          站点
                        </dt>
                        <dd>
                          <code className="ah-entry" title={a.entry}>
                            {a.entry || '—'}
                          </code>
                        </dd>
                      </div>
                    </dl>

                    {a.tosNotice && (
                      <div className="ah-tos">
                        <Scale size={12} />
                        <div>
                          <strong>服务条款提示</strong>
                          <p>{a.tosNotice}</p>
                        </div>
                      </div>
                    )}

                    {a.lastError && (
                      <div className="ah-err">
                        <AlertTriangle size={11} />
                        <span>{a.lastError}</span>
                      </div>
                    )}

                    {note && (
                      <div className={`ah-note tone-${note.tone}`}>
                        <Info size={11} />
                        <span>{note.text}</span>
                      </div>
                    )}

                    <div className="ah-card-foot">
                      {selEntries.length > 0 ? (
                        <button
                          type="button"
                          className="st-btn ah-sel-toggle"
                          aria-expanded={selOpen}
                          aria-controls={`ah-sel-${a.id}`}
                          onClick={() => toggleSel(a.id)}
                        >
                          {selOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                          {selOpen ? '收起选择器' : '展开选择器'}
                        </button>
                      ) : (
                        <span className="ah-no-sel">这个适配器没有声明选择器</span>
                      )}
                      <button
                        type="button"
                        className="st-btn"
                        onClick={() => void checkOne(a.id)}
                        disabled={busy || allRunning}
                        title="重新探测这个适配器：会真的打开一次它对应的站点"
                      >
                        {busy ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}
                        {busy ? '重测中…' : '重测'}
                      </button>
                    </div>

                    {selEntries.length > 0 && (
                      <div className={`ah-sel-wrap${selOpen ? ' open' : ''}`} id={`ah-sel-${a.id}`}>
                        <div className="ah-sel-inner" aria-hidden={!selOpen}>
                          <ul className="ah-sel-list">
                            {selEntries.map(([k, v]) => (
                              <li className="ah-sel-item" key={k}>
                                <span className="ah-sel-name">
                                  <Code2 size={10} />
                                  {k}
                                </span>
                                <code className="ah-sel-code">{v}</code>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>
                    )}
                  </article>
                )
              })}
            </div>
          )}
        </>
      )}
    </section>
  )
}
