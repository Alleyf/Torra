import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ModelSummary } from '../store'
import '../settings.css'
import type { HotkeyState } from '@shared/types'
import type { CheckResult } from '@shared/diagnostics'
import { WebModelDialog } from './WebModelDialog'
import { ApiModelDialog } from './ApiModelDialog'
import { CodexProviderDialog } from './CodexProviderDialog'
import { MagpieImportDialog } from './MagpieImportDialog'
import { SmartAddDialog } from './SmartAddDialog'
import { DiagnosticsPanel, CheckRow } from './DiagnosticsPanel'
import { WebModelSection } from './WebModelSection'
import { ModelAvatar } from './ModelAvatar'
import { ConfigDefaultsSection } from './ConfigDefaultsSection'
import { AboutSection } from './AboutSection'
import { BackupSection } from './BackupSection'
import { MemorySection } from './MemorySection'
import type { DiscussionConfig, DiscussionConfigKey } from '../configDefaults'
import {
  Settings,
  Key,
  Plus,
  Check,
  CheckCircle,
  ChevronDown,
  ChevronRight,
  AlertTriangle,
  Trash2,
  Pencil,
  ArrowLeft,
  RefreshCw,
  Zap,
  Stethoscope,
  Sparkles,
  ScanSearch,
  Search,
  SunMoon,
  RotateCcw,
  SlidersHorizontal,
  Link2,
  Link2Off,
  Download,
  Play,
  Info,
  X,
  Boxes,
  ScrollText,
  Package,
  Puzzle,
  Blocks,
  ShieldCheck,
  CloudUpload,
  Gauge,
  Database,
  ImagePlus,
  LayoutGrid,
  FolderTree,
  FolderInput,
  GitBranch,
  Globe,
  Terminal,
  Bot,
  Briefcase,
  Code2,
  Compass,
  Users,
  CalendarClock,
  Pause,
} from 'lucide-react'
import { Pager, pageSlice } from './Pager'
import { LibCard, LibDetail, LibGrid, LibPill } from './LibraryCards'
import { THEME_LABEL, THEME_MODES, type ThemeMode } from '@shared/theme'
import { SKILL_CATALOG, SKILL_MARKETS, type SkillCatalogEntry } from '@shared/skill-catalog'
import {
  APPROVAL_MODES,
  APPROVAL_MODE_LABEL,
  APPROVE_TIMEOUT_MAX_MS,
  APPROVE_TIMEOUT_MIN_MS,
  SEARCH_PROVIDERS,
  SEARCH_PROVIDER_HINT,
  SEARCH_PROVIDER_LABEL,
  type AssistantApprovalMode,
  type AssistantApprovalPrefs,
  type AssistantSearchProvider,
  type AssistantSearchPrefsView,
} from '@shared/assistant'
import type {
  AssistantCapabilitiesView,
  AssistantModelView,
  AssistantPluginView,
  AssistantResult,
  DiscoveredSkill,
  LocalSkillView,
  PendingPluginListView,
  PendingPluginView,
  PluginListView,
  RepoSkillView,
  SkillRepoView,
  SkillLinkKind,
  SkillScanSummaryView,
  ScheduledTaskView,
  ScheduledTasksView,
  SkillSourceView,
} from '@shared/assistant'
import type { PluginListResult } from '@shared/plugins'
import {
  MEMORY_DIMS,
  MEMORY_TOP_K_MAX,
  memoryModelIdentity,
  type AssistantMemoryView,
  type MemoryRuntimeSource,
} from '@shared/memory'
import { AppPluginsSection } from './PluginManager'
import { chooseTheme, useThemeMode } from '../theme'

type Tab = 'models' | 'discussion' | 'doctor' | 'assistant' | 'appearance' | 'memory' | 'backup' | 'about'

const TABS: Array<{ id: Tab; label: string; icon: typeof Key }> = [
  { id: 'models', label: '模型管理', icon: Key },
  { id: 'discussion', label: '讨论参数', icon: SlidersHorizontal },
  { id: 'doctor', label: '诊断与日志', icon: Stethoscope },
  // 技能 / 插件 / 扩展的获取渠道与生效时机各不相同，所以收成一个「资源库」，
  // 内部再按渠道分页 —— 几个入口共用页签，才不会在导航里排成一列同义词。
  { id: 'assistant', label: '资源库', icon: Boxes },
  { id: 'appearance', label: '外观', icon: SunMoon },
  // 网页实例的内存去向与手动释放：属于「这台机器上的资源」，不是某个模型的配置
  { id: 'memory', label: '性能', icon: Gauge },
  // 备份的去处：数据不出本机，但得能换台机器接着用 —— 和「关于」挨着，
  // 都是整机级的东西，不是某个模型的配置文件
  { id: 'backup', label: '备份', icon: CloudUpload },
  // 版本、更新、数据目录 —— 都是「关于这台机器上的 Torra」，不是配置项
  { id: 'about', label: '关于', icon: Info },
]

