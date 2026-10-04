/**
 * Cookie / 登录态可视化面板。
 *
 * 只展示主进程 login:diagnose 已经算好的结论与证据：cookie 数量、
 * 疑似鉴权 cookie 的「域名 :: 名称」、页面存储键、登录判定与最终结论。
 * 面板不读取任何 cookie 值 —— 值留在主进程，界面只看名字。
 */

import { useCallback, useState } from 'react'
import type { LoginDiagnosis, ModelSummary } from '../store'
import { Shield, Globe, RefreshCw, CheckCircle, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react'

const STATE_LABEL: Record<LoginDiagnosis['loginState'], { text: string; cls: string }> = {
  'logged-in': { text: '已登录', cls: 'ok' },
  'logged-out': { text: '未登录', cls: 'bad' },
  unknown: { text: '未知', cls: 'warn' },
}

export function CookiePanel({ webModels }: { webModels: ModelSummary[] }) {
  const [results, setResults] = useState<Record<string, LoginDiagnosis>>({})
  const [loading, setLoading] = useState<Record<string, boolean>>({})
  const [refreshing, setRefreshing] = useState<Record<string, boolean>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const diagnose = useCallback(async (modelId: string) => {
    setLoading((p) => ({ ...p, [modelId]: true }))
    setError(null)
    try {
      const d = await window.torra.diagnoseLogin(modelId)
      setResults((p) => ({ ...p, [modelId]: d }))
      if (!d.ok) setError(`「${modelId}」诊断失败：${d.reason ?? '未知原因'}`)
    } catch (e) {
      setError((e as Error).message)
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

  return (
    <section>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <h3 className="settings-section-title" style={{ margin: 0, flex: 1 }}>
          <Shield size={13} />
          Cookie 与登录态
        </h3>
        <button className="btn sm" onClick={() => void diagnoseAll()} disabled={webModels.length === 0}>
          <RefreshCw size={12} />
          检查全部
        </button>
      </div>
      <p className="settings-section-desc">
        逐模型查看登录分区里的 cookie 与页面存储，判断「存了没生效」还是「压根没存」。仅展示名称与域名，不读取任何 cookie 值。
      </p>

      {error && <div className="diag-error">{error}</div>}

      {webModels.length === 0 && <div className="settings-empty">暂无网页模型</div>}

      <div className="settings-list">
        {webModels.map((m) => (
          <CookieRow
            key={m.id}
            model={m}
            d={results[m.id]}
            loading={!!loading[m.id]}
            refreshing={!!refreshing[m.id]}
            open={expanded.has(m.id)}
            onToggle={() => toggle(m.id)}
            onDiagnose={() => void diagnose(m.id)}
            onRefresh={() => void refresh(m.id)}
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
  onToggle,
  onDiagnose,
  onRefresh,
}: {
  model: ModelSummary
  d?: LoginDiagnosis
  loading: boolean
  refreshing: boolean
  open: boolean
  onToggle: () => void
  onDiagnose: () => void
  onRefresh: () => void
}) {
  const state = d ? STATE_LABEL[d.loginState] : null

  return (
    <div className={`cookie-row ${d && !d.ok ? 'error' : ''}`}>
      <div className="cookie-head" onClick={onToggle}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="settings-row-name">{model.displayName}</div>
          <div className="settings-row-meta">
            <Globe size={10} />
            {model.domain ?? '—'}
          </div>
        </div>
        {state && <span className={`cookie-state ${state.cls}`}>{state.text}</span>}
        {d?.ok && <span className="cookie-count">{d.cookieTotal} cookies</span>}
        {loading && <RefreshCw size={12} className="spin" />}
        <button
          className="btn sm"
          onClick={(e) => {
            e.stopPropagation()
            onDiagnose()
          }}
          disabled={loading}
        >
          检查
        </button>
        <button
          className="btn sm"
          title="强制刷新后台实例并复核登录"
          onClick={(e) => {
            e.stopPropagation()
            onRefresh()
          }}
          disabled={refreshing || loading}
        >
          <RefreshCw size={11} className={refreshing ? 'spin' : ''} />
        </button>
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
