/**
 * 原生墙的窗格编排（纯函数，可单测）
 *
 * 聊天模式默认把参与聊天的网页模型一次全贴在右侧，每一格都是站点自己的页面。
 * 这里只回答一件事：哪几枚真的挂上去、哪几枚退回标签、网格开几列几行。
 *
 * 为什么要单独拎出来：这段判断的输入有四路（参与者、用户换进来的顺序、墙此刻多大、
 * 被放大的那格），而它的错误不是崩，是「点了没反应」和「多挂一枚多烧一个渲染进程」。
 * 留在组件里就得靠手点 Electron 才能覆盖，抽出来才有断言的地方。
 */

/**
 * 拿不到实测尺寸时的兜底格数（首帧、或墙还没挂出来）。
 * 常态下格数由 planGrid 按墙的实际像素算，这个常量只在「还没有尺寸可量」时顶一下。
 */
export const DEFAULT_LIVE_PANES = 4

/**
 * 舒适档：站点保住自己的桌面布局，一屏能读完一条回答连同它自己的输入框。
 * 达到这一档时 tier 记 0，界面不必提示「挤」。
 */
export const COMFY_PANE = { w: 560, h: 340 }

/**
 * 地板档：低于这个尺寸就不再分了 —— 再碎只是把内存花在看不到字的页面上。
 *
 * 它同时是「最多能挂几枚」的算尺：墙上摆几格由它定，形状再由舒适档去挑。
 * 判据含缝宽（c 格 + (c-1) 条 SEAM_PX 装得下才算摆得下），漏掉缝会多算一格然后横向溢出。
 * 为什么不拿舒适档当上限：1920 窗口下把左栏展开、墙拖到 950px 时，560 的下限只会
 * 算出「1 列 × 2 行」，四家参与者当场掉成两家 —— 用户要的是「放更多」，
 * 结果先变少了，那是把守卫做成了倒退。地板档在这里给出 2×2，与旧口径一模一样。
 *
 * 它同时是**拖动的下限**：`shiftSeam` 让最窄那一格拖到地板档就停手。曾经这里另有一个更小的
 * 「硬底」（180），意思是「先允许拖破地板、少挂一枚，再拦住压碎」—— 但那句话在实测里变成了
 * 锁死：两轴都拖破之后墙塌成 1×1，而只剩一格时墙上连一条缝都不剩，点别的标签只是把那唯一
 * 一格顶掉，用户再也回不到并存。所以硬底取消，地板档就是底。
 */
export const FLOOR_PANE = { w: 420, h: 240 }

/** 列数天花板：再碎就成了条，站点自己的导航栏都放不下 */
export const MAX_PANE_COLS = 4
/** 行数天花板：第四行起连站点标题栏都占满了 */
export const MAX_PANE_ROWS = 3

/**
 * 格与格之间那条缝的宽度 —— 它是一条真的栅格轨道，不是 gap。
 *
 * 为什么不能做成盖在缝上的 DOM 把手：WebContentsView 永远画在渲染层之上，
 * 压在窗格上的那几像素收不到指针，用户只会觉得「缝拖不动」。所以命中带必须是
 * 自己的轨道，缝里没有视图，指针才落得下来。列轨之间的 gap 同理不能用负 margin 借。
 *
 * 这个数与 styles.css 的 --cx-seam 必须一致：算格数时它是成本，画的时候它是轨道，
 * 两边不一致就会「算出来摆得下、实际摆不下」而横向溢出（回归测试把这条钉住了）。
 */
export const SEAM_PX = 7

export interface WallBox {
  /** 网格容器此刻的可用宽（CSS px） */
  w: number
  /** 同上的高 */
  h: number
}

/**
 * 一轴的格权重：100 = 等分，长度必须等于该轴的格数，否则按等分处理。
 *
 * 存比例而不是存像素：窗口一拉大，存像素的那套比例就变形了（旧的列宽守卫踩过这个坑），
 * 而「这一格比隔壁宽一半」是用户真正拖出来的东西。
 */
export type Weights = number[]

