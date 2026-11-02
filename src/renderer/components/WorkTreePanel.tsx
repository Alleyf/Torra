/**
 * 会话工作树面板：右侧那一栏。
 *
 * 一列一场会话（聚焦时只留当前那场并居中，全部时所有根会话横着排）；
 * 列内按层往下长，同一层有兄弟就横着铺开 —— 分支不靠把线画细来塞。
 * 宽度超出就横向滚，历史长了就纵向滚，两个方向都在同一个视口里。
 *
 * 这一栏只负责「摆」和「看」，不负责「记」：
 * 节点来自 workTree.ts 对账本的投影，光来自 lancerLight.ts。
 * 面板自己不写任何状态进存储 —— 会话里的账本才是真的，摆出来的样子随时可以重算。
 *
 * 运行时的那口气（细窄的同色流动边框）只挂在 status === 'running' 的节点上，
 * 完成或失败就没了；键盘焦点是另一套（:focus-visible），两件事不共用样式 ——
 * 鼠标点一下不该被理解成「正在跑」。
 */

import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, type CSSProperties } from 'react'
import { FileText, GitBranch } from 'lucide-react'
import { AgentMark, agentLook } from '../agentMarks'
import { layoutTrees, type Layout, type PlacedNode, type WorkTree } from '../workTree'

export type TreeMode = 'focus' | 'all'

export interface WorkTreeHandle {
  /** 把某个节点滚到视口里。返回它此刻在不在可见范围内 */
  reveal(nodeId: string): boolean
}

interface Props {
  trees: WorkTree[]
  mode: TreeMode
  focusId?: string
  follow: boolean
  /** 面板自己的演示开关：开了才把演示树混进来 */
  demo: boolean
  onMode(mode: TreeMode): void
  onFollow(on: boolean): void
  onOpenFile(path: string): void
  /** 演示开关：开了才把演示树混进来（调用方负责同时切到「全部」） */
  onDemo?(on: boolean): void
  /** 空树的说明：正文在那一家那边时，这里只剩一个根，话得说清 */
  emptyHint?: string
}

/** 一家的颜色：取 agentMarks 那一份，别处不再定第二套 */
function hueOf(agentId: string): string {
  return agentLook(agentId)?.hue ?? '#5b6470'
}

/**
 * 连线。
 *
 * 往下的那条画成「竖干 + 一小段横的」：同一层的孩子共用同一根竖干，
 * 一眼看得出谁挂在哪根干上。平滑曲线在这里反而糊 —— 缩进式树里
 * 每条线都只差一格，弧线全叠在一起就成了一团。
 *
 * 完成合流的那条另画一道虚的回弯，从节点的右边缘绕回目标：它是「收口了」，
 * 跟「往下长」不是一件事，形状上就不该一样。
 */
function edgePath(a: PlacedNode, b: PlacedNode, id: string, merge: boolean): string {
  const f = (n: number): string => (Math.round(n * 10) / 10).toString()
  if (!merge) {
    const trunk = b.x - 8
    const sy = a.y + a.h / 2
    const ey = b.y + b.h / 2
    // 从父亲的左边下来；同一层的孩子都落在同一根竖干上
    return `M ${f(Math.min(a.x, trunk))} ${f(sy)} H ${f(trunk)} V ${f(ey)} H ${f(b.x)}`
  }
  /*
   * 合流那条不走曲线：从孩子右边缘出去一格，往上竖到目标的横线，再回目标的右边缘。
   * 曲线在同一列里会互相压着 —— 三个兄弟各收一次口，三条弧叠起来像一团毛线；
   * 直角折线在缩进式树里最好认：它就是「这一支收到上面去了」。
   */
  const gutter = a.x + a.w + 9
  return `M ${f(a.x + a.w)} ${f(a.y + a.h / 2)} H ${f(gutter)} V ${f(b.y + b.h / 2)} H ${f(b.x + b.w)}`
}

