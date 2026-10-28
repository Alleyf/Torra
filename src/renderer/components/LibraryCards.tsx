/**
 * 资源库的卡片墙零件：技能 / 自建工具 / 记忆 / 应用 / 权限 / 搜索六页共用一套骨架。
 *
 * 为什么抽出来而不是各页自己写：卡片的五个位置（图标砖 / 标题 / 来路徽标 / 两行说明 /
 * 页脚元信息）在六页上必须长得一样 —— 用户是靠「同一位置的颜色和字重」认出这是资源、
 * 那是状态。各写一份的结局是每页差 1px 字号和 2px 内边距，看着像三个人做的。
 *
 * 四处约定：
 * 1. **整卡可点 → 详情弹窗**。卡片面积大，点它是「我想看看这是什么」，不是「执行」；
 *    真正的动作（导入 / 启用 / 删除）留在弹窗里，页脚只放低风险的直连键。
 * 2. **胶囊是位置，不是语义**。同一个位置在「来源」页是「导入」，在「记忆」页是
 *    「生成插件」，由页面决定，组件不猜。
 * 3. **不引外部图片**。图标只取 lucide，来路用文字徽标：仓库里没有发布方，编一个
 *    服务商 logo 只会让人以为那是个真实的生态。
 * 4. **弹窗不带 backdrop-filter**：祖先一旦有模糊，原生 <select> 的下拉会被渲染成纯黑。
 */

import { useEffect, type ReactNode, type SyntheticEvent } from 'react'
import { RefreshCw, X, type LucideIcon } from 'lucide-react'

export function LibGrid({ children }: { children: ReactNode }) {
  return <div className="lib-grid">{children}</div>
}

export function LibCard({
  icon: Icon,
  title,
  meta,
  action,
  desc,
  footer,
  tone,
  wide,
  onOpen,
  children,
}: {
  icon: LucideIcon
  title: string
  /** 来路徽标：来源应用、kind、版本都放这里 */
  meta?: ReactNode
  /** 右上角：一颗胶囊，或一两个图标键 */
  action?: ReactNode
  desc?: ReactNode
  footer?: ReactNode
  /** 坏清单 / 失效链接这类需要一眼认出来的卡 */
  tone?: 'warn'
  /** 跨满一行：页级告警不是某一条资源 */
  wide?: boolean
  /** 给了就整卡可点，打开详情 */
  onOpen?: () => void
  /** 说明与页脚之间的额外内容（源码预览、警告行） */
  children?: ReactNode
}) {
  // 卡里嵌着按钮：点在按钮上只该执行那个按钮，不该顺手把详情弹出来
  const fromButton = (e: SyntheticEvent) => !!(e.target as HTMLElement).closest('button')
  return (
    <article
      className={`lib-card${tone ? ` ${tone}` : ''}${wide ? ' wide' : ''}${onOpen ? ' openable' : ''}`}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      title={onOpen ? '查看详情' : undefined}
      onClick={onOpen ? (e) => (fromButton(e) ? undefined : onOpen()) : undefined}
      onKeyDown={
        onOpen
          ? (e) => {
              if (fromButton(e)) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onOpen()
              }
            }
          : undefined
      }
    >
      <div className="lib-card-head">
        <span className="lib-card-ico" aria-hidden="true">
          <Icon size={16} />
        </span>
        <div className="lib-card-id">
          <h4 className="lib-card-name" title={title}>
            {title}
          </h4>
          {meta && <div className="lib-card-meta">{meta}</div>}
        </div>
        {action && <div className="lib-card-act">{action}</div>}
      </div>
      {desc && <p className="lib-card-desc">{desc}</p>}
      {children}
      {footer && <div className="lib-card-foot">{footer}</div>}
    </article>
  )
}

/**
 * 卡片右上那颗胶囊。
 *
 * 没有 onClick 时渲染成 span：它是状态（已加载 / 缺说明），不该假装可点 ——
 * 一颗按下去没反应的按钮比一句静止的状态更让人困惑。
 */
export function LibPill({
  children,
  tone = 'plain',
  busy,
  disabled,
  title,
  onClick,
}: {
  children: ReactNode
  tone?: 'brand' | 'plain' | 'ok' | 'warn'
  busy?: boolean
  disabled?: boolean
  title?: string
  onClick?: () => void
}) {
  const className = `lib-pill${tone === 'plain' ? '' : ` ${tone}`}`
  const body = (
    <>
      {busy && <RefreshCw size={11} className="spin" />}
      {children}
    </>
  )
  if (!onClick) {
    return (
      <span className={className} title={title}>
        {body}
      </span>
    )
  }
  return (
    <button type="button" className={className} title={title} disabled={disabled} onClick={onClick}>
      {body}
    </button>
  )
}

/**
 * 资源详情弹窗。
 *
 * 卡片只承载「一眼认出」，所以真正要读的东西（完整说明、路径、能力清单、待审源码、
 * 失败原因）都在这里；动作也放这里 —— 危险动作不该躺在列表里等着误触。
 */
export function LibDetail({
  icon: Icon,
  title,
  meta,
  desc,
  tone,
  children,
  actions,
  onClose,
}: {
  icon: LucideIcon
  title: string
  meta?: ReactNode
  desc?: ReactNode
  tone?: 'warn'
  children?: ReactNode
  actions?: ReactNode
  onClose: () => void
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="modal-mask lib-detail-mask" onMouseDown={onClose}>
      <div
        className={`lib-detail${tone ? ` ${tone}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="lib-detail-head">
          <span className="lib-card-ico" aria-hidden="true">
            <Icon size={18} />
          </span>
          <div className="lib-detail-id">
            <h3 className="lib-detail-title">{title}</h3>
            {meta && <div className="lib-card-meta">{meta}</div>}
          </div>
          <button className="st-icon" aria-label="关闭" title="关闭（Esc）" onClick={onClose}>
            <X size={13} />
          </button>
        </header>
        {desc && <p className="lib-detail-desc">{desc}</p>}
        {children}
        {actions && <footer className="lib-detail-actions">{actions}</footer>}
      </div>
    </div>
  )
}