/** 权重能不能用：长度对、都是正有限数。长度不对就是换了形状 —— 交给等分 */
export function usableWeights(w: Weights | null | undefined, n: number): Weights | null {
  if (!Array.isArray(w) || w.length !== n) return null
  const ok = w.every((x) => Number.isFinite(x) && x > 0)
  return ok ? w : null
}

/** 扣掉缝之后，这一轴真正能分给格子的像素 */
export function freePx(total: number, n: number): number {
  return Math.max(0, total - Math.max(0, n - 1) * SEAM_PX)
}

/**
 * 按权重把「扣掉缝的空间」分给各格，返回每格的实际像素。
 * 权重不可用（没拖过 / 换了形状）就等分。
 */
export function trackPx(total: number, weights: Weights | null | undefined): number[] {
  const n = Math.max(0, Math.round(weights?.length ?? 0))
  if (n === 0) return []
  const free = freePx(total, n)
  const w = usableWeights(weights, n)
  if (!w) return Array.from({ length: n }, () => free / n)
  const sum = w.reduce((a, b) => a + b, 0)
  return w.map((x) => (sum > 0 ? (free * x) / sum : free / n))
}

/** 把像素数组换算回「100 = 等分」的权重，四舍五入到整数 */
function toWeights(sizes: number[]): Weights {
  const sum = sizes.reduce((a, b) => a + b, 0)
  if (!(sum > 0)) return sizes.map(() => 100)
  return sizes.map((s) => Math.max(1, Math.round((s / sum) * sizes.length * 100)))
}

/**
 * 拖动夹住地板档时留的舍入余量。
 *
 * `shiftSeam` 交出去的是**整数权重**（`toWeights` 四舍五入），换算回像素会差一两像素：
 * 1787 的墙两格等分，把右格正好夹在 420 → 权重 [153,47] → 再量回来是 418.1。
 * 差这 2px 不要紧，要紧的是 `shrinkBoxFor` 认「低于地板档」这件事 —— 它一认，
 * 整面墙按最窄那一格折算容量，2 列当场塌成 1 列，正是这次要根治的那个死状态。
 * 所以让出的下限抬高几个像素，保证夹住之后按整数权重量回来仍在地板档之上。
 */
export const FLOOR_GUARD_PX = 6

/**
 * 拖一条缝：把缝右侧（/下侧）那一格的一些像素转给左侧（/上侧），其余格一动不动。
 *
 * 权重和保持不变 → 按 fr 分发时，没参与的格拿到的像素正好不变，
 * 这正是「拖开一格、剩下的继续等分剩余空间」该有的手感。
 *
 * `floorPx` 是这一轴的地板档（宽轴 420 / 高轴 240）：谁都不许被拖到它以下，
 * 所以「把这一格放大」不会把墙拖塌成一格。想独占整面墙走「放大此窗格」，
 * 那是一条说得清楚、也还得回来的路。
 * 已经在地板档以下的那一格（拖完之后墙变小把比例压破的）算 room=0：它不能再让出一像素，
 * 但另一格照样能让它变大 —— 手感是「拖得回来，拖不坏」。
 */
export function shiftSeam(
  total: number,
  weights: Weights,
  seam: number,
  deltaPx: number,
  floorPx: number,
): Weights {
  const n = weights.length
  if (n < 2 || seam < 0 || seam > n - 2) return [...weights]
  const sizes = trackPx(total, weights)
  // 左边能让出的 / 右边能让出的（两个方向的约束落在不同那格上）
  const room = (px: number) => (px >= floorPx + FLOOR_GUARD_PX ? px - floorPx - FLOOR_GUARD_PX : 0)
  const roomLeft = room(sizes[seam] ?? 0)
  const roomRight = room(sizes[seam + 1] ?? 0)
  let d = deltaPx
  if (d > 0) d = Math.min(d, roomRight)
  if (d < 0) d = Math.max(d, -roomLeft)
  return toWeights(sizes.map((s, k) => (k === seam ? s + d : k === seam + 1 ? s - d : s)))
}

/**
 * 「每格都不低于地板档」最多能开几列（几行）。
 * 判据是 c 格 + (c-1) 条缝装得下，漏掉缝就会多算一格然后横向溢出。
 */
