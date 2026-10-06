/**
 * Cookie / 登录态可视化面板。
 *
 * 只展示主进程 login:diagnose 已经算好的结论与证据：cookie 数量、
 * 疑似鉴权 cookie 的「域名 :: 名称」、页面存储键、登录判定与最终结论。
 * 面板不读取任何 cookie 值 —— 值留在主进程，界面只看名字。
 *
 * 同时是「统一登录」入口：把未登录 / 失效的网页模型集中列出，点选后
 * 用共享会话的 WebviewDock 就地登录，登录态与后台自动化同一份。
 */

import { useCallback, useMemo, useState } from 'react'
import { cookieExpireText, credentialHint, type CredExpiryInput } from '../../shared/credentials'
import type { LoginDiagnosis, ModelSummary } from '../store'
import { WebviewDock } from './WebviewDock'
import {
  Shield,
  Globe,
  RefreshCw,
  CheckCircle,
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  LogIn,
  Clock,
} from 'lucide-react'

const STATE_LABEL: Record<LoginDiagnosis['loginState'], { text: string; cls: string }> = {
  'logged-in': { text: '已登录', cls: 'ok' },
  'logged-out': { text: '未登录', cls: 'bad' },
  unknown: { text: '未知', cls: 'warn' },
}

type EffectiveState = LoginDiagnosis['loginState']

/** 综合「诊断结论 > 主进程登录态 > 状态灯」，给出当前可展示的登录判定 */
function effectiveState(m: ModelSummary, d?: LoginDiagnosis): EffectiveState {
  if (d) return d.loginState
  if (m.loginState) return m.loginState
  if (m.status === 'expired') return 'logged-out'
  if (m.status === 'ready') return 'logged-in'
  return 'unknown'
}

/**
 * 有效期取数优先级：本次诊断结果 > 主进程状态快照。
 * 诊断是刚读过的 cookie，更准；但面板刚打开时还没有它。
 * 没有诊断时只在「未被判为未登录」时用快照 —— 未登录的模型挂一个「剩 N 天」只会自相矛盾。
 */
function credInput(m: ModelSummary, d?: LoginDiagnosis): CredExpiryInput | undefined {
  if (d?.ok) return { expiresAt: d.credExpiresAt, expiresCookie: d.credExpiresCookie, sessionOnly: d.credSessionOnly }
  if (m.loginState !== 'logged-out') {
    return { expiresAt: m.credExpiresAt, expiresCookie: m.credExpiresCookie, sessionOnly: m.credSessionOnly }
  }
  return undefined
}

