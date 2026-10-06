/**
 * 网页模型区：模型行 = 通道状态 + 登录态 + cookie 证据，三件事在同一行说完。
 *
 * 为什么合在一行：此前「网页模型」列表在模型管理、「登录态与 cookie 证据」在
 * Cookie 与登录，同一批模型两套行组件、两处按钮，用户要点开另一个 tab 才能登录
 * 刚在这里看见的那个模型。合并后行头给结论（就绪 / 已登录 / 凭据剩 N 天 / cookies 数），
 * 展开给证据，登录就嵌在行下方 —— 与后台自动化共用同一个共享会话。
 *
 * 证据全部来自 login:diagnose：界面不读 cookie 值，只看名称、域名与到期时间；
 * 有效期也不自己算，只消费主进程给的时刻。
 */

import { useCallback, useMemo, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import { cookieExpireText, credentialHint, type CredExpiryInput } from '../../shared/credentials'
import type { LoginDiagnosis, ModelSummary } from '../store'
import { getFaviconUrls } from './ModelRail'
import { WebviewDock } from './WebviewDock'
import {
  AlertTriangle,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  Clock,
  Globe,
  Image as ImageIcon,
  LogIn,
  RefreshCw,
  Shield,
  Trash2,
} from 'lucide-react'

const STATE_LABEL: Record<LoginDiagnosis['loginState'], { text: string; cls: string }> = {
  'logged-in': { text: '已登录', cls: 'tone-ok' },
  'logged-out': { text: '未登录', cls: 'tone-bad' },
  unknown: { text: '未知', cls: 'tone-warn' },
}

type EffectiveState = LoginDiagnosis['loginState']

/** 综合「本次诊断 > 主进程登录态快照 > 状态灯」，给出当前可展示的登录判定 */
function effectiveState(m: ModelSummary, d?: LoginDiagnosis): EffectiveState {
  if (d) return d.loginState
  if (m.loginState) return m.loginState
  if (m.status === 'expired') return 'logged-out'
  if (m.status === 'ready') return 'logged-in'
  return 'unknown'
}

/**
 * 有效期取数优先级：本次诊断结果 > 主进程状态快照。
 * 诊断是刚读过的 cookie，更准；但界面刚打开时还没有它。
 * 没有诊断时只在「未被判为未登录」时用快照 —— 未登录的模型挂一个「剩 N 天」只会自相矛盾。
 */
function credInput(m: ModelSummary, d?: LoginDiagnosis): CredExpiryInput | undefined {
  if (d?.ok) return { expiresAt: d.credExpiresAt, expiresCookie: d.credExpiresCookie, sessionOnly: d.credSessionOnly }
  if (m.loginState !== 'logged-out') {
    return { expiresAt: m.credExpiresAt, expiresCookie: m.credExpiresCookie, sessionOnly: m.credSessionOnly }
  }
  return undefined
}

export function WebModelSection({
  webModels,
  onModelsChanged,
  onDeleteModel,
}: {
  webModels: ModelSummary[]
  onModelsChanged: () => Promise<void> | void
  onDeleteModel: (id: string) => Promise<void> | void
}) {
  const [results, setResults] = useState<Record<string, LoginDiagnosis>>({})
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [loginTarget, setLoginTarget] = useState<string | null>(null)
  const [loginNote, setLoginNote] = useState<string | null>(null)

  const diagnose = useCallback(async (modelId: string) => {
    setLoading((p) => ({ ...p, [modelId]: true }))
    setError(null)
    try {
      const d = await window.torra.diagnoseLogin(modelId)
      setResults((p) => ({ ...p, [modelId]: d }))
      if (!d.ok) setError(`「${modelId}」诊断失败：${d.reason ?? '未知原因'}`)
      return d
    } catch (e) {
      setError((e as Error).message)
      return undefined
    } finally {
      setLoading((p) => ({ ...p, [modelId]: false }))
    }
  }, [])

  const diagnoseAll = async () => {
    for (const m of webModels) await diagnose(m.id)
  }

  const refresh = async (modelId: string) => {
    setRefreshing((p) => ({ ...p, [modelId]: true }))
    try {
      await window.torra.refreshLogin(modelId)
      await diagnose(modelId)
    } finally {
      setRefreshing((p) => ({ ...p, [modelId]: false }))
    }
  }

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  /** 待处理 = 未登录 / 失效 / 未知。已确认登录的不该出现在快捷区里占位置 */
  const pending = useMemo(
    () => webModels.filter((m) => effectiveState(m, results[m.id]) !== 'logged-in'),
    [webModels, results],
  )
  const allLoggedIn = webModels.length > 0 && pending.length === 0
  const targetModel = loginTarget ? webModels.find((m) => m.id === loginTarget) : undefined

  const startLogin = (modelId: string) => {
    setLoginNote(null)
    setLoginTarget(modelId)
    toggle2(modelId, setExpanded)
  }

  /** 「我已登录完成」：复核后台实例并诊断；确认登录后收起登录槽并刷新状态灯 */
  const recheckLogin = async () => {
    if (!loginTarget) return
    const id = loginTarget
    const r = await window.torra.refreshLogin(id)
    const d = await diagnose(id)
    const loggedIn = r.ok || (d && d.loginState === 'logged-in')
    if (loggedIn) {
      setLoginNote('登录已确认，可发起讨论')
      await onModelsChanged()
      window.setTimeout(() => {
        setLoginTarget(null)
        setLoginNote(null)
      }, 1400)
    } else {
      setLoginNote(r.reason ?? d?.verdict ?? '仍未检测到登录凭据，请完成登录后再试')
    }
  }

  return (
    <section className="st-section">
      <div className="st-sec-head">
        <h3 className="st-sec-title">
          <Globe size={13} />
          网页模型
          <span className={`wm-tally${allLoggedIn ? ' ok' : ''}`}>
            {webModels.length === 0 ? '暂无' : `${webModels.length - pending.length}/${webModels.length} 已登录`}
          </span>
        </h3>
        <div className="st-sec-actions">
          <button className="st-btn" onClick={() => void diagnoseAll()} disabled={webModels.length === 0}>
            <Shield size={12} />
            检查全部登录态
          </button>
        </div>
      </div>
      <p className="st-desc">
        用浏览器自动化驱动网页版模型。行内点「登录」就地登录即可 —— 登录页与后台自动化共用同一个共享会话，登录成功即生效，不必再去别处登录第二遍。展开行看 cookie 与页面存储的证据（只有名称和域名，不含值）。
      </p>

      {webModels.length > 0 && !allLoggedIn && (
        <div className="wm-login">
          <div className="wm-login-head">
            <LogIn size={13} />
            <strong>登录待处理</strong>
            <span className="wm-login-count">{pending.length} 个</span>
          </div>
          <p className="wm-login-desc">点一个模型，在它自己的会话里完成登录；判据是站点真实的鉴权 cookie 与页面信号，不是「页面打开了」。</p>
          <div className="wm-picks">
            {pending.map((m) => {
              const st = effectiveState(m, results[m.id])
              return (
                <button
                  key={m.id}
                  className={`wm-pick${loginTarget === m.id ? ' active' : ''}`}
                  onClick={() => startLogin(m.id)}
                  title={m.loginNote ?? ''}
                >
                  <span className={`wm-pick-dot ${st === 'logged-out' ? 'bad' : 'warn'}`} />
                  <span className="wm-pick-name">{m.displayName}</span>
                  <span className="wm-pick-state">{STATE_LABEL[st].text}</span>
                </button>
              )
            })}
          </div>
        </div>
      )}
      {allLoggedIn && <div className="wm-login-ok"><CheckCircle size={11} />所有网页模型均已登录，可直接发起讨论。</div>}

      {error && <div className="diag-error">{error}</div>}
      {webModels.length === 0 && <div className="st-empty">暂无网页模型</div>}

      <div className="st-list">
        {webModels.map((m) => (
          <div key={m.id} className="wm-entry">
            <WebModelRow
              model={m}
              d={results[m.id]}
              loading={!!loading[m.id]}
              refreshing={!!refreshing[m.id]}
              open={expanded.has(m.id)}
              logging={loginTarget === m.id}
              onToggle={() => toggle(m.id)}
              onDiagnose={() => void diagnose(m.id)}
              onRefresh={() => void refresh(m.id)}
              onLogin={() => startLogin(m.id)}
              onDelete={() => void onDeleteModel(m.id)}
            />
            {loginTarget === m.id && targetModel && targetModel.id === m.id && (
              <div className="wm-slot">
                <WebviewDock model={targetModel} onClose={() => setLoginTarget(null)} onRecheck={() => void recheckLogin()} />
                {loginNote && <div className="wm-slot-note">{loginNote}</div>}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  )
}

/** 登录时把这一行同时展开：证据与登录页在一起，不必再点一次 */
function toggle2(id: string, setExpanded: (fn: (prev: Set<string>) => Set<string>) => void) {
  setExpanded((prev) => (prev.has(id) ? prev : new Set(prev).add(id)))
}

function WebModelRow({
  model,
  d,
  loading,
  refreshing,
  open,
  logging,
  onToggle,
  onDiagnose,
  onRefresh,
  onLogin,
  onDelete,
}: {
  model: ModelSummary
  d?: LoginDiagnosis
  loading: boolean
  refreshing: boolean
  open: boolean
  logging: boolean
  onToggle: () => void
  onDiagnose: () => void
  onRefresh: () => void
  onLogin: () => void
  onDelete: () => void
}) {
  const [faviconIndex, setFaviconIndex] = useState(0)
  const [refetching, setRefetching] = useState(false)
  const faviconUrls = getFaviconUrls(model.domain)
  const hasFavicon = faviconUrls.length > 0 && faviconIndex < faviconUrls.length
  const state = STATE_LABEL[effectiveState(model, d)]
  const cred = credentialHint(credInput(model, d))

  const refetchIcon = () => {
    setRefetching(true)
    setFaviconIndex(0)
    setTimeout(() => setRefetching(false), 1500)
  }

  return (
    <div className={`wm-row${logging ? ' logging' : ''}${d && !d.ok ? ' error' : ''}`}>
      <div
        className="wm-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${model.displayName} 的登录与通道详情`}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <div className="st-avatar" style={hasFavicon ? { background: 'transparent' } : { background: model.color }}>
          {hasFavicon ? (
            <img
              src={faviconUrls[faviconIndex]}
              alt=""
              crossOrigin="anonymous"
              onError={() => setFaviconIndex((prev) => prev + 1)}
            />
          ) : (
            model.displayName.slice(0, 1)
          )}
        </div>
        <div className="st-grow">
          <div className="st-name">{model.displayName}</div>
          <div className="st-meta">
            <span
              className={`st-dot ${model.status === 'ready' ? 'ok' : 'warn'}`}
              title={model.status === 'ready' ? '就绪' : '需要处理（多为未登录）'}
            />
            {model.domain ?? '—'}
            <span className={`wm-state ${state.cls}`}>{state.text}</span>
            {cred && (
              <span className={`wm-cred tone-${cred.tone}`} title={cred.title}>
                <Clock size={10} />
                {cred.text}
              </span>
            )}
            {d?.ok && <span className="wm-count">{d.cookieTotal} cookies</span>}
            {model.adapterStale && <span className="wm-stale">适配器待校准</span>}
            {model.adapterLastError && (
              <span className="wm-err" title={model.adapterLastError}>
                上次通道异常
              </span>
            )}
            {loading && <RefreshCw size={11} className="spin" />}
          </div>
        </div>
        <div className="st-actions quiet">
          <button className="st-icon" title="在这个模型的共享会话里登录" aria-label={`登录 ${model.displayName}`} onClick={stop(onLogin)}>
            <LogIn size={11} />
          </button>
          <button className="st-icon" title="读取登录分区里的 cookie 与存储" aria-label={`检查 ${model.displayName} 的登录态`} onClick={stop(onDiagnose)} disabled={loading}>
            <Shield size={11} />
          </button>
          <button
            className="st-icon"
            title="强制刷新后台实例并复核登录"
            aria-label={`复核 ${model.displayName} 的登录态`}
            onClick={stop(onRefresh)}
            disabled={refreshing || loading}
          >
            <RefreshCw size={11} className={refreshing ? 'spin' : ''} />
          </button>
          <button
            className="st-icon"
            title="重新获取图标"
            aria-label={`重新获取「${model.displayName}」的图标`}
            onClick={stop(refetchIcon)}
            disabled={refetching || !model.domain}
          >
            <ImageIcon size={11} className={refetching ? 'spin' : ''} />
          </button>
          {model.userDefined && (
            <button className="st-icon danger" title={`移除「${model.displayName}」`} aria-label={`移除「${model.displayName}」`} onClick={stop(onDelete)}>
              <Trash2 size={11} />
            </button>
          )}
        </div>
      </div>

      {!d && !loading && <div className="wm-hint">点这一行展开：cookie 名称、认证 cookie 有效期、页面存储与判定依据</div>}
      {d && !d.ok && <div className="wm-verdict bad">{d.reason ?? '诊断失败'}</div>}

      {d && d.ok && open && (
        <div className="wm-body">
          <div className={`wm-verdict ${verdictTone(d.loginState)}`}>{d.verdict}</div>

          {d.partitionMismatch && (
            <div className="wm-warn">
              <AlertTriangle size={11} />
              分区不一致：声明 <code>{d.declaredPartition}</code>，实际运行 <code>{d.partition}</code>。登录态可能对不上。
            </div>
          )}

          <div className="wm-grid">
            <div>
              <div className="wm-label">分区</div>
              <code className="wm-code">{d.partition}</code>
            </div>
            <div>
              <div className="wm-label">页面地址</div>
              <code className="wm-code">{d.pageUrl || '—'}</code>
            </div>
            <div>
              <div className="wm-label">cookie 总数</div>
              <div className="wm-value">{d.cookieTotal}</div>
            </div>
            <div>
              <div className="wm-label">输入框探针</div>
              <div className="wm-value">{d.probeOk ? '命中' : '未命中'}</div>
            </div>
          </div>

          <div className="wm-sub">疑似鉴权 cookie（域名 :: 名称，最多 20 条）</div>
          {d.authCookies.length === 0 ? (
            <div className="wm-empty">未发现 token/auth/session 类 cookie</div>
          ) : (
            <div className="wm-tags">
              {d.authCookies.map((c, i) => (
                <span key={i} className="wm-tag">
                  {c}
                </span>
              ))}
            </div>
          )}

          <div className="wm-sub">认证 cookie 有效期（只列判定为本站点凭据的那些，不含值）</div>
          {!d.credCookies || d.credCookies.length === 0 ? (
            <div className="wm-empty">没有识别到属于本站点的认证 cookie，此时界面上不会出现「凭据剩 N 天」</div>
          ) : (
            <div className="wm-credlist">
              {[...d.credCookies]
                .sort((a, b) => (a.exp > 0 ? a.exp : Infinity) - (b.exp > 0 ? b.exp : Infinity))
                .map((c, i) => {
                  const t = cookieExpireText(c.exp)
                  const earliest = !!d.credExpiresAt && c.exp === d.credExpiresAt
                  return (
                    <div key={i} className={`wm-creditem${earliest ? ' earliest' : ''}`}>
                      <span className="wm-credname">{c.name}</span>
                      <span className="wm-creddomain">{c.domain}</span>
                      <span className={`wm-credleft tone-${t.tone}`}>{t.text}</span>
                      {earliest && <span className="wm-credflag">这里和模型栏看的是同一条</span>}
                    </div>
                  )
                })}
            </div>
          )}

          {d.storage && (
            <>
              <div className="wm-sub">页面存储键</div>
              <div className="wm-two">
                <div>
                  <div className="wm-label">localStorage{d.storage.localKeys.length ? ` (${d.storage.localKeys.length})` : ''}</div>
                  {d.storage.localKeys.length === 0 ? (
                    <div className="wm-empty">空</div>
                  ) : (
                    <div className="wm-tags">
                      {d.storage.localKeys.map((k, i) => (
                        <span key={i} className="wm-tag">
                          {k}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <div className="wm-label">sessionStorage{d.storage.sessionKeys.length ? ` (${d.storage.sessionKeys.length})` : ''}</div>
                  {d.storage.sessionKeys.length === 0 ? (
                    <div className="wm-empty">空</div>
                  ) : (
                    <div className="wm-tags">
                      {d.storage.sessionKeys.map((k, i) => (
                        <span key={i} className="wm-tag">
                          {k}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {d.evidence && (
            <>
              <div className="wm-sub">判定依据</div>
              <div className="wm-evidence">
                <span className={d.evidence.onLoginPage ? 'bad' : ''}>登录页重定向：{d.evidence.onLoginPage ? '是' : '否'}</span>
                <span className={d.evidence.hasUserFlag ? 'ok' : ''}>用户标识：{d.evidence.hasUserFlag ? '有' : '无'}</span>
                <span className={d.evidence.hasLoginCta ? 'bad' : ''}>登录按钮：{d.evidence.hasLoginCta ? '有' : '无'}</span>
              </div>
              {d.evidence.allLocalKeys.length > 0 && (
                <div className="wm-tags">
                  {d.evidence.allLocalKeys.map((k, i) => (
                    <span key={i} className="wm-tag">
                      {k}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}

          {d.loginState === 'logged-in' && (
            <div className="wm-oknote">
              <CheckCircle size={11} />
              登录已落盘，可发起讨论。
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** 行内按钮不该顺带把行折叠/展开：拦住冒泡 */
function stop(fn: () => void) {
  return (e: React.MouseEvent) => {
    e.stopPropagation()
    fn()
  }
}

function verdictTone(state: LoginDiagnosis['loginState']): string {
  if (state === 'logged-in') return 'ok'
  if (state === 'logged-out') return 'bad'
  return 'warn'
}