function maxTracks(total: number, floor: number, ceiling: number): number {
  if (total <= 0) return 1
  return Math.max(1, Math.min(ceiling, Math.floor((total + SEAM_PX) / (floor + SEAM_PX))))
}

export interface WallSeams {
  /** 列权重（长度 = 列数时生效，否则等分） */
  cols?: Weights | null
  rows?: Weights | null
}

/**
 * 拖破地板档 → 这形状摆不下了，退回「每格都按最窄那一格算」的等效墙再挑形状。
 *
 * 为什么要等效墙而不是直接减一列：形状退回去了要重新等分，用户拖出来的窄格随之作废，
 * 这正是选定的「拖破地板就少挂一枚」；等效宽度让算出来的格数与真实可读宽度一致，
 * 不会出现「说好少挂一枚，下一帧又摆回同样挤的三列」。
 */
function shrinkBoxFor(total: number, floor: number, weights: Weights | null | undefined): number {
  const n = weights?.length ?? 0
  if (n <= 1) return total
  const sizes = trackPx(total, weights)
  const min = Math.min(...sizes)
  if (min >= floor) return total
  return n * min + (n - 1) * SEAM_PX
}

/**
 * 拖出来的比例自己报出列数：长度 N、每格都不破地板，这一屏就按 N 列摆。
 *
 * 不这么做的话「拖破地板少挂一枚」只成立一帧：形状退回后权重长度和行列对不上，
 * 下一次重算（点个标签、换个参与者）planGrid 会照原始墙宽把列数开回去，
 * 用户刚拖出来的宽窄也一起丢 —— 症状是「我一放手格子自己长回去了」。
 * 认列数就等于把这句话存下来：「我要这几列，这个宽窄」。
 * 破地板时返回 null：那时由 shrinkBoxFor 收窄列数，比例照旧作废。
 */
function pinnedCols(total: number, weights: Weights | null | undefined): number | null {
  const n = Math.max(0, Math.round(weights?.length ?? 0))
  if (n < 2 || n > MAX_PANE_COLS || total <= 0) return null
  if (!usableWeights(weights, n)) return null
  return Math.min(...trackPx(total, weights)) >= FLOOR_PANE.w ? n : null
}

export interface WallGrid {
  cols: number
  rows: number
  /**
   * 这一屏摆得下几枚（地板档下的 maxCols × maxRows）。
   *
   * 它不等于 cols × rows —— 后者是「这次挑的摆法占几格」，前者是「墙还能塞几格」。
   * 界面那句「这一屏放得下 N 枚」要说的是前者：三枚参与者摆成 3×1 时，
   * 报 3 会让用户以为墙已经满了、拖宽没用，而它其实还剩大半。
   */
  cap: number
  /** 0 = 每格达到舒适档；1 = 已经让到地板档（界面可以据此说明「挤了一档」） */
  tier: number
}

/**
 * 按墙的实际像素算格数。
 *
 * 两步：先用地板档算「这一屏最多塞得下几枚」（cap，判据含缝宽），再用它挑一种摆法 ——
 * 在不超过 cap 的前提下，取空格最少、且每格形状最接近舒适档比例的那个列数。
 * 于是「参与者少」时格子会变大而不是留空位，「参与者多」时先分满、形状其次。
 * 拿不到尺寸（首帧 / 墙被收起来）退回旧的 2×2 口径。
 *
 * 给了 seams（用户拖过缝）时，先按「最窄那一格」折算等效宽度再定容量：
 * 拖破地板档就少挂，而不是一格挤成一条还硬摆。形状退回后重新等分，所以挑出来的
 * 行列与拖出来的权重长度不再相同 —— 那是有意的，窄格作废、大家重新平分。
 */
