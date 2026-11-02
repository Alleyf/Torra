/**
 * 一行密钥：名字与状态在左，输入与动作在右。
 *
 * 密钥总页与插件详情共用同一份 —— 两处各写一遍，迟早一边忘了清空输入框、
 * 一边把「可选」画成红色警告。
 */
import { useState, type ReactNode } from 'react'
import { AlertTriangle, Check, CheckCircle, RefreshCw, Trash2 } from 'lucide-react'
import { fail, failFromReason } from '../messages'

export type SecretOutcome = { ok: boolean; reason?: string; text?: string }

export function SecretRow({
  icon,
  title,
  detail,
  configured,
  optional,
  placeholder,
  saveLabel = '保存',
  layout = 'row',
  onSave,
  onClear,
}: {
  icon?: ReactNode
  title: string
  detail?: ReactNode
  configured: boolean
  optional?: boolean
  placeholder?: string
  saveLabel?: string
  /** 弹窗或窄栏里用 stack：输入框换到下一行，免得把按钮挤出边界 */
  layout?: 'row' | 'stack'
  onSave: (value: string) => Promise<SecretOutcome>
  onClear?: () => Promise<SecretOutcome>
}) {
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState<'save' | 'clear' | null>(null)
  const [note, setNote] = useState<{ ok: boolean; text: string; detail?: string } | null>(null)

  const flash = (ok: boolean, text: string, detail?: string) => {
    setNote({ ok, text, detail })
    window.setTimeout(() => setNote((current) => (current?.text === text ? null : current)), 6000)
  }

  const save = async () => {
    const secret = value.trim()
    if (!secret) return
    setBusy('save')
    const started = Date.now()
    try {
      const r = await onSave(secret)
      // 成败都清空：失败时留着等于把密钥摊在界面上
      setValue('')
      const elapsed = Date.now() - started
      if (elapsed < 350) await new Promise((res) => setTimeout(res, 350 - elapsed))
      if (r.ok) {
        flash(true, r.text ?? '已保存')
      } else {
        const f = failFromReason(
          '这把密钥没存下来',
          r.reason,
          '确认本机钥匙串可用后点「保存」再试一次；也可以换一把 Key 再试。',
        )
        flash(false, f.text, f.detail)
      }
    } catch (e) {
      const f = fail(
        '这把密钥没存下来。确认本机钥匙串可用后点「保存」再试一次；也可以换一把 Key 再试。',
        (e as Error).message,
      )
      flash(false, f.text, f.detail)
    } finally {
      setBusy(null)
    }
  }

  const clear = async () => {
    if (!onClear) return
    setBusy('clear')
    try {
      const r = await onClear()
      if (r.ok) {
        flash(true, r.text ?? '已清除')
      } else {
        const f = failFromReason(
          '这把密钥没清掉',
          r.reason,
          '确认本机钥匙串可用后点「清除」再试一次；实在清不掉就换一把 Key 覆盖它。',
        )
        flash(false, f.text, f.detail)
      }
    } catch (e) {
      const f = fail(
        '这把密钥没清掉。确认本机钥匙串可用后点「清除」再试一次；实在清不掉就换一把 Key 覆盖它。',
        (e as Error).message,
      )
      flash(false, f.text, f.detail)
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className={layout === 'stack' ? 'st-row stack' : 'st-row'}>
      {icon && (
        <div className="st-avatar" style={{ background: 'var(--sunken)', color: 'var(--text-3)' }}>
          {icon}
        </div>
      )}
      <div className="st-grow">
        <div className="st-name">{title}</div>
        <div className="st-meta">
          {configured ? (
            <span className="ok">
              <CheckCircle size={10} /> 已配置
            </span>
          ) : optional ? (
            <span>未配置 · 可选</span>
          ) : (
            <span className="warn">
              <AlertTriangle size={10} /> 未配置
            </span>
          )}
          {detail}
        </div>
        {note && (
          <div className="st-meta">
            <span className={note.ok ? 'ok' : 'warn'}>
              {note.ok ? <CheckCircle size={10} /> : <AlertTriangle size={10} />} {note.text}
            </span>
          </div>
        )}
        {note?.detail && (
          <div className="st-meta">
            <span className="st-note-detail">原始信息：{note.detail}</span>
          </div>
        )}
      </div>
      <div className="st-actions" style={layout === 'stack' ? { width: '100%' } : undefined}>
        <input
          type="password"
          className="st-input"
          value={value}
          disabled={busy !== null}
          aria-label={`${title} 的密钥`}
          placeholder={placeholder}
          style={layout === 'stack' ? { flex: '1 1 auto', width: 'auto', minWidth: 0 } : undefined}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim()) void save()
          }}
        />
        <button className="st-btn primary" disabled={busy !== null || !value.trim()} onClick={() => void save()}>
          {busy === 'save' ? <RefreshCw size={12} className="spin" /> : <Check size={12} />}
          {saveLabel}
        </button>
        {onClear && (
          <button className="st-btn danger" disabled={busy !== null || !configured} onClick={() => void clear()}>
            {busy === 'clear' ? <RefreshCw size={12} className="spin" /> : <Trash2 size={12} />}
            清除
          </button>
        )}
      </div>
    </div>
  )
}