export const WorkTreePanel = forwardRef<WorkTreeHandle, Props>(function WorkTreePanel(
  { trees, mode, focusId, follow, demo, onMode, onFollow, onOpenFile, onDemo, emptyHint },
  ref,
) {
  const viewport = useRef<HTMLDivElement | null>(null)
  const layout: Layout = useMemo(() => layoutTrees(trees, mode, focusId), [trees, mode, focusId])
  const placed = useMemo(() => {
    const map = new Map<string, PlacedNode>()
    for (const t of layout.trees) for (const n of t.nodes) map.set(n.id, n)
    return map
  }, [layout])

  useImperativeHandle(ref, () => ({
    reveal(nodeId: string) {
      const vp = viewport.current
      if (!vp) return false
      const el = vp.querySelector<HTMLElement>(`[data-wtx-node="${cssAttr(nodeId)}"]`)
      if (!el) return false
      const vr = vp.getBoundingClientRect()
      const er = el.getBoundingClientRect()
      const visible =
        er.top >= vr.top - 1 && er.bottom <= vr.bottom + 1 && er.left >= vr.left - 1 && er.right <= vr.right + 1
      // 不跟随时只回答「在不在眼前」，不去挪人家的滚动位置
      if (follow && !visible) {
        /*
         * 只滚这一栏，而且**只滚够用的那一点**。
         *
         * 早先按「把节点摆到正中」来滚：一列里有三个兄弟时，画布比这栏宽，
         * 居中就把会话根挤出了左边界 —— 一打开工作树看到的是半截步骤，
         * 不知道自己在哪一棵树上。滚到刚好进视野为止，根能留就留着。
         *
         * 用瞬时滚动（不带 behavior:'smooth'）：光要在滚定之后才量坐标，
         * 平滑滚动还在动的那 300ms 里量出来的落点，会差出半个屏幕。
         */
        const pad = 8
        const dy =
          er.bottom > vr.bottom - pad
            ? er.bottom - (vr.bottom - pad)
            : er.top < vr.top + pad
              ? er.top - (vr.top + pad)
              : 0
        const dx =
          er.right > vr.right - pad
            ? er.right - (vr.right - pad)
            : er.left < vr.left + pad
              ? er.left - (vr.left + pad)
              : 0
        if (dy || dx) vp.scrollBy({ top: dy, left: dx })
      }
      return visible
    },
  }))

  /*
   * 换显示范围时把视口归位到左上。
   *
   * 「聚焦」时为了让新节点进视野，可能已经横向滚过一段；再切到「全部」，
   * 第一棵会话的左边就被裁在外面 —— 一打开看到的是半截树，不知道自己在哪。
   * 切换是「换一张图看」，回到原点是最不会骗人的位置。
   */
  useEffect(() => {
    const vp = viewport.current
    if (!vp) return
    vp.scrollTo({ left: 0, top: 0 })
  }, [mode, demo])

  return (
    <aside className="wtx" aria-label="会话工作树">
      <header className="wtx-head">
        <GitBranch size={13} />
        <b>会话工作树</b>
        <div className="wtx-seg" role="group" aria-label="显示范围">
          <button
            type="button"
            className={mode === 'focus' ? 'on' : ''}
            aria-pressed={mode === 'focus'}
            onClick={() => onMode('focus')}
          >
            聚焦
          </button>
          <button
            type="button"
            className={mode === 'all' ? 'on' : ''}
            aria-pressed={mode === 'all'}
            onClick={() => onMode('all')}
          >
            全部
          </button>
        </div>
        <button
          type="button"
          className={`wtx-follow${follow ? ' on' : ''}`}
          aria-pressed={follow}
          onClick={() => onFollow(!follow)}
          title="新节点出现时把工作树滚到它 —— 只滚这一栏，不动中间的聊天记录"
        >
          跟随
        </button>
        {onDemo && (
          <button
            type="button"
            className={`wtx-follow${demo ? ' on' : ''}`}
            aria-pressed={demo}
            onClick={() => onDemo(!demo)}
            title="演示数据：分叉、孙分支、并行会话是摆出来的，用来验这棵树画得对不对"
          >
            演示
          </button>
        )}
      </header>

      {demo && (
        <div className="wtx-demo">演示数据 · 分叉、孙分支、并行会话都是摆出来的，不代表真跑过</div>
      )}

      <div className="wtx-viewport" ref={viewport}>
        {layout.trees.length === 0 ? (
          <div className="wtx-empty">
            {emptyHint ?? '这一场还没有节点。说一句话，工作树就从会话根往下长。'}
          </div>
        ) : (
          <div
            className={`wtx-canvas${mode === 'focus' ? ' solo' : ''}`}
            style={{ width: layout.width, height: layout.height }}
          >
            <svg className="wtx-edges" width={layout.width} height={layout.height} aria-hidden="true">
              {layout.edges.map((e) => {
                const a = placed.get(e.from)
                const b = placed.get(e.to)
                if (!a || !b) return null
                const tree = trees.find((t) => t.id === e.treeId)
                return (
                  <path
                    key={e.id}
                    className={`wtx-edge${e.merge ? ' merge' : ''}`}
                    d={edgePath(a, b, e.id, e.merge)}
                    stroke={hueOf(tree?.agentId ?? '')}
                    data-edge={e.id}
                  />
                )
              })}
            </svg>

            {layout.trees.flatMap((t) =>
              t.nodes.map((n) => (
                <NodeView
                  key={n.id}
                  node={n}
                  treeTitle={trees.find((x) => x.id === t.id)?.title ?? ''}
                  onOpenFile={onOpenFile}
                />
              )),
            )}
          </div>
        )}
      </div>
    </aside>
  )
})