export function planGrid(box?: WallBox | null, want = 0, seams?: WallSeams): WallGrid {
  const w = box?.w ?? 0
  const h = box?.h ?? 0
  if (w <= 0 || h <= 0) {
    return { cols: 2, rows: 2, cap: DEFAULT_LIVE_PANES, tier: 0 }
  }
  const wEff = shrinkBoxFor(w, FLOOR_PANE.w, seams?.cols)
  const hEff = shrinkBoxFor(h, FLOOR_PANE.h, seams?.rows)
  const maxCols = maxTracks(wEff, FLOOR_PANE.w, MAX_PANE_COLS)
  const maxRows = maxTracks(hEff, FLOOR_PANE.h, MAX_PANE_ROWS)
  // 这一屏的容量：地板档下的满格数，跟最后挑了哪种摆法无关
  const cap = maxCols * maxRows
  const live = Math.min(Math.max(0, want), cap)
  if (live === 0) return { cols: 1, rows: 1, cap, tier: 0 }

  let best: WallGrid | null = null
  let bestEmpty = Number.POSITIVE_INFINITY
  let bestGap = Number.POSITIVE_INFINITY
  for (let cols = 1; cols <= maxCols; cols++) {
    const rows = Math.ceil(live / cols)
    if (rows > maxRows) continue
    // 形状与舒适度按真实像素判（等效墙只用来定容量，别把「退回一档」写成「真的更挤」）
    const paneW = freePx(w, cols) / cols
    const paneH = freePx(h, rows) / rows
    /*
     * 第一判据是空格子数：四枚摆在三列里会留下两格空位（顶上三格、底下一格），
     * 看着像墙坏了一半 —— 宁可形状差一点，也不要那种缺口。
     * 第二判据才是形状：每格尽量接近舒适档的宽高比，太扁（读不完一条回答）
     * 和太瘦（站点内容横向滚动）都扣分。
     */
    const empty = cols * rows - live
    const gap = Math.abs(Math.log(paneW / paneH / (COMFY_PANE.w / COMFY_PANE.h)))
    if (empty < bestEmpty || (empty === bestEmpty && gap < bestGap)) {
      bestEmpty = empty
      bestGap = gap
      best = { cols, rows, cap, tier: paneW >= COMFY_PANE.w && paneH >= COMFY_PANE.h ? 0 : 1 }
    }
  }
  // 一行都摆不满（参与者多于格数）时按满格摆：多出来的那几枚退回标签条，点一下换进来
  return best ?? { cols: maxCols, rows: maxRows, cap, tier: 1 }
}

export interface PanePlan {
  /** 真的挂载显示的模型 id，按墙上顺序 */
  live: string[]
  /** 没挂上的那些：渲染层把它们摆成能点进来的标签 */
  rest: string[]
  /** 网格列数 */
  cols: number
  /** 挂上这些枚数要占几行（列数是取小之后的实际值，所以不能拿 planGrid 的行数顶） */
  rows: number
  /**
   * 这一屏摆得下的格数（= 地板档下的 cols × rows），跟挂了几枚无关。
   *
   * 界面拿它写「这一屏放 N 枚」那句提示，所以它必须回答「这堵墙能摆几格」，
   * 不是「这次挑了哪种摆法」—— 三枚参与者摆 3×1 时，若报成 3，
   * 用户会以为墙拖宽也没用，而它其实还差得远。
   */
  cap: number
  /** 0 = 舒适档，1 = 已经挤到地板档 */
  tier: number
  /**
   * 这一路实际生效的列权重（长度 = cols；没拖过就是全 100 = 等分）。
   * 渲染层拿它拼栅格轨道，所以「拖开的比例」和「算出来的形状」必须出自同一个判断，
   * 否则会出现形状退回 2 列、轨道还按 3 列的权重分，中间凭空少一格。
   */
  colW: Weights
  /** 同上的行权重（长度 = rows） */
  rowW: Weights
  /**
   * 列数是被拖出来的比例钉住的，而不是这堵墙只能开这么多列。
   * 界面拿它解释「墙放得下 6 枚，可墙上只有 4 格」——不解释这句，用户以为墙坏了。
   */
  seamPinned: boolean
  /**
   * 有一轴的比例破了地板档（= breachCols || breachRows），这一屏的容量按「最窄那一格」折算过。
   *
   * 界面必须认得这一种：比例把列数压到 1 之后，墙上连一条缝都不剩，
   * 「双击缝恢复等分」这句指引就成了死路 —— 所以它单独报出来，让墙头能给一颗复位钮，
   * 也让点未挂载那枚标签时知道「该先把比例清掉再换进来」。
   * 拖动本身拖不出这一种（shiftSeam 拿地板档当下限），它来自拖完之后墙变小。
   */
  seamBreached: boolean
  /** 破档的是列轴吗（清存值时只清这一轴，另一轴是用户故意拖出来的宽窄） */
  breachCols: boolean
  /** 破档的是行轴吗 */
  breachRows: boolean
}

