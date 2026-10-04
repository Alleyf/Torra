import { useState } from 'react'
import type { ModelSummary, PickCandidate, PickScan } from '../store'
import { Globe, Search, CheckCircle, AlertTriangle, X, Plus, Scan } from 'lucide-react'

const PRESETS: Array<{ label: string; entry: string; hint: string }> = [
  { label: 'DeepSeek', entry: 'https://chat.deepseek.com/', hint: '发送/停止同一按钮，需文本稳定判定' },
  { label: '通义千问', entry: 'https://chat.qwen.ai/', hint: '按钮带 aria-label，最规范' },
  { label: '豆包', entry: 'https://www.doubao.com/chat/', hint: 'data-testid 钩子最稳' },
  { label: 'Kimi', entry: 'https://www.kimi.com/', hint: 'Lexical 富文本编辑器' },
]

const ROLE_LABEL: Record<keyof PickScan, string> = {
  input: '输入框',
  send: '发送按钮',
  stop: '停止按钮',
  stream: '回复容器',
}

const ROLES = Object.keys(ROLE_LABEL) as Array<keyof PickScan>

export function WebModelDialog({
  models,
  onClose,
  onCreated,
}: {
  models: ModelSummary[]
  onClose: () => void
  onCreated: () => Promise<void> | void
}) {
  const [name, setName] = useState('')
  const [entry, setEntry] = useState('')
  const [sel, setSel] = useState<Record<keyof PickScan, string>>({
    input: '',
    send: '',
    stop: '',
    stream: '',
  })
  const [inputKind, setInputKind] = useState<'textarea' | 'contenteditable'>('textarea')
  const [sendMode, setSendMode] = useState<'click' | 'enter'>('enter')
  const [streamMode, setStreamMode] = useState<'last' | 'all'>('last')
  const [completionMode, setCompletionMode] = useState<'stop_button_hidden' | 'dom_stable'>('dom_stable')

  const [scan, setScan] = useState<PickScan | null>(null)
  const [scanning, setScanning] = useState(false)
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [created, setCreated] = useState(false)

  const canScan = /^https?:\/\//.test(entry.trim())
  const ready = name.trim().length > 0 && entry.trim().length > 0 && sel.input.trim().length > 0

  const runScan = async () => {
    setScanning(true)
    setMsg(null)
    try {
      const existing = models.find((m) => m.transport === 'webview' && sameHost(m.id, entry))
      const res = existing
        ? await window.torra.scanSelectorsOfModel(existing.id)
        : await window.torra.scanSelectors(entry.trim())

      if (!res.ok || !res.scan) {
        setMsg({ kind: 'err', text: res.reason ?? '扫描失败' })
        return
      }

      const s = res.scan
      setScan(s)

      const auto: Record<keyof PickScan, string> = { ...sel }
      let filled = 0
      for (const role of ROLES) {
        const hit = (s[role] ?? []).find((c) => c.candidates.some((x) => x.matches === 1))
        if (hit) {
          auto[role] = hit.selector
          filled += 1
        }
      }
      setSel(auto)

      const inputHit = (s.input ?? [])[0]
      if (inputHit && (inputHit.selector.includes('contenteditable') || inputHit.tag === 'div')) {
        setInputKind('contenteditable')
      }
      if (auto.send) setSendMode('click')

      const total = ROLES.reduce((n, r) => n + (s[r]?.length ?? 0), 0)
      setMsg({
        kind: 'ok',
        text: `扫描到 ${total} 个候选元素，已自动填入 ${filled} 项。请确认下方选择器后再创建。`,
      })
    } catch (e) {
      setMsg({ kind: 'err', text: (e as Error).message })
    } finally {
      setScanning(false)
    }
  }

  const create = async () => {
    setMsg(null)
    try {
      const res = await window.torra.createWebModel({
        displayName: name.trim(),
        entry: entry.trim(),
        selectors: {
          input: sel.input.trim(),
          ...(sel.send ? { send: sel.send.trim() } : {}),
          ...(sel.stop ? { stop: sel.stop.trim() } : {}),
          stream: sel.stream.trim(),
        },
        input_kind: inputKind,
        send_mode: sendMode,
        stream_mode: streamMode,
        completion_mode: completionMode,
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
        <div className="modal" style={{ maxWidth: 560 }}>
          <h2>
            <CheckCircle size={18} style={{ color: 'var(--consensus)' }} />
            已添加「{name}」
          </h2>
          <p>适配器已写入本机 userData 目录，重启后仍然保留。</p>
          <p style={{ color: 'var(--warn)' }}>
            接下来：关闭本窗口，点击左栏该模型的头像打开页面并完成登录。
            登录后建议先用它单独试一轮，确认能正常抓到回复再加入正式讨论。
          </p>
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
      <div className="modal" style={{ maxWidth: 760, maxHeight: '90vh', overflowY: 'auto' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ margin: 0 }}>
            <Globe size={18} />
            添加网页版模型
          </h2>
          <button className="btn icon" onClick={onClose}>
            <X size={14} />
          </button>
        </div>
        <p>
          Torra 通过驱动你已登录的浏览器实例来调用网页版模型。
          填好站点地址后扫描页面元素即可自动生成 CSS 选择器 —— 不必手写。
        </p>

        <div className="field">
          <label>模型名称</label>
          <input type="text" value={name} placeholder="例如：智谱清言" onChange={(e) => setName(e.target.value)} />
        </div>

        <div className="field">
          <label>站点地址</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input
              type="text"
              value={entry}
              placeholder="https://chat.example.com/"
              onChange={(e) => setEntry(e.target.value)}
            />
            <button
              className="btn"
              disabled={!canScan || scanning}
              onClick={() => void runScan()}
              title={canScan ? '打开页面并扫描候选元素' : '请先填写 http(s) 地址'}
            >
              <Scan size={12} />
              {scanning ? '扫描中…' : '扫描'}
            </button>
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
            {PRESETS.map((p) => (
              <button
                key={p.entry}
                className="btn sm"
                title={p.hint}
                onClick={() => {
                  setEntry(p.entry)
                  if (!name) setName(p.label)
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        {msg && (
          <div
            className={`banner ${msg.kind === 'err' ? 'danger' : ''}`}
            style={{ borderRadius: 'var(--radius-sm)', marginBottom: 10, display: 'flex' }}
          >
            {msg.kind === 'err' ? <AlertTriangle size={14} /> : <CheckCircle size={14} />}
            {msg.text}
          </div>
        )}

        <div className="field-row">
          <div className="field">
            <label>输入框类型</label>
            <select value={inputKind} onChange={(e) => setInputKind(e.target.value as typeof inputKind)}>
              <option value="textarea">原生 textarea / input</option>
              <option value="contenteditable">富文本（Lexical / Slate）</option>
            </select>
          </div>
          <div className="field">
            <label>发送方式</label>
            <select value={sendMode} onChange={(e) => setSendMode(e.target.value as typeof sendMode)}>
              <option value="enter">Enter 键</option>
              <option value="click">点击发送按钮</option>
            </select>
          </div>
        </div>

        <div className="field-row">
          <div className="field">
            <label>回复读取</label>
            <select value={streamMode} onChange={(e) => setStreamMode(e.target.value as typeof streamMode)}>
              <option value="last">最后一条消息</option>
              <option value="all">全部拼接（分段模型）</option>
            </select>
          </div>
          <div className="field">
            <label>完成判定</label>
            <select value={completionMode} onChange={(e) => setCompletionMode(e.target.value as typeof completionMode)}>
              <option value="dom_stable">文本稳定（最鲁棒，推荐）</option>
              <option value="stop_button_hidden">停止按钮消失</option>
            </select>
          </div>
        </div>

        <div style={{ fontSize: 11, color: 'var(--text-3)', margin: '14px 0 8px', lineHeight: 1.7, display: 'flex', alignItems: 'center', gap: 6 }}>
          <Search size={11} />
          CSS 选择器 —— 扫描后自动填入，可手动修改
        </div>

        {ROLES.map((role) => (
          <div className="field" key={role}>
            <label>
              {ROLE_LABEL[role]}
              <span style={{ color: 'var(--text-3)', marginLeft: 6 }}>
                {role === 'stop'
                  ? '（可留空）'
                  : role === 'send'
                    ? '（Enter 发送时可留空）'
                    : ''}
              </span>
            </label>
            <input
              type="text"
              value={sel[role]}
              placeholder={role === 'input' ? 'textarea[name="user query"]' : '可留空'}
              onChange={(e) => setSel({ ...sel, [role]: e.target.value })}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5 }}
            />
            {scan && (scan[role]?.length ?? 0) > 0 && (
              <SelectorChips candidates={scan[role]} onPick={(v) => setSel({ ...sel, [role]: v })} />
            )}
          </div>
        ))}

        {completionMode === 'dom_stable' && (
          <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.8, marginTop: 4 }}>
            「文本稳定」表示回复内容连续约 3 秒不变即视为生成结束。这是对站点改版最鲁棒的方式，
            不确定时推荐用它。部分站点（如发送与停止复用同一按钮）只能靠这种方式判定。
          </div>
        )}

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" disabled={!ready} onClick={() => void create()}>
            <Plus size={13} />
            创建模型
          </button>
        </div>
        {!ready && (
          <div style={{ fontSize: 11, color: 'var(--text-3)', textAlign: 'right', marginTop: 6 }}>
            需填写名称、站点地址与输入框选择器
          </div>
        )}
      </div>
    </div>
  )
}

function SelectorChips({
  candidates,
  onPick,
}: {
  candidates: PickCandidate[]
  onPick: (selector: string) => void
}) {
  const list = candidates.slice(0, 6)
  if (list.length === 0) return null
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
      {list.map((c, i) => {
        const unique = c.candidates.find((x) => x.matches === 1)
        const multi = c.candidates.find((x) => x.matches > 1)
        const shown = unique ?? multi
        if (!shown) return null
        const isUnique = shown.matches === 1
        return (
          <button
            key={i}
            className="btn sm"
            title={`${isUnique ? '唯一匹配' : `匹配 ${shown.matches} 个，可能不精确`}：${shown.selector}`}
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              maxWidth: 240,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              borderColor: isUnique ? 'var(--consensus)' : 'var(--warn)',
            }}
            onClick={() => onPick(shown.selector)}
          >
            {isUnique ? <><CheckCircle size={9} /> </> : <><AlertTriangle size={9} /> </>}
            {shown.selector}
          </button>
        )
      })}
    </div>
  )
}

function sameHost(modelId: string, entry: string): boolean {
  const known: Record<string, string> = {
    deepseek: 'chat.deepseek.com',
    qwen: 'chat.qwen.ai',
    doubao: 'www.doubao.com',
    kimi: 'www.kimi.com',
  }
  const host = known[modelId]
  if (!host) return false
  try {
    return new URL(entry).host.includes(host)
  } catch {
    return false
  }
}
