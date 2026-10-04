import { useState } from 'react'
import type { ModelSummary } from '../store'
import { WebModelDialog } from './WebModelDialog'
import { ApiModelDialog } from './ApiModelDialog'
import { SmartAddDialog } from './SmartAddDialog'
import { DiagnosticsPanel } from './DiagnosticsPanel'
import { CookiePanel } from './CookiePanel'
import { getFaviconUrls } from './ModelRail'
import {
  Settings,
  Key,
  Globe,
  Plus,
  CheckCircle,
  AlertTriangle,
  Trash2,
  ArrowLeft,
  Shield,
  RefreshCw,
  Zap,
  Stethoscope,
  Sparkles,
  ScanSearch,
  SunMoon,
} from 'lucide-react'
import { THEME_LABEL, THEME_MODES, type ThemeMode } from '@shared/theme'
import { chooseTheme, useThemeMode } from '../theme'

type Tab = 'models' | 'cookie' | 'doctor' | 'appearance'

const TABS: Array<{ id: Tab; label: string; icon: typeof Key }> = [
  { id: 'models', label: '模型与密钥', icon: Key },
  { id: 'cookie', label: 'Cookie 与登录', icon: Shield },
  { id: 'doctor', label: '链路体检', icon: Stethoscope },
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
  const [showSmart, setShowSmart] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('models')

  const apiModels = models.filter((m) => m.transport === 'api')
  const webModels = models.filter((m) => m.transport === 'webview')

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
    <div className="discussion-flow">
      <div className="empty-card" style={{ maxWidth: 720 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 28 }}>
          <button className="btn sm" onClick={onBack} style={{ flex: '0 0 auto' }}>
            <ArrowLeft size={13} />
          </button>
          <h2 style={{ margin: 0, flex: 1 }}>
            <Settings size={20} />
            设置
          </h2>
          <button className="btn sm" onClick={handleRefreshAll} disabled={refreshing}>
            <RefreshCw size={12} className={refreshing ? 'spin' : ''} />
            {refreshing ? '刷新中…' : '刷新状态'}
          </button>
        </div>
        {refreshMsg && (
          <div style={{ textAlign: 'right', margin: '-20px 0 20px', fontSize: 12, color: 'var(--text-3)' }}>
            {refreshMsg}
          </div>
        )}

        <div className="settings-tabs">
          {TABS.map((t) => {
            const Icon = t.icon
            return (
              <button
                key={t.id}
                className={`settings-tab${tab === t.id ? ' active' : ''}`}
                onClick={() => setTab(t.id)}
              >
                <Icon size={13} />
                {t.label}
              </button>
            )
          })}
        </div>

        {tab === 'models' && (
          <>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                marginBottom: 22,
                padding: '12px 14px',
                border: '1px dashed var(--accent)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--accent-soft)',
              }}
            >
              <Sparkles size={16} style={{ color: 'var(--accent)', flex: '0 0 auto' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>智能添加</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                  只给一个地址：自动读页面结构或嗅探端点，产出经过真实页面校验的配置，拿不准的地方再来问你。
                </div>
              </div>
              <button className="btn primary sm" onClick={() => setShowSmart(true)}>
                <ScanSearch size={12} />
                开始识别
              </button>
            </div>

            <section style={{ marginBottom: 32 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <h3 className="settings-section-title" style={{ margin: 0 }}>
                  <Key size={13} />
                  API 密钥
                </h3>
                <button className="btn sm" onClick={() => setShowAddApi(true)}>
                  <Zap size={12} />
                  添加 API 模型
                </button>
              </div>
              <p className="settings-section-desc">
                密钥仅存储在本机操作系统钥匙串，不上传。
              </p>
              {apiModels.length === 0 ? (
                <div className="settings-empty">暂无 API 模型</div>
              ) : (
                <div className="settings-list">
                  {apiModels.map((m) => (
                    <ApiKeyRow
                      key={m.id}
                      model={m}
                      onSaved={onModelsChanged}
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

            <section>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <h3 className="settings-section-title" style={{ margin: 0 }}>
                  <Globe size={13} />
                  网页模型
                </h3>
                <button className="btn sm" onClick={() => setShowAddWeb(true)}>
                  <Plus size={12} />
                  添加网页模型
                </button>
              </div>
              <p className="settings-section-desc">
                通过浏览器自动化驱动网页版模型，需先登录。
              </p>
              {webModels.length === 0 ? (
                <div className="settings-empty">暂无网页模型</div>
              ) : (
                <div className="settings-list">
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
          </>
        )}

        {tab === 'cookie' && <CookiePanel webModels={webModels} />}

        {tab === 'doctor' && (
          <DiagnosticsPanel
            modelIds={models.map((m) => ({ id: m.id, displayName: m.displayName, transport: m.transport }))}
          />
        )}

        {tab === 'appearance' && <AppearanceSection />}

        <div className="settings-footer">
          <Shield size={11} />
          所有讨论数据、报告与密钥均存储在本机。密钥经操作系统级加密，Torra 不上传、不代管。
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
    <div className="settings-row">
      <div className="settings-avatar" style={hasFavicon ? { background: 'transparent' } : { background: model.color }}>
        {hasFavicon ? (
          <img
            src={faviconUrls[faviconIndex]}
            alt=""
            crossOrigin="anonymous"
            style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 8 }}
            onError={() => setFaviconIndex((prev) => prev + 1)}
          />
        ) : (
          model.displayName.slice(0, 1)
        )}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="settings-row-name">{model.displayName}</div>
        <div className="settings-row-meta">
          {model.domain ?? '—'}
        </div>
      </div>
      <button
        className="btn sm"
        title="重新获取图标"
        onClick={refetch}
        disabled={fetching || !model.domain}
      >
        <RefreshCw size={11} className={fetching ? 'spin' : ''} />
      </button>
      <span className={`settings-status-dot ${model.status === 'ready' ? 'ok' : 'warn'}`} />
      {model.userDefined && (
        <button
          className="btn sm danger"
          title={`移除「${model.displayName}」`}
          onClick={() => void onDelete()}
        >
          <Trash2 size={11} />
        </button>
      )}
    </div>
  )
}

function ApiKeyRow({
  model,
  onSaved,
  onDelete,
}: {
  model: ModelSummary
  onSaved: () => Promise<void> | void
  onDelete?: () => Promise<void> | void
}) {
  const [key, setKey] = useState('')
  const [saved, setSaved] = useState(false)
  const [justSaved, setJustSaved] = useState(false)

  const handleSave = async () => {
    if (!key.trim()) return
    const result = await window.torra.setSecret(`${model.id}:key`, key.trim())
    if (!result.ok) return
    setSaved(true)
    setJustSaved(true)
    setKey('')
    await onSaved()
    setTimeout(() => setJustSaved(false), 2000)
  }

  return (
    <div className="settings-row">
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="settings-row-name">{model.displayName}</div>
        <div className="settings-row-meta">
          {model.hasKey || saved ? (
            <span style={{ color: 'var(--consensus)' }}>
              <CheckCircle size={10} style={{ verticalAlign: -1 }} /> 已配置
            </span>
          ) : (
            <span style={{ color: 'var(--warn)' }}>
              <AlertTriangle size={10} style={{ verticalAlign: -1 }} /> 未配置
            </span>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          type="password"
          className="settings-key-input"
          value={key}
          placeholder={saved ? '已保存' : 'sk-...'}
          onChange={(e) => setKey(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && key.trim()) void handleSave()
          }}
        />
        <button
          className="btn sm"
          onClick={() => void handleSave()}
          disabled={!key.trim()}
        >
          {justSaved ? <CheckCircle size={12} /> : '保存'}
        </button>
        {onDelete && (
          <button
            className="btn sm danger"
            title={`移除「${model.displayName}」`}
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
 * 主题选择。
 *
 * 三个选项里只有「跟随系统」需要问操作系统，另两个点了就直接变色；
 * 真正的权威值在主进程（它写 preferences.json），这里只等它回执纠正本地。
 */
function AppearanceSection() {
  const mode = useThemeMode()
  return (
    <>
      <h3 className="settings-section-title" style={{ margin: 0 }}>
        主题
      </h3>
      <p className="settings-section-desc">
        白天与黑夜是两套独立配色；「跟随系统」跟着 Windows 的深浅色设置走。
        选择立即生效，并记在本机 preferences.json 里，下次启动保持。
      </p>
      <div className="theme-options">
        {THEME_MODES.map((m) => (
          <button
            key={m}
            className={`theme-option${mode === m ? ' active' : ''}`}
            onClick={() => void chooseTheme(m)}
          >
            {THEME_LABEL[m]}
          </button>
        ))}
      </div>
    </>
  )
}