/** 等分权重：100 = 平均 */
const equalW = (n: number): Weights => Array.from({ length: Math.max(0, n) }, () => 100)

/**
 * 把权重拼成栅格轨道：「格 缝 格 缝 格」。
 *
 * 缝必须是轨道而不是 gap 或负 margin —— 原生视图画在渲染层之上，
 * 只有缝自己占住的那几像素没人盖，把手才收得到指针（见 SEAM_PX）。
 * 每格写成 minmax(0,Xfr)：不写 minmax(0,…) 的话，站点自己的宽表格会把格子顶宽，
 * 拖窄就成了拖不动的假象。
 */
export function wallTracks(weights: Weights): string {
  if (weights.length === 0) return 'minmax(0,1fr)'
  return weights.map((x) => `minmax(0,${x}fr)`).join(` ${SEAM_PX}px `)
}

/** 第 k 格（0 起）落在交错栅格里的那一条轨（1 起） */
export function trackIndex(k: number): number {
  return 2 * k + 1
}

/**
 * 把 order 里 a、b 两个位置对调，其余位的相对次序一动不动。
 *
 * 拖动交换要写的就是「这两格对调」，不是「把这一枚挪到第 b 格」：后者会把中间那些
 * 格子整体往前挪一位，用户只换了两个窗口，看到的却是半面墙重排。
 * 下标越界或相等时原样返回 —— 拖出墙外、松手在缝上这些情况都不该改坏名单。
 */
export function swapAt(order: readonly string[], a: number, b: number): string[] {
  const next = [...order]
  if (a < 0 || b < 0 || a >= next.length || b >= next.length || a === b) return next
  const t = next[a] as string
  next[a] = next[b] as string
  next[b] = t
  return next
}

