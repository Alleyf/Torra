import { useEffect, useMemo, useState } from 'react'
import type { ModelSummary } from '../store'
import { lookupPublicPrice } from '@shared/model-prices'
import { Key, CheckCircle, AlertTriangle, X, Loader2, RefreshCw, Zap } from 'lucide-react'

const PROTOCOL_OPTIONS = [
  { value: 'openai', label: 'OpenAI 兼容', desc: 'DeepSeek / OpenAI / 通义千问 / 月之暗面等' },
  { value: 'anthropic', label: 'Anthropic', desc: 'Claude API / Anthropic 兼容端点' },
] as const

/** 主进程返回的可编辑配置（含 hasKey，不含 Key 本身） */
type EditableConfig = Awaited<ReturnType<typeof window.torra.getApiModelConfig>>['config']

export function ApiModelDialog({
  models,
  editModelId,
  onClose,
  onCreated,
}: {
  models: ModelSummary[]
  /** 传入则进入编辑模式：预填当前配置，Key 留空表示不改 */
  editModelId?: string
  onClose: () => void
  onCreated: () => Promise<void> | void
}) {
  const editing = Boolean(editModelId)
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [homepage, setHomepage] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [protocol, setProtocol] = useState<'openai' | 'anthropic'>('openai')
  const [vision, setVision] = useState(false)
  // 可切换清单：勾中的模型 id（默认模型恒在列，主进程提交时强制并入并去重）
  const [checked, setChecked] = useState<Set<string>>(new Set())
  // 手动补录输入框：/models 拉不到的端点（Anthropic 直连等）照样能建清单
  const [manualId, setManualId] = useState('')

  const [remoteModels, setRemoteModels] = useState<Array<{ id: string; name?: string }>>([])
  const [fetching, setFetching] = useState(false)
  const [fetched, setFetched] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [created, setCreated] = useState(false)
  const [cfg, setCfg] = useState<EditableConfig | undefined>()
  const [loading, setLoading] = useState(editing)
  const [saving, setSaving] = useState(false)

  // 编辑模式：Key 不在渲染层，只能向主进程要一次配置快照来预填
  useEffect(() => {
    if (!editModelId) return
    let alive = true
    window.torra
      .getApiModelConfig(editModelId)
      .then((r) => {
        if (!alive) return
        if (!r.ok || !r.config) {
          setMsg({ kind: 'err', text: r.errors?.join('；') ?? '读取配置失败' })
          return
        }
        const c = r.config
        setName(c.displayName)
        setBaseUrl(c.baseUrl)
        setHomepage(c.homepage ?? '')
        setModel(c.model)
        setProtocol(c.protocol)
        setVision(c.vision)
        setChecked(new Set(c.availableModels ?? []))
        setCfg(c)
      })
      .catch((e: unknown) => {
        if (alive) setMsg({ kind: 'err', text: (e as Error).message })
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [editModelId])

  // 新建态要有当场填的 Key；编辑态没填新 Key 也能拉 —— 主进程用钥匙串里那份
  const canFetch =
    /^https?:\/\//.test(baseUrl.trim()) && (apiKey.trim().length > 0 || (editing && !!cfg?.hasKey))

  /** 手动补录：去重并入清单（主进程还会再并默认模型） */
  const addManual = () => {
    const id = manualId.trim()
    if (!id) return
    setChecked((prev) => new Set(prev).add(id))
    setManualId('')
  }
  // 公开价目表按模型名匹配；命中与否都只影响这里的说明文字，真正的计费在主进程
  const listed = useMemo(() => lookupPublicPrice(model.trim()), [model])
  const hasOwnPrice = Boolean(cfg && (cfg.pricePerMTokIn > 0 || cfg.pricePerMTokOut > 0))
  // 编辑时 Key 可以留空（沿用已存的），新建时必须填
  const canSubmit =
    !saving && !!name.trim() && !!baseUrl.trim() && !!model.trim() && (editing || !!apiKey.trim())

  const handleFetchModels = async () => {
    if (!canFetch) return
    setFetching(true)
    setMsg(null)
    try {
      // 编辑态没填新 Key 就按 id 走主进程钥匙串；其余按当场填的拉
      const res =
        editing && !apiKey.trim()
          ? await window.torra.listRemoteModels(editModelId!)
          : await window.torra.listRemoteModels(baseUrl.trim(), apiKey.trim())
      if (!res.ok) {
        setMsg({ kind: 'err', text: res.error ?? '获取模型列表失败' })
        return
      }
      const list = res.models ?? []
      setRemoteModels(list)
      setFetched(true)
      if (list.length > 0 && !model.trim()) {
        setModel(list[0]!.id)
      }
      /*
       * 勾选集合与列表对齐：旧条目不在新列表里的保留（saved 清单是用户资产，
       * 端点 /models 少报一个不该把他选好的模型悄悄踢掉）；
       * 从没勾过时默认全选 —— 拉列表的人想要的就是"这个端点有一串模型"。
       */
      setChecked((prev) => (prev.size > 0 ? prev : new Set(list.map((m) => m.id))))
      setMsg({ kind: 'ok', text: `获取到 ${list.length} 个模型，请从中选择` })
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setFetching(false)
    }
  }

  const handleSubmit = async () => {
    if (!canSubmit) return
    setMsg(null)
    setSaving(true)
    const start = Date.now()
    try {
      /*
       * 勾中的即清单（主进程会再并入 model、去重；≤1 条视为无清单）。
       * 编辑模式即使没重新拉过列表也要带上勾选项——预填本就来自已存清单，
       * 不带等于把用户的清单悄悄抹掉。
       */
      const patch = {
        displayName: name.trim(),
        baseUrl: baseUrl.trim(),
        // 选填项清空要能真的清掉：传空串，主进程据此落成 undefined
        homepage: homepage.trim(),
        model: model.trim(),
        protocol,
        vision,
        availableModels: [...checked],
      }
      const res = editing
        ? await window.torra.updateApiModel(editModelId!, {
            ...patch,
            ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
          })
        : await window.torra.createApiModel({ ...patch, apiKey: apiKey.trim() })
      if (!res.ok) {
        setMsg({ kind: 'err', text: res.errors?.join('；') ?? (editing ? '保存失败' : '创建失败') })
        return
      }
      // 提交很快时也要让按钮的忙碌态被看见，否则用户以为没点上
      const elapsed = Date.now() - start
      if (elapsed < 800) await new Promise((r) => setTimeout(r, 800 - elapsed))
      setCreated(true)
      await onCreated()
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message || (editing ? '保存失败，请重试' : '创建失败，请重试') })
    } finally {
      setSaving(false)
    }
  }

  if (created) {
    return (
      <div className="modal-mask">
        <div className="modal" style={{ maxWidth: 480 }}>
          <h2>
            <CheckCircle size={18} style={{ color: 'var(--consensus)' }} />
            {editing ? `已更新「${name}」` : `已添加「${name}」`}
          </h2>
          <p>API 模型配置已保存，密钥经操作系统级加密存储在本机。</p>
          <p>接下来：关闭本窗口，在「发起一场讨论」中勾选该模型即可使用。</p>
          <div className="modal-actions">
            <button className="btn primary" onClick={onClose}>
              知道了
            </button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-mask">
      <div className="modal" style={{ maxWidth: 560, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>
            <Zap size={18} />
            {editing ? '编辑 API 模型' : '添加 API 模型'}
          </h2>
          <button className="btn icon" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 20 }}>
          {editing
            ? '改动会立即生效：正在排队或后续的发言都用新的端点与模型名。名称变化不影响历史讨论记录。'
            : '支持 OpenAI 兼容和 Anthropic API 端点。OpenAI 兼容端点可一键获取模型列表，Anthropic 端点请手动填写模型名。'}
        </p>

        {loading && (
          <div className="moderator-note">
            <Loader2 size={12} className="spin" style={{ marginRight: 6, verticalAlign: -2 }} />
            正在读取当前配置…
          </div>
        )}

        <div className="field">
          <label>
            <Key size={12} />
            模型名称
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="如：GPT-4o、DeepSeek-V3"
          />
        </div>

        <div className="field">
          <label>API 协议</label>
          <div style={{ display: 'flex', gap: 8 }}>
            {PROTOCOL_OPTIONS.map((opt) => (
              <label
                key={opt.value}
                className={`check-item${protocol === opt.value ? ' on' : ''}`}
                style={{ flex: 1 }}
              >
                <input
                  type="radio"
                  name="protocol"
                  value={opt.value}
                  checked={protocol === opt.value}
                  onChange={() => setProtocol(opt.value)}
                  style={{ display: 'none' }}
                />
                <div>
                  <div style={{ fontWeight: 500, fontSize: 13 }}>{opt.label}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{opt.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </div>

        <div className="field">
          <label>Base URL</label>
          <input
            type="text"
            value={baseUrl}
            onChange={(e) => { setBaseUrl(e.target.value); setFetched(false) }}
            placeholder="https://api.openai.com/v1"
          />
        </div>

        <div className="field">
          <label>主页 URL（选填）</label>
          <input
            type="text"
            value={homepage}
            onChange={(e) => setHomepage(e.target.value)}
            placeholder="https://www.deepseek.com"
          />
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
            只用于取图标：Base URL 所在站点没有公开图标时（中转站、内网网关常见），
            改用这个地址的站点图标。留空则只用 Base URL 推导。
          </div>
        </div>

        <div className="field">
          <label>API Key</label>
          <input
            type="password"
            value={apiKey}
            onChange={(e) => { setApiKey(e.target.value); setFetched(false) }}
            placeholder={editing ? (cfg?.hasKey ? '留空即沿用已保存的 Key' : '尚未配置 Key，请填写') : 'sk-...'}
          />
          {editing && (
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
              已保存的 Key 不会显示在这里，也无法读回；留空即保持原值不变。
            </div>
          )}
        </div>

        <div className="field">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <label style={{ margin: 0 }}>模型</label>
            <button
              className="btn sm"
              onClick={handleFetchModels}
              disabled={!canFetch || fetching}
              title={
                editing && !apiKey.trim()
                  ? cfg?.hasKey
                    ? '用已保存的 Key 拉取该端点的模型列表'
                    : '尚未配置 Key：先在下方保存一个，或手动补录模型名'
                  : '从端点拉取可用模型'
              }
            >
              {fetching ? <Loader2 size={11} className="spin" /> : <RefreshCw size={11} />}
              {fetching ? '获取中…' : '获取模型列表'}
            </button>
          </div>
          {fetched && remoteModels.length > 0 ? (
            <select value={model} onChange={(e) => setModel(e.target.value)} style={{ width: '100%' }}>
              {remoteModels.map((m) => (
                <option key={m.id} value={m.id}>{m.name ?? m.id}</option>
              ))}
            </select>
          ) : (
            <input
              type="text"
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder={fetched ? '未获取到模型，请手动输入' : 'model-name 或点击上方按钮获取'}
            />
          )}
          {listed && !hasOwnPrice && (
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
              未填单价时按公开价目计费：${listed.pricePerMTokIn} / ${listed.pricePerMTokOut}
              （每百万 token 输入/输出，{listed.source.replace(/^https?:\/\//, '').split('/')[0]}，
              {listed.asOf} 核对）。走中转网关时实际单价可能与此不同。
            </div>
          )}
          {listed && hasOwnPrice && (
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
              计费沿用已保存的单价（${cfg?.pricePerMTokIn} / ${cfg?.pricePerMTokOut}），公开价目为
              ${listed.pricePerMTokIn} / ${listed.pricePerMTokOut}。
            </div>
          )}
        </div>

        <div className="field">
          <label>可切换模型清单</label>
          {/* 已勾选的项永远可见可移除：编辑时未重新拉取也要能看到自己保存过的清单 */}
          {checked.size > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
              {[...checked].map((id) => {
                const isDefault = id === model.trim()
                return (
                  <span
                    key={id}
                    className={`check-item${isDefault ? ' on' : ''}`}
                    style={{ padding: '4px 9px', gap: 6, fontSize: 11.5, opacity: isDefault ? 0.72 : 1 }}
                    title={isDefault ? '默认模型恒在清单内' : undefined}
                  >
                    {id}
                    {!isDefault && (
                      <button
                        type="button"
                        aria-label={`移除 ${id}`}
                        style={{ border: 'none', background: 'none', cursor: 'pointer', padding: 0, color: 'var(--text-3)', fontSize: 11 }}
                        onClick={() =>
                          setChecked((prev) => {
                            const next = new Set(prev)
                            next.delete(id)
                            return next
                          })
                        }
                      >
                        ×
                      </button>
                    )}
                  </span>
                )
              })}
            </div>
          )}
          {fetched && remoteModels.length > 0 ? (
            <>
              <div
                style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 6,
                  maxHeight: 160,
                  overflowY: 'auto',
                  padding: '8px 10px',
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                }}
              >
                {remoteModels.map((m) => {
                  const isDefault = m.id === model.trim()
                  const on = isDefault || checked.has(m.id)
                  return (
                    <label
                      key={m.id}
                      className={`check-item${on ? ' on' : ''}`}
                      /* 紧凑排布：check-item 的整行卡片内边距在这里太宽，压成胶囊 */
                      style={{
                        padding: '4px 9px',
                        gap: 6,
                        cursor: isDefault ? 'default' : 'pointer',
                        opacity: isDefault ? 0.72 : 1,
                      }}
                      title={isDefault ? '默认模型恒在清单内' : undefined}
                    >
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={isDefault}
                        onChange={() =>
                          setChecked((prev) => {
                            const next = new Set(prev)
                            if (next.has(m.id)) next.delete(m.id)
                            else next.add(m.id)
                            return next
                          })
                        }
                      />
                      <span style={{ fontSize: 11.5 }}>{m.name ?? m.id}</span>
                    </label>
                  )
                })}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
                勾中的模型会成为这一条 API 的可切换清单 —— 发起讨论时按座位选「本场生效模型」，
                不用每个模型建一条。全不勾则只保留默认模型。
              </div>
            </>
          ) : (
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
              {checked.size > 0
                ? '以上是已保存的清单。拉取列表可勾选更多，或在下方手动补录。'
                : '点击「获取模型列表」后勾选；拉不到的端点（如 Anthropic）可在下方手动补录模型名。'}
            </div>
          )}
          {/* 手动补录：Anthropic 端点或 /models 拉取失败时，照样能建清单 */}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <input
              type="text"
              value={manualId}
              onChange={(e) => setManualId(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  addManual()
                }
              }}
              placeholder="手动补录模型名（回车加入清单）"
              style={{ flex: 1 }}
            />
            <button className="btn sm" onClick={addManual} disabled={!manualId.trim()}>
              加入
            </button>
          </div>
        </div>

        <div className="field">
          <label className={`check-item${vision ? ' on' : ''}`} style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={vision}
              onChange={(e) => setVision(e.target.checked)}
            />
            <div>
              <div style={{ fontWeight: 500, fontSize: 13 }}>支持图片输入（视觉）</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                勾选后助手才能向该端点发送图片；纯文本端点请保持关闭，否则请求会被拒。
              </div>
            </div>
          </label>
        </div>

        {msg && (
          <div className={`moderator-note${msg.kind === 'err' ? ' error' : ''}`} style={{ marginTop: 16 }}>
            {msg.kind === 'err' && <AlertTriangle size={12} style={{ marginRight: 6, verticalAlign: -2 }} />}
            {msg.text}
          </div>
        )}

        <div className="modal-actions" style={{ marginTop: 24 }}>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={handleSubmit} disabled={!canSubmit}>
            {saving ? <Loader2 size={12} className="spin" /> : null}
            {saving ? '保存中…' : editing ? '保存修改' : '创建'}
          </button>
        </div>
      </div>
    </div>
  )
}