export function SettingsPage({
  models,
  config,
  defaults,
  customizedDefaults,
  onBack,
  onModelsChanged,
  onDeleteModel,
  onResetConfig,
  onSetDefault,
  onRestoreFactoryDefaults,
}: {
  models: ModelSummary[]
  config: DiscussionConfig
  /** 生效默认（用户在设置页自设的那组），讨论参数区编辑的就是它 */
  defaults: DiscussionConfig
  /** 与出厂值不同的项，用于抬头小结与「恢复出厂默认」的可用态 */
  customizedDefaults: DiscussionConfigKey[]
  onBack: () => void
  onModelsChanged: () => Promise<void> | void
  onDeleteModel: (id: string) => Promise<void> | void
  onResetConfig: () => void
  onSetDefault: (key: DiscussionConfigKey, value: unknown) => void
  onRestoreFactoryDefaults: () => void
}) {
  const [showAddWeb, setShowAddWeb] = useState(false)
  const [showAddApi, setShowAddApi] = useState(false)
  const [showCodexProviders, setShowCodexProviders] = useState(false)
  const [showMagpie, setShowMagpie] = useState(false)
  // 正在编辑的 API 模型 id（null=不打开编辑弹窗）。编辑与新增共用同一个弹窗，只是入口不同。
  const [editApiId, setEditApiId] = useState<string | null>(null)
  const [showSmart, setShowSmart] = useState(false)
  const [showAddMenu, setShowAddMenu] = useState(false)
  const addMenuRef = useRef<HTMLDivElement>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('models')

  const apiModels = models.filter((m) => m.transport === 'api')
  const webModels = models.filter((m) => m.transport === 'webview')

  useEffect(() => {
    if (!showAddMenu) return
    const closeOnOutside = (event: MouseEvent) => {
      if (!addMenuRef.current?.contains(event.target as Node)) setShowAddMenu(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowAddMenu(false)
    }
    window.addEventListener('mousedown', closeOnOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      window.removeEventListener('mousedown', closeOnOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [showAddMenu])

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
      </aside>

      <div className="st-main">
        <div className="st-body">
          <div className="st-tool">
            <h2 className="st-h1">{TABS.find((t) => t.id === tab)?.label}</h2>
            <div className="st-tool-side">
              {/* 这颗按钮探的是模型登录态；摆在外观、关于这些页上，点了只动模型那一栏 */}
              {tab === 'models' && (
                <>
                  {refreshMsg && <span className="st-inline-msg">{refreshMsg}</span>}
                  <button className="st-btn" onClick={() => void handleRefreshAll()} disabled={refreshing}>
                    <RefreshCw size={12} className={refreshing ? 'spin' : ''} />
                    {refreshing ? '刷新中…' : '刷新状态'}
                  </button>
                </>
              )}
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
                  <div className={`st-add-menu${showAddMenu ? ' open' : ''}`} ref={addMenuRef}>
                    <button
                      type="button"
                      className="st-btn primary st-add-trigger"
                      aria-haspopup="menu"
                      aria-expanded={showAddMenu}
                      onClick={() => setShowAddMenu((open) => !open)}
                    >
                      <Plus size={12} />
                      添加模型
                      <ChevronDown size={11} className="st-add-caret" />
                    </button>
                    {showAddMenu && (
                      <div className="st-add-pop" role="menu" aria-label="选择添加模型的方式">
                        <button
                          type="button"
                          role="menuitem"
                          className="st-add-item featured"
                          onClick={() => {
                            setShowAddMenu(false)
                            setShowSmart(true)
                          }}
                        >
                          <span className="st-add-icon"><ScanSearch size={14} /></span>
                          <span className="st-add-copy">
                            <strong>智能添加</strong>
                            <small>只给一个地址，自动识别页面或端点</small>
                          </span>
                          <span className="st-add-badge">推荐</span>
                        </button>
                        <div className="st-add-sep" />
                        <button
                          type="button"
                          role="menuitem"
                          className="st-add-item"
                          onClick={() => {
                            setShowAddMenu(false)
                            setShowAddApi(true)
                          }}
                        >
                          <span className="st-add-icon"><Zap size={14} /></span>
                          <span className="st-add-copy">
                            <strong>API 模型</strong>
                            <small>使用服务商提供的 API Key</small>
                          </span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="st-add-item"
                          onClick={() => {
                            setShowAddMenu(false)
                            setShowCodexProviders(true)
                          }}
                        >
                          <span className="st-add-icon"><Link2 size={14} /></span>
                          <span className="st-add-copy">
                            <strong>复用 Codex Provider</strong>
                            <small>导入本机已有的 Codex 配置</small>
                          </span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="st-add-item"
                          onClick={() => {
                            setShowAddMenu(false)
                            setShowMagpie(true)
                          }}
                        >
                          <span className="st-add-icon"><Download size={14} /></span>
                          <span className="st-add-copy">
                            <strong>从 magpie 导入</strong>
                            <small>读取本机 magpie 中已配置的模型</small>
                          </span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          className="st-add-item"
                          onClick={() => {
                            setShowAddMenu(false)
                            setShowAddWeb(true)
                          }}
                        >
                          <span className="st-add-icon"><Plus size={14} /></span>
                          <span className="st-add-copy">
                            <strong>网页模型</strong>
                            <small>登录网页后直接对话</small>
                          </span>
                        </button>
                      </div>
                    )}
                  </div>
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
                  API 模型
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

            <WebModelSection
              webModels={webModels}
              onModelsChanged={onModelsChanged}
              onDeleteModel={async (id) => {
                await onDeleteModel(id)
                await onModelsChanged()
              }}
            />

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

        {tab === 'discussion' && (
          <ConfigDefaultsSection
            config={config}
            defaults={defaults}
            customized={customizedDefaults}
            onReset={onResetConfig}
            onSetDefault={onSetDefault}
            onRestoreFactory={onRestoreFactoryDefaults}
          />
        )}

        {tab === 'doctor' && (
          <DiagnosticsPanel
            modelIds={models.map((m) => ({ id: m.id, displayName: m.displayName, transport: m.transport }))}
          />
        )}

        {tab === 'assistant' && <LibrarySection />}

        {tab === 'appearance' && (
          <>
            <AppearanceSection />
            <HotkeySection />
          </>
        )}

        {tab === 'backup' && <BackupSection />}

        {tab === 'memory' && <MemorySection />}

        {tab === 'about' && <AboutSection />}
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

      {showCodexProviders && (
        <CodexProviderDialog
          onClose={() => setShowCodexProviders(false)}
          onImported={onModelsChanged}
        />
      )}

      {showMagpie && (
        <MagpieImportDialog
          onClose={() => setShowMagpie(false)}
          onImported={onModelsChanged}
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

  const handlePickIcon = async () => {
    setNote(null)
    const result = await window.torra.pickModelIcon(model.id)
    if (!result.ok) {
      if (!result.canceled) setNote(result.reason ?? '选择图标失败')
      return
    }
    await onSaved()
  }

  const handleClearIcon = async () => {
    setNote(null)
    const result = await window.torra.clearModelIcon(model.id)
    if (!result.ok) {
      setNote(result.reason ?? '清除图标失败')
      return
    }
    await onSaved()
  }

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
        <ModelAvatar model={model} fontSize={12} className="st-avatar" />
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
            {/* 多模型端点要说在行上：用户得知道这一条开场时可按座位换模型，不是只有一个 */}
            {(model.availableModels?.length ?? 0) > 1 && (
              <span className="ok"> · {model.availableModels!.length} 个模型可切换</span>
            )}
          </div>
        </div>
        <div className="st-actions">
          {model.userDefined && (
            <button
              className="st-icon"
              title={model.iconUrl ? '更换自定义图标' : '为这个模型选择本机图标'}
              aria-label={`为「${model.displayName}」选择图标`}
              onClick={() => void handlePickIcon()}
            >
              <ImagePlus size={11} />
            </button>
          )}
          {model.userDefined && model.iconUrl && (
            <button
              className="st-icon"
              title="清除自定义图标，回到品牌图标"
              aria-label={`清除「${model.displayName}」的自定义图标`}
              onClick={() => void handleClearIcon()}
            >
              <X size={11} />
            </button>
          )}
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
 * 在线搜索：总开关 + Provider + 密钥。
 *
 * 三件事必须分开说清：
 * - 开关默认关：助手一旦能自己查网页，回答的来源就从本机状态变成了公网，
 *   这个权限要单独点一次才算给；
 * - Key 只进系统钥匙串，这里只显示「配没配」：保存后输入框立刻清空，
 *   界面上永远不回显明文，日志和会话记录里也不会有它；
 * - 「测试搜索」真发一次请求（默认 1 条），用来区分「没配好」和「配好了但没结果」。
 */
function SearchSection() {
  const [prefs, setPrefs] = useState<AssistantSearchPrefsView | null>(null)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const reload = useCallback(() => {
    void window.torra.assistantSearchPrefs().then(setPrefs)
  }, [])

  useEffect(reload, [reload])

  /** 提示至少停留 5 秒：失败原因要能读完，不然用户只会看见按钮闪了一下 */
  const flash = (text: string) => {
    setMsg(text)
    window.setTimeout(() => setMsg((m) => (m === text ? null : m)), 5000)
  }

  const provider = prefs?.provider ?? 'tavily'
  const enabled = prefs?.enabled ?? false

  /** 落盘很快，但快到手就看不见：补个最短可感知时长，和别的开关一致 */
  const settle = async <T,>(r: Promise<T>): Promise<T> => {
    setBusy(true)
    const started = Date.now()
    try {
      return await r
    } finally {
      const elapsed = Date.now() - started
      if (elapsed < 500) await new Promise((res) => setTimeout(res, 500 - elapsed))
      setBusy(false)
    }
  }

  const applyPrefs = async (patch: { enabled?: boolean; provider?: AssistantSearchProvider }) => {
    const r = await settle(window.torra.assistantSetSearchPrefs(patch))
    flash(r.ok ? '已保存' : r.reason ?? '保存失败')
    reload()
  }

  const saveKey = async () => {
    const k = key.trim()
    if (!k) return
    const r = await settle(window.torra.assistantSetSearchKey({ provider, key: k }))
    // 无论成败都清掉输入框：失败时留着等于把密钥摊在界面上，成功时更不该留
    setKey('')
    flash(r.ok ? `已保存「${SEARCH_PROVIDER_LABEL[provider]}」的密钥到系统钥匙串` : r.reason ?? '保存失败')
    reload()
  }

  const clearKey = async () => {
    const r = await settle(window.torra.assistantClearSearchKey(provider))
    flash(r.ok ? '已清除密钥' : r.reason ?? '清除失败')
    reload()
  }

  const test = async () => {
    const r = await settle(window.torra.assistantTestSearch(provider))
    flash(
      r.ok
        ? `连通正常，命中 ${r.count} 条${r.first ? `，首条：${r.first}` : ''}${r.ms !== undefined ? `（${r.ms} ms）` : ''}`
        : r.reason ?? '测试失败',
    )
  }

  return (
    <section className="st-section">
      <p className="st-desc">
        助手回答问题前可以自己联网查一次资料。<strong>默认关闭</strong>：打开后回答的来源就从本机状态变成了公网，
        所以它单独生效，和资源库里别的开关互不影响。
      </p>

      {!prefs && <div className="st-meta">读取搜索配置…</div>}

      <div className="st-row">
        <div className="st-grow">
          <div className="st-name">允许助手联网搜索</div>
          <div className="st-meta">
            {enabled ? (
              <span className="ok">
                <CheckCircle size={10} /> 已开启：助手可按需调用搜索工具
              </span>
            ) : (
              <span>已关闭：助手只用本机信息和你给的内容回答</span>
            )}
          </div>
        </div>
        <button
          className={`st-switch${enabled ? ' on' : ''}`}
          role="switch"
          aria-checked={enabled}
          aria-label="允许助手联网搜索"
          disabled={!prefs || busy}
          onClick={() => void applyPrefs({ enabled: !enabled })}
        />
      </div>

      <div className="st-sub">搜索服务</div>
      <div className="st-opt-list">
        {SEARCH_PROVIDERS.map((p) => (
          <button
            key={p}
            type="button"
            className={`st-opt${provider === p ? ' on' : ''}`}
            disabled={!prefs || busy}
            onClick={() => void applyPrefs({ provider: p })}
          >
            <span className="st-opt-name">
              {SEARCH_PROVIDER_LABEL[p]}
              {p === 'tavily' && <em className="st-opt-tag">默认</em>}
            </span>
            <span className="st-opt-desc">{SEARCH_PROVIDER_HINT[p]}</span>
          </button>
        ))}
      </div>

      <div className="st-sub">API 密钥（{SEARCH_PROVIDER_LABEL[provider]}）</div>
      <div className="st-row">
        <input
          type="password"
          className="st-input st-long"
          value={key}
          disabled={busy}
          aria-label={`${SEARCH_PROVIDER_LABEL[provider]} 的 API 密钥`}
          placeholder={prefs?.hasKey ? '已保存，输入新值即替换' : provider === 'tavily' ? 'tvly-...' : '可不填（匿名额度）'}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && key.trim()) void saveKey()
          }}
        />
        <button className="st-btn primary" disabled={busy || !key.trim()} onClick={() => void saveKey()}>
          {busy ? <RefreshCw size={12} className="spin" /> : <Check size={12} />}
          保存
        </button>
        <button className="st-btn danger" disabled={busy || !prefs?.hasKey} onClick={() => void clearKey()}>
          <Trash2 size={12} />
          清除
        </button>
        <button className="st-btn" disabled={busy} onClick={() => void test()}>
          {busy ? <RefreshCw size={12} className="spin" /> : <Search size={12} />}
          测试搜索
        </button>
      </div>
      <div className="st-meta">
        {prefs?.hasKey ? (
          <span className="ok">
            <CheckCircle size={10} /> 已配置：保存在系统钥匙串里（引用名 <code>assistant:search:{provider}</code>），
            助手、日志和界面都读不到明文
          </span>
        ) : provider === 'tavily' ? (
          <span className="warn">
            <AlertTriangle size={10} /> 未配置：Tavily 必须填 Key，否则助手一搜索就会直接报错
          </span>
        ) : (
          <span className="warn">
            <AlertTriangle size={10} /> 未配置：AnySearch 可以匿名用，但额度很少，建议填上
          </span>
        )}
      </div>

      {prefs && !prefs.keychainAvailable && (
        <p className="st-note warn">
          <AlertTriangle size={10} /> 系统钥匙串不可用：密钥保存会被拒绝。先在本机解锁登录钥匙串（Windows 凭据管理器）再试。
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
 * 本地记忆库（memvid）。
 *
 * 三块各自回答一个问题，顺序就是「没它能不能用」：
 * 1. 运行时 —— 没有 memvid 可执行文件，别的都动不了；
 * 2. 嵌入端点 —— 没有它只能按关键词检索（中文基本搜不到），配了才叫语义检索；
 * 3. 记忆库文件 —— 一个 .mv2 一个库，检索工具靠为它生成的 kind:'memory' 清单注册。
 *
 * 下载是 137MB 的外网动作：点一下立刻返回，进度靠轮询 memoryView()；重复点击不会并发第二份。
 * 嵌入 Key 只进系统钥匙串，界面只显示「配没配」。
 */
const MEMORY_SOURCE_LABEL: Record<MemoryRuntimeSource, string> = {
  configured: '手动指定',
  managed: '托管下载',
  path: '系统 PATH',
  none: '未找到',
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function MemoryPanel() {
  const [view, setView] = useState<AssistantMemoryView | null>(null)
  const [form, setForm] = useState<{ baseUrl: string; model: string; dims: number } | null>(null)
  const [key, setKey] = useState('')
  const [storeName, setStoreName] = useState('')
  const [acting, setActing] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [openStore, setOpenStore] = useState<AssistantMemoryView['stores'][number] | null>(null)

  const reload = useCallback(async () => {
    setView(await window.torra.assistantMemoryView())
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // 输入框只在第一次拿到配置时种一次：之后每次保存都重读 view，
  // 若每次都覆盖，用户正改到一半的文字会被弹回去
  useEffect(() => {
    if (!view) return
    setForm((f) => f ?? { baseUrl: view.prefs.baseUrl, model: view.prefs.model, dims: view.prefs.dims })
  }, [view])

  // 安装进度只在主进程里：这里 700ms 轮询一次，直到 phase 不再是 download/extract
  const install = view?.runtime.install
  const installing = install?.phase === 'download' || install?.phase === 'extract'
  useEffect(() => {
    if (!installing) return
    const timer = window.setTimeout(() => void reload(), 700)
    return () => window.clearTimeout(timer)
  }, [installing, install?.received, install?.phase, reload])

  const flash = (text: string) => {
    setMsg(text)
    window.setTimeout(() => setMsg((m) => (m === text ? null : m)), 6000)
  }

  /** 一次只放一个动作跑；最短 500ms 的可感知时长，免得状态一闪而过 */
  const act = async (id: string, run: () => Promise<{ ok: boolean; reason?: string }>, okText?: string) => {
    setActing(id)
    const started = Date.now()
    try {
      const r = await run()
      const text = r.ok ? okText ?? r.reason ?? '完成' : r.reason ?? '操作失败'
      const elapsed = Date.now() - started
      if (elapsed < 500) await new Promise((res) => setTimeout(res, 500 - elapsed))
      flash(text)
      return r.ok
    } finally {
      setActing(null)
      void reload()
    }
  }

  const runtime = view?.runtime
  const pct =
    install?.phase === 'download' && install.total > 0
      ? Math.min(100, Math.round((install.received / install.total) * 100))
      : undefined

  return (
    <section className="st-section">
      <p className="st-desc">
        每个库可以生成一条 <code>kind: memory</code> 的插件清单，「检索这个库」于是成了一个可插拔的工具。
        检索只把查询文本发给你配的嵌入端点，库内容不出本机。
      </p>

      {!view && <div className="st-meta">读取记忆配置…</div>}

      {/* 1. 运行时 */}
      <div className="st-sub">运行时（memvid）</div>
      <div className="st-row">
        <div className="st-grow">
          <div className="st-name">
            {runtime?.ok ? (
              <span className="ok">
                <CheckCircle size={10} /> 可用
                {runtime.version ? ` · ${runtime.version}` : ''} · {MEMORY_SOURCE_LABEL[runtime.source]}
              </span>
            ) : (
              <span className="warn">
                <AlertTriangle size={10} /> {runtime ? MEMORY_SOURCE_LABEL[runtime.source] : '读取中'}
              </span>
            )}
          </div>
          <div className="st-meta">
            {runtime?.path ? <code>{runtime.path}</code> : runtime?.reason ?? '还没找到 memvid 可执行文件'}
          </div>
          {runtime && !runtime.ok && <div className="st-path">托管目录：{runtime.managedDir}</div>}
          {installing && (
            <div className="st-meta">
              {install.phase === 'download'
                ? `下载中 ${pct ?? 0}% · ${fmtBytes(install.received)}${install.total > 0 ? ` / ${fmtBytes(install.total)}` : ''}`
                : '下载完成，正在解压…'}
            </div>
          )}
          {install?.phase === 'failed' && (
            <div className="st-meta st-warn">上次安装失败：{install.reason ?? '未知原因'}</div>
          )}
        </div>
        <button
          className="st-btn primary"
          disabled={acting !== null || installing}
          onClick={() => void act('install', () => window.torra.assistantMemoryInstall(), '已开始下载，进度见上方')}
        >
          {acting === 'install' || installing ? <RefreshCw size={12} className="spin" /> : <Download size={12} />}
          {runtime?.ok ? '重新下载' : '下载运行时'}
        </button>
        <button
          className="st-btn"
          disabled={acting !== null}
          title="已经有 memvid 可执行文件时直接指定它"
          onClick={() => void act('exe', () => window.torra.assistantMemorySetRuntime(), '已指定运行时')}
        >
          <Package size={12} /> 指定文件
        </button>
        {view?.prefs.exe && (
          <button
            className="st-btn danger"
            disabled={acting !== null}
            title="清空手动指定的路径，回到「托管下载 / 系统 PATH」"
            onClick={() => void act('exe-clear', () => window.torra.assistantMemorySetRuntime(''), '已清空手动指定的运行时')}
          >
            <Link2Off size={12} /> 清空指定
          </button>
        )}
      </div>
      <div className="st-meta">
        下载自 npm 平台包 <code>@memvid/cli-win32-x64</code>（约 137MB，含 JVM 依赖），装进上面的托管目录；
        只下载一次，重复点击不会并发。
      </div>

      {/* 2. 嵌入端点 */}
      <div className="st-sub">嵌入端点（语义检索用）</div>
      <p className="st-meta">
        任意 OpenAI 兼容的 <code>/embeddings</code> 端点。Torra 自己分块、自己算向量，memvid 只存不算 ——
        所以 Key 不会被 memvid 拿去发别的请求。维度必须与模型一致，写错了查不到任何东西。
      </p>
      <div className="st-row">
        <input
          type="text"
          className="st-input st-long"
          aria-label="嵌入端点地址"
          placeholder="https://api.openai.com/v1"
          value={form?.baseUrl ?? ''}
          disabled={acting !== null || !form}
          onChange={(e) => setForm((f) => (f ? { ...f, baseUrl: e.target.value } : f))}
        />
        <input
          type="text"
          className="st-input"
          aria-label="嵌入模型名"
          placeholder="text-embedding-3-small"
          value={form?.model ?? ''}
          disabled={acting !== null || !form}
          onChange={(e) => setForm((f) => (f ? { ...f, model: e.target.value } : f))}
        />
        <select
          className="st-input"
          aria-label="向量维度"
          value={form?.dims ?? 1536}
          disabled={acting !== null || !form}
          onChange={(e) => setForm((f) => (f ? { ...f, dims: Number(e.target.value) } : f))}
        >
          {MEMORY_DIMS.map((d) => (
            <option key={d} value={d}>
              {d} 维 · {memoryModelIdentity(d)}
            </option>
          ))}
        </select>
        <button
          className="st-btn primary"
          disabled={acting !== null || !form}
          onClick={() =>
            void act('embed-save', () =>
              window.torra.assistantMemorySetEmbedding({
                baseUrl: form?.baseUrl ?? '',
                model: form?.model ?? '',
                dims: form?.dims ?? 1536,
              }),
            )
          }
        >
          {acting === 'embed-save' ? <RefreshCw size={12} className="spin" /> : <Check size={12} />}
          保存
        </button>
      </div>
      <div className="st-row">
        <input
          type="password"
          className="st-input st-long"
          aria-label="嵌入 API Key"
          placeholder={view?.hasKey ? '已保存，输入新值即替换' : '多数本地端点可不填'}
          value={key}
          disabled={acting !== null}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && key.trim()) {
              const k = key.trim()
              void act('key', async () => {
                const r = await window.torra.assistantMemorySetKey(k)
                setKey('')
                return r
              }, '已保存嵌入 Key 到系统钥匙串')
            }
          }}
        />
        <button
          className="st-btn primary"
          disabled={acting !== null || !key.trim()}
          onClick={() => {
            const k = key.trim()
            void act(
              'key',
              async () => {
                const r = await window.torra.assistantMemorySetKey(k)
                // 成败都清空：失败时留着等于把密钥摊在界面上
                setKey('')
                return r
              },
              '已保存嵌入 Key 到系统钥匙串',
            )
          }}
        >
          <Key size={12} /> 保存 Key
        </button>
        <button
          className="st-btn danger"
          disabled={acting !== null || !view?.hasKey}
          onClick={() => void act('key-clear', () => window.torra.assistantMemoryClearKey(), '已清除嵌入 Key')}
        >
          <Trash2 size={12} /> 清除
        </button>
        <button
          className="st-btn"
          disabled={acting !== null || !form?.baseUrl?.trim() || !form?.model?.trim()}
          onClick={() =>
            void act('test', async () => {
              const r = await window.torra.assistantMemoryTestEmbedding()
              return {
                ok: r.ok,
                reason: r.ok ? `连通正常：返回 ${r.dims} 维向量${r.ms !== undefined ? `（${r.ms} ms）` : ''}` : r.reason,
              }
            })
          }
        >
          {acting === 'test' ? <RefreshCw size={12} className="spin" /> : <Zap size={12} />}
          测试嵌入
        </button>
      </div>
      <div className="st-meta">
        {view?.hasKey ? (
          <span className="ok">
            <CheckCircle size={10} /> 已配置 Key（系统钥匙串 <code>assistant:memory:embed</code>，界面与日志都读不到明文）
          </span>
        ) : (
          <span>未配置 Key：本地端点（Ollama、LM Studio 等）通常不需要</span>
        )}
        {view && !view.keychainAvailable && (
          <span className="warn">
            <AlertTriangle size={10} /> 系统钥匙串不可用，Key 保存会被拒绝
          </span>
        )}
      </div>

      {/* 3. 库文件 */}
      <div className="st-sub">记忆库文件</div>
      <div className="st-row">
        <input
          type="text"
          className="st-input"
          aria-label="新记忆库名字"
          placeholder="库名（小写字母 / 数字 / 连字符）"
          value={storeName}
          disabled={acting !== null}
          onChange={(e) => setStoreName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && storeName.trim()) {
              const name = storeName.trim()
              void act('create', () => window.torra.assistantMemoryCreate(name), `已新建 ${name}.mv2`).then((ok) => {
                if (ok) setStoreName('')
              })
            }
          }}
        />
        <button
          className="st-btn primary"
          disabled={acting !== null || !storeName.trim()}
          onClick={() => {
            const name = storeName.trim()
            void act('create', () => window.torra.assistantMemoryCreate(name), `已新建 ${name}.mv2`).then((ok) => {
              if (ok) setStoreName('')
            })
          }}
        >
          {acting === 'create' ? <RefreshCw size={12} className="spin" /> : <Plus size={12} />}
          新建记忆库
        </button>
      </div>
      <p className="st-meta">
        新建要先用运行时；每库上限由 memvid 免费档决定（约 50MB）。删除只删这个库文件，已生成的插件清单要另外删。
      </p>

      {view && view.stores.length === 0 && (
        <div className="st-empty">还没有记忆库。新建一个之后，为它生成检索插件，助手就能在对话里用上它。</div>
      )}

      {view && view.stores.length > 0 && (
        <LibGrid>
          {view.stores.map((s) => {
            const id = `s:${s.file}`
            return (
              <LibCard
                key={s.file}
                icon={Database}
                onOpen={() => setOpenStore(s)}
                title={s.file}
                tone={s.error ? 'warn' : undefined}
                meta={
                  <>
                    {s.frames && <span className="st-chip">{s.frames} 帧</span>}
                    {s.usage && <span className="st-chip">{s.usage}</span>}
                    {!s.frames && s.bytes > 0 && <span className="st-chip">{fmtBytes(s.bytes)}</span>}
                  </>
                }
                action={
                  <LibPill
                    tone="brand"
                    busy={acting === id}
                    disabled={acting !== null}
                    title={`为 ${s.file} 生成 kind:'memory' 插件清单；下一次对话生效`}
                    onClick={() => void act(id, () => window.torra.assistantMemoryWritePlugin(s.file))}
                  >
                    生成插件
                  </LibPill>
                }
                footer={
                  <>
                    <span className="lib-card-path" title={s.path}>
                      {s.path}
                    </span>
                    <button
                      className="st-icon danger"
                      title={`删除 ${s.file}（只删这个文件，不能撤销）`}
                      disabled={acting !== null}
                      onClick={() => void act(`${id}:del`, () => window.torra.assistantMemoryRemove(s.file), `已删除 ${s.file}`)}
                    >
                      <Trash2 size={12} />
                    </button>
                  </>
                }
              >
                {s.error && (
                  <p className="lib-card-warn">
                    <AlertTriangle size={11} /> 读不到统计：{s.error}
                  </p>
                )}
              </LibCard>
            )
          })}
        </LibGrid>
      )}
      {openStore && (
        <LibDetail
          icon={Database}
          title={openStore.file}
          tone={openStore.error ? 'warn' : undefined}
          meta={
            <>
              {openStore.frames && <span className="st-chip">{openStore.frames} 帧</span>}
              {openStore.usage && <span className="st-chip">{openStore.usage}</span>}
              <span className="st-chip">{fmtBytes(openStore.bytes)}</span>
              {openStore.error && <span className="st-chip">读不到统计</span>}
            </>
          }
          desc="本地单文件记忆库（.mv2）。为它生成一条 kind: memory 的清单之后，「检索这个库」就是助手能调用的工具；写入仍然要你确认。"
          onClose={() => setOpenStore(null)}
          actions={
            <>
              <button className="st-btn" onClick={() => setOpenStore(null)}>
                关闭
              </button>
              <button
                className="st-btn"
                disabled={acting !== null}
                onClick={() => {
                  const f = openStore.file
                  void act(`s:${f}`, () => window.torra.assistantMemoryWritePlugin(f))
                }}
              >
                {acting === `s:${openStore.file}` ? <RefreshCw size={12} className="spin" /> : <Plus size={12} />}
                生成插件
              </button>
              <button
                className="st-btn danger"
                disabled={acting !== null}
                onClick={() => {
                  const f = openStore.file
                  setOpenStore(null)
                  void act(`s:${f}:del`, () => window.torra.assistantMemoryRemove(f), `已删除 ${f}`)
                }}
              >
                <Trash2 size={12} />
                删除库文件
              </button>
            </>
          }
        >
          <dl className="lib-detail-row">
            <dt>库文件</dt>
            <dd>{openStore.path}</dd>
          </dl>
          {openStore.modifiedAt && (
            <dl className="lib-detail-row plain">
              <dt>修改于</dt>
              <dd>{new Date(openStore.modifiedAt).toLocaleString()}</dd>
            </dl>
          )}
          {openStore.frames && (
            <dl className="lib-detail-row plain">
              <dt>统计</dt>
              <dd>
                {openStore.frames} 帧{openStore.usage ? ` · ${openStore.usage}` : ''}
              </dd>
            </dl>
          )}
          {openStore.error && (
            <p className="lib-card-warn">
              <AlertTriangle size={11} /> 读不到统计：{openStore.error}
            </p>
          )}
        </LibDetail>
      )}
      <p className="st-meta">
        检索工具一次最多返回 {MEMORY_TOP_K_MAX} 条；没配嵌入端点时只会按关键词检索 ——
        memvid 的分词不切中文，中文内容基本要靠语义检索。
      </p>

      {msg && (
        <p className="st-note ok">
          <CheckCircle size={10} /> {msg}
        </p>
      )}
    </section>
  )
}

/**
 * 资源库：助手能用的东西按「获取渠道」分成六页。
 *
 * 为什么分页：技能是链接进来的目录、自建工具是助手自己写的东西、记忆是本地库文件、
 * 应用是带面板的成套插件、权限是闸门 —— 这几样的获取渠道、生效时机与失败面
 * 差别够大。原来摊在一页里，想找「我那条坏清单」要滚过三块列表。
 *
 * 清单和扩展合成「自建工具」：它们是「助手给自己加工具」的两种信任级别
 * （数据 / 代码），拆两页会让「插件」在这一页和在「应用」页指两样东西 ——
 * 用户原话「这里的插件和扩展不知道有啥区别」。现在「插件」只指应用式插件。
 *
 * 技能不再单拆「来源」页：添加仓库、导入、看到已加载是同一条链上的三步，
 * 拆开之后「查找技能」在别的页签里，人得来回切才知道自己刚加的东西去哪了。
 *
 * 页头（标题 + 一句话说明）归外壳所有，子页不再各自写标题 —— 否则切页时三层同字号
 * 文字叠在一起，看不出主线。技能与扩展常开，没有总开关：资源库里只放用户自己的东西，
 * 关掉它没有安全收益，只会让人先去开一遍才算「装好」。
 */
type LibTab = 'skills' | 'tools' | 'schedule' | 'memory' | 'apps' | 'approval' | 'search'

const LIB_META: Record<LibTab, { title: string; sub: string }> = {
  skills: {
    title: '技能',
    sub: '技能目录里有什么就读什么；本机其他应用的技能也按应用分组列出，导入只建链接。',
  },
  tools: {
    title: '自建工具',
    sub: '一个工具 = 一份清单：实现写成数据（HTTP / 本地命令 / 记忆库）就下一次对话生效；写成脚本（kind=js）则先落待审区，人看过源码点启用才加载。',
  },
  schedule: {
    title: '定时',
    sub: '每天某一刻让后台助手跑一轮：抓取地址、整理内容、把成品写进任务目录；只在 Torra 运行期间触发，错过的那一天下次启动补跑一次。',
  },
  memory: { title: '记忆', sub: '本地单文件记忆库：写入永远要你确认，检索按语义或关键词走同一个库。' },
  apps: { title: '应用', sub: '带面板与工具的插件：代码跑在独立进程里，能做什么由它的能力清单约束。' },
  approval: { title: '权限', sub: '写操作的审批方式，以及是否允许助手自己写清单、技能与扩展。' },
  search: { title: '搜索', sub: '在线搜索的供应商与密钥：密钥只进系统钥匙串。' },
}

function LibrarySection() {
  const [caps, setCaps] = useState<AssistantCapabilitiesView | null>(null)
  // 插件清单不能走 capabilities：那是「上一次会话装配时」的快照，助手刚写完一条清单、
  // 还没重新对话时它是空的。这里直接读盘，页签计数和列表用的是同一份数据。
  const [plugView, setPlugView] = useState<PluginListView | null>(null)
  // 应用插件（带面板那类）与「自建工具」里的清单是两套数据：这里只要启用数，列表自己读
  const [appPlugins, setAppPlugins] = useState<PluginListResult | null>(null)
  // 待审区同样不靠 capabilities()：那份快照要等会话装配，第一条消息之前盘上明明有文件也是空的。
  const [pendingView, setPendingView] = useState<PendingPluginListView | null>(null)
  // 技能页不靠 capabilities()：那是上一次会话装配的快照，第一条消息之前 skills 恒为空。
  // 这里直接扫盘，页签计数与两个列表用同一份结果。
  const [skillView, setSkillView] = useState<SkillScanSummaryView | null>(null)
  // 定时任务读盘即可，不等调度器也不等会话装配
  const [schedView, setSchedView] = useState<ScheduledTasksView | null>(null)
  const [skillScanning, setSkillScanning] = useState(false)
  const [skillError, setSkillError] = useState<string | null>(null)
  const [tab, setTab] = useState<LibTab>('skills')

  const reload = useCallback(async () => {
    const [c, p, a, pend, sched] = await Promise.all([
      window.torra.assistantCapabilities(),
      window.torra.assistantPlugins(),
      window.torra.pluginsList(),
      window.torra.assistantPending(),
      window.torra.assistantScheduledTasks(),
    ])
    setCaps(c)
    setPlugView(p)
    setAppPlugins(a)
    setPendingView(pend)
    setSchedView(sched)
  }, [])

  // 每切一页都重读：清单 / 技能目录可能在别处刚被改过（拖进一个 *.plugin.json、删掉一个技能），
  // 只挂载时读一次的话，切回来看见的还是旧列表
  useEffect(() => {
    void reload()
  }, [reload, tab])

  // 进这一页就自动读盘，不要求用户先点一次「扫描」；切走再回来也重读，
  // 因为仓库导入、别的应用增删技能都可能在页面之外发生。
  const scanSkills = useCallback(async (): Promise<SkillScanSummaryView | null> => {
    setSkillScanning(true)
    try {
      const v = await window.torra.assistantSkillsScan()
      setSkillView(v)
      setSkillError(v.ok ? null : v.reason ?? '扫描失败')
      return v
    } catch (e) {
      setSkillError((e as Error).message)
      return null
    } finally {
      setSkillScanning(false)
    }
  }, [])

  useEffect(() => {
    if (tab === 'skills') void scanSkills()
  }, [scanSkills, tab])

  const errs = caps?.errors ?? []
  const meta = LIB_META[tab]
  const tabs: Array<{ id: LibTab; label: string; icon: typeof Key; n?: number }> = [
    { id: 'skills', label: '技能', icon: ScrollText, n: skillView?.local.length ?? caps?.skills?.length ?? 0 },
    {
      id: 'tools',
      label: '自建工具',
      icon: Puzzle,
      n: (plugView?.plugins?.length ?? 0) + (pendingView?.pending.length ?? 0),
    },
    { id: 'schedule', label: '定时', icon: CalendarClock, n: schedView?.tasks.length ?? 0 },
    { id: 'memory', label: '记忆', icon: Database },
    { id: 'apps', label: '应用', icon: LayoutGrid, n: appPlugins?.plugins.filter((p) => p.enabled).length ?? 0 },
    { id: 'approval', label: '权限', icon: ShieldCheck },
    { id: 'search', label: '搜索', icon: Search },
  ]

  return (
    <section className="st-section lib">
      <header className="lib-head">
        <span className="lib-eyebrow">资源库</span>
        <h2 className="lib-h1">{meta.title}</h2>
        <p className="lib-h1-sub">{meta.sub}</p>
      </header>

      <div className="lib-tabs" role="tablist" aria-label="资源库">
        {tabs.map((t) => {
          const Icon = t.icon
          return (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              className={`lib-tab${tab === t.id ? ' on' : ''}`}
              onClick={() => setTab(t.id)}
            >
              <Icon size={13} />
              {t.label}
              {t.n ? <span className="lib-n">{t.n}</span> : null}
            </button>
          )
        })}
      </div>

      {/* 加载失败的东西必须一直看得见：不报错就等于「以为生效了」 */}
      {errs.length > 0 && (
        <div className="lib-warn">
          <div className="st-name st-warn">
            <AlertTriangle size={11} /> {errs.length} 项加载失败
          </div>
          {errs.map((e) => (
            <div key={`${e.path}-${e.error}`} className="st-meta st-warn">
              <code>{e.path || '未知文件'}</code> · {e.error}
            </div>
          ))}
        </div>
      )}

      {tab === 'skills' && (
        <SkillTab
          view={skillView}
          scanning={skillScanning}
          error={skillError}
          onRefresh={scanSkills}
        />
      )}
      {tab === 'tools' && <SelfToolsTab pluginView={plugView} pendingView={pendingView} onChanged={reload} />}
      {tab === 'schedule' && <ScheduledTab view={schedView} onChanged={reload} />}
      {tab === 'memory' && <MemoryPanel />}
      {tab === 'apps' && <AppPluginsSection onChanged={reload} />}
      {tab === 'approval' && (
        <PermissionPanel
          selfAuthoringEnabled={caps?.selfAuthoringEnabled ?? false}
          onChanged={reload}
        />
      )}
      {tab === 'search' && <SearchSection />}
    </section>
  )
}

/** 定时任务的时间都按本地时区显示：用户写的是 08:00，看到的也必须是 08:00 */
function fmtTaskWhen(ms: number): string {
  return new Date(ms).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

/**
 * 定时页：一条任务一张卡，点开看完整指令与产出目录。
 *
 * 为什么「立即运行」也在卡片上：建完任务最想验的就是「它到底跑不跑得通」，
 * 而真正的到点要等到明天。手动一轮与定时一轮走的是同一条 run 路径，
 * 验过的就是明天要跑的那一套 —— 不要另做一个「测试模式」。
 */
function ScheduledTab({
  view,
  onChanged,
}: {
  view: ScheduledTasksView | null
  onChanged: () => Promise<void> | void
}) {
  const [openId, setOpenId] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [form, setForm] = useState(false)
  const [title, setTitle] = useState('')
  const [time, setTime] = useState('08:00')
  const [prompt, setPrompt] = useState('')
  const [retention, setRetention] = useState(30)
  const [outDir, setOutDir] = useState('')
  const [modelId, setModelId] = useState('')
  const [models, setModels] = useState<AssistantModelView[]>([])

  // 定时任务跑完会推一条：页面停在这一屏时也要当场看到最近一次的结果
  useEffect(() => {
    return window.torra.on('assistant:scheduled-changed', () => {
      void onChanged()
    })
  }, [onChanged])

  const openForm = () => {
    setForm(true)
    setMsg(null)
    void window.torra.assistantModels().then((ms) => {
      setModels(ms.filter((m) => m.transport === 'api' && m.enabled))
    })
  }

  const save = async () => {
    const t = title.trim()
    const p = prompt.trim()
    if (!t || !p) {
      setMsg({ ok: false, text: '任务名与指令都不能为空' })
      return
    }
    setBusy('new')
    try {
      const r = await window.torra.assistantScheduleTask({
        title: t,
        time,
        prompt: p,
        retentionDays: retention,
        ...(outDir.trim() ? { outDir: outDir.trim() } : {}),
        ...(modelId ? { modelId } : {}),
      })
      if (!r.ok) {
        setMsg({ ok: false, text: r.reason ?? '创建失败' })
        return
      }
      setForm(false)
      setTitle('')
      setPrompt('')
      setOutDir('')
      setModelId('')
      setMsg({ ok: true, text: `已创建 ${r.id ?? ''}：每天 ${time} 运行` })
      await onChanged()
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const runNow = async (task: ScheduledTaskView) => {
    setBusy(`run:${task.id}`)
    setMsg(null)
    try {
      const r = await window.torra.assistantRunScheduledTask(task.id)
      setMsg(
        r.ok
          ? { ok: true, text: `「${task.title}」跑完了：产出 ${r.files?.length ?? 0} 个文件` }
          : { ok: false, text: `「${task.title}」失败：${r.reason ?? '未知原因'}` },
      )
      await onChanged()
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(null)
    }
  }

  const toggle = async (task: ScheduledTaskView) => {
    setBusy(`toggle:${task.id}`)
    try {
      const r = await window.torra.assistantToggleScheduledTask(task.id, !task.enabled)
      if (!r.ok) setMsg({ ok: false, text: r.reason ?? '操作失败' })
      await onChanged()
    } finally {
      setBusy(null)
    }
  }

  const remove = async (task: ScheduledTaskView) => {
    setBusy(`del:${task.id}`)
    try {
      const r = await window.torra.assistantRemoveScheduledTask(task.id)
      if (r.ok) {
        setOpenId(null)
        setMsg({ ok: true, text: `已删除「${task.title}」；已写出的文件保留在原目录` })
      } else {
        setMsg({ ok: false, text: r.reason ?? '删除失败' })
      }
      await onChanged()
    } finally {
      setBusy(null)
    }
  }

  const tasks = view?.tasks ?? []
  const open = openId ? tasks.find((x) => x.id === openId) ?? null : null

  return (
    <section className="st-section">
      <div className="lib-bar">
        <span className="st-sec-title">每天定时执行</span>
        <span className="st-grow" />
        <button className="st-btn primary" disabled={busy !== null} onClick={openForm}>
          <Plus size={12} />
          新建任务
        </button>
      </div>

      {!view ? (
        <p className="st-meta">正在读取任务清单…</p>
      ) : tasks.length === 0 ? (
        <p className="st-meta">
          还没有定时任务。点「新建任务」，或者直接让助手「每天早上 8 点帮我抓某个地址整理成日报」——
          它会把任务建在这里。
        </p>
      ) : (
        <LibGrid>
          {tasks.map((t) => {
            const last = t.lastRun
            return (
              <LibCard
                key={t.id}
                icon={CalendarClock}
                title={t.title}
                meta={
                  <>
                    <span className="st-chip">每天 {t.time}</span>
                    {t.enabled ? null : <span className="st-chip">已停用</span>}
                    {t.nextRunAt ? <span className="st-chip">下次 {fmtTaskWhen(t.nextRunAt)}</span> : null}
                  </>
                }
                desc={t.prompt.length > 110 ? `${t.prompt.slice(0, 110)}…` : t.prompt}
                footer={
                  last ? (
                    <span className={last.ok ? 'ok' : 'warn'}>
                      {last.ok ? <CheckCircle size={10} /> : <AlertTriangle size={10} />} 最近 {fmtTaskWhen(last.startedAt)} ·{' '}
                      {last.ok ? `${last.files.length} 个文件` : (last.error ?? '失败')}
                    </span>
                  ) : (
                    <span>还没运行过</span>
                  )
                }
                action={
                  <LibPill
                    tone="plain"
                    busy={busy === `run:${t.id}`}
                    disabled={busy !== null}
                    title="立即跑一轮（与到点时同一条路径）"
                    onClick={() => void runNow(t)}
                  >
                    <Play size={11} />
                    {busy === `run:${t.id}` ? '运行中' : '立即运行'}
                  </LibPill>
                }
                onOpen={() => setOpenId(t.id)}
              />
            )
          })}
        </LibGrid>
      )}

      {view && <p className="st-meta">{view.note}</p>}

      {msg && (
        <p className={`st-note ${msg.ok ? 'ok' : 'warn'}`}>
          {msg.ok ? <CheckCircle size={10} /> : <AlertTriangle size={10} />} {msg.text}
        </p>
      )}

      {open && (
        <LibDetail
          icon={CalendarClock}
          title={open.title}
          meta={
            <>
              <span className="st-chip">每天 {open.time}</span>
              <span className="st-chip">{open.enabled ? '启用中' : '已停用'}</span>
              {open.nextRunAt ? <span className="st-chip">下次 {fmtTaskWhen(open.nextRunAt)}</span> : null}
            </>
          }
          desc="到点后由后台受限助手执行这条指令：只有抓取、写任务目录、列任务目录三样工具，不会改配置，也不会弹确认卡片。"
          onClose={() => setOpenId(null)}
          actions={
            <>
              <button className="st-btn" onClick={() => setOpenId(null)}>
                关闭
              </button>
              <button
                className="st-btn"
                disabled={busy !== null}
                onClick={() => void runNow(open)}
              >
                {busy === `run:${open.id}` ? <RefreshCw size={12} className="spin" /> : <Play size={12} />}
                立即运行
              </button>
              <button className="st-btn" disabled={busy !== null} onClick={() => void toggle(open)}>
                {busy === `toggle:${open.id}` ? <RefreshCw size={12} className="spin" /> : <Pause size={12} />}
                {open.enabled ? '停用' : '启用'}
              </button>
              <button className="st-btn danger" disabled={busy !== null} onClick={() => void remove(open)}>
                {busy === `del:${open.id}` ? <RefreshCw size={12} className="spin" /> : <Trash2 size={12} />}
                删除任务
              </button>
            </>
          }
        >
          <dl className="lib-detail-row plain">
            <dt>指令</dt>
            <dd>
              <pre className="lib-task-prompt">{open.prompt}</pre>
            </dd>
          </dl>
          <dl className="lib-detail-row">
            <dt>产出目录</dt>
            <dd>{open.outDir}</dd>
          </dl>
          <dl className="lib-detail-row plain">
            <dt>保留</dt>
            <dd>{open.retentionDays > 0 ? `${open.retentionDays} 天（按文件修改时间清理）` : '不自动清理'}</dd>
          </dl>
          {open.lastRun && (
            <dl className="lib-detail-row plain">
              <dt>最近一次</dt>
              <dd>
                {fmtTaskWhen(open.lastRun.startedAt)} · {open.lastRun.ok ? '成功' : `失败：${open.lastRun.error ?? '未知'}`} ·{' '}
                {Math.round(open.lastRun.ms / 1000)}s
                {open.lastRun.files.length > 0 && (
                  <div className="lib-run-files">
                    {open.lastRun.files.map((f) => (
                      <code key={f}>{f}</code>
                    ))}
                  </div>
                )}
                {open.lastRun.note && <p className="st-meta">{open.lastRun.note}</p>}
              </dd>
            </dl>
          )}
        </LibDetail>
      )}

      {form && (
        <LibDetail
          icon={CalendarClock}
          title="新建定时任务"
          desc="任务指令要写成一条能独立执行的完整指令：到点那一刻没有人在场补充说明。建完可以先点「立即运行」验一次。"
          onClose={() => setForm(false)}
          actions={
            <>
              <button className="st-btn" onClick={() => setForm(false)}>
                取消
              </button>
              <button className="st-btn primary" disabled={busy !== null} onClick={() => void save()}>
                {busy === 'new' ? <RefreshCw size={12} className="spin" /> : <Plus size={12} />}
                创建
              </button>
            </>
          }
        >
          <div className="lib-form">
            <label className="lib-form-row">
              <span>任务名</span>
              <input
                className="st-input st-long"
                value={title}
                maxLength={60}
                placeholder="例如 AIHOT 日报"
                onChange={(e) => setTitle(e.target.value)}
              />
            </label>
            <label className="lib-form-row">
              <span>每天</span>
              <input
                className="st-input lib-form-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
              />
            </label>
            <label className="lib-form-row">
              <span>保留天数</span>
              <input
                className="st-input lib-form-num"
                type="number"
                min={0}
                max={365}
                value={retention}
                onChange={(e) => setRetention(Math.max(0, Math.min(365, Number(e.target.value) || 0)))}
              />
              <span className="st-meta">0 = 不清理</span>
            </label>
            {models.length > 0 && (
              <label className="lib-form-row">
                <span>用模型</span>
                <select className="st-input st-long" value={modelId} onChange={(e) => setModelId(e.target.value)}>
                  <option value="">当前助手模型</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="lib-form-row">
              <span>产出目录</span>
              <input
                className="st-input st-long"
                value={outDir}
                placeholder="留空用应用默认目录"
                onChange={(e) => setOutDir(e.target.value)}
              />
            </label>
            <label className="lib-form-row col">
              <span>指令</span>
              <textarea
                className="st-input lib-form-text"
                value={prompt}
                placeholder="例如：抓取 https://example.com/api/daily ，整理出头条导读与整期目录，写到 2026-10-29.md"
                onChange={(e) => setPrompt(e.target.value)}
              />
            </label>
          </div>
        </LibDetail>
      )}
    </section>
  )
}

/** 来源应用的分组图标：先认出「这批技能是谁家的」，再读名字 */
const SKILL_APP_ICONS: Record<string, typeof Key> = {
  agents: Boxes,
  claude: Bot,
  codex: Terminal,
  qoder: Code2,
  workbuddy: Briefcase,
  trae: Compass,
  codebuddy: Users,
}

const SKILL_LINK_LABEL: Record<SkillLinkKind, string> = {
  junction: '目录链接',
  symlink: '软链接',
  copy: '复制副本',
}

/** 落盘快到手看不见：处置动作补一个最短可感知时长，别让按钮像没按下去 */
function sleepPad(start: number): Promise<void> {
  const elapsed = Date.now() - start
  return elapsed < 800 ? new Promise((res) => setTimeout(res, 800 - elapsed)) : Promise.resolve()
}

const skillRemoveLabel = (kind: SkillLinkKind | undefined) => (kind === 'copy' ? '移除副本' : '断开')

/**
 * 技能页：一个页面装下三条来源 —— 仓库缓存（资源库中）、技能目录、别的应用（AGENT 中已有）。
 *
 * 扫描在 LibrarySection 里自动跑（进这一页就读盘），两个列表共用同一份结果：
 * 「技能目录里现在有什么」和「别的应用里还有什么可以导」必须来自同一次读取，
 * 否则刚导入的那条会在一个列表里出现、另一个列表里还是旧状态。
 */
function SkillTab({
  view,
  scanning,
  error,
  onRefresh,
}: {
  view: SkillScanSummaryView | null
  scanning: boolean
  error: string | null
  onRefresh: () => Promise<SkillScanSummaryView | null>
}) {
  return (
    <>
      <SkillRepoSection />
      <SkillDirSection local={view?.local ?? []} scanning={scanning} error={error} onRefresh={onRefresh} />
      <SkillImportSection view={view} scanning={scanning} error={error} onRefresh={onRefresh} />
    </>
  )
}

/** 技能目录里现在真正有什么：直接读盘，不靠上一次会话装配的快照 */
function SkillDirSection({
  local,
  scanning,
  error,
  onRefresh,
}: {
  local: LocalSkillView[]
  scanning: boolean
  error: string | null
  onRefresh: () => Promise<SkillScanSummaryView | null>
}) {
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [open, setOpen] = useState<LocalSkillView | null>(null)
  const [acting, setActing] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const kw = q.trim().toLowerCase()
  const rows = useMemo(
    () =>
      local.filter(
        (s) => !kw || s.name.toLowerCase().includes(kw) || s.description.toLowerCase().includes(kw),
      ),
    [local, kw],
  )
  const SIZE = 9
  const { rows: shown, safePage } = pageSlice(rows, page, SIZE)
  useEffect(() => setPage(1), [q])

  const remove = async (s: LocalSkillView) => {
    if (!s.linkKind || acting) return
    setActing(s.linkName)
    const start = Date.now()
    try {
      const r = await window.torra.assistantSkillsRemove(s.linkName)
      await sleepPad(start)
      setMsg(r.ok ? `已移除「${s.name}」` : `${s.name}：${r.reason ?? '移除失败'}`)
      if (r.ok) await onRefresh()
    } finally {
      setActing(null)
    }
  }

  return (
    <>
      <h3 className="st-sec-title st-sub">技能目录</h3>
      <div className="lib-bar">
        <div className="search-box">
          <Search size={13} />
          <input
            type="text"
            placeholder="按名称或说明筛选"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <span className="lib-bar-n">
          {rows.length} / {local.length} 条
        </span>
        {msg && <span className="lib-bar-n st-accent">{msg}</span>}
      </div>

      {local.length === 0 ? (
        <div className="st-empty">
          {error
            ? `读取技能目录失败：${error}`
            : scanning
              ? '正在读取技能目录…'
              : '技能目录还是空的：在上面接一个仓库，或往下从别的应用导入。'}
        </div>
      ) : rows.length === 0 ? (
        <div className="st-empty">没有匹配「{q}」的技能</div>
      ) : (
        <LibGrid>
          {shown.map((s) => (
            <LibCard
              key={s.path}
              icon={ScrollText}
              title={s.name}
              meta={
                <>
                  <FolderTree size={11} />
                  技能目录
                  {s.linkKind && <span className="st-chip">{SKILL_LINK_LABEL[s.linkKind]}</span>}
                </>
              }
              action={
                s.linkKind ? (
                  <LibPill
                    busy={acting === s.linkName}
                    disabled={acting !== null && acting !== s.linkName}
                    title={
                      s.linkKind === 'copy'
                        ? '移除复制进来的那份副本（源技能不动）'
                        : '断开导入（只删 Torra 里的链接，源技能不动）'
                    }
                    onClick={() => void remove(s)}
                  >
                    {skillRemoveLabel(s.linkKind)}
                  </LibPill>
                ) : s.description ? undefined : (
                  <LibPill tone="warn">缺说明</LibPill>
                )
              }
              desc={s.description || '没有 description：助手看不到它，也用不上它'}
              footer={
                <span className="lib-card-path" title={s.path}>
                  {s.path}
                </span>
              }
              onOpen={() => setOpen(s)}
            />
          ))}
        </LibGrid>
      )}
      <Pager page={safePage} pageSize={SIZE} total={rows.length} onPage={setPage} />

      {open && (
        <LibDetail
          icon={ScrollText}
          title={open.name}
          meta={
            <>
              <span className="st-chip">技能目录</span>
              {open.linkKind && <span className="st-chip">{SKILL_LINK_LABEL[open.linkKind]}</span>}
              {!open.description && <span className="st-chip">缺说明</span>}
            </>
          }
          desc={open.description || '没有 description：助手看得到名称，但不知道什么时候该用它，实际上等于没装。'}
          onClose={() => setOpen(null)}
          actions={
            open.linkKind ? (
              <>
                <button className="st-btn" onClick={() => setOpen(null)}>
                  关闭
                </button>
                <button
                  className="st-btn danger"
                  disabled={acting !== null}
                  onClick={() => {
                    const cur = open
                    setOpen(null)
                    void remove(cur)
                  }}
                >
                  {acting === open.linkName ? <RefreshCw size={12} className="spin" /> : <Trash2 size={12} />}
                  {skillRemoveLabel(open.linkKind)}
                </button>
              </>
            ) : (
              <button className="st-btn" onClick={() => setOpen(null)}>
                关闭
              </button>
            )
          }
        >
          <dl className="lib-detail-row">
            <dt>位置</dt>
            <dd>{open.path}</dd>
          </dl>
          {open.linkKind && (
            <dl className="lib-detail-row">
              <dt>Torra 里</dt>
              <dd>{open.linkName}</dd>
            </dl>
          )}
          {open.source && (
            <dl className="lib-detail-row">
              <dt>来源</dt>
              <dd>{open.source}</dd>
            </dl>
          )}
          <p className="st-meta">
            {open.linkKind
              ? '这是导入进来的链接 / 副本：移除只断开 Torra 这一侧，原技能不动。'
              : '这一条就在技能目录里，每次对话装配时自动加载。要停用它，把它的目录移出技能目录即可。'}
          </p>
        </LibDetail>
      )}
    </>
  )
}

/**
 * 自建工具：助手给自己加工具的那一条路，一页答完。
 *
 * 一个工具 = 一份清单（*.plugin.json）。实现是数据（http / shell / memory）时，
 * 清单就是全部，下一次对话装配就生效；实现是代码（kind=js）时，清单旁边还有一份
 * 同名 .js，必须先落待审区、人看过源码点启用 —— 两种信任级别，同一个装载器。
 */
function SelfToolsTab({
  pluginView,
  pendingView,
  onChanged,
}: {
  pluginView: PluginListView | null
  pendingView: PendingPluginListView | null
  onChanged: () => void
}) {
  return (
    <>
      <PluginPanel view={pluginView} onChanged={onChanged} />
      <h3 className="st-sec-title st-sub">待审查</h3>
      <p className="st-desc">
        助手写的脚本工具只有先落在这里，进详情看过源码才会生效。<strong>启用</strong>就是把清单和源码一起搬进工具目录，
        之后每一场对话都会加载；<strong>丢弃</strong>只删待审文件，不影响任何已有配置。
      </p>
      <PendingToolsPanel view={pendingView} onChanged={onChanged} />
    </>
  )
}

/** 实现种类的中文说法：卡片上一眼能分清「发请求」「跑命令」「查记忆库」「跑脚本」 */
const KIND_LABEL: Record<AssistantPluginView['kind'], string> = {
  http: 'HTTP',
  shell: '本地命令',
  memory: '记忆库',
  js: '本地脚本',
}

const KIND_ICON: Record<AssistantPluginView['kind'], typeof Globe> = {
  http: Globe,
  shell: Terminal,
  memory: Database,
  js: Code2,
}

/**
 * 工具清单：磁盘上的全部自建工具（*.plugin.json，kind=js 还有同名源码）。
 *
 * 数据类清单的重点不是「危险」，而是「有哪些、要发什么请求、删掉会怎样」；
 * js 类多答一条「最近一次装配有没有真的把它装上」。删的是文件；
 * 这一轮对话已经注册进会话的工具不受影响。
 */
function PluginPanel({
  view,
  onChanged,
}: {
  view: PluginListView | null
  onChanged: () => void
}) {
  const [acting, setActing] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [open, setOpen] = useState<PluginListView['plugins'][number] | null>(null)
  const [openInvalid, setOpenInvalid] = useState<PluginListView['invalid'][number] | null>(null)

  /** 一次只放一个动作跑：并发删两条清单，失败原因就分不清是哪一条的了 */
  const act = async (key: string, label: string, run: () => Promise<AssistantResult>) => {
    setActing(key)
    const start = Date.now()
    const r = await run()
    const elapsed = Date.now() - start
    if (elapsed < 800) await new Promise((res) => setTimeout(res, 800 - elapsed))
    setActing(null)
    setMsg(`${label}：${r.reason ?? (r.ok ? '完成' : '操作失败')}`)
    // 删完要重读盘：列表和页签上的计数都来自上层那一份 view
    onChanged()
    setTimeout(() => setMsg(null), 5000)
  }

  const plugins = view?.plugins ?? []
  const invalid = view?.invalid ?? []
  const legacy = view?.legacy ?? []
  const rowDisabled = (key: string) => acting !== null && acting !== key

  return (
    <>
      <div className="lib-bar">
        <span className="lib-bar-n">{plugins.length} 个工具</span>
        {view && (
          <span className="lib-card-path" title={view.dir}>
            {view.dir}
          </span>
        )}
      </div>
      {msg && <p className="st-note">{msg}</p>}

      {/* 旧格式的 pi 扩展已不再装载：盘上还有就明说，别让它们静静地失效 */}
      {legacy.length > 0 && (
        <div className="lib-warn">
          <div className="st-name st-warn">
            <AlertTriangle size={11} /> {legacy.length} 个旧格式扩展已不再加载
          </div>
          {legacy.map((f) => (
            <div key={f.file} className="st-meta st-warn">
              <code>{f.file}</code> · 请改写成 kind=js 的自建工具（清单 + 同名 .js），或删掉它
            </div>
          ))}
        </div>
      )}

      {plugins.length === 0 && invalid.length === 0 && (
        <div className="st-empty">
          还没有工具。助手在「权限」页打开「允许自建工具」后会自己写，也可以手动放进上面的目录。
        </div>
      )}

      {(plugins.length > 0 || invalid.length > 0) && (
        <LibGrid>
          {plugins.map((p) => {
            const Icon = KIND_ICON[p.kind]
            return (
              <LibCard
                key={p.file}
                icon={Icon}
                title={p.label || p.name}
                meta={
                  <>
                    <span className="st-chip">{KIND_LABEL[p.kind]}</span>
                    <span className="st-chip">{CONFIRM_LABEL[p.confirm]}</span>
                    {p.kind === 'js' && <span className="st-chip">{p.lines ?? 0} 行脚本</span>}
                  </>
                }
                action={
                  <LibPill tone={!p.enabled ? 'warn' : p.loaded ? 'ok' : 'plain'}>
                    {!p.enabled ? '已停用' : p.loaded ? '已加载' : '待下一次对话'}
                  </LibPill>
                }
                onOpen={() => setOpen(p)}
                desc={p.description || '这份清单没写 description'}
                footer={
                  <span className="lib-card-path" title={p.file}>
                    {p.file}
                  </span>
                }
              />
            )
          })}
          {invalid.map((e) => (
            <LibCard
              key={`${e.file}-${e.name}`}
              tone="warn"
              icon={AlertTriangle}
              title={e.name || '未知清单'}
              meta={<span className="st-chip">格式不合法</span>}
              onOpen={() => setOpenInvalid(e)}
              footer={
                <span className="lib-card-path" title={e.file}>
                  {e.file}
                </span>
              }
            >
              <p className="lib-card-warn">{e.errors.join('；')}</p>
            </LibCard>
          ))}
        </LibGrid>
      )}

      {open && (
        <LibDetail
          icon={KIND_ICON[open.kind]}
          title={open.label || open.name}
          meta={
            <>
              <span className="st-chip">{KIND_LABEL[open.kind]}</span>
              <span className="st-chip">{CONFIRM_LABEL[open.confirm]}</span>
              <span className="st-chip">{open.loaded ? '已加载' : '待下一次对话'}</span>
            </>
          }
          desc={open.description || '这份清单没写 description'}
          onClose={() => setOpen(null)}
          actions={
            <>
              <button className="st-btn" onClick={() => setOpen(null)}>
                关闭
              </button>
              <button
                className="st-btn danger"
                disabled={acting !== null}
                onClick={() => {
                  const name = open.name
                  setOpen(null)
                  void act(`p:${name}`, `删除 ${name}`, () => window.torra.assistantPluginRemove(name))
                }}
              >
                <Trash2 size={12} />
                {open.kind === 'js' ? '删除清单与源码' : '删除清单'}
              </button>
            </>
          }
        >
          <dl className="lib-detail-row plain">
            <dt>工具名</dt>
            <dd>{open.name}</dd>
          </dl>
          <dl className="lib-detail-row">
            <dt>清单文件</dt>
            <dd>{open.file}</dd>
          </dl>
          {open.kind === 'js' && (
            <>
              <dl className="lib-detail-row">
                <dt>源码文件</dt>
                <dd>{open.codeFile ?? '(缺失)'}</dd>
              </dl>
              <dl className="lib-detail-row plain">
                <dt>脚本规模</dt>
                <dd>{open.lines ?? 0} 行</dd>
              </dl>
            </>
          )}
          {open.kind === 'memory' && (
            <dl className="lib-detail-row plain">
              <dt>检索库</dt>
              <dd>只读检索；写入走单独的记忆写入工具</dd>
            </dl>
          )}
          <p className="st-meta">
            {open.kind === 'js'
              ? '脚本跑在主进程里，参数由清单的 schema 定；启用前源码已经由人审过，每次调用照样弹确认卡片。'
              : '清单是数据不是代码：写操作与本地命令执行前照样弹确认卡片。'}
            删掉的是这份文件；这一轮对话里已经注册的工具不受影响。
          </p>
        </LibDetail>
      )}

      {openInvalid && (
        <LibDetail
          icon={AlertTriangle}
          title={openInvalid.name || '未知清单'}
          tone="warn"
          meta={<span className="st-chip">格式不合法</span>}
          desc="这份清单没通过校验，整条都不会注册。修好下面列出的问题再放回工具目录。"
          onClose={() => setOpenInvalid(null)}
          actions={
            <button className="st-btn" onClick={() => setOpenInvalid(null)}>
              关闭
            </button>
          }
        >
          <ul className="lib-detail-list">
            {openInvalid.errors.map((e, i) => (
              <li key={`${i}-${e}`}>
                <span>{e}</span>
              </li>
            ))}
          </ul>
          <dl className="lib-detail-row">
            <dt>文件</dt>
            <dd>{openInvalid.file}</dd>
          </dl>
        </LibDetail>
      )}
    </>
  )
}

/**
 * 待审区：助手写的脚本工具（清单 + 同名源码）在这里等人读。
 *
 * 启用动作本身就是那次批准 —— 所以卡片与详情里摆的必须是**源码本身**，
 * 而不是助手对源码的描述。读不出来或校验不过的条目也列出来，不静默丢掉。
 */
function PendingToolsPanel({
  view,
  onChanged,
}: {
  view: PendingPluginListView | null
  onChanged: () => void
}) {
  const [acting, setActing] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [openPending, setOpenPending] = useState<PendingPluginView | null>(null)

  const act = async (key: string, label: string, run: () => Promise<AssistantResult>) => {
    setActing(key)
    const start = Date.now()
    const r = await run()
    const elapsed = Date.now() - start
    if (elapsed < 800) await new Promise((res) => setTimeout(res, 800 - elapsed))
    setActing(null)
    setMsg(`${label}：${r.reason ?? (r.ok ? '完成' : '操作失败')}`)
    // 列表和页签计数都来自上层那份读盘结果
    onChanged()
    setTimeout(() => setMsg(null), 5000)
  }

  const pending = view?.pending ?? []
  const invalid = view?.invalid ?? []
  return (
    <>
      <div className="lib-bar">
        <span className="lib-bar-n">{pending.length} 份待审</span>
        {view && (
          <span className="lib-card-path" title={view.dir}>
            {view.dir}
          </span>
        )}
      </div>
      {msg && <p className="st-note">{msg}</p>}

      {pending.length === 0 && invalid.length === 0 && <div className="st-empty">没有待审的工具。</div>}
      {(pending.length > 0 || invalid.length > 0) && (
        <LibGrid>
          {pending.map((p) => (
            <LibCard
              key={p.file}
              icon={Blocks}
              title={p.label || p.name}
              meta={
                <>
                  <span className="st-chip">{KIND_LABEL[p.kind]}</span>
                  <span className="st-chip">
                    {p.lines} 行 · {p.bytes} 字节
                  </span>
                  {p.truncated && <span className="st-chip">源码较长</span>}
                </>
              }
              action={<LibPill tone="warn">待审查</LibPill>}
              desc="点开看源码：启用后它就跑在主进程里，每次调用仍然会弹确认卡片。"
              footer={
                <span className="lib-card-path" title={p.file}>
                  {p.file}
                </span>
              }
              onOpen={() => setOpenPending(p)}
            />
          ))}
          {invalid.map((e) => (
            <LibCard
              key={`${e.file}-${e.name}`}
              tone="warn"
              icon={AlertTriangle}
              title={e.name || '未知清单'}
              meta={<span className="st-chip">格式不合法</span>}
              footer={
                <span className="lib-card-path" title={e.file}>
                  {e.file}
                </span>
              }
            >
              <p className="lib-card-warn">{e.errors.join('；')}</p>
            </LibCard>
          ))}
        </LibGrid>
      )}

      {openPending && (
        <LibDetail
          icon={Blocks}
          title={openPending.label || openPending.name}
          tone="warn"
          meta={
            <>
              <span className="st-chip">{KIND_LABEL[openPending.kind]}</span>
              <span className="st-chip">待审查</span>
              <span className="st-chip">
                {openPending.lines} 行 · {openPending.bytes} 字节
              </span>
            </>
          }
          desc={openPending.description || '这份清单没写 description'}
          onClose={() => setOpenPending(null)}
          actions={
            <>
              <button className="st-btn" onClick={() => setOpenPending(null)}>
                关闭
              </button>
              <button
                className="st-btn danger"
                disabled={acting !== null}
                onClick={() => {
                  const name = openPending.name
                  void act(`e:${name}:drop`, `丢弃 ${name}`, () => window.torra.assistantPendingDrop(name)).then(() =>
                    setOpenPending(null)
                  )
                }}
              >
                {acting === `e:${openPending.name}:drop` ? <RefreshCw size={12} className="spin" /> : <X size={12} />}
                丢弃
              </button>
              <button
                className="st-btn primary"
                disabled={acting !== null}
                onClick={() => {
                  const name = openPending.name
                  void act(`e:${name}:enable`, `启用 ${name}`, () => window.torra.assistantPendingEnable(name)).then(() =>
                    setOpenPending(null)
                  )
                }}
              >
                {acting === `e:${openPending.name}:enable` ? <RefreshCw size={12} className="spin" /> : <Play size={12} />}
                启用
              </button>
            </>
          }
        >
          <dl className="lib-detail-row">
            <dt>待审清单</dt>
            <dd>{openPending.file}</dd>
          </dl>
          {openPending.codeFile && (
            <dl className="lib-detail-row">
              <dt>待审源码</dt>
              <dd>{openPending.codeFile}</dd>
            </dl>
          )}
          <pre className="lib-card-src">{openPending.preview}</pre>
          {openPending.truncated && (
            <p className="st-meta">
              这里只显示前若干行；完整源码在待审文件里，启用前请自己打开看完。
            </p>
          )}
        </LibDetail>
      )}
    </>
  )
}

/** 权限页：写操作审批 + 「允许助手自建工具」。两样都是闸门，得放在一起看 */
function PermissionPanel({
  selfAuthoringEnabled,
  onChanged,
}: {
  selfAuthoringEnabled: boolean
  onChanged: () => void
}) {
  return (
    <>
      <ApprovalSection />
      <SelfAuthoringToggle selfAuthoringEnabled={selfAuthoringEnabled} onChanged={onChanged} />
    </>
  )
}
/** 一行操作按钮共用的忙碌判定：整表扫描中、或这一行正在被处置 */
const skillRowDisabled = (scanning: boolean, acting: string | null, key: string) =>
  scanning || (acting !== null && acting !== key)

function SkillRepoSection() {
  const [view, setView] = useState<SkillRepoView | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [acting, setActing] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [kwInput, setKwInput] = useState('')
  const [kw, setKw] = useState('')
  const [onlyStale, setOnlyStale] = useState(false)
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<RepoSkillView[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  const [openSource, setOpenSource] = useState<SkillSourceView | null>(null)
  const [openSkill, setOpenSkill] = useState<RepoSkillView | null>(null)

  const reload = useCallback(async () => {
    setBusy(true)
    try {
      const v = await window.torra.assistantRepoView()
      setView(v)
      setPage(1)
      return v
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  // 输入停 250ms 再查，别每敲一个字都往主进程发一次
  useEffect(() => {
    const t = setTimeout(() => setKw(kwInput.trim().toLowerCase()), 250)
    return () => clearTimeout(t)
  }, [kwInput])
  useEffect(() => {
    setPage(1)
  }, [kw, onlyStale])

  // 每页只取 9 条：过滤、排序、切片都在主进程做，渲染层不存全量
  const REPO_SIZE = 9
  useEffect(() => {
    if (!view) return
    const my = ++seq.current
    setLoading(true)
    void window.torra
      .assistantRepoSkills({ kw, onlyStale, offset: (page - 1) * REPO_SIZE, limit: REPO_SIZE })
      .then((r) => {
        if (my !== seq.current) return
        setRows(r.rows)
        setTotal(r.total)
        const pages = Math.max(1, Math.ceil(r.total / REPO_SIZE))
        if (page > pages) setPage(pages)
      })
      .catch((e) => {
        if (my === seq.current) setMsg({ ok: false, text: (e as Error).message })
      })
      .finally(() => {
        if (my === seq.current) setLoading(false)
      })
  }, [view, kw, onlyStale, page])

  const add = async () => {
    const input0 = input.trim()
    if (!input0 || busy) return
    setBusy(true)
    setMsg(null)
    try {
      const r = await window.torra.assistantRepoAdd(input0)
      if (!r.ok) {
        setMsg({ ok: false, text: r.reason ?? '添加失败' })
      } else {
        setInput('')
        setMsg({ ok: true, text: `已拉取 ${r.addedSkills ?? 0} 条技能进资源库` })
        await reload()
      }
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setBusy(false)
    }
  }

  const refresh = async (sourceId: string) => {
    setActing(sourceId)
    setMsg(null)
    try {
      const r = await window.torra.assistantRepoRefresh(sourceId)
      setMsg(r.ok ? { ok: true, text: '来源已更新到最新' } : { ok: false, text: r.reason ?? '更新失败' })
      await reload()
    } finally {
      setActing(null)
    }
  }

  const removeSource = async (sourceId: string) => {
    setActing(sourceId)
    setMsg(null)
    try {
      const r = await window.torra.assistantRepoRemove(sourceId)
      setMsg(r.ok ? { ok: true, text: '已移除来源与缓存（已导入的链接断开后可在下方清理）' } : { ok: false, text: r.reason ?? '移除失败' })
      await reload()
    } finally {
      setActing(null)
    }
  }

  const imp = async (key: string) => {
    setActing(key)
    setMsg(null)
    try {
      const r = await window.torra.assistantRepoImport(key)
      setMsg(r.ok ? { ok: true, text: `已导入为 ${r.linkName ?? '技能'}（下一次对话生效）` } : { ok: false, text: r.reason ?? '导入失败' })
      await reload()
    } finally {
      setActing(null)
    }
  }

  // 内置来源：只是入口，点下去才走 assistantRepoAdd 下载缓存，页面本身不联网
  const addPreset = async (entry: SkillCatalogEntry) => {
    const id = `github:${entry.ref}`
    if (acting || busy) return
    setActing(id)
    setMsg(null)
    try {
      const r = await window.torra.assistantRepoAdd(entry.ref)
      if (!r.ok) {
        setMsg({ ok: false, text: `${entry.name}：${r.reason ?? '拉取失败'}` })
        return
      }
      setMsg({ ok: true, text: `${entry.name}：已拉取 ${r.addedSkills ?? 0} 条技能进资源库` })
      await reload()
    } catch (e) {
      setMsg({ ok: false, text: (e as Error).message })
    } finally {
      setActing(null)
    }
  }

  // 已添加的直接沉到下面「来源」里，这里不再重复摆一张卡
  const presets = useMemo(() => {
    const added = new Set((view?.sources ?? []).map((s) => s.id))
    return SKILL_CATALOG.filter((c) => !added.has(`github:${c.ref}`))
  }, [view])

  const staleCount = (view?.updates ?? []).filter((u) => !u.upToDate).length
  const pages = Math.max(1, Math.ceil(total / REPO_SIZE))
  const safePage = Math.min(pages, Math.max(1, page))

  return (
    <section className="st-section">
      <h3 className="st-sec-title st-sub">资源库中</h3>
      <div className="lib-bar">
        <div className="search-box wide">
          <Search size={13} />
          <input
            type="text"
            placeholder="owner/repo、GitHub 链接，或本机上的文件夹路径"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void add()
            }}
          />
        </div>
        <button className="st-btn" onClick={() => void add()} disabled={busy || !input.trim()}>
          {busy ? <RefreshCw size={12} className="spin" /> : <Download size={12} />}
          添加来源
        </button>
      </div>
      {msg && <p className={msg.ok ? 'st-note' : 'st-note warn'}>{msg.text}</p>}

      {view && presets.length > 0 && (
        <>
          <h4 className="st-sec-title st-sub">常用来源</h4>
          <LibGrid>
            {presets.map((c) => (
              <LibCard
                key={c.ref}
                icon={GitBranch}
                title={c.name}
                meta={
                  <>
                    <span className="st-chip">{c.tag}</span>
                    <span className="st-chip">{c.ref}</span>
                  </>
                }
                desc={c.blurb}
                action={
                  <LibPill
                    tone="brand"
                    busy={acting === `github:${c.ref}`}
                    disabled={acting !== null || busy}
                    title={`拉取 ${c.ref} 并缓存到本机`}
                    onClick={() => void addPreset(c)}
                  >
                    添加
                  </LibPill>
                }
                footer={
                  <span className="lib-card-path" title={`https://github.com/${c.ref}`}>
                    github.com/{c.ref}
                  </span>
                }
              />
            ))}
          </LibGrid>
        </>
      )}
      <p className="st-meta">
        去别处找：
        {SKILL_MARKETS.map((m, i) => (
          <span key={m.url}>
            {i > 0 ? ' · ' : ''}
            <a className="ext-link" href={m.url} target="_blank" rel="noopener noreferrer" title={m.note}>
              {m.name}
            </a>
          </span>
        ))}
      </p>

      {view && view.sources.length > 0 && (
        <>
          <div className="lib-bar">
            <span className="lib-bar-n">
              {view.sources.length} 个来源 · {view.total} 条技能
              {staleCount > 0 ? ` · ${staleCount} 个有更新` : ''}
            </span>
            <label className="st-chip" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={onlyStale}
                onChange={(e) => setOnlyStale(e.target.checked)}
                style={{ marginRight: 4 }}
              />
              只看有更新的来源
            </label>
          </div>
          <p className="st-meta">
            缓存目录 <code>{view.repoDir}</code>
          </p>
        </>
      )}

      {view && view.sources.length > 0 ? (
        <LibGrid>
          {view.sources.map((s) => {
            const upd = view.updates.find((u) => u.sourceId === s.id)
            const stale = upd ? !upd.upToDate : false
            return (
              <LibCard
                key={s.id}
                icon={s.kind === 'github' ? GitBranch : FolderInput}
                title={s.name}
                tone={stale || s.lastError ? 'warn' : undefined}
                meta={
                  <>
                    <span className="st-chip">{s.kind === 'github' ? 'GitHub' : '本地'}</span>
                    <span className="st-chip">{s.skillCount} 条技能</span>
                    <span className="st-chip">
                      {s.fetchedAt > 0 ? `缓存于 ${new Date(s.fetchedAt).toLocaleDateString()}` : '未拉取'}
                    </span>
                  </>
                }
                action={stale ? <LibPill tone="warn">有更新</LibPill> : <LibPill>已缓存</LibPill>}
                desc={s.kind === 'github' ? `仓库 ${s.ref}` : `本地目录 ${s.ref}`}
                footer={
                  <span className="lib-card-path" title={s.ref}>
                    {s.ref}
                  </span>
                }
                onOpen={() => setOpenSource(s)}
              >
                {s.lastError && (
                  <p className="lib-card-warn">
                    <AlertTriangle size={11} /> 上次拉取失败：{s.lastError}
                  </p>
                )}
              </LibCard>
            )
          })}
        </LibGrid>
      ) : (
        view && (
          <div className="st-empty">还没有来源：点上面的常用来源，或自己输入 owner/repo、本机文件夹路径。</div>
        )
      )}

      {view && view.sources.length > 0 && (
        <>
          <div className="lib-bar">
            <div className="search-box">
              <Search size={13} />
              <input
                type="text"
                placeholder="搜索资源库里的技能"
                value={kwInput}
                onChange={(e) => setKwInput(e.target.value)}
              />
            </div>
            <span className="lib-bar-n">
              {loading ? '正在加载…' : kw || onlyStale ? `${total} 条匹配` : `${view?.total ?? 0} 条在库里`}
            </span>
          </div>
          {rows.length > 0 ? (
            <LibGrid>
              {rows.map((s) => (
                <LibCard
                  key={s.key}
                  icon={ScrollText}
                  title={s.name}
                  tone={s.loadable ? undefined : 'warn'}
                  meta={
                    <>
                      <span className="st-chip">{s.sourceName}</span>
                      {s.imported && <span className="st-chip">已链接</span>}
                      {!s.loadable && <span className="st-chip">加载不了</span>}
                    </>
                  }
                  action={
                    <LibPill
                      tone={s.imported ? 'plain' : 'brand'}
                      busy={acting === s.key}
                      disabled={acting !== null || s.imported || !s.loadable}
                      title={
                        s.imported
                          ? '已在技能目录里'
                          : s.loadable
                            ? '以软链接导入（目录型指进缓存，缓存更新即跟随）'
                            : '这条技能加载不了，先修好原文件再导入'
                      }
                      onClick={s.imported ? undefined : () => void imp(s.key)}
                    >
                      {s.imported ? '已链接' : '导入'}
                    </LibPill>
                  }
                  desc={s.description || '没有 description：助手不会加载这条技能'}
                  footer={
                    <span className="lib-card-path" title={s.relPath}>
                      {s.relPath}
                    </span>
                  }
                  onOpen={() => setOpenSkill(s)}
                >
                  {s.warnings.length > 0 && (
                    <p className="lib-card-warn">
                      <AlertTriangle size={11} /> {s.warnings.join('；')}
                    </p>
                  )}
                </LibCard>
              ))}
            </LibGrid>
          ) : (
            <p className="st-note">{kw || onlyStale ? '没有匹配的技能。' : '这个来源下还没有技能。'}</p>
          )}
          <Pager page={safePage} pageSize={REPO_SIZE} total={total} onPage={setPage} />
        </>
      )}

      {openSource && (
        <LibDetail
          icon={openSource.kind === 'github' ? GitBranch : FolderInput}
          title={openSource.name}
          meta={
            <>
              <span className="st-chip">{openSource.kind === 'github' ? 'GitHub' : '本地'}</span>
              <span className="st-chip">{openSource.skillCount} 条技能</span>
            </>
          }
          desc={
            openSource.kind === 'github'
              ? '远端仓库：拉取时把整包缓存到本机，下面的技能从缓存里软链接出去。'
              : '本机文件夹：缓存只是登记它的位置，技能直接从那个目录链接进来。'
          }
          tone={openSource.lastError ? 'warn' : undefined}
          onClose={() => setOpenSource(null)}
          actions={
            <>
              <button className="st-btn" onClick={() => setOpenSource(null)}>
                关闭
              </button>
              <button
                className="st-btn danger"
                disabled={acting !== null}
                onClick={() => {
                  const id = openSource.id
                  setOpenSource(null)
                  void removeSource(id)
                }}
              >
                <Trash2 size={12} />
                移除来源
              </button>
              <button
                className="st-btn primary"
                disabled={acting !== null}
                onClick={() => {
                  const id = openSource.id
                  void refresh(id)
                }}
              >
                {acting === openSource.id ? <RefreshCw size={12} className="spin" /> : <RefreshCw size={12} />}
                重新拉取
              </button>
            </>
          }
        >
          <dl className="lib-detail-row">
            <dt>来源</dt>
            <dd>{openSource.ref}</dd>
          </dl>
          <dl className="lib-detail-row plain">
            <dt>缓存于</dt>
            <dd>
              {openSource.fetchedAt > 0 ? new Date(openSource.fetchedAt).toLocaleString() : '还没拉取过'}
            </dd>
          </dl>
          {view && (
            <dl className="lib-detail-row">
              <dt>缓存目录</dt>
              <dd>{view.repoDir}</dd>
            </dl>
          )}
          {openSource.lastError && (
            <p className="lib-card-warn">
              <AlertTriangle size={11} /> 上次拉取失败：{openSource.lastError}
            </p>
          )}
          <p className="st-meta">
            移除来源会删掉缓存；已经软链接进技能目录的条目会变成失效链接，可在「技能」页一键清理。
          </p>
        </LibDetail>
      )}

      {openSkill && (
        <LibDetail
          icon={ScrollText}
          title={openSkill.name}
          tone={openSkill.loadable ? undefined : 'warn'}
          meta={
            <>
              <span className="st-chip">{openSkill.sourceName}</span>
              {openSkill.imported && <span className="st-chip">已链接</span>}
              {!openSkill.loadable && <span className="st-chip">加载不了</span>}
            </>
          }
          desc={openSkill.description || '没有 description：助手看得到名称，但不知道什么时候该用它。'}
          onClose={() => setOpenSkill(null)}
          actions={
            <>
              <button className="st-btn" onClick={() => setOpenSkill(null)}>
                关闭
              </button>
              <button
                className="st-btn primary"
                disabled={acting !== null || openSkill.imported || !openSkill.loadable}
                onClick={() => {
                  const key = openSkill.key
                  setOpenSkill(null)
                  void imp(key)
                }}
              >
                {acting === openSkill.key ? <RefreshCw size={12} className="spin" /> : <Link2 size={12} />}
                {openSkill.imported ? '已导入' : '导入到技能目录'}
              </button>
            </>
          }
        >
          <dl className="lib-detail-row">
            <dt>库内路径</dt>
            <dd>{openSkill.relPath}</dd>
          </dl>
          {openSkill.imported && (
            <dl className="lib-detail-row plain">
              <dt>链接名</dt>
              <dd>{openSkill.linkName ?? openSkill.name}</dd>
            </dl>
          )}
          {openSkill.warnings.length > 0 && (
            <p className="lib-card-warn">
              <AlertTriangle size={11} /> {openSkill.warnings.join('；')}
            </p>
          )}
          <p className="st-meta">
            导入是软链接：缓存更新后这边跟着变，移除导入只断开链接，不动缓存里的原文件。
          </p>
        </LibDetail>
      )}
    </section>
  )
}

/**
 * 从别的 agent 应用导入技能。
 *
 * 两个界面必须说实话的地方：
 * —— 导入是软链接，不是复制。所以「原应用里删了这条技能」这边就变失效链接，
 *    列表里要单列出来让用户一键清掉，否则技能目录里长出一堆点不开的残骸。
 * —— 加载开关关着时，导入只是把链接摆好，助手并不会用它。这句话不写出来，
 *    用户下一次对话发现没反应，只会以为按钮坏了。
 */
/**
 * 别的 agent 应用里的技能。
 *
 * 进页自动读，不再要求先按一次「开始扫描」；列表按应用分组，每组用该应用自己的记号，
 * 一屏就能看出「这些技能是从哪儿来的」。导入仍然是软链接：不复制内容，移除只断开链接。
 * 失效链接单列成一张跨行卡片 —— 源应用删掉一条技能时，这里只会剩一个点不开的残骸。
 */
function SkillImportSection({
  view,
  scanning,
  error,
  onRefresh,
}: {
  view: SkillScanSummaryView | null
  scanning: boolean
  error: string | null
  onRefresh: () => Promise<SkillScanSummaryView | null>
}) {
  const [open, setOpen] = useState<DiscoveredSkill | null>(null)
  const [danglingOpen, setDanglingOpen] = useState(false)
  const [acting, setActing] = useState<string | null>(null)
  const [msg, setMsg] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const [kw, setKw] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [rows, setRows] = useState<DiscoveredSkill[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(false)
  const seq = useRef(0)
  const appliedKw = useRef('')

  const act = async (s: DiscoveredSkill) => {
    if (acting) return
    setActing(s.key)
    const start = Date.now()
    try {
      const r = s.imported
        ? await window.torra.assistantSkillsRemove(s.linkName ?? s.name)
        : await window.torra.assistantSkillsImport({ key: s.key, name: s.name })
      await sleepPad(start)
      if (!r.ok) {
        setMsg(`${s.name}：${r.reason ?? '操作失败'}`)
        return
      }
      setMsg(`${s.name}：${r.reason ?? '完成'}`)
      await onRefresh()
    } finally {
      setActing(null)
    }
  }

  const cleanDangling = async () => {
    if (!view?.dangling.length || acting) return
    setActing('dangling')
    const names = view.dangling.map((d) => d.name)
    const start = Date.now()
    try {
      const rs = await Promise.all(names.map((n) => window.torra.assistantSkillsRemove(n)))
      await sleepPad(start)
      const bad = rs.filter((r) => !r.ok)
      setMsg(
        bad.length
          ? `清掉了 ${names.length - bad.length} 条，还有 ${bad.length} 条要手动处理`
          : `已清理 ${names.length} 条失效链接`,
      )
      await onRefresh()
    } finally {
      setActing(null)
    }
  }

  // 每个来源应用一个页签：几十上百条技能平铺在一页里要滚很久，翻页时也说不清自己在看谁家的。
  // 搜索不删页签，只改角标上的数字，这样「哪家有我要的」一眼就能看出来。
  const groups = useMemo(
    () =>
      (view?.apps ?? [])
        .filter((a) => a.total > 0)
        .map((a) => ({
          id: a.id,
          label: a.displayName,
          icon: SKILL_APP_ICONS[a.id] ?? ScrollText,
          skipped: a.skipped,
          total: a.total,
        })),
    [view],
  )
  const active = groups.find((g) => g.id === picked) ?? groups[0]
  const activeId = active?.id ?? ''
  const all = useMemo(() => (view?.apps ?? []).reduce((n, a) => n + a.total, 0), [view])
  const matched = Object.values(counts).reduce((n, x) => n + x, 0)

  useEffect(() => {
    const t = setTimeout(() => setKw(q.trim().toLowerCase()), 250)
    return () => clearTimeout(t)
  }, [q])
  useEffect(() => {
    setPage(1)
  }, [kw, activeId])

  // 每页 9 条，搜索、排序、切片都在主进程做
  const APP_SIZE = 9
  useEffect(() => {
    if (!activeId) return
    const my = ++seq.current
    setLoading(true)
    void window.torra
      .assistantSkillsAppPage({ appId: activeId, kw, offset: (page - 1) * APP_SIZE, limit: APP_SIZE })
      .then((r) => {
        if (my !== seq.current) return
        if (!r.ok) {
          setRows([])
          setCounts({})
          setMsg(r.reason ?? '读取失败')
          return
        }
        setRows(r.rows)
        setCounts(r.counts)
        // 搜索命中在别的应用里时直接翻过去：停在一条都没有的页签上会让人以为没搜到。
        // 只在关键词变化后的第一次结果里判定，用户之后手动点别的页签不抢回选择。
        if (kw && appliedKw.current !== kw) {
          appliedKw.current = kw
          if ((r.counts[activeId] ?? 0) === 0) {
            const hit = (view?.apps ?? []).find((a) => (r.counts[a.id] ?? 0) > 0)
            if (hit) setPicked(hit.id)
          }
        }
        if (!kw) appliedKw.current = ''
        const pages = Math.max(1, Math.ceil(r.matched / APP_SIZE))
        if (page > pages) setPage(pages)
      })
      .catch((e) => {
        if (my === seq.current) setMsg((e as Error).message)
      })
      .finally(() => {
        if (my === seq.current) setLoading(false)
      })
  }, [view, activeId, kw, page])

  return (
    <section className="st-section">
      <h3 className="st-sec-title st-sub">从其他应用导入</h3>
      <p className="st-desc">
        自动读取 Claude Code / Codex / Qoder / WorkBuddy / Trae 等应用自己的技能目录，按应用分页；
        导入以<strong>软链接</strong>接进来，不复制内容，移除也只断开链接，源目录不动。
      </p>

      <div className="lib-bar">
        <div className="search-box">
          <Search size={13} />
          <input
            type="text"
            placeholder="搜索技能名称或说明"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <span className="lib-bar-n">
          {loading ? '正在筛选…' : `${matched} / ${all} 条`} · 已导入 {view?.imported ?? 0}
        </span>
        <button
          className="st-icon"
          aria-label="重新读取技能目录"
          title="重新读取技能目录"
          disabled={scanning || acting !== null}
          onClick={() => {
            setMsg(null)
            void onRefresh()
          }}
        >
          <RefreshCw size={13} className={scanning ? 'spin' : undefined} />
        </button>
      </div>

      <p className="st-meta">
        {view ? (
          <>
            扫描自 <code>{view.home}</code>
            {view.skillsDir && (
              <>
                {' '}
                · 导入目标 <code>{view.skillsDir}</code>
              </>
            )}
          </>
        ) : scanning ? (
          '正在读取本机各应用的技能目录…'
        ) : (
          '还没有读取结果'
        )}
        {msg && <span className="st-gap st-accent">{msg}</span>}
      </p>
      {error && <p className="st-note warn">读取失败：{error}</p>}

      {view && view.dangling.length > 0 && (
        <LibGrid>
          <LibCard
            wide
            tone="warn"
            icon={AlertTriangle}
            title={`失效链接 ${view.dangling.length} 条`}
            desc={
              view.dangling
                .slice(0, 3)
                .map((d) => `${d.name} → ${d.target}`)
                .join('；') + (view.dangling.length > 3 ? '…' : '')
            }
            action={<LibPill tone="warn">待清理</LibPill>}
            onOpen={() => setDanglingOpen(true)}
          />
        </LibGrid>
      )}

      {view && all === 0 && (
        <p className="st-note warn">没有扫描到任何技能：这些应用要么没装，要么技能没放在它们的技能目录里。</p>
      )}
      {view && all > 0 && !loading && kw && matched === 0 && <p className="st-note">没有匹配「{q}」的技能。</p>}

      {groups.length > 0 && (
        <div className="lib-tabs lib-app-tabs" role="tablist" aria-label="技能来源应用">
          {groups.map((g) => {
            const Icon = g.icon
            const on = active?.id === g.id
            return (
              <button
                key={g.id}
                role="tab"
                aria-selected={on}
                className={`lib-tab${on ? ' on' : ''}`}
                onClick={() => setPicked(g.id)}
              >
                <span className={`lib-app-ico app-${g.id}`} aria-hidden="true">
                  <Icon size={13} />
                </span>
                {g.label}
                <span className="lib-n">{kw ? (counts[g.id] ?? 0) : g.total}</span>
              </button>
            )
          })}
        </div>
      )}
      {active && !loading && kw && rows.length === 0 && matched > 0 && (
        <p className="st-note">「{active.label}」里没有匹配「{q}」的技能，其他应用里有 {matched} 条。</p>
      )}

      {active && (() => {
        const g = active
        const pages = Math.max(1, Math.ceil((counts[g.id] ?? 0) / APP_SIZE))
        const safePage = Math.min(pages, Math.max(1, page))
        return (
          <section className="lib-app" key={g.id}>
            {g.skipped > 0 && (
              <header className="lib-app-head">
                <span className="lib-app-note">{g.skipped} 条重名已合并</span>
              </header>
            )}
            <LibGrid>
              {rows.map((s) => (
                <LibCard
                  key={s.key}
                  icon={ScrollText}
                  title={s.name}
                  meta={
                    <>
                      {s.imported && s.linkName ? (
                        <span className="st-chip">已导入：{s.linkName}</span>
                      ) : (
                        <span className="st-chip">待导入</span>
                      )}
                    </>
                  }
                  action={
                    <LibPill
                      tone={s.imported ? 'plain' : 'brand'}
                      busy={acting === s.key}
                      disabled={skillRowDisabled(scanning, acting, s.key) || (!s.imported && !s.loadable)}
                      title={
                        s.imported
                          ? s.linkKind === 'copy'
                            ? '移除复制进来的那份副本（源技能不动）'
                            : '断开导入（只删 Torra 里的链接，源技能不动）'
                          : s.loadable
                            ? s.kind === 'file'
                              ? '复制导入（单文件技能没有可链接的目录）'
                              : '以软链接导入'
                            : '这条技能加载不了，先修好原文件再导入'
                      }
                      onClick={() => void act(s)}
                    >
                      {s.imported ? (s.linkKind === 'copy' ? '移除副本' : '断开') : '导入'}
                    </LibPill>
                  }
                  desc={s.description || '（没有 description，助手不会加载）'}
                  onOpen={() => setOpen(s)}
                  footer={
                    <span className="lib-card-path" title={s.path}>
                      {s.path}
                    </span>
                  }
                >
                  {s.warnings.length > 0 && (
                    <p className="lib-card-warn">
                      <AlertTriangle size={11} /> {s.warnings.join('；')}
                    </p>
                  )}
                </LibCard>
              ))}
            </LibGrid>
            <Pager page={safePage} pageSize={APP_SIZE} total={counts[g.id] ?? 0} onPage={setPage} />
          </section>
        )
      })()}

      {open && (
        <LibDetail
          icon={ScrollText}
          title={open.name}
          meta={
            <>
              <span className="st-chip">{open.appDisplayName}</span>
              {open.imported && <span className="st-chip">已{open.linkKind === 'copy' ? '复制导入' : '链接'}</span>}
              {!open.loadable && <span className="st-chip">加载不了</span>}
            </>
          }
          desc={open.description || '（没有 description，助手不会加载这条技能）'}
          tone={open.loadable ? undefined : 'warn'}
          onClose={() => setOpen(null)}
          actions={
            <>
              <button className="st-btn" onClick={() => setOpen(null)}>
                关闭
              </button>
              <button
                className={`st-btn${open.imported ? ' danger' : ' primary'}`}
                disabled={skillRowDisabled(scanning, acting, open.key) || (!open.imported && !open.loadable)}
                onClick={() => {
                  const cur = open
                  setOpen(null)
                  void act(cur)
                }}
              >
                {acting === open.key ? <RefreshCw size={12} className="spin" /> : null}
                {open.imported ? (open.linkKind === 'copy' ? '移除副本' : '断开导入') : '导入到技能目录'}
              </button>
            </>
          }
        >
          <dl className="lib-detail-row plain">
            <dt>来源应用</dt>
            <dd>{open.appDisplayName}</dd>
          </dl>
          <dl className="lib-detail-row">
            <dt>原位置</dt>
            <dd>{open.path}</dd>
          </dl>
          {open.imported && (
            <dl className="lib-detail-row">
              <dt>Torra 里</dt>
              <dd>{open.linkName ?? open.name}</dd>
            </dl>
          )}
          {open.warnings.length > 0 && (
            <p className="lib-card-warn">
              <AlertTriangle size={11} /> {open.warnings.join('；')}
            </p>
          )}
          {!open.loadable && !open.imported && (
            <p className="st-meta">这条技能加载不了：先修好原文件（缺 SKILL.md 或清单不合法），再回来导入。</p>
          )}
        </LibDetail>
      )}

      {danglingOpen && view && (
        <LibDetail
          icon={AlertTriangle}
          title={`失效链接 ${view.dangling.length} 条`}
          tone="warn"
          desc="源目录里已经没有、Torra 技能目录里还留着链接的条目。它们不会生效，但会一直挂在技能目录里。"
          onClose={() => setDanglingOpen(false)}
          actions={
            <>
              <button className="st-btn" onClick={() => setDanglingOpen(false)}>
                关闭
              </button>
              <button
                className="st-btn danger"
                disabled={scanning || acting !== null}
                onClick={() => {
                  setDanglingOpen(false)
                  void cleanDangling()
                }}
              >
                {acting === 'dangling' ? <RefreshCw size={12} className="spin" /> : <Trash2 size={12} />}
                一键清理
              </button>
            </>
          }
        >
          <ul className="lib-detail-list">
            {view.dangling.map((d) => (
              <li key={d.name}>
                <b>{d.name}</b>
                <span>{d.target}</span>
              </li>
            ))}
          </ul>
        </LibDetail>
      )}
    </section>
  )
}

/**
 * 「允许助手自建工具」开关。
 *
 * 关着的时候，那四个 author_* / remove_plugin 工具连注册都没有 —— 不是拒绝，是不存在，
 * 所以助手的提示词里也不提它们。打开之后每一次写动作仍会弹确认卡片。
 * 待审的脚本与已装清单在「自建工具」一页里看得见，这里只管闸门。
 */
function SelfAuthoringToggle({
  selfAuthoringEnabled,
  onChanged,
}: {
  selfAuthoringEnabled: boolean
  onChanged: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)

  const toggle = async () => {
    const next = !selfAuthoringEnabled
    setBusy(true)
    setMsg(null)
    const start = Date.now()
    const r = await window.torra.assistantSetSelfAuthoring(next)
    // 落盘几乎瞬间完成，但快到手就看不见：补个最短可感知时长
    const elapsed = Date.now() - start
    if (elapsed < 800) await new Promise((res) => setTimeout(res, 800 - elapsed))
    setBusy(false)
    setMsg(
      r.ok
        ? next
          ? '已开启：助手可以写清单 / 技能 / 待审脚本，每次写都会弹确认卡片'
          : '已关闭：那四个自建工具不注册，已有的清单和技能不受影响'
        : r.reason ?? '切换失败',
    )
    onChanged()
    setTimeout(() => setMsg(null), 5000)
  }

  return (
    <>
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
              开的时候助手会往工具 / 技能目录里写东西；脚本类工具先落在待审区，还要你人工看过源码才生效。
            </div>
          )}
        </div>
        <button className="st-btn" onClick={() => void toggle()} disabled={busy}>
          {busy ? <RefreshCw size={12} className="spin" /> : null}
          {selfAuthoringEnabled ? '关闭' : '开启'}
        </button>
      </div>
    </>
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
