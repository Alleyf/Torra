import { useEffect, useState } from 'react'
import type { ModelSummary } from '../store'
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
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [protocol, setProtocol] = useState<'openai' | 'anthropic'>('openai')
  const [vision, setVision] = useState(false)

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
        setModel(c.model)
        setProtocol(c.protocol)
        setVision(c.vision)
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

  const canFetch = protocol === 'openai' && /^https?:\/\//.test(baseUrl.trim()) && apiKey.trim().length > 0
  // 编辑时 Key 可以留空（沿用已存的），新建时必须填
  const canSubmit =
    !saving && !!name.trim() && !!baseUrl.trim() && !!model.trim() && (editing || !!apiKey.trim())

  const handleFetchModels = async () => {
    if (!canFetch) return
    setFetching(true)
    setMsg(null)
    try {
      const res = await window.torra.listRemoteModels(baseUrl.trim(), apiKey.trim())
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
      const patch = {
        displayName: name.trim(),
        baseUrl: baseUrl.trim(),
        model: model.trim(),
        protocol,
        vision,
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
                  ? '已保存的 Key 不回显，填入新 Key 后才能重新拉取列表'
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
