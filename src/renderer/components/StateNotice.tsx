/*
 * 空状态与失败提示的标准长相。
 *
 * 为什么做成组件而不是各处手写：一屏里有三个空状态，就有三段「这里会出现什么 / 怎么让它出现」，
 * 手写迟早写成三种说法、三个字号。统一到这里，改一次全站一致。
 *
 * 图标一律用 lucide-react 的真 SVG —— Unicode 拼出来的符号（✓ ✕ ! ·）在两套皮肤下粗细不一致，
 * 也不随字号缩放，还容易被输入法替换成别的字形。
 */

import type { ReactNode } from 'react'
import { CircleAlert, Inbox } from 'lucide-react'

/**
 * 空状态：上面一句说「这里会出现什么」，下面一句说「怎么让它出现」。
 *
 * 两句都要有。只有上面那句，用户读完还是不知道该点哪儿 —— 那等于没写。
 * 只有下面那句，用户不知道这里本来该有东西。
 */
export function EmptyState({
  what,
  how,
  icon,
  compact,
  children,
}: {
  /** 这里会出现什么 */
  what: ReactNode
  /** 怎么让它出现 */
  how?: ReactNode
  icon?: ReactNode
  /** 紧凑版：用于侧栏、浮层、表格这类地方，不占大块留白 */
  compact?: boolean
  children?: ReactNode
}) {
  return (
    <div className={`es-box${compact ? ' compact' : ''}`}>
      <span className="es-what">
        {icon ? <span className="es-icon">{icon}</span> : null}
        <span>{what}</span>
      </span>
      {how ? <span className="es-how">{how}</span> : null}
      {children}
    </div>
  )
}

/** 空状态默认用的那枚图标（收件箱：这里本该有东西，现在还空着） */
export function EmptyIcon({ size = 14 }: { size?: number }) {
  return <Inbox size={size} />
}

/**
 * 失败提示：主句说「什么坏了 + 你能做什么」，原始信息缩成灰色小字挂在后面。
 *
 * 原始信息不能丢 —— 丢了就再也查不出是哪一步坏的；但它不能占主位，
 * 一句英文异常摆在最上面，用户既看不懂也不知道下一步该干什么。
 */
export function FailureNote({
  text,
  detail,
  icon,
}: {
  /** 主句 */
  text: ReactNode
  /** 原始信息（英文异常、内部 id）；有就挂成灰色小字 */
  detail?: string
  icon?: ReactNode
}) {
  return (
    <span className="fail-note">
      <span className="fail-icon">{icon ?? <CircleAlert size={12} />}</span>
      <span className="fail-text">{text}</span>
      {detail ? (
        <span className="fail-detail" title={detail}>
          原始信息：{detail}
        </span>
      ) : null}
    </span>
  )
}
