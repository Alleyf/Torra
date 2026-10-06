import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ModelSummary } from '../store'
import '../settings.css'
import type { HotkeyState } from '@shared/types'
import type { CheckResult } from '@shared/diagnostics'
import { WebModelDialog } from './WebModelDialog'
import { ApiModelDialog } from './ApiModelDialog'
import { SmartAddDialog } from './SmartAddDialog'
import { DiagnosticsPanel, CheckRow } from './DiagnosticsPanel'
import { CookiePanel } from './CookiePanel'
import { getFaviconUrls } from './ModelRail'
import {
  Settings,
  Key,
  Globe,
  Plus,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Trash2,
  Pencil,
  ArrowLeft,
  Shield,
  RefreshCw,
  Zap,
  Stethoscope,
  Sparkles,
  ScanSearch,
  Search,
  SunMoon,
  RotateCcw,
  Link2,
  Link2Off,
  Play,
  X,
} from 'lucide-react'
import { Pager, pageSlice } from './Pager'
import { THEME_LABEL, THEME_MODES, type ThemeMode } from '@shared/theme'
import {
  APPROVAL_MODES,
  APPROVAL_MODE_LABEL,
  APPROVE_TIMEOUT_MAX_MS,
  APPROVE_TIMEOUT_MIN_MS,
  type AssistantApprovalMode,
  type AssistantApprovalPrefs,
} from '@shared/assistant'
import type {
  AssistantCapabilitiesView,
  AssistantResult,
  DiscoveredSkill,
  PendingExtensionView,
  PluginListView,
  SkillScanView,
} from '@shared/assistant'
import { chooseTheme, useThemeMode } from '../theme'

type Tab = 'models' | 'cookie' | 'doctor' | 'assistant' | 'appearance'

const TABS: Array<{ id: Tab; label: string; icon: typeof Key }> = [
  { id: 'models', label: '模型与密钥', icon: Key },
  { id: 'cookie', label: 'Cookie 与登录', icon: Shield },
  { id: 'doctor', label: '链路体检', icon: Stethoscope },
  { id: 'assistant', label: '助手能力', icon: Sparkles },
  { id: 'appearance', label: '外观', icon: SunMoon },
]

