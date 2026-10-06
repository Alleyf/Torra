/**
 * 标题栏提示 chip —— 全应用唯一的提示出口（见 notice.ts 的取舍说明）。
 *
 * 它参与标题栏的 flex 布局而不是盖在上面：中间空档本来就归它，
 * 左边的导航和右边的操作按钮都设了不可压缩，长文案先省略号、再换 title，
 * 所以永远不可能压住菜单或按钮。
 */
import { useState } from 'react'
import { AlertCircle, AlertTriangle, CheckCircle, ChevronRight, Info, X } from 'lucide-react'
import { clearNotice, useTransientNotice, type NoticeItem, type NoticeTone } from '../notice'

const TONE_ICON: Record<NoticeTone, React.ReactNode> = {
  info: <Info size={12} />,
  success: <CheckCircle size={12} />,
  warn: <AlertTriangle size={12} />,
  danger: <AlertCircle size={12} />,
}

export function TitlebarNotice({ persistent }: { persistent: NoticeItem[] }) {
  const transient = useTransientNotice()
  /** 常驻提示只显一条，其余靠这个页码轮看 —— 不做「悄悄藏起来」 */
  const [page, setPage] = useState(0)

  const shown = transient ?? (persistent.length > 0 ? persistent[page % persistent.length]! : null)
  if (!shown) return null

  const runAction = () => {
    shown.action?.run()
    if (transient) clearNotice()
  }

  return (
    <div
      className={`titlebar-notice tn-${shown.tone}`}
      role="status"
      aria-live="polite"
      title={shown.hint ?? shown.text}
    >
      <span className="tn-icon">{TONE_ICON[shown.tone]}</span>
      <span className="tn-text">{shown.text}</span>
      {!transient && persistent.length > 1 && (
        <button
          className="tn-page"
          onClick={() => setPage((p) => (p + 1) % persistent.length)}
          title={`还有 ${persistent.length - 1} 条提示，点击轮看`}
        >
          {(page % persistent.length) + 1}
          /{persistent.length}
          <ChevronRight size={11} />
        </button>
      )}
      {shown.action && (
        <button className="tn-btn" onClick={runAction}>
          {shown.action.label}
        </button>
      )}
      {transient && (
        <button className="tn-x" onClick={clearNotice} title="收起提示" aria-label="收起提示">
          <X size={11} />
        </button>
      )}
    </div>
  )
}