export function CookiePanel({ webModels }: { webModels: ModelSummary[] }) {
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

  // 待处理 = 未登录 / 失效 / 未知（已确认登录的不必出现在快捷区里）
  const pending = useMemo(
    () => webModels.filter((m) => effectiveState(m, results[m.id]) !== 'logged-in'),
    [webModels, results],
  )
  const allLoggedIn = webModels.length > 0 && pending.length === 0
  const targetModel = loginTarget ? webModels.find((m) => m.id === loginTarget) : undefined

  const startLogin = (modelId: string) => {
    setLoginNote(null)
    setLoginTarget(modelId)
  }

  const endLogin = () => {
    setLoginTarget(null)
    setLoginNote(null)
  }

  // 「我已登录完成」：复核后台实例并诊断；确认登录后自动收起并复核全量登录态
  const recheckLogin = async () => {
    if (!loginTarget) return
    const id = loginTarget
    const r = await window.torra.refreshLogin(id)
    const d = await diagnose(id)
    const loggedIn = r.ok || (d && d.loginState === 'logged-in')
    if (loggedIn) {
      setLoginNote('登录已确认，可发起讨论')
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
          <Shield size={13} />
          Cookie 与登录态
        </h3>
        <button className="st-btn" onClick={() => void diagnoseAll()} disabled={webModels.length === 0}>
          <RefreshCw size={12} />
          检查全部
        </button>
      </div>
      <p className="st-desc">
        逐模型查看登录分区里的 cookie 与页面存储，判断「存了没生效」还是「压根没存」。仅展示名称与域名，不读取任何 cookie 值。
      </p>

      {webModels.length > 0 && (
        <div className="cookie-login-box">
          <div className="cookie-login-head">
            <LogIn size={13} />
            <strong>统一登录</strong>
            <span className="cookie-login-count">
              {allLoggedIn ? '全部已登录' : `${pending.length} 个待处理`}
            </span>
          </div>
          {allLoggedIn ? (
            <div className="cookie-login-ok">
              <CheckCircle size={11} />
              所有网页模型均已登录，可直接发起讨论。
            </div>
          ) : (
            <>
              <p className="cookie-login-desc">
                选择一个未登录 / 失效的模型即可就地登录。登录页与后台自动化共用同一会话，登录成功即生效、无需重复。
              </p>
              <div className="cookie-login-picks">
                {pending.map((m) => {
                  const st = effectiveState(m, results[m.id])
                  const isTarget = loginTarget === m.id
                  return (
                    <button
                      key={m.id}
                      className={`cookie-login-chip${isTarget ? ' active' : ''}`}
                      onClick={() => startLogin(m.id)}
                      title={m.loginNote ?? ''}
                    >
                      <span className={`cookie-login-dot ${st === 'logged-out' ? 'bad' : 'warn'}`} />
                      <span className="cookie-login-name">{m.displayName}</span>
                      <span className="cookie-login-state">{STATE_LABEL[st].text}</span>
                    </button>
                  )
                })}
              </div>
            </>
          )}

          {targetModel && (
            <div className="cookie-login-slot">
              <WebviewDock model={targetModel} onClose={endLogin} onRecheck={() => void recheckLogin()} />
              {loginNote && <div className="cookie-login-note">{loginNote}</div>}
            </div>
          )}
        </div>
      )}

      {error && <div className="diag-error">{error}</div>}

      {webModels.length === 0 && <div className="st-empty">暂无网页模型</div>}

      <div className="st-list">
        {webModels.map((m) => (
          <CookieRow
            key={m.id}
            model={m}
            d={results[m.id]}
            loading={!!loading[m.id]}
            refreshing={!!refreshing[m.id]}
            open={expanded.has(m.id)}
            active={loginTarget === m.id}
            onToggle={() => toggle(m.id)}
            onDiagnose={() => void diagnose(m.id)}
            onRefresh={() => void refresh(m.id)}
            onLogin={() => startLogin(m.id)}
          />
        ))}
      </div>
    </section>
  )
}

function CookieRow({
  model,
  d,
  loading,
  refreshing,
  open,
  active,
  onToggle,
  onDiagnose,
  onRefresh,
  onLogin,
}: {
  model: ModelSummary
  d?: LoginDiagnosis
  loading: boolean
  refreshing: boolean
  open: boolean
  active: boolean
  onToggle: () => void
  onDiagnose: () => void
  onRefresh: () => void
  onLogin: () => void
}) {
  const state = d ? STATE_LABEL[d.loginState] : null
  const cred = credentialHint(credInput(model, d))

  return (
    <div className={`cookie-row${active ? ' active' : ''}${d && !d.ok ? ' error' : ''}`}>
      <div
        className="cookie-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-label={`${model.displayName} 的登录诊断详情`}
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            onToggle()
          }
        }}
      >
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <div className="st-grow">
          <div className="st-name">{model.displayName}</div>
          <div className="st-meta">
            <Globe size={10} />
            {model.domain ?? '—'}
          </div>
        </div>
        {state && <span className={`cookie-state ${state.cls}`}>{state.text}</span>}
        {d?.ok && <span className="cookie-count">{d.cookieTotal} cookies</span>}
        {cred && (
          <span className={`cookie-cred tone-${cred.tone}`} title={cred.title}>
            <Clock size={10} />
            {cred.text}
          </span>
        )}
        {loading && <RefreshCw size={12} className="spin" />}
        <div className="st-actions">
          <button
            className="st-btn"
            title="在该模型的共享会话里登录"
            onClick={(e) => {
              e.stopPropagation()
              onLogin()
            }}
          >
            <LogIn size={11} />
            登录
          </button>
          <button
            className="st-btn"
            onClick={(e) => {
              e.stopPropagation()
              onDiagnose()
            }}
            disabled={loading}
          >
            检查
          </button>
          <button
            className="st-icon"
            title="强制刷新后台实例并复核登录"
            aria-label={`复核 ${model.displayName} 的登录态`}
            onClick={(e) => {
              e.stopPropagation()
              onRefresh()
            }}
            disabled={refreshing || loading}
          >
            <RefreshCw size={11} className={refreshing ? 'spin' : ''} />
          </button>
        </div>
      </div>

      {!d && !loading && (
        <div className="cookie-hint">点击「检查」读取该模型登录分区里的 cookie 与存储</div>
      )}

      {d && !d.ok && <div className="cookie-verdict bad">{d.reason ?? '诊断失败'}</div>}

      {d && d.ok && open && (
        <div className="cookie-body">
          <div className={`cookie-verdict ${verdictTone(d.loginState)}`}>{d.verdict}</div>

          {d.partitionMismatch && (
            <div className="cookie-warn">
              <AlertTriangle size={11} />
              分区不一致：声明 <code>{d.declaredPartition}</code>，实际运行 <code>{d.partition}</code>。登录态可能对不上。
            </div>
          )}

          <div className="cookie-grid">
            <div>
              <div className="cookie-label">分区</div>
              <code className="cookie-code">{d.partition}</code>
            </div>
            <div>
              <div className="cookie-label">页面地址</div>
              <code className="cookie-code">{d.pageUrl || '—'}</code>
            </div>
            <div>
              <div className="cookie-label">cookie 总数</div>
              <div className="cookie-value">{d.cookieTotal}</div>
            </div>
            <div>
              <div className="cookie-label">输入框探针</div>
              <div className="cookie-value">{d.probeOk ? '命中' : '未命中'}</div>
            </div>
          </div>

          <div className="cookie-sub">疑似鉴权 cookie（域名 :: 名称，最多 20 条）</div>
          {d.authCookies.length === 0 ? (
            <div className="cookie-empty">未发现 token/auth/session 类 cookie</div>
          ) : (
            <div className="cookie-chips">
              {d.authCookies.map((c, i) => (
                <span key={i} className="cookie-chip">
                  {c}
                </span>
              ))}
            </div>
          )}

          <div className="cookie-sub">认证 cookie 有效期（只列判定为本站点凭据的那些，不含值）</div>
          {!d.credCookies || d.credCookies.length === 0 ? (
            <div className="cookie-empty">没有识别到属于本站点的认证 cookie，此时界面上不会出现「凭据剩 N 天」</div>
          ) : (
            <div className="cookie-cred-list">
              {[...d.credCookies]
                .sort((a, b) => (a.exp > 0 ? a.exp : Infinity) - (b.exp > 0 ? b.exp : Infinity))
                .map((c, i) => {
                  const t = cookieExpireText(c.exp)
                  const earliest = !!d.credExpiresAt && c.exp === d.credExpiresAt
                  return (
                    <div key={i} className={`cookie-cred-item${earliest ? ' earliest' : ''}`}>
                      <span className="cookie-cred-name">{c.name}</span>
                      <span className="cookie-cred-domain">{c.domain}</span>
                      <span className={`cookie-cred-left tone-${t.tone}`}>{t.text}</span>
                      {earliest && <span className="cookie-cred-flag">模型栏看的就是这条</span>}
                    </div>
                  )
                })}
            </div>
          )}

          {d.storage && (
            <>
              <div className="cookie-sub">页面存储键</div>
              <div className="cookie-two">
                <div>
                  <div className="cookie-label">localStorage{d.storage.localKeys.length ? ` (${d.storage.localKeys.length})` : ''}</div>
                  {d.storage.localKeys.length === 0 ? (
                    <div className="cookie-empty">空</div>
                  ) : (
                    <div className="cookie-chips">
                      {d.storage.localKeys.map((k, i) => (
                        <span key={i} className="cookie-chip">
                          {k}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
                <div>
                  <div className="cookie-label">sessionStorage{d.storage.sessionKeys.length ? ` (${d.storage.sessionKeys.length})` : ''}</div>
                  {d.storage.sessionKeys.length === 0 ? (
                    <div className="cookie-empty">空</div>
                  ) : (
                    <div className="cookie-chips">
                      {d.storage.sessionKeys.map((k, i) => (
                        <span key={i} className="cookie-chip">
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
              <div className="cookie-sub">判定依据</div>
              <div className="cookie-evidence">
                <span className={d.evidence.onLoginPage ? 'bad' : ''}>登录页重定向：{d.evidence.onLoginPage ? '是' : '否'}</span>
                <span className={d.evidence.hasUserFlag ? 'ok' : ''}>用户标识：{d.evidence.hasUserFlag ? '有' : '无'}</span>
                <span className={d.evidence.hasLoginCta ? 'bad' : ''}>登录按钮：{d.evidence.hasLoginCta ? '有' : '无'}</span>
              </div>
              {d.evidence.allLocalKeys.length > 0 && (
                <div className="cookie-chips">
                  {d.evidence.allLocalKeys.map((k, i) => (
                    <span key={i} className="cookie-chip">
                      {k}
                    </span>
                  ))}
                </div>
              )}
            </>
          )}

          {d.loginState === 'logged-in' && (
            <div className="cookie-ok-note">
              <CheckCircle size={11} />
              登录已落盘，可发起讨论。
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function verdictTone(state: LoginDiagnosis['loginState']): string {
  if (state === 'logged-in') return 'ok'
  if (state === 'logged-out') return 'bad'
  return 'warn'
}
