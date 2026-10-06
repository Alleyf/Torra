import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react'

/**
 * 通用分页条：横排紧凑、以图标为主，信息量放在左侧一行。
 * 只有一页时不渲染，避免给短列表强加一层噪声控件。
 */
export function Pager({
  page,
  pageSize,
  total,
  onPage,
}: {
  page: number
  pageSize: number
  total: number
  onPage: (p: number) => void
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize))
  if (pages <= 1) return null
  const go = (p: number) => onPage(Math.min(pages, Math.max(1, p)))
  return (
    <div className="pager">
      <span className="pager-info">
        共 {total} 条 · 第 {page}/{pages} 页
      </span>
      <div className="pager-btns">
        <button className="btn sm icon" onClick={() => go(1)} disabled={page <= 1} title="首页" aria-label="首页">
          <ChevronsLeft size={13} />
        </button>
        <button className="btn sm icon" onClick={() => go(page - 1)} disabled={page <= 1} title="上一页" aria-label="上一页">
          <ChevronLeft size={13} />
        </button>
        <button
          className="btn sm icon"
          onClick={() => go(page + 1)}
          disabled={page >= pages}
          title="下一页"
          aria-label="下一页"
        >
          <ChevronRight size={13} />
        </button>
        <button className="btn sm icon" onClick={() => go(pages)} disabled={page >= pages} title="末页" aria-label="末页">
          <ChevronsRight size={13} />
        </button>
      </div>
    </div>
  )
}

/** 把整页数量钳到合法范围，返回当前页要展示的那一段 */
export function pageSlice<T>(all: T[], page: number, pageSize: number): { rows: T[]; safePage: number } {
  const pages = Math.max(1, Math.ceil(all.length / pageSize))
  const safePage = Math.min(pages, Math.max(1, page))
  return { rows: all.slice((safePage - 1) * pageSize, safePage * pageSize), safePage }
}
