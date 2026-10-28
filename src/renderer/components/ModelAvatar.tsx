import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { ModelSummary } from '../store'
import { iconDomainChain } from '@shared/model-brand'

export function initials(name: string): string {
  const trimmed = name.trim()
  if (/^[\u4e00-\u9fa5]/.test(trimmed)) return trimmed.slice(0, 1)
  return trimmed.slice(0, 2).toUpperCase()
}

export function getFaviconUrls(domain?: string): string[] {
  if (!domain) return []
  return [
    // 首选主进程磁盘缓存协议：命中即本地读；404 再落到下面的直连兜底链
    `torra-icon://${domain}`,
    `https://favicon.im/${domain}?size=64`,
    `https://api.iowen.cn/favicon/${domain}.png`,
    `https://www.google.com/s2/favicons?domain=${domain}&sz=64`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
    `https://favicon.yandex.net/favicon/v2/${domain}?size=64`,
    `https://logo.clearbit.com/${domain}`,
  ]
}

/**
 * 图标候选链：自定义图标 → Base URL 推导出的域名 → 主页地址的域名。
 *
 * 中转站与内网网关的 Base URL 常常没有公开 favicon，只按它取就是一张字母牌；
 * 配置里填了主页，就再拿品牌站点试一遍。顺序不能反：用户给的主页可能是
 * 一个通用官网，Base URL 才是这条配置真正的来源。
 */
export function getModelIconUrls(
  model: Pick<ModelSummary, 'iconUrl' | 'domain' | 'homepage'>,
): string[] {
  const urls = [
    ...(model.iconUrl ? [model.iconUrl] : []),
    ...iconDomainChain(model.domain, model.homepage).flatMap((d) => getFaviconUrls(d)),
  ]
  return [...new Set(urls)]
}

/**
 * 所有模型入口共用的头像。
 *
 * 自定义图标 → 品牌 favicon（逐源回退）→ 统一字母牌。最后这一层不是“没有图”的
 * 临时状态：它用模型标识色调出一张小牌子，保证 API、内网网关和加载失败的站点
 * 在同一套视觉里仍然可辨认。
 */
export function ModelAvatar({
  model,
  size,
  fill = false,
  fontSize,
  className = '',
}: {
  model: Pick<ModelSummary, 'id' | 'displayName' | 'color' | 'domain' | 'iconUrl' | 'homepage'>
  size?: number
  fill?: boolean
  fontSize?: number
  className?: string
}) {
  const urls = useMemo(() => getModelIconUrls(model), [model.iconUrl, model.domain, model.homepage])
  const [index, setIndex] = useState(0)

  useEffect(() => {
    setIndex(0)
  }, [model.id, model.iconUrl, model.domain, model.homepage])

  const box: CSSProperties | undefined = fill
    ? { width: '100%', height: '100%', flexBasis: 'auto' }
    : size
      ? { width: size, height: size, flexBasis: size }
      : undefined

  if (urls.length > 0 && index < urls.length) {
    return (
      <img
        src={urls[index]}
        alt=""
        crossOrigin="anonymous"
        className={`model-avatar ${className}`.trim()}
        style={box}
        onError={() => setIndex((prev) => prev + 1)}
      />
    )
  }

  const fallbackSize = fontSize ?? (size ? Math.max(8, size * 0.42) : undefined)
  return (
    <span
      className={`model-avatar model-avatar-fallback ${className}`.trim()}
      style={{
        ...box,
        color: `color-mix(in srgb, ${model.color} 82%, var(--text))`,
        background: `color-mix(in srgb, ${model.color} 16%, var(--surface-raise))`,
        borderColor: `color-mix(in srgb, ${model.color} 38%, transparent)`,
        ...(fallbackSize ? { fontSize: fallbackSize } : null),
      }}
      aria-hidden="true"
    >
      {initials(model.displayName)}
    </span>
  )
}