export function planPanes(o: {
  /** 参与聊天的网页模型，按侧栏/参与者原有顺序 */
  ids: readonly string[]
  /** 用户从标签换进来的那些，排在最前 */
  promoted?: readonly string[]
  /** 显式上限；给了就不看墙尺寸（测试与「整面墙收起」这两路用得上） */
  cap?: number
  /** 墙此刻的可用像素。给了就按 planGrid 算，不给退回 DEFAULT_LIVE_PANES */
  box?: WallBox | null
  /** 被单独放大的那一格；不在 ids 里当没发生 */
  expanded?: string | null
  /** 用户拖过的缝（权重，100 = 等分）；长度和形状对不上就等分 */
  seams?: WallSeams
  /**
   * 拖动期间钉住的形状。
   * 缝正被拖着的时候不能让格数当场变 —— 手柄所属的那一格会先消失，指针像是被弹开；
   * 松手（不再传 hold）才让 planGrid 按新的最窄格重算，该少挂的少挂、该等分的等分。
   */
  hold?: { cols: number; rows: number } | null
}): PanePlan {
  const w = o.box?.w ?? 0
  const h = o.box?.h ?? 0
  const grid = planGrid(o.box, o.ids.length, o.seams)
  const cap = o.cap ?? grid.cap
  /** 生效权重 + 舒适度：形状定了才知道拖过的比例还对不对得上这个形状 */
  const applyW = (cols: number, rows: number) => {
    const colW = usableWeights(o.seams?.cols, cols) ?? equalW(cols)
    const rowW = usableWeights(o.seams?.rows, rows) ?? equalW(rows)
    if (w <= 0 || h <= 0) return { colW, rowW, tier: 0 }
    const tight = trackPx(w, colW).some((px) => px < COMFY_PANE.w) ||
      trackPx(h, rowW).some((px) => px < COMFY_PANE.h)
    return { colW, rowW, tier: tight ? 1 : 0 }
  }
  const present = new Set(o.ids)
  /*
   * 存过的那份顺序按「优先照这个摆」用，同时兜两层脏：不在场的 id 直接丢掉（自愈），
   * 重复的 id 只算第一次。重复这一层不是洁癖 —— 同一个 id 上两次墙，就是两格挂同一家站点，
   * 两个 dock 的贴合循环对着同一个原生视图各报自己的矩形，症状是那格一直在抖。
   * 主进程已经拒了重复，这里是第二道：偏好文件可能被手改过，也可能是旧版本留下的。
   */
  const head = [...new Set((o.promoted ?? []).filter((id) => present.has(id)))]
  const rest = o.ids.filter((id) => !head.includes(id))
  const order = [...head, ...rest]

  // 放大：只留那一枚真的挂载。其余不是「藏起来」而是从 DOM 卸载 ——
  // 窗格卸载会 dismiss 回离屏宿主，页面活着，切回来不重载（见 pool.dismiss）。
  if (o.expanded && present.has(o.expanded)) {
    // 那一枚独占整面墙，尺寸按满幅算 —— 未放大时的「挤了一档」不该跟着搬到放大态上
    const one = applyW(1, 1)
    return {
      live: [o.expanded],
      rest: order.filter((id) => id !== o.expanded),
      cols: 1,
      rows: 1,
      cap,
      tier: one.tier,
      colW: one.colW,
      rowW: one.rowW,
      seamPinned: false,
      seamBreached: false,
      // 放大态是一格满幅，比例根本没参与，也就无所谓破不破
      breachCols: false,
      breachRows: false,
    }
  }
  let live = order.slice(0, Math.max(0, cap))
  /*
   * 列数只跟「实际挂了几枚」取小：两枚参与者不该占三列，中间那根空列在墙上是一竖条应用底色。
   * tier 也跟着实际行列重算，不沿用 planGrid 按「want 枚」挑的那个形状 ——
   * 显式 cap（整面墙被收起、只剩一格）压过尺寸时，挂上的格数比 planGrid 以为的少得多，
   * 那一格其实又宽又高，照抄旧 tier 就会在一条舒服的大格上写「低于舒适档」。
   *
   * 拖过缝的那一轴报出自己的列数（pinnedCols）：形状一旦由比例决定，行数就要跟着让 ——
   * 钉成两列还想挂满六枚得摆三行，而第三行的格高会掉到地板档以下。
   * 让不下的那几枚退回标签条，正是「拖破地板自动少挂」的同一条规矩。
   */
  const pin = o.hold ? null : pinnedCols(w, o.seams?.cols)
  const cols = o.hold
    ? Math.max(1, Math.min(o.hold.cols, live.length || 1))
    : live.length <= 1
      ? 1
      : Math.min(pin ?? grid.cols, live.length)
  const rows = o.hold
    ? Math.max(1, o.hold.rows)
    : Math.min(Math.max(1, Math.ceil(live.length / cols)), Math.max(1, grid.rows))
  if (!o.hold) live = live.slice(0, cols * rows)
  const shaped = applyW(cols, rows)
  /*
   * 比例是否已经破到地板档以下（shrinkBoxFor 真的把等效墙收窄了），分轴报。
   * 拖动期间不算：那一趟由 hold 钉着，形状还没定，报出来只会让墙头那颗钮一闪一闪。
   *
   * 拖动本身已经把地板档当下限（见 shiftSeam），所以今天只剩一条路会进来：
   * 拖的时候墙够宽，之后窗口缩小 / 左栏展开，把那份比例压到地板以下。
   * 界面据此分叉 —— 墙头给「恢复等分」，而点未挂载那枚标签时只清**破了的那一轴**，
   * 没破的那一轴是用户故意拖出来的宽窄，不该被顺手抹平。
   */
  const canMeasure = !o.hold && w > 0 && h > 0
  const breachCols = canMeasure && shrinkBoxFor(w, FLOOR_PANE.w, o.seams?.cols) < w
  const breachRows = canMeasure && shrinkBoxFor(h, FLOOR_PANE.h, o.seams?.rows) < h
  return {
    live,
    rest: order.slice(live.length),
    cols,
    rows,
    cap,
    tier: shaped.tier,
    colW: shaped.colW,
    rowW: shaped.rowW,
    seamPinned: live.length < Math.min(cap, order.length),
    seamBreached: breachCols || breachRows,
    breachCols,
    breachRows,
  }
}
