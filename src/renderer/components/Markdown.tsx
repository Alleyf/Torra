import { memo } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

// 写在 JSX 里的数组每次渲染都是新对象，ReactMarkdown 会把「配置没变」误判成「配置变了」
const REMARK_PLUGINS = [remarkGfm]

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
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
})

/** 卡片摘要里只该出现行内强调：标题/列表/表格会被整段折进两行，读起来像坏了 */
const INLINE_ONLY = ['strong', 'em', 'del', 'code', 'a', 'br'] as const
const INLINE_ALLOWED = [...INLINE_ONLY]

/**
 * 行内 Markdown：论点摘要卡、共识点条目这类「一段被压成两三行」的位置。
 * 块级标记被摊平（unwrapDisallowed），只保留加粗/斜体/删除线/行内代码/链接。
 * 传入前先过 mdInline/mdExcerpt 压成单段，否则摊平后段与段之间会黏住。
 */
export const MarkdownInline = memo(function MarkdownInline({ text }: { text: string }) {
  return (
    <span className="md md-inline">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} allowedElements={INLINE_ALLOWED} unwrapDisallowed components={components}>
        {text}
      </ReactMarkdown>
    </span>
  )
})