function NodeView({
  node,
  treeTitle,
  onOpenFile,
}: {
  node: PlacedNode
  treeTitle: string
  onOpenFile(path: string): void
}) {
  const style = {
    left: node.x,
    top: node.y,
    width: node.w,
    height: node.h,
    ['--wtx-hue' as string]: hueOf(node.agentId),
  } as CSSProperties
  const what = node.kind === 'session' ? '会话' : node.kind === 'turn' ? '轮' : node.kind === 'delivery' ? '交付' : '步骤'
  const title = `${treeTitle} · ${what}：${node.label}`

  if (node.kind === 'delivery') {
    return (
      <div
        className={`wtx-node wtx-delivery ${node.status}`}
        style={style}
        data-wtx-node={node.id}
        data-wtx-kind={node.kind}
        title={title}
      >
        <div className="wtx-delivery-top">
          <FileText size={12} />
          <b>交付</b>
          {node.demo && <span className="wtx-demo-tag">演示</span>}
        </div>
        {node.detail ? (
          <p className="wtx-delivery-say">{node.detail}</p>
        ) : (
          <p className="wtx-delivery-say none">这一轮改了文件，但没有留下结论</p>
        )}
        <div className="wtx-files">
          {(node.files ?? []).slice(0, 3).map((f) => (
            <button
              key={f.path}
              type="button"
              className="wtx-file"
              onClick={() => onOpenFile(f.path)}
              title={`${f.path}　+${f.added} −${f.removed}`}
            >
              <FileText size={10} />
              <span>{f.path.split(/[\\/]/).pop()}</span>
              <i>
                +{f.added} −{f.removed}
              </i>
            </button>
          ))}
          {(node.files ?? []).length > 3 && <span className="wtx-more">+{(node.files ?? []).length - 3}</span>}
        </div>
      </div>
    )
  }

  return (
    <div
      className={`wtx-node ${node.kind} ${node.status}`}
      style={style}
      data-wtx-node={node.id}
      data-wtx-kind={node.kind}
      title={title}
      aria-label={title}
    >
      {node.kind === 'session' ? (
        <span className="wtx-mark">
          <AgentMark id={node.agentId} title={node.agentId} size={16} />
        </span>
      ) : (
        <span className={`wtx-dot ${node.status}`} aria-hidden="true" />
      )}
      <span className="wtx-label">{node.label}</span>
      {node.demo && <span className="wtx-demo-tag">演示</span>}
      {node.status === 'running' && <span className="wtx-live-dot" aria-hidden="true" />}
      {node.status === 'failed' && <span className="wtx-fail">失败</span>}
    </div>
  )
}

/** 节点 id 里有冒号，属性选择器里引号与反斜杠要转义 */
function cssAttr(s: string): string {
  return s.replace(/["\\]/g, '\\$&')
}