export function SettingsPage({
  models,
  onBack,
  onModelsChanged,
  onDeleteModel,
}: {
  models: ModelSummary[]
  onBack: () => void
  onModelsChanged: () => Promise<void> | void
  onDeleteModel: (id: string) => Promise<void> | void
}) {
  const [showAddWeb, setShowAddWeb] = useState(false)
  const [showAddApi, setShowAddApi] = useState(false)
  // 正在编辑的 API 模型 id（null=不打开编辑弹窗）。编辑与新增共用同一个弹窗，只是入口不同。
  const [editApiId, setEditApiId] = useState<string | null>(null)
  const [showSmart, setShowSmart] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('models')

  const apiModels = models.filter((m) => m.transport === 'api')
  const webModels = models.filter((m) => m.transport === 'webview')

  // 被「移除」的内置模型走隐藏而非真删，这里把它们列出来供恢复。
  const [hidden, setHidden] = useState<Awaited<ReturnType<typeof window.torra.listHiddenModels>>>([])
  const reloadHidden = () => void window.torra.listHiddenModels().then(setHidden)
  useEffect(() => {
    reloadHidden()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [models])
  const restore = async (id: string) => {
    await window.torra.restoreModel(id)
    await onModelsChanged()
    reloadHidden()
  }

  const handleRefreshAll = async () => {
    setRefreshing(true)
    setRefreshMsg(null)
    const start = Date.now()
    await window.torra.probeModels()
    await onModelsChanged()
    // 最少展示 800ms 让动画可感知
    const elapsed = Date.now() - start
    if (elapsed < 800) await new Promise((r) => setTimeout(r, 800 - elapsed))
    setRefreshing(false)
    const latest = await window.torra.listModels()
    const ready = latest.filter((m) => m.transport === 'api' ? m.hasKey : m.status === 'ready').length
    const total = latest.length
    setRefreshMsg(`已刷新：${ready}/${total} 就绪`)
    setTimeout(() => setRefreshMsg(null), 4000)
  }

  return (
    <div className="st-root">
      <aside className="st-rail">
        <div className="st-rail-top">
          <button className="st-icon" onClick={onBack} title="返回讨论" aria-label="返回讨论">
            <ArrowLeft size={14} />
          </button>
          <span className="st-wordmark">
            <Settings size={14} />
            设置
          </span>
        </div>

        <div className="st-eyebrow">CONFIGURE</div>
        <nav className="st-nav">
          {TABS.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.id}
                className={`st-nav-item${tab === t.id ? ' on' : ''}`}
                onClick={() => setTab(t.id)}
                aria-current={tab === t.id ? 'page' : undefined}
              >
                <Icon size={13} />
                {t.label}
              </button>
            )
          })}
        </nav>

        <p className="st-rail-foot">
          讨论数据、报告与密钥都只存在本机；密钥走操作系统级加密，Torra 不上传、不代管。
        </p>
      </aside>

      <div className="st-main">
        <div className="st-body">
          <div className="st-tool">
            <h2 className="st-h1">{TABS.find((t) => t.id === tab)?.label}</h2>
            <div className="st-tool-side">
              {refreshMsg && <span className="st-inline-msg">{refreshMsg}</span>}
              <button className="st-btn" onClick={() => void handleRefreshAll()} disabled={refreshing}>
                <RefreshCw size={12} className={refreshing ? 'spin' : ''} />
                {refreshing ? '刷新中…' : '刷新状态'}
              </button>
            </div>
          </div>

        {tab === 'models' && (
          <>
            <section className="st-section">
              <div className="st-sec-head">
                <h3 className="st-sec-title">
                  <Sparkles size={13} />
                  添加模型
                </h3>
                <div className="st-sec-actions">
                  <button className="st-btn" onClick={() => setShowAddApi(true)}>
                    <Zap size={12} />
                    API 模型
                  </button>
                  <button className="st-btn" onClick={() => setShowAddWeb(true)}>
                    <Plus size={12} />
                    网页模型
                  </button>
                  <button className="st-btn primary" onClick={() => setShowSmart(true)} title="只给一个地址，自动读页面结构或嗅探端点">
                    <ScanSearch size={12} />
                    智能添加
                  </button>
                </div>
              </div>
              <p className="st-desc">
                拿不准怎么填就用「智能添加」：只给一个地址，它自己读页面结构或嗅探端点，产出经过真实页面校验的配置，遇到拿不准的地方再来问你。
              </p>
            </section>

            <section className="st-section">
              <div className="st-sec-head">
                <h3 className="st-sec-title">
                  <Key size={13} />
                  API 密钥
                </h3>
              </div>
              <p className="st-desc">密钥只写进本机操作系统钥匙串，不上传、不代管。</p>
              {apiModels.length === 0 ? (
                <div className="st-empty">暂无 API 模型</div>
              ) : (
                <div className="st-list">
                  {apiModels.map((m) => (
                    <ApiKeyRow
                      key={m.id}
                      model={m}
                      onSaved={onModelsChanged}
                      onEdit={m.userDefined ? () => setEditApiId(m.id) : undefined}
                      onDelete={
                        m.userDefined
                          ? async () => {
                              await onDeleteModel(m.id)
                              await onModelsChanged()
                            }
                          : undefined
                      }
                    />
                  ))}
                </div>
              )}
            </section>

            <section className="st-section">
              <div className="st-sec-head">
                <h3 className="st-sec-title">
                  <Globe size={13} />
                  网页模型
                </h3>
              </div>
              <p className="st-desc">用浏览器自动化驱动网页版模型，需要先在「Cookie 与登录」里登录。</p>
              {webModels.length === 0 ? (
                <div className="st-empty">暂无网页模型</div>
              ) : (
                <div className="st-list">
                  {webModels.map((m) => (
                    <WebModelRow
                      key={m.id}
                      model={m}
                      onDelete={async () => {
                        await onDeleteModel(m.id)
                        await onModelsChanged()
                      }}
                    />
                  ))}
                </div>
              )}
            </section>

            {hidden.length > 0 && (
              <section className="st-section">
                <div className="st-sec-head">
                  <h3 className="st-sec-title">
                    <RotateCcw size={13} />
                    已隐藏的模型
                  </h3>
                </div>
                <p className="st-desc">以下内置模型已从侧栏移除（登录态与数据都保留），可随时恢复回侧栏。</p>
                <div className="st-list">
                  {hidden.map((h) => (
                    <div key={h.id} className="st-row">
                      <div className="st-avatar" style={{ background: h.color }}>
                        {h.displayName.slice(0, 1)}
                      </div>
                      <div className="st-grow">
                        <div className="st-name">{h.displayName}</div>
                        <div className="st-meta">{h.domain ?? (h.transport === 'api' ? 'API' : '网页')}</div>
                      </div>
                      <button className="st-btn" title="恢复到侧栏" onClick={() => void restore(h.id)}>
                        <RotateCcw size={11} />
                        恢复
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </>
        )}

        {tab === 'cookie' && <CookiePanel webModels={webModels} />}

        {tab === 'doctor' && (
          <DiagnosticsPanel
            modelIds={models.map((m) => ({ id: m.id, displayName: m.displayName, transport: m.transport }))}
          />
        )}

        {tab === 'assistant' && (
          <>
            <ApprovalSection />
            <AssistantSection />
          </>
        )}

        {tab === 'appearance' && (
          <>
            <AppearanceSection />
            <HotkeySection />
          </>
        )}
        </div>
      </div>

      {showAddWeb && (
        <WebModelDialog
          models={models}
          onClose={() => setShowAddWeb(false)}
          onCreated={async () => {
            await onModelsChanged()
          }}
        />
      )}

      {showAddApi && (
        <ApiModelDialog
          models={models}
          onClose={() => setShowAddApi(false)}
          onCreated={async () => {
            await onModelsChanged()
          }}
        />
      )}

      {editApiId && (
        <ApiModelDialog
          models={models}
          editModelId={editApiId}
          onClose={() => setEditApiId(null)}
          onCreated={async () => {
            await onModelsChanged()
          }}
        />
      )}

      {showSmart && (
        <SmartAddDialog
          models={models}
          onClose={() => setShowSmart(false)}
          onCreated={async () => {
            await onModelsChanged()
          }}
        />
      )}
    </div>
  )
}

function WebModelRow({
  model,
  onDelete,
}: {
  model: ModelSummary
  onDelete: () => Promise<void> | void
}) {
  const [faviconIndex, setFaviconIndex] = useState(0)
  const [fetching, setFetching] = useState(false)
  const faviconUrls = getFaviconUrls(model.domain)
  const hasFavicon = faviconUrls.length > 0 && faviconIndex < faviconUrls.length

  const refetch = () => {
    setFetching(true)
    setFaviconIndex(0)
    setTimeout(() => setFetching(false), 1500)
  }

  return (
    <div className="st-row">
      <div className="st-avatar" style={hasFavicon ? { background: 'transparent' } : { background: model.color }}>
        {hasFavicon ? (
          <img src={faviconUrls[faviconIndex]} alt="" crossOrigin="anonymous" onError={() => setFaviconIndex((prev) => prev + 1)} />
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
        </div>
      </div>
      <div className="st-actions quiet">
        <button className="st-icon" title="重新获取图标" aria-label={`重新获取「${model.displayName}」的图标`} onClick={refetch} disabled={fetching || !model.domain}>
          <RefreshCw size={11} className={fetching ? 'spin' : ''} />
        </button>
        {model.userDefined && (
          <button
            className="st-icon danger"
            title={`移除「${model.displayName}」`}
            aria-label={`移除「${model.displayName}」`}
            onClick={() => void onDelete()}
          >
            <Trash2 size={11} />
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * API 模型的一行：密钥写入 + 就地验证有效性。
 *
 * 「检查」不新造探测逻辑，复用的是体检的 API 层（同一个 doctor:run，范围收到
 * 这一个模型）：只发一次免费的 GET {baseUrl}/models，不计费、不产生对话 ——
 * 这条边界是诊断代码的授权前提，真发一条补全要先经用户明确同意，不放这里。
 *
 * 结论只取属于这张卡片的几跳（layer==='api' 且 subject===模型 id）：体检顺带跑的
 * 环境层、主持层混进来只会让人以为「密钥没问题但体检说有别处红」。
 */
function ApiKeyRow({
  model,
  onSaved,
  onEdit,
  onDelete,
}: {
  model: ModelSummary
  onSaved: () => Promise<void> | void
  /** 打开编辑弹窗；内置模型不可编辑，缺省时不显示按钮 */
  onEdit?: () => void
  onDelete?: () => Promise<void> | void
}) {
  const [key, setKey] = useState('')
  const [saved, setSaved] = useState(false)
  const [justSaved, setJustSaved] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checks, setChecks] = useState<CheckResult[] | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [shown, setShown] = useState<Set<string>>(new Set())
  /** 本轮结论里是否含那次真实补全请求（花钱的探测要能被看出来） */
  const [probed, setProbed] = useState(false)

  const handleSave = async () => {
    if (!key.trim()) return
    const result = await window.torra.setSecret(`${model.id}:key`, key.trim())
    if (!result.ok) return
    setSaved(true)
    setJustSaved(true)
    setKey('')
    // 换了 Key，上一轮的「端点可达/Key 无效」就不作数了
    setChecks(null)
    setProbed(false)
    setNote(null)
    await onSaved()
    setTimeout(() => setJustSaved(false), 2000)
  }

  const handleCheck = async (withCompletion = false) => {
    setChecking(true)
    setNote(null)
    const start = Date.now()
    try {
      const report = await window.torra.runDoctor({
        modelId: model.id,
        probeApi: true,
        // 只有这里传 true：一次最小补全，按 token 计费，用户逐次点
        probeCompletion: withCompletion,
      })
      const mine = report.checks.filter((c) => c.layer === 'api' && c.subject === model.id)
      setChecks(mine)
      setProbed(withCompletion)
      setShown(new Set())
      // 全通过时收起，有提醒/失败时替用户展开，避免「看着像没事」
      setOpen(mine.some((c) => c.status === 'fail' || c.status === 'warn'))
      if (mine.length === 0) {
        const scope = report.checks.find((c) => c.subject === model.id)
        setNote(scope ? `${scope.title} —— ${scope.fix ?? '该模型不在体检范围内'}` : '这个模型没有可检查的 API 通道')
      }
      // 探测很快时也要让忙碌态被看见，否则用户以为没点上
      const elapsed = Date.now() - start
      if (elapsed < 800) await new Promise((r) => setTimeout(r, 800 - elapsed))
    } catch (e) {
      setChecks(null)
      setNote(`检查没跑起来：${(e as Error).message}`)
    } finally {
      setChecking(false)
    }
  }

  const bad = checks?.find((c) => c.status === 'fail')
  const soft = checks?.find((c) => c.status === 'warn')
  const head = bad ?? soft ?? checks?.find((c) => c.status === 'skip') ?? checks?.[0] ?? null
  const tone = bad ? 'fail' : soft ? 'warn' : checks && checks.length > 0 ? 'ok' : 'warn'

  return (
    <div className="st-item">
      <div className="st-row">
        <div className="st-grow">
          <div className="st-name">{model.displayName}</div>
          <div className="st-meta">
            {model.hasKey || saved ? (
              <span className="ok">
                <CheckCircle size={10} /> 已配置
              </span>
            ) : (
              <span className="warn">
                <AlertTriangle size={10} /> 未配置
              </span>
            )}
          </div>
        </div>
        <div className="st-actions">
          <input
            type="password"
            className="st-input"
            value={key}
            aria-label={`${model.displayName} 的 API 密钥`}
            placeholder={saved ? '已保存' : 'sk-...'}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && key.trim()) void handleSave()
            }}
          />
          <button className="st-btn" onClick={() => void handleSave()} disabled={!key.trim()}>
            {justSaved ? <CheckCircle size={12} /> : '保存'}
          </button>
          <button
            className="st-icon"
            title={
              model.hasKey
                ? '检查有效性：只发一次免费的 GET /models，不计费、不产生对话'
                : '先为该模型填入 API 密钥，再检查有效性'
            }
            aria-label={`检查「${model.displayName}」的 API 有效性`}
            onClick={() => void handleCheck()}
            disabled={checking || !model.hasKey}
          >
            <Stethoscope size={11} className={checking ? 'spin' : ''} />
          </button>
          {onEdit && (
            <button className="st-icon" title={`编辑「${model.displayName}」`} aria-label={`编辑「${model.displayName}」`} onClick={onEdit}>
              <Pencil size={11} />
            </button>
          )}
          {onDelete && (
            <button
              className="st-icon danger"
              title={`移除「${model.displayName}」`}
              aria-label={`移除「${model.displayName}」`}
              onClick={() => void onDelete()}
            >
              <Trash2 size={11} />
            </button>
          )}
        </div>
      </div>

      {(checks || note) && (
        <div className="st-check">
          <div className="st-check-head" onClick={() => setOpen((o) => !o)}>
            {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
            {note ? (
              <span className="diag-pill warn">{note}</span>
            ) : (
              <>
                <span className={`diag-pill ${tone}`}>{head?.title ?? '没有得出结论'}</span>
                <span className="st-check-count">
                  通过 {checks?.filter((c) => c.status === 'pass').length ?? 0} / 提醒{' '}
                  {checks?.filter((c) => c.status === 'warn').length ?? 0} / 失败{' '}
                  {checks?.filter((c) => c.status === 'fail').length ?? 0}
                  {probed ? ' · 含一次真实请求' : ''}
                </span>
              </>
            )}
            {!!checks?.length && (
              <button
                className="st-icon"
                aria-label="试一次真实请求"
                title={
                  probed
                    ? '再发一次最小补全请求：会产生真实费用'
                    : '试一次真实请求：真发一条最小补全，验证「能不能正常应答」。会产生真实费用（一个词 + 16 token，通常不到一分钱）'
                }
                onClick={(e) => {
                  e.stopPropagation()
                  void handleCheck(true)
                }}
                disabled={checking || !model.hasKey}
              >
                <Zap size={10} className={checking ? 'spin' : ''} />
              </button>
            )}
            <button
              className="st-icon"
              aria-label="重新检查"
              title="重新检查"
              onClick={(e) => {
                e.stopPropagation()
                void handleCheck()
              }}
              disabled={checking || !model.hasKey}
            >
              <RefreshCw size={10} className={checking ? 'spin' : ''} />
            </button>
          </div>
          {open &&
            checks?.map((c) => (
              <CheckRow
                key={c.id}
                c={c}
                open={shown.has(c.id)}
                onToggle={() =>
                  setShown((prev) => {
                    const next = new Set(prev)
                    if (next.has(c.id)) next.delete(c.id)
                    else next.add(c.id)
                    return next
                  })
                }
              />
            ))}
        </div>
      )}
    </div>
  )
}

/** 插件确认策略的人话：清单里写的是 always/once/never，界面上要说的是会不会弹卡片 */
const CONFIRM_LABEL = { always: '每次运行都确认', once: '首次运行确认', never: '免确认' } as const

const APPROVAL_MODE_DESC: Record<AssistantApprovalMode, string> = {
  always_ask: '每张卡片都等你点。超时没处理就自动取消，不会改动任何东西。',
  auto_after_timeout:
    '卡片倒计时若干秒后自动执行；这期间点「拒绝」、按 Esc、关掉抽屉都能拦下。需要填 API Key 的卡片仍然必须人工点。',
  auto_all: '不再弹卡片，写操作直接执行，只在对话里留一行「已自动执行」。需要填 API Key 的卡片照旧等人。',
  read_only: '写操作一律拒绝，助手只能查、不能改。适合让它先体检和解释，别动配置。',
}

/**
 * 写操作审批：模式 + 「超时自动批准」的倒计时时长。
 *
 * 这组配置存在主进程，不存在的渲染层：确认卡片到点该不该放行，不能依赖
 * 界面还开着。所以每个动作都立刻写盘并把结果说回来 —— 静默切换等于没切。
 */
function ApprovalSection() {
  const [prefs, setPrefs] = useState<AssistantApprovalPrefs | null>(null)
  const [secs, setSecs] = useState('10')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const reload = useCallback(() => {
    void window.torra.assistantApprovalPrefs().then((p) => {
      setPrefs(p)
      setSecs(String(Math.round(p.timeoutMs / 1000)))
    })
  }, [])

  useEffect(reload, [reload])

  const flash = (text: string) => {
    setMsg(text)
    window.setTimeout(() => setMsg((m) => (m === text ? null : m)), 5000)
  }

  const parsed = Number.parseInt(secs, 10)
  const secsClamped = Number.isFinite(parsed)
    ? Math.min(APPROVE_TIMEOUT_MAX_MS / 1000, Math.max(APPROVE_TIMEOUT_MIN_MS / 1000, parsed))
    : Math.round((prefs?.timeoutMs ?? APPROVE_TIMEOUT_MIN_MS) / 1000)
  const dirty = prefs?.mode === 'auto_after_timeout' && secsClamped !== Math.round(prefs.timeoutMs / 1000)

  const apply = async (mode: AssistantApprovalMode, timeoutSec: number) => {
    setBusy(true)
    const start = Date.now()
    const r = await window.torra.assistantSetApprovalPrefs({ mode, timeoutMs: Math.round(timeoutSec * 1000) })
    // 落盘几乎瞬间完成，但快到手就看不见：补个最短可感知时长，和「刷新状态」一致
    const elapsed = Date.now() - start
    if (elapsed < 500) await new Promise((res) => setTimeout(res, 500 - elapsed))
    setBusy(false)
    if (!r.ok) {
      flash(r.reason ?? '切换失败')
      reload()
      return
    }
    flash(r.reason ?? '已保存')
    reload()
  }

  const minS = APPROVE_TIMEOUT_MIN_MS / 1000
  const maxS = APPROVE_TIMEOUT_MAX_MS / 1000

  return (
    <section className="st-section">
      <h3 className="st-sec-title">
        写操作审批
      </h3>
      <p className="st-desc">
        助手要改本机配置（建模型、写适配器、跑插件、删东西）时，默认先弹一张确认卡片问人。
        下面决定的是<strong>它问不问、问多久</strong> —— 四种模式下它能做的动作范围完全一样，
        差别只在卡片要不要等人点。
      </p>
      {!prefs && <div className="st-meta">读取审批偏好…</div>}
      <div className="st-opt-list">
        {APPROVAL_MODES.map((m) => (
          <button
            key={m}
            type="button"
            className={`st-opt${prefs?.mode === m ? ' on' : ''}${m === 'auto_all' || m === 'read_only' ? ` ${m}` : ''}`}
            disabled={!prefs || busy}
            onClick={() => void apply(m, secsClamped)}
          >
            <span className="st-opt-name">
              {APPROVAL_MODE_LABEL[m]}
              {m === 'always_ask' && <em className="st-opt-tag">默认</em>}
              {m === 'auto_all' && <em className="st-opt-tag warn">放行不问</em>}
              {m === 'read_only' && <em className="st-opt-tag">不改动</em>}
            </span>
            <span className="st-opt-desc">{APPROVAL_MODE_DESC[m]}</span>
          </button>
        ))}
      </div>

      {prefs?.mode === 'auto_after_timeout' && (
        <div className="st-row">
          <div className="st-grow">
            <div className="st-name">倒计时时长</div>
            <div className="st-meta">
              {minS}–{maxS} 秒。这段时间就是你能拦下它的窗口：卡片上的秒数走完才执行。
            </div>
          </div>
          <input
            className="st-num"
            type="number"
            min={minS}
            max={maxS}
            step={1}
            value={secs}
            disabled={busy}
            onChange={(e) => setSecs(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && dirty) void apply('auto_after_timeout', secsClamped)
            }}
          />
          <span className="st-unit">秒</span>
          <button className="st-btn" disabled={busy || !dirty} onClick={() => void apply('auto_after_timeout', secsClamped)}>
            {busy ? <RefreshCw size={12} className="spin" /> : <Check size={12} />}
            应用
          </button>
        </div>
      )}

      {prefs?.mode === 'auto_all' && (
        <p className="st-note warn">
          <AlertTriangle size={10} /> 「全部自动批准」下助手不再问你：删除模型、执行插件这类动作也会直接落地。
          适合你盯着它一步步做事的时候用，做完记得切回「每次询问」。
        </p>
      )}

      {msg && (
        <p className="st-note ok">
          <CheckCircle size={10} /> {msg}
        </p>
      )}
    </section>
  )
}

/**
 * 助手能力：技能 / 扩展开关与已加载清单。
 *
 * 开关默认关 —— 扩展是 JS 代码，加载后直接跑在主进程里，不经过助手那套
 * 「写操作先弹卡片」的闸门。所以这里既要把风险说清楚，也要把「开完以后
 * 到底加载了哪些东西」摊开：看不见的生效是最难查的。
 */
function AssistantSection() {
  const [caps, setCaps] = useState<AssistantCapabilitiesView | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  const [capQ, setCapQ] = useState('')
  const [capPage, setCapPage] = useState(1)

  const reload = useCallback(() => {
    void window.torra.assistantCapabilities().then(setCaps)
  }, [])

  useEffect(reload, [reload])

  const toggle = async () => {
    const next = !(caps?.extensionsEnabled ?? false)
    setBusy(true)
    setMsg(null)
    const start = Date.now()
    const r = await window.torra.assistantSetExtensions(next)
    // 改动生效很快，但快到手就看不见；和「刷新状态」一样补个最短可感知时长
    const elapsed = Date.now() - start
    if (elapsed < 800) await new Promise((res) => setTimeout(res, 800 - elapsed))
    setBusy(false)
    setMsg(r.ok ? (next ? '已开启：下一次对话会加载技能与扩展' : '已关闭：助手只调用内置工具') : r.reason ?? '切换失败')
    reload()
    setTimeout(() => setMsg(null), 5000)
  }

  const on = caps?.extensionsEnabled ?? false
  const skills = caps?.skills ?? []
  const exts = caps?.extensions ?? []
  const plugins = caps?.plugins ?? []
  const errs = caps?.errors ?? []

  // 已加载清单：插件、扩展在前、技能在后，合并成统一条目后按名称/说明检索再分页
  type LoadedRow = { key: string; kind: '插件' | '扩展' | '技能'; name: string; meta: string }
  const loaded: LoadedRow[] = [
    ...plugins.map((p): LoadedRow => ({
      key: `p:${p.file}`,
      kind: '插件',
      name: p.label || p.name,
      meta: `${p.kind === 'shell' ? '本机命令' : 'HTTP'} · ${CONFIRM_LABEL[p.confirm]} · ${p.description}`,
    })),
    ...exts.map((e): LoadedRow => ({ key: `e:${e.path}`, kind: '扩展', name: e.name, meta: e.tools.length ? `工具：${e.tools.join('、')}` : '未注册工具' })),
    ...skills.map((s): LoadedRow => ({ key: `s:${s.path}`, kind: '技能', name: s.name, meta: s.description ?? s.path })),
  ]
  const kw = capQ.trim().toLowerCase()
  const loadedFiltered = kw
    ? loaded.filter(
        (r) =>
          r.name.toLowerCase().includes(kw) ||
          r.meta.toLowerCase().includes(kw) ||
          r.kind.toLowerCase().includes(kw),
      )
    : loaded
  const CAP_SIZE = 8
  const { rows: loadedRows, safePage: loadedPage } = pageSlice(loadedFiltered, capPage, CAP_SIZE)
  useEffect(() => setCapPage(1), [capQ])

  return (
    <section className="st-section">
      <h3 className="st-sec-title">
        技能与扩展
      </h3>
      <p className="st-desc">
        助手默认只用 Torra 内置的工具，任何改配置的动作都会先弹卡片问你。
        打开后它会加载放在本机 <code>userData/torra/pi</code> 目录里的技能（SKILL.md）和扩展（JS）：
        技能列表会进助手的系统提示词，并附赠一个<strong>受限的 read</strong> 让它读得到技能正文 ——
        这个 read 被关在上面的技能目录里，读别处会被直接拦下，不弹确认也不报错。
        注意：扩展代码直接在主进程里运行，不经过确认卡片 —— 只放你自己信任的内容。
      </p>
      <p className="st-desc">
        还有一层<strong>声明式插件</strong>：一个工具 = 一个 <code>*.plugin.json</code> 清单，
        只有 <code>http</code>（带占位符的请求模板）和 <code>shell</code>（固定 argv、参数只能填进位置）两种，
        由同一个解释器执行。它<strong>不受上面那个开关约束</strong> —— 清单是数据不是代码，
        但除 GET/HEAD 之外每次运行都会弹确认卡片，卡片上写明「会跑到哪个地址 / 执行哪条命令」。
      </p>

      <div className="st-row">
        <div className="st-grow">
          <div className="st-name">加载技能 / 扩展</div>
          <div className="st-meta">
            {on ? (
              <span className="ok">
                <CheckCircle size={10} /> 已开启
              </span>
            ) : (
              <span>已关闭（推荐）</span>
            )}
            {msg && <span className="st-gap">{msg}</span>}
          </div>
        </div>
        <button className="st-btn" onClick={() => void toggle()} disabled={busy}>
          {busy ? <RefreshCw size={12} className="spin" /> : null}
          {on ? '关闭' : '开启'}
        </button>
      </div>

      {caps?.dirs && (
        <p className="st-desc">
          技能目录 <code>{caps.dirs.skills}</code> · 扩展目录 <code>{caps.dirs.extensions}</code> · 插件目录{' '}
          <code>{caps.dirs.plugins}</code>
        </p>
      )}

      {caps?.note && (
        <p className="st-note warn">
          <AlertTriangle size={10} /> {caps.note}
        </p>
      )}

      {(skills.length > 0 || exts.length > 0 || plugins.length > 0) && (
        <>
          <h3 className="st-sec-title st-sub">
            已加载
          </h3>
          <div className="search-box st-search">
            <Search size={13} />
            <input
              type="text"
              placeholder="搜索插件 / 技能 / 扩展名称或说明"
              value={capQ}
              onChange={(e) => setCapQ(e.target.value)}
            />
          </div>
          {loadedRows.map((r) => (
            <div key={r.key} className="st-row">
              <div className="st-grow">
                <div className="st-name">{r.kind} · {r.name}</div>
                <div className="st-meta">{r.meta}</div>
              </div>
            </div>
          ))}
          {loadedFiltered.length === 0 && (
            <div className="st-meta st-tight">
              没有匹配「{capQ}」的插件 / 技能 / 扩展
            </div>
          )}
          <Pager page={loadedPage} pageSize={CAP_SIZE} total={loadedFiltered.length} onPage={setCapPage} />
        </>
      )}

      {errs.length > 0 && (
        <>
          <h3 className="st-sec-title st-sub st-warn">
            加载失败
          </h3>
          {errs.map((e) => (
            <div key={`${e.path}-${e.error}`} className="st-row">
              <div className="st-grow">
                <div className="st-name">{e.path || '未知文件'}</div>
                <div className="st-meta st-warn">
                  {e.error}
                </div>
              </div>
            </div>
          ))}
        </>
      )}

      <SkillImportSection extensionsEnabled={on} />
      <SelfAuthoringSection
        selfAuthoringEnabled={caps?.selfAuthoringEnabled ?? false}
        extensionsEnabled={on}
        onChanged={reload}
      />
    </section>
  )
}

/** 一行操作按钮共用的忙碌判定：整表扫描中、或这一行正在被处置 */
const skillRowDisabled = (scanning: boolean, acting: string | null, key: string) =>
  scanning || (acting !== null && acting !== key)

/**
 * 从别的 agent 应用导入技能。
 *
 * 两个界面必须说实话的地方：
 * —— 导入是软链接，不是复制。所以「原应用里删了这条技能」这边就变失效链接，
 *    列表里要单列出来让用户一键清掉，否则技能目录里长出一堆点不开的残骸。
 * —— 加载开关关着时，导入只是把链接摆好，助手并不会用它。这句话不写出来，
 *    用户下一次对话发现没反应，只会以为按钮坏了。
 */
function SkillImportSection({ extensionsEnabled }: { extensionsEnabled: boolean }) {
  const [view, setView] = useState<SkillScanView | null>(null)
  const [scanning, setScanning] = useState(false)
  const [acting, setActing] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [app, setApp] = useState('all')
  const [page, setPage] = useState(1)

  /** 扫描 + 保持最短可感知时长：几百毫秒的忙碌一闪而过，等于没说它动过 */
  const runScan = useCallback(async (quiet?: string) => {
    setScanning(true)
    const start = Date.now()
    const v = await window.torra.assistantSkillsScan()
    const elapsed = Date.now() - start
    if (elapsed < 800) await new Promise((res) => setTimeout(res, 800 - elapsed))
    setScanning(false)
    setView(v)
    setMsg(quiet ?? (v.ok ? `扫描完成：${v.total} 条技能，已导入 ${v.imported} 条` : v.reason ?? '扫描失败'))
    return v
  }, [])

  const act = async (s: DiscoveredSkill) => {
    setActing(s.key)
    const start = Date.now()
    const r = s.imported
      ? await window.torra.assistantSkillsRemove(s.linkName ?? s.name)
      : await window.torra.assistantSkillsImport({ key: s.key, name: s.name })
    const elapsed = Date.now() - start
    if (elapsed < 800) await new Promise((res) => setTimeout(res, 800 - elapsed))
    setActing(null)
    if (!r.ok) {
      setMsg(`${s.name}：${r.reason ?? '操作失败'}`)
      return
    }
    setMsg(`${s.name}：${r.reason ?? '完成'}`)
    await runScan(msgKeep(r.reason ?? '完成'))
  }

  const cleanDangling = async () => {
    if (!view?.dangling.length) return
    setActing('dangling')
    const names = view.dangling.map((d) => d.name)
    const start = Date.now()
    const rs = await Promise.all(names.map((n) => window.torra.assistantSkillsRemove(n)))
    const elapsed = Date.now() - start
    if (elapsed < 800) await new Promise((res) => setTimeout(res, 800 - elapsed))
    setActing(null)
    const bad = rs.filter((r) => !r.ok)
    await runScan(bad.length ? `清掉了 ${names.length - bad.length} 条，还有 ${bad.length} 条要手动处理` : `已清理 ${names.length} 条失效链接`)
  }

  const all = useMemo(() => (view?.apps ?? []).flatMap((a) => a.skills), [view])
  const appsWithSkills = useMemo(
    () => (view?.apps ?? []).filter((a) => a.skills.length > 0 || !a.missing),
    [view],
  )
  const kw = q.trim().toLowerCase()
  const rows = useMemo(() => {
    const list = all
      .filter((s) => (app === 'all' ? true : s.appId === app))
      .filter((s) => (kw ? s.name.toLowerCase().includes(kw) || s.description.toLowerCase().includes(kw) : true))
    // 能用的排前面：几百条里先给能导入的，失效的沉到最后但不出现在看不见的地方
    return [...list].sort((a, b) => Number(b.loadable) - Number(a.loadable) || a.name.localeCompare(b.name))
  }, [all, app, kw])
  const SKILL_SIZE = 8
  const { rows: skillRows, safePage } = pageSlice(rows, page, SKILL_SIZE)
  useEffect(() => setPage(1), [q, app])

  return (
    <section className="st-section">
      <h3 className="st-sec-title st-sub">
        从其他应用导入技能
      </h3>
      <p className="st-desc">
        一键扫描 Claude Code / Codex / Qoder / WorkBuddy / Trae 等应用放在各自目录里的技能，
        以<strong>软链接</strong>接进 Torra —— 不复制内容，原应用更新了这边跟着变；移除导入也只断开链接，不动源目录。
      </p>

      <div className="st-row">
        <div className="st-grow">
          <div className="st-name">技能扫描</div>
          <div className="st-meta">
            {view ? (
              <>
                {view.total} 条，已导入 {view.imported} 条 · 扫描自 <code>{view.home}</code>
              </>
            ) : (
              '还没扫描过'
            )}
            {msg && <span className="st-gap st-accent">{msg}</span>}
          </div>
        </div>
        <button className="st-btn" onClick={() => void runScan()} disabled={scanning || acting !== null}>
          {scanning ? <RefreshCw size={12} className="spin" /> : <ScanSearch size={12} />}
          {view ? '重新扫描' : '开始扫描'}
        </button>
      </div>

      {view?.skillsDir && (
        <p className="st-desc">
          导入目标 <code>{view.skillsDir}</code>
        </p>
      )}

      {view && !extensionsEnabled && (
        <p className="st-note warn">
          <AlertTriangle size={10} /> 上面的「加载技能 / 扩展」开关还关着：现在导入只是把链接摆好，助手不会用它。
        </p>
      )}

      {view && view.dangling.length > 0 && (
        <div className="st-row">
          <div className="st-grow">
            <div className="st-name st-warn">
              失效链接 {view.dangling.length} 条
            </div>
            <div className="st-meta">
              {view.dangling
                .slice(0, 3)
                .map((d) => `${d.name} → ${d.target}`)
                .join('；')}
              {view.dangling.length > 3 ? '…' : ''}
            </div>
          </div>
          <button className="st-btn" onClick={() => void cleanDangling()} disabled={scanning || acting !== null}>
            {acting === 'dangling' ? <RefreshCw size={12} className="spin" /> : <Trash2 size={12} />}
            一键清理
          </button>
        </div>
      )}

      {view && (
        <>
          <div className="st-filter">
            <div className="search-box">
              <Search size={13} />
              <input
                type="text"
                placeholder="搜索技能名称或说明"
                value={q}
                onChange={(e) => setQ(e.target.value)}
              />
            </div>
            <select className="st-input st-fit" value={app} onChange={(e) => setApp(e.target.value)}>
              <option value="all">全部应用</option>
              {appsWithSkills.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.displayName}（{a.skills.length}）
                </option>
              ))}
            </select>
          </div>

          {appsWithSkills.length === 0 && view.total === 0 && (
            <p className="st-note warn">没有扫描到任何技能：这些应用要么没装，要么技能没放在上面列出的目录里。</p>
          )}

          <div className="st-list st-list-sm">
            {skillRows.map((s) => (
              <div key={s.key} className="st-row">
              <div className="st-grow">
                <div className="st-name">
                  {s.name}
                  <span className="st-chip">{s.appDisplayName}</span>
                  {s.imported && (
                    <span className="st-chip on">
                      {s.linkKind === 'copy' ? '已复制导入' : '已链接'}
                      {s.linkName ? ` · ${s.linkName}` : ''}
                    </span>
                  )}
                </div>
                <div className="st-meta">{s.description || '（没有 description，助手不会加载）'}</div>
                <div className="st-path" title={s.path}>
                  {s.path}
                </div>
                {s.warnings.length > 0 && (
                  <div className="st-note warn">
                    <AlertTriangle size={10} /> {s.warnings.join('；')}
                  </div>
                )}
              </div>
              <button
                className={`st-icon${s.imported ? ' danger' : ''}`}
                title={
                  s.imported
                    ? '断开导入（只删 Torra 里的链接，源技能不动）'
                    : s.loadable
                      ? s.kind === 'file'
                        ? '复制导入（单文件技能没有可链接的目录）'
                        : '以软链接导入'
                      : '这条技能加载不了，先修好原文件再导入'
                }
                disabled={skillRowDisabled(scanning, acting, s.key) || (!s.imported && !s.loadable)}
                onClick={() => void act(s)}
              >
                {acting === s.key ? <RefreshCw size={12} className="spin" /> : s.imported ? <Link2Off size={12} /> : <Link2 size={12} />}
              </button>
            </div>
            ))}
          </div>
          {rows.length === 0 && view.total > 0 && (
            <div className="st-meta st-tight">没有匹配的技能</div>
          )}
          <Pager page={safePage} pageSize={SKILL_SIZE} total={rows.length} onPage={setPage} />
        </>
      )}
    </section>
  )
}

/** 处置完一条技能后重扫，把刚做的那件事留在提示行里，而不是被「扫描完成」盖掉 */
function msgKeep(done: string): string {
  return `${done}（已刷新列表）`
}

/**
 * 自建工具 / 插件：助手往自己身上装东西的那条链路，最后由这一页收口。
 *
 * 三层各有各的生效条件，混着说就一定有人理解错，所以分开讲：
 * —— 插件清单（*.plugin.json）是数据不是代码，不受「加载技能 / 扩展」开关约束，
 *    但删掉也不等于那个工具立刻消失 —— 工具是装配会话时注册的，下一次对话才少掉它。
 * —— 待审扩展是任意 JS：启用它 = 把文件搬进 extensions/，之后直接跑在主进程里，
 *    不过确认卡片。所以这里摆的是源码本身，不是助手对它的描述。
 * 每一层的写动作在主进程都会弹确认卡片；这一页只负责「装完看得见、随时能拆」。
 */
function SelfAuthoringSection({
  selfAuthoringEnabled,
  extensionsEnabled,
  onChanged,
}: {
  selfAuthoringEnabled: boolean
  extensionsEnabled: boolean
  /** 开关与增删都会改变会话装配结果，让上层重读一次 capabilities */
  onChanged: () => void
}) {
  const [view, setView] = useState<PluginListView | null>(null)
  const [pending, setPending] = useState<PendingExtensionView[]>([])
  const [busy, setBusy] = useState(false)
  const [acting, setActing] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)

  const reload = useCallback(async () => {
    const [plugins, pend] = await Promise.all([window.torra.assistantPlugins(), window.torra.assistantPending()])
    setView(plugins)
    setPending(pend)
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  /** 提示只留 5 秒，但内容必须说实话：结果文案全部用主进程返回的 reason */
  const say = (text: string) => {
    setMsg(text)
    setTimeout(() => setMsg(null), 5000)
  }

  const toggle = async () => {
    const next = !selfAuthoringEnabled
    setBusy(true)
    setMsg(null)
    const start = Date.now()
    const r = await window.torra.assistantSetSelfAuthoring(next)
    // 改动生效很快，但快到手就看不见；和「刷新状态」一样补个最短可感知时长
    const elapsed = Date.now() - start
    if (elapsed < 800) await new Promise((res) => setTimeout(res, 800 - elapsed))
    setBusy(false)
    setMsg(
      r.ok
        ? next
          ? '已开启：助手可以写插件清单 / 技能 / 待审扩展（每一次都仍会弹卡片问你）'
          : '已关闭：那几个自建工具不再注册，已有的清单和技能不动'
        : r.reason ?? '切换失败',
    )
    void reload()
    onChanged()
    setTimeout(() => setMsg(null), 5000)
  }

  /** 行内动作：整表忙碌时其他行禁用，只有点的那一行转 spinner */
  const act = async (key: string, label: string, run: () => Promise<AssistantResult>) => {
    setActing(key)
    const start = Date.now()
    const r = await run()
    const elapsed = Date.now() - start
    if (elapsed < 800) await new Promise((res) => setTimeout(res, 800 - elapsed))
    setActing(null)
    say(`${label}：${r.reason ?? (r.ok ? '完成' : '操作失败')}`)
    await reload()
    onChanged()
  }

  const rowDisabled = (key: string) => busy || (acting !== null && acting !== key)
  const plugins = view?.plugins ?? []
  const invalid = view?.invalid ?? []

  return (
    <section className="st-section">
      <h3 className="st-sec-title st-sub">
        自建工具 / 插件
      </h3>
      <p className="st-desc">
        助手可以给自己装工具：一个 <code>*.plugin.json</code> 声明式清单、一份 SKILL.md 技能、
        或一个写在待审区的 JS 扩展。这一页就是这几样东西的账本 —— 有什么、从哪个文件来、能不能拆掉。
      </p>

      <div className="st-row">
        <div className="st-grow">
          <div className="st-name">允许助手自建工具</div>
          <div className="st-meta">
            {selfAuthoringEnabled ? (
              <span className="ok">
                <CheckCircle size={10} /> 已开启
              </span>
            ) : (
              <span>已关闭（推荐）</span>
            )}
            {msg && <span className="st-gap">{msg}</span>}
          </div>
          {selfAuthoringEnabled && (
            <div className="st-meta">
              开着时助手能往这台机器写插件清单、技能与待审扩展；这些动作每一个都会弹确认卡片。
            </div>
          )}
        </div>
        <button className="st-btn" onClick={() => void toggle()} disabled={busy}>
          {busy ? <RefreshCw size={12} className="spin" /> : null}
          {selfAuthoringEnabled ? '关闭' : '开启'}
        </button>
      </div>

      {view && (
        <p className="st-desc">
          插件目录 <code>{view.dir}</code>
        </p>
      )}

      <h3 className="st-sec-title st-sub">
        插件清单
      </h3>
      <p className="st-desc">
        清单是数据，所以<strong>不受上面「加载技能 / 扩展」开关约束</strong>；除 GET/HEAD 外每次运行都会弹确认卡片。
        <strong>删除只影响下一次对话</strong> —— 这一轮里已经注册的工具不会立刻消失。
      </p>
      {plugins.length === 0 && invalid.length === 0 && (
        <div className="st-meta st-tight">
          目录里还没有插件清单{selfAuthoringEnabled ? '：开着自建时，助手写的清单会出现在这里' : ''}
        </div>
      )}
      <div className="st-list">
        {plugins.map((p) => {
          const key = `p:${p.name}`
          return (
            <div key={p.file} className="st-row">
              <div className="st-grow">
                <div className="st-name">
                  {p.label || p.name}
                  <span className="st-chip">{p.kind === 'shell' ? '本机命令' : 'HTTP'}</span>
                  <span className="st-chip">{CONFIRM_LABEL[p.confirm]}</span>
                  {!p.enabled && <span className="st-chip">清单里已停用</span>}
                </div>
                <div className="st-meta">{p.description || '（清单没写 description）'}</div>
                <div className="st-meta">
                  <code>{p.file}</code>
                </div>
              </div>
              <button
                className="st-icon danger"
                title={`删除插件清单「${p.name}」（只删这个文件，下一次对话才不再注册）`}
                disabled={rowDisabled(key)}
                onClick={() => void act(key, `删除 ${p.name}`, () => window.torra.assistantPluginRemove(p.name))}
              >
                {acting === key ? <RefreshCw size={12} className="spin" /> : <Trash2 size={12} />}
              </button>
            </div>
          )
        })}
        {invalid.map((e) => (
          <div key={`${e.file}-${e.name}`} className="st-row">
            <div className="st-grow">
              <div className="st-name st-warn">
                {e.name || '未知清单'}（读不出来）
              </div>
              <div className="st-meta">
                <code>{e.file}</code>
              </div>
              <div className="st-meta st-warn">
                {e.errors.join('；')}
              </div>
            </div>
          </div>
        ))}
      </div>

      <h3 className="st-sec-title st-sub">
        待审扩展
      </h3>
      <p className="st-desc">
        助手写出的 JS 扩展只会先进待审区，它不会自己生效：<strong>启用</strong>就是把文件搬进扩展目录，
        之后<strong>直接运行在主进程里</strong>，不经过确认卡片。所以下面放的是源码本身 ——
        审的是代码，不是助手对它功能的描述。
      </p>
      {pending.length === 0 && <div className="st-meta st-tight">待审区是空的</div>}
      {pending.length > 0 && !extensionsEnabled && (
        <p className="st-note warn">
          <AlertTriangle size={10} /> 上面的「加载技能 / 扩展」开关还关着：现在启用只是把文件搬进扩展目录，助手不会加载它。
        </p>
      )}
      <div className="st-list">
        {pending.map((p) => {
          const enableKey = `e:${p.name}:enable`
          const dropKey = `e:${p.name}:drop`
          // 预览行数从 preview 本身数出来：主进程截到第几行是它的实现细节，界面不该抄一个常量
          const shown = p.preview.split('\n').length
          return (
            <div key={p.file} className="st-row st-top">
              <div className="st-grow">
                <div className="st-name">
                  {p.name}
                  <span className="st-chip">{p.lines} 行 · {p.bytes} 字节</span>
                </div>
                <div className="st-meta">
                  <code>{p.file}</code>
                  {p.truncated && <span>共 {p.lines} 行，显示前 {shown} 行，其余看文件</span>}
                </div>
                <pre className="st-src">{p.preview}</pre>
              </div>
              <div className="st-btns">
                <button
                  className="st-icon"
                  title="启用：把文件搬进扩展目录，之后它会直接运行在主进程里；只有「加载技能 / 扩展」开着时才会被加载"
                  disabled={rowDisabled(enableKey)}
                  onClick={() => void act(enableKey, `启用 ${p.name}`, () => window.torra.assistantPendingEnable(p.name))}
                >
                  {acting === enableKey ? <RefreshCw size={12} className="spin" /> : <Play size={12} />}
                </button>
                <button
                  className="st-icon danger"
                  title="丢弃：只删待审区里这份文件，扩展目录不受影响"
                  disabled={rowDisabled(dropKey)}
                  onClick={() => void act(dropKey, `丢弃 ${p.name}`, () => window.torra.assistantPendingDrop(p.name))}
                >
                  {acting === dropKey ? <RefreshCw size={12} className="spin" /> : <X size={12} />}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/**
 * 主题选择。
 *
 * 三个选项里只有「跟随系统」需要问操作系统，另两个点了就直接变色；
 * 真正的权威值在主进程（它写 preferences.json），这里只等它回执纠正本地。
 */
function AppearanceSection() {
  const mode = useThemeMode()
  return (
    <section className="st-section">
      <h3 className="st-sec-title">主题</h3>
      <p className="st-desc">
        白天与黑夜是两套独立配色；「跟随系统」跟着 Windows 的深浅色设置走。
        选择立即生效，并记在本机 preferences.json 里，下次启动保持。
      </p>
      <div className="st-seg" role="group" aria-label="主题">
        {THEME_MODES.map((m) => (
          <button
            key={m}
            className={`st-seg-item${mode === m ? ' on' : ''}`}
            onClick={() => void chooseTheme(m)}
            aria-pressed={mode === m}
          >
            {THEME_LABEL[m]}
          </button>
        ))}
      </div>
    </section>
  )
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent)

/**
 * 一次 keydown 翻成 Electron Accelerator 串。
 *
 * 约定：普通键必须带修饰键（Ctrl/⌘/Alt/Shift 任一），F1–F12 可单独作全局热键 ——
 * 没有修饰键的字母键若被系统级接管，会把正常打字也拦掉。Escape 用作取消录制。
 */
function accelFromEvent(e: KeyboardEvent): string | null {
  if (e.repeat) return null
  const k = e.key
  if (k === 'Control' || k === 'Alt' || k === 'Meta' || k === 'Shift') return null
  if (k === 'Escape') return 'CANCEL'
  const mods: string[] = []
  // CommandOrControl：同一份配置在 Win/Linux 走 Ctrl、mac 走 ⌘
  if (e.metaKey && IS_MAC) mods.push('Command')
  else if (e.ctrlKey) mods.push('CommandOrControl')
  else if (e.metaKey) mods.push('Super')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  let base: string
  if (/^F\d{1,2}$/.test(k)) base = k
  else if (k === ' ') base = 'Space'
  else if (k === 'ArrowUp') base = 'Up'
  else if (k === 'ArrowDown') base = 'Down'
  else if (k === 'ArrowLeft') base = 'Left'
  else if (k === 'ArrowRight') base = 'Right'
  else if (k === 'Enter') base = 'Return'
  else if (k.length === 1) base = k.toUpperCase()
  else base = k
  const isFn = /^F\d{1,2}$/.test(base)
  if (mods.length === 0 && !isFn) return null
  return [...mods, base].join('+')
}

/** Accelerator 串渲染成人类可读的键名（mac 用符号，其它用 + 连接） */
function prettyAccel(a: string): string {
  if (!a) return '未设置'
  const map: Record<string, string> = {
    CommandOrControl: IS_MAC ? '⌘/Ctrl' : 'Ctrl',
    Command: '⌘',
    Control: IS_MAC ? '⌃' : 'Ctrl',
    Alt: IS_MAC ? '⌥' : 'Alt',
    Shift: '⇧',
    Super: IS_MAC ? '⌘' : 'Win',
    Return: '↵',
    Escape: 'Esc',
  }
  return a.split('+').map((t) => map[t] ?? t).join(IS_MAC ? ' ' : ' + ')
}

function HotkeySection() {
  const [st, setSt] = useState<HotkeyState | null>(null)
  const [recording, setRecording] = useState(false)
  const [preview, setPreview] = useState('')
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  useEffect(() => {
    void window.torra.getHotkey().then(setSt)
  }, [])

  // 录制中：捕获阶段拦截整页 keydown，翻成组合键后立刻落盘 + 重注册
  useEffect(() => {
    if (!recording) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      const acc = accelFromEvent(e)
      if (acc === null) return
      setRecording(false)
      if (acc === 'CANCEL') {
        setPreview('')
        return
      }
      setPreview(acc)
      void window.torra.setHotkey({ enabled: true, accel: acc }).then((r) => {
        setSt(r)
        setMsg(r.ok ? { kind: 'ok', text: `已设为 ${prettyAccel(acc)}` } : { kind: 'err', text: r.reason ?? '快捷键注册失败' })
      })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [recording])

  const toggleEnabled = async () => {
    if (!st) return
    const r = await window.torra.setHotkey({ enabled: !st.enabled, accel: st.accel })
    setSt(r)
    setMsg(null)
  }

  const status = !st
    ? ''
    : !st.enabled
      ? '已停用，不占用系统快捷键'
      : st.registered
        ? '生效中'
        : st.error ?? '未生效'

  return (
    <section className="st-section">
      <h3 className="st-sec-title">全局快捷键</h3>
      <p className="st-desc">
        设一个系统级组合键，随时唤起 Torra 或把它最小化：应用在前台时按下即最小化，其它时候按下会拉到前台。
        快捷键由操作系统接管，请避开已被其它程序占用的组合。
      </p>
      {st && (
        <div className="st-row">
          <div className="st-grow">
            <div className="st-name">启用组合键</div>
            <div className="st-meta">
              <span className={st.enabled && !st.registered ? 'warn' : undefined}>{status}</span>
            </div>
          </div>
          <div className="st-actions">
            <button
              className={`st-capture${recording ? ' rec' : ''}`}
              onClick={() => {
                setPreview('')
                setMsg(null)
                setRecording(true)
              }}
              title="点击后按下你想要的组合键（Esc 取消）"
              aria-label="录制快捷键"
            >
              {recording ? preview || '按下组合键…（Esc 取消）' : prettyAccel(st.accel)}
            </button>
            <button
              className={`st-switch${st.enabled ? ' on' : ''}`}
              role="switch"
              aria-checked={st.enabled}
              aria-label="启用全局快捷键"
              onClick={() => void toggleEnabled()}
            />
          </div>
        </div>
      )}
      {msg && <p className={`st-note ${msg.kind}`}>{msg.text}</p>}
    </section>
  )
}
