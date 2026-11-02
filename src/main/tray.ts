/**
 * 托盘菜单的唯一定义处。
 *
 * 菜单本体在主进程建，设置页要显示的也是同一份条目 —— 两处各写一遍标签，
 * 改了一处另一处还留着旧字，用户点开托盘看到的和设置页写的对不上，
 * 于是「托盘里到底有什么」这件事永远说不准。
 *
 * 所以条目只在这里写一次：主进程拿它建菜单，界面拿它显示。
 * 这里不 import electron：它是一份纯数据，脱机就能读、能测。
 */

/** 条目的两种形态：一条命令，或一条分隔线 */
export type TrayEntryKind = 'item' | 'separator'

export interface TrayEntry {
  /** 主进程按 id 挂动作；分隔线没有动作 */
  id: 'show' | 'hide' | 'sep' | 'quit'
  /** 菜单上显示的字（分隔线没有字） */
  label: string
  /** 这一条是干什么的：菜单里只有字，说明放在这里跟着条目走 */
  hint: string
  kind: TrayEntryKind
}

/**
 * 托盘右键菜单的条目，顺序即菜单顺序。
 *
 * 这不是「给用户看的说明」，是菜单本身 —— 设置页那一份是从这里取的，
 * 不是照着这里抄的。
 */
export const TRAY_ENTRIES: TrayEntry[] = [
  { id: 'show', label: '显示主窗口', hint: '主窗口被关掉或藏起来了，把它拉回前台', kind: 'item' },
  { id: 'hide', label: '隐藏主窗口', hint: '把主窗口收起来，Torra 还在后台跑', kind: 'item' },
  { id: 'sep', label: '', hint: '', kind: 'separator' },
  { id: 'quit', label: '退出 Torra', hint: '完全退出（退出前会刷盘登录态）', kind: 'item' },
]

/** 设置页那一格要的一整包：菜单条目 + 托盘此刻在不在 */
export interface TrayInfo {
  /** 托盘图标真的挂上了（品牌图缺失时挂不上，那时界面得说清楚） */
  alive: boolean
  /** 与主进程建菜单用的是同一份 */
  entries: TrayEntry[]
}
