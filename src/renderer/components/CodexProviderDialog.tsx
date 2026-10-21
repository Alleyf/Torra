import { useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle, Loader2, X } from 'lucide-react'

type CodexProvider = Awaited<ReturnType<typeof window.torra.listCodexProviders>>['providers'][number]

export function CodexProviderDialog({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: () => Promise<void> | void
}) {
  const [providers, setProviders] = useState<CodexProvider[]>([])
  const [providerId, setProviderId] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [model, setModel] = useState('')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [success, setSuccess] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    let alive = true
    window.torra.listCodexProviders().then((result) => {
      if (!alive) return
      setProviders(result.providers)
      const first = result.providers[0]
      if (first) {
        setProviderId(first.id)
        setDisplayName(first.name || first.id)
        setModel(first.model || '')
      }
      if (result.error) setMessage({ ok: false, text: result.error })
    }).catch((error: unknown) => {
      if (alive) setMessage({ ok: false, text: (error as Error).message || '读取 Codex Provider 失败' })
    }).finally(() => {
      if (alive) setLoading(false)
    })
    return () => { alive = false }
  }, [])

  const selected = useMemo(() => providers.find((provider) => provider.id === providerId), [providers, providerId])
  const canImport = !loading && !saving && !!selected && selected.wireApi === 'responses' && selected.credentialsConfigured && !!displayName.trim() && !!model.trim()

  const chooseProvider = (id: string) => {
    const provider = providers.find((item) => item.id === id)
    setProviderId(id)
    setDisplayName(provider?.name || provider?.id || '')
    setModel(provider?.model || '')
    setMessage(null)
  }

  const handleImport = async () => {
    if (!canImport || !selected) return
    setSaving(true)
    setMessage(null)
    try {
      const result = await window.torra.importCodexProvider({
        providerId: selected.id,
        displayName: displayName.trim(),
        model: model.trim(),
      })
      if (!result.ok) {
        setMessage({ ok: false, text: result.errors?.join('；') || '导入失败' })
        return
      }
      await onImported()
      setSuccess(true)
    } catch (error) {
      setMessage({ ok: false, text: (error as Error).message || '导入失败，请重试' })
    } finally {
      setSaving(false)
    }
  }

  if (success) {
    return (
      <div className="modal-mask">
        <div className="modal" style={{ maxWidth: 480 }}>
          <h2><CheckCircle size={18} style={{ color: 'var(--consensus)' }} />已导入「{displayName}」</h2>
          <p>已从 Codex 复用 Responses Provider 配置，模型列表已刷新。凭据保存在本机钥匙串中。</p>
          <div className="modal-actions">
            <button className="btn primary" onClick={onClose}>知道了</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="modal-mask">
      <div className="modal" style={{ maxWidth: 560, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>复用 Codex Provider</h2>
          <button className="btn icon" onClick={onClose} aria-label="关闭"><X size={14} /></button>
        </div>
        <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 20 }}>
          从本机 Codex 配置导入 Responses Provider。凭据与自定义请求头不会显示在此窗口。
        </p>

        {loading ? (
          <div className="moderator-note"><Loader2 size={12} className="spin" style={{ marginRight: 6 }} />正在读取 Codex 配置…</div>
        ) : providers.length === 0 ? (
          <div className="moderator-note">没有可用的 Codex Provider。</div>
        ) : (
          <>
            <div className="field">
              <label>Provider</label>
              <select value={providerId} onChange={(event) => chooseProvider(event.target.value)} style={{ width: '100%' }}>
                {providers.map((provider) => (
                  <option key={provider.id} value={provider.id}>{provider.name || provider.id} · {provider.wireApi}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>显示名称</label>
              <input type="text" value={displayName} onChange={(event) => setDisplayName(event.target.value)} placeholder="模型名称" />
            </div>
            <div className="field">
              <label>模型</label>
              <input type="text" value={model} onChange={(event) => setModel(event.target.value)} placeholder="填写 Codex 使用的模型名" />
            </div>
            <div className="moderator-note">
              {selected?.credentialsConfigured ? '检测到凭据配置；导入时由主进程安全读取并写入本机钥匙串。' : '缺少凭据配置。请先检查 Codex 的环境变量或请求头配置。'}
              {selected?.wireApi !== 'responses' && ' 目前仅支持 wire_api = "responses"。'}
              {selected && <div style={{ marginTop: 4, color: 'var(--text-3)' }}>{selected.baseUrl}</div>}
            </div>
          </>
        )}

        {message && (
          <div className={`moderator-note${message.ok ? '' : ' error'}`} style={{ marginTop: 16 }}>
            {!message.ok && <AlertTriangle size={12} style={{ marginRight: 6, verticalAlign: -2 }} />}
            {message.text}
          </div>
        )}

        <div className="modal-actions" style={{ marginTop: 24 }}>
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={() => void handleImport()} disabled={!canImport}>
            {saving && <Loader2 size={12} className="spin" />}
            {saving ? '导入中…' : '导入 Provider'}
          </button>
        </div>
      </div>
    </div>
  )
}
