import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle, ExternalLink, Loader2, RefreshCw, X } from 'lucide-react'

/** 主进程探测结果里的模型行 */
type MagpieModel = { id: string }

type Discover = Awaited<ReturnType<typeof window.torra.discoverMagpie>>

/**
 * 自动发现本机 magpie 网关并批量导入其模型。
 *
 * magpie 在 127.0.0.1:3425 暴露一个自述端点（GET / 回 {"name":"magpie"}），据此
 * 区别于任意 OpenAI 兼容网关；命中后拉 /v1/models 得清单。用户勾选确认才落盘：
 * magpie 可能挂了几十个模型，一键全铺进侧栏会失控，勾选这道闸门与
 * 「复用 Codex Provider」的密钥需用户确认一脉相承。
 */
export function MagpieImportDialog({
  onClose,
  onImported,
}: {
  onClose: () => void
  onImported: () => Promise<void> | void
}) {
  // 默认探本机 magpie 固定端口；地址可改，兼容换端口或 LAN 共享的 magpie
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:3425')
  const [loading, setLoading] = useState(true)
  const [found, setFound] = useState(false)
  // 探测规范化后的 base，导入与去重都用它，不用输入框原值，避免尾斜杠差异漏判重复
  const [probedBase, setProbedBase] = useState('')
  const [models, setModels] = useState<MagpieModel[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const [result, setResult] = useState<{ created: number; skipped: number; errors?: string[] } | null>(null)
  // each=每个模型一条（旧行为）；single=合并为一条带可切换清单的条目
  const [mode, setMode] = useState<'each' | 'single'>('each')
  const [entryName, setEntryName] = useState('magpie 网关')

  const discover = useCallback(
    async (address: string) => {
      setLoading(true)
      setMessage(null)
      setResult(null)
      setModels([])
      setSelected(new Set())
      let res: Discover
      try {
        res = await window.torra.discoverMagpie(address)
      } catch (error) {
        setFound(false)
        setMessage({ ok: false, text: (error as Error).message || '探测 magpie 失败' })
        setLoading(false)
        return
      }
      setFound(res.found)
      setProbedBase(res.baseUrl)
      if (res.error) setMessage({ ok: res.found, text: res.error })
      if (res.found && res.models.length) {
        setModels(res.models)
        // 默认全选：用户更常是想整批接入，逐条取消比逐条勾省力
        setSelected(new Set(res.models.map((m) => m.id)))
      }
      setLoading(false)
    },
    [],
  )

  useEffect(() => {
    void discover(baseUrl)
    // 只在挂载时探一次默认地址；换地址后由「重新探测」按钮显式触发
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }
  const selectAll = () => setSelected(new Set(models.map((m) => m.id)))
  const clearAll = () => setSelected(new Set())

  const selectedIds = useMemo(() => models.map((m) => m.id).filter((id) => selected.has(id)), [models, selected])
  const canImport = !loading && !importing && found && selectedIds.length > 0

  const handleImport = async () => {
    if (!canImport) return
    setImporting(true)
    setMessage(null)
    try {
      const res = await window.torra.importMagpieModels({
        baseUrl: probedBase,
        ids: selectedIds,
        ...(mode === 'single' ? { asSingleEntry: true, displayName: entryName.trim() || 'magpie 网关' } : {}),
      })
      if (!res.ok) {
        setMessage({ ok: false, text: res.errors?.join('；') || '导入失败' })
      } else {
        setResult({ created: res.created, skipped: res.skipped, ...(res.errors ? { errors: res.errors } : {}) })
        await onImported()
      }
    } catch (error) {
      setMessage({ ok: false, text: (error as Error).message || '导入失败，请重试' })
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="modal-mask">
      <div className="modal" style={{ maxWidth: 560, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>从 magpie 网关导入</h2>
          <button className="btn icon" onClick={onClose} aria-label="关闭"><X size={14} /></button>
        </div>

        {result ? (
          <>
            <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 12 }}>
              <CheckCircle size={16} style={{ color: 'var(--consensus)', verticalAlign: -3, marginRight: 6 }} />
              {mode === 'single'
                ? result.created > 0
                  ? `已新增一条「${entryName.trim() || 'magpie 网关'}」，含 ${selectedIds.length} 个可切换模型`
                  : result.skipped >= selectedIds.length
                    ? '清单无新增 —— 这条网关早就认识这些模型，什么都没改'
                    : `已把 ${selectedIds.length - result.skipped} 个新模型并入现有「${entryName.trim() || 'magpie 网关'}」的清单`
                : `新增 ${result.created} 个模型${result.skipped > 0 ? `，跳过 ${result.skipped} 个已存在` : ''}`}
              。凭据按网关占位 Key 存于本机钥匙串。
            </p>
            {result.errors && result.errors.length > 0 && (
              <div className="moderator-note error" style={{ marginBottom: 12 }}>
                {result.errors.map((e, i) => (
                  <div key={i}>{e}</div>
                ))}
              </div>
            )}
            <div className="modal-actions">
              <button className="btn primary" onClick={onClose}>完成</button>
            </div>
          </>
        ) : (
          <>
            <p style={{ fontSize: 13, color: 'var(--text-2)', marginBottom: 16 }}>
              探测本机 magpie 网关，把它服务的模型批量接入议事厅。每个模型走 OpenAI 兼容协议连到网关，由 magpie 负责路由与配额。
              {' '}
              {/* 官网链接放正文末尾：用户在这里卡住时最想知道的是「我该怎么让 magpie 起来」，
                  而不是再去翻 README。target=_blank 由 Electron 的 window-open 守卫交给系统浏览器 */}
              <a className="ext-link" href="https://usemagpie.ai/zh/" target="_blank" rel="noopener noreferrer">
                <ExternalLink size={11} style={{ marginRight: 3, verticalAlign: -1 }} />
                magpie 官网 · 方便用户快速接入
              </a>
            </p>

            <div className="field">
              <label>网关地址</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="url"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                  placeholder="http://127.0.0.1:3425"
                  style={{ flex: 1 }}
                  disabled={importing}
                />
                <button className="btn" onClick={() => void discover(baseUrl)} disabled={loading || importing}>
                  <RefreshCw size={12} className={loading ? 'spin' : undefined} style={{ marginRight: 4 }} />
                  {loading ? '探测中…' : '重新探测'}
                </button>
              </div>
            </div>

            {message && (
              <div className={`moderator-note${message.ok ? '' : ' error'}`} style={{ marginTop: 4, marginBottom: 12 }}>
                {!message.ok && <AlertTriangle size={12} style={{ marginRight: 6, verticalAlign: -2 }} />}
                {message.text}
              </div>
            )}

            {found && models.length > 0 && (
              <>
                <div className="field" style={{ marginBottom: 12 }}>
                  <label>导入方式</label>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <label className={`check-item${mode === 'each' ? ' on' : ''}`} style={{ flex: 1, cursor: 'pointer' }}>
                      <input type="radio" name="magpie-mode" checked={mode === 'each'} onChange={() => setMode('each')} style={{ display: 'none' }} />
                      <div>
                        <div style={{ fontWeight: 500, fontSize: 13 }}>每个模型一条</div>
                        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>侧栏各占一席，可单独配色与定价</div>
                      </div>
                    </label>
                    <label className={`check-item${mode === 'single' ? ' on' : ''}`} style={{ flex: 1, cursor: 'pointer' }}>
                      <input type="radio" name="magpie-mode" checked={mode === 'single'} onChange={() => setMode('single')} style={{ display: 'none' }} />
                      <div>
                        <div style={{ fontWeight: 500, fontSize: 13 }}>合并为一条</div>
                        <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>一个端点带全部清单，开场时按座位选模型</div>
                      </div>
                    </label>
                  </div>
                  {mode === 'single' && (
                    <div className="field" style={{ marginBottom: 0, marginTop: 8 }}>
                      <label>条目名称</label>
                      <input
                        type="text"
                        value={entryName}
                        onChange={(event) => setEntryName(event.target.value)}
                        placeholder="例如：magpie 网关"
                        disabled={importing}
                      />
                    </div>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', margin: '8px 0' }}>
                  <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                    共 {models.length} 个模型，已选 {selectedIds.length}
                  </span>
                  <span style={{ display: 'flex', gap: 8 }}>
                    <button className="btn sm" onClick={selectAll}>全选</button>
                    <button className="btn sm" onClick={clearAll}>清空</button>
                  </span>
                </div>
                <div style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', maxHeight: 280, overflowY: 'auto' }}>
                  {models.map((m, idx) => (
                    <label
                      key={m.id}
                      /* 首行不画分隔线：容器自己有边框，第一条行内上边线会和它叠成双线 */
                      style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px', fontSize: 12.5, cursor: 'pointer', borderTop: idx ? '1px solid var(--border-subtle)' : 'none' }}
                    >
                      <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} />
                      {/* 用 --font-mono：原先写的 --mono 在主题里根本不存在，一直落到 monospace 兜底 */}
                      <span style={{ fontFamily: 'var(--font-mono)' }}>{m.id}</span>
                    </label>
                  ))}
                </div>
              </>
            )}

            {found && models.length === 0 && !loading && (
              <div className="moderator-note">网关在线但未列出任何模型。</div>
            )}

            <div className="modal-actions" style={{ marginTop: 20 }}>
              <button className="btn" onClick={onClose}>取消</button>
              <button className="btn primary" onClick={() => void handleImport()} disabled={!canImport}>
                {importing && <Loader2 size={12} className="spin" />}
                {importing
                  ? '导入中…'
                  : mode === 'single'
                    ? `合并为一条（${selectedIds.length} 个可切换模型）`
                    : `导入选中的 ${selectedIds.length} 个模型`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
