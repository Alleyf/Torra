import { useState } from 'react'
import type { ModelSummary } from '../store'
import { Key, CheckCircle, AlertTriangle, X, Loader2, RefreshCw, Zap } from 'lucide-react'

const PROTOCOL_OPTIONS = [
  { value: 'openai', label: 'OpenAI 兼容', desc: 'DeepSeek / OpenAI / 通义千问 / 月之暗面等' },
  { value: 'anthropic', label: 'Anthropic', desc: 'Claude API / Anthropic 兼容端点' },
] as const

export function ApiModelDialog({
  models,
  onClose,
  onCreated,
}: {
  models: ModelSummary[]
  onClose: () => void
  onCreated: () => Promise<void> | void
}) {
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [protocol, setProtocol] = useState<'openai' | 'anthropic'>('openai')

  const [remoteModels, setRemoteModels] = useState<Array<{ id: string; name?: string }>>([])
  const [fetching, setFetching] = useState(false)
  const [fetched, setFetched] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [created, setCreated] = useState(false)

  const canFetch = protocol === 'openai' && /^https?:\/\//.test(baseUrl.trim()) && apiKey.trim().length > 0
  const canCreate = name.trim() && baseUrl.trim() && apiKey.trim() && model.trim()

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

  const handleCreate = async () => {
    setMsg(null)
    try {
      const res = await window.torra.createApiModel({
        displayName: name.trim(),
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        model: model.trim(),
        protocol,
      })
      if (!res.ok) {
        setMsg({ kind: 'err', text: res.errors?.join('；') ?? '创建失败' })
        return
      }
      setCreated(true)
      await onCreated()
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message || '创建失败，请重试' })
    }
  }

  if (created) {
    return (
      <div className="modal-mask">
        <div className="modal" style={{ maxWidth: 480 }}>
          <h2>
            <CheckCircle size={18} style={{ color: 'var(--consensus)' }} />
            已添加「{name}」
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
            添加 API 模型
          </h2>
          <button className="btn icon" onClick={onClose}>
            <X size={14} />
          </button>
        </div>

        <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 20 }}>
          支持 OpenAI 兼容和 Anthropic API 端点。OpenAI 兼容端点可一键获取模型列表，Anthropic 端点请手动填写模型名。
        </p>

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
            placeholder="sk-..."
          />
        </div>

        <div className="field">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <label style={{ margin: 0 }}>模型</label>
            <button
              className="btn sm"
              onClick={handleFetchModels}
              disabled={!canFetch || fetching}
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

        {msg && (
          <div className={`moderator-note${msg.kind === 'err' ? ' error' : ''}`} style={{ marginTop: 16 }}>
            {msg.kind === 'err' && <AlertTriangle size={12} style={{ marginRight: 6, verticalAlign: -2 }} />}
            {msg.text}
          </div>
        )}

        <div className="modal-actions" style={{ marginTop: 24 }}>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={handleCreate} disabled={!canCreate}>
            创建
          </button>
        </div>
      </div>
    </div>
  )
}
