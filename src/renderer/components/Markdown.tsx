import { isValidElement, memo, useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react'
import type { Components } from 'react-markdown'
import { normalizeMd } from '../textFormat'
import { AssistantUi } from './AssistantUi'

/*
 * react-markdown 整条管线（micromark + mdast/hast + property-information 那张常量表）
 * 压完约 380 kB，原先全砸在首屏的入口块里 —— 而首屏那一帧一个字节的 Markdown 都不排：
 * 冷启动看到的是「新建会话」，议事厅在逐字流期间走的是 PlainStream。
 *
 * 所以解析器改成「第一次真要排版时才取」。取到之前用同一套 .md 类名的纯文本兜底：
 * 文字先出来、格式晚一帧，不会留空白，也不需要给每个消费方套 Suspense 边界。
 */
type ReactMarkdownLike = ComponentType<{
  children?: string
  remarkPlugins?: unknown[]
  allowedElements?: string[]
  unwrapDisallowed?: boolean
  components?: Components
}>

/** 已取到的渲染器与插件数组；数组必须是模块级同一份引用，否则每次渲染都是新配置对象 */
let Renderer: ReactMarkdownLike | null = null
let REMARK_PLUGINS: unknown[] = []
let loading: Promise<void> | null = null

function loadMarkdown(): Promise<void> {
  if (!loading) {
    loading = Promise.all([import('react-markdown'), import('remark-gfm')]).then(([md, gfm]) => {
      Renderer = md.default as unknown as ReactMarkdownLike
      REMARK_PLUGINS = [gfm.default]
    })
  }
  return loading
}

/** 供离线 SSR 验证与「第一次渲染前就想要格式」的调用方把模块取到位 */
export function preloadMarkdown(): Promise<void> {
  return loadMarkdown()
}

/** 这一帧能不能排版；取不到就一直用纯文本兜底，读得到内容比有格式重要 */
function useRenderer(): ReactMarkdownLike | null {
  const [ready, setReady] = useState(!!Renderer)
  useEffect(() => {
    if (Renderer) {
      setReady(true)
      return
    }
    let alive = true
    // 分块在打包后的应用里就在一旁，取不到只可能是磁盘问题：退回纯文本，不重试不报错
    void loadMarkdown().then(
      () => {
        if (alive) setReady(true)
      },
      () => {
        if (alive) setReady(true)
      },
    )
    return () => {
      alive = false
    }
  }, [])
  return ready ? Renderer : null
}

// 同样必须是模块级同一份引用：写在 JSX 里的对象每次渲染都是新的
const components: Components = {
  // 模型输出不可信：react-markdown 默认不渲染原始 HTML，链接统一新窗口打开并切断 opener。
  // 剔除 react-markdown 注入的 hast 节点对象 node，避免它作为未知属性落到 DOM 上。
  a: ({ node: _node, children, ...rest }) => (
    <a {...rest} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
}

/**
 * memo 的前提是消费方只传 text（字符串按值比较）。
 * 逐字流每来一个 token 整页都要重渲染，没有 memo 时早已写完的消息也跟着重新解析一遍。
 */
type MarkdownUi = { onAction: (prompt: string) => void }
type MarkdownProps = { text: string; ui?: MarkdownUi; streaming?: boolean }

function torraUiRaw(children: ReactNode): string | null {
  if (!isValidElement<{ className?: string; children?: ReactNode }>(children)) return null
  const className = children.props.className
  if (typeof className !== 'string' || !className.split(/\s+/).includes('language-torra-ui')) {
    return null
  }
  if (typeof children.props.children === 'string') return children.props.children
  if (Array.isArray(children.props.children)) {
    return children.props.children.filter((part): part is string => typeof part === 'string').join('')
  }
  return null
}

export const Markdown = memo(function Markdown({ text, ui, streaming = false }: MarkdownProps) {
  const R = useRenderer()
  const uiComponents = useMemo<Components>(() => {
    if (!ui) return components
    return {
      ...components,
      pre: ({ children }) => {
        const raw = torraUiRaw(children)
        return raw === null ? (
          <pre>{children}</pre>
        ) : (
          <AssistantUi raw={raw} streaming={streaming} onAction={ui.onAction} />
        )
      },
    }
  }, [streaming, ui])
  if (!R) return <PlainStream text={text} />
  /**
   * normalizeMd 只修加粗竖线的 CommonMark 合规性（全角标点紧贴 `**` 时星号会被原样打印），
   * 不做排版加工。放在这里是因为所有模型原文都从这一个入口进 AST。
   */
  const src = normalizeMd(text)
  return (
    <div className="md">
      <R remarkPlugins={REMARK_PLUGINS} components={uiComponents}>
        {src}
      </R>
    </div>
  )
})

/**
 * 逐字流期间的正文：只保换行，一份 AST 都不建。
 * 增量已经合到 60ms 一批，一条 1500 字的回答仍是一篇整文重解析 25 次，
 * 而这些中间态没人读格式 —— 收尾后换成 Markdown，格式一次到位。
 */
export function PlainStream({ text }: { text: string }) {
  return <div className="md md-plain">{text}</div>
}

/** 卡片摘要里只该出现行内强调：标题/列表/表格会被整段折进两行，读起来像坏了 */
const INLINE_ONLY = ['strong', 'em', 'del', 'code', 'a', 'br'] as const
const INLINE_ALLOWED = [...INLINE_ONLY]

/**
 * 行内 Markdown：论点摘要卡、共识点条目这类「一段被压成两三行」的位置。
 * 块级标记被摊平（unwrapDisallowed），只保留加粗/斜体/删除线/行内代码/链接。
 * 传入前先过 mdInline/mdExcerpt 压成单段，否则摊平后段与段之间会黏住。
 */
export const MarkdownInline = memo(function MarkdownInline({ text }: { text: string }) {
  const R = useRenderer()
  if (!R) return <span className="md md-inline">{text}</span>
  return (
    <span className="md md-inline">
      <R remarkPlugins={REMARK_PLUGINS} allowedElements={INLINE_ALLOWED} unwrapDisallowed components={components}>
        {text}
      </R>
    </span>
  )
})
