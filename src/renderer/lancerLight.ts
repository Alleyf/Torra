/**
 * 光线层：一束光从「谁说的」飞到「哪一步」。
 *
 * 全项目只有这一套光线实现。接口就两个名字 —— `createLightLayer(svg)` 建层，
 * `layer.emit(...)` 打一束。别处要画光就复用这里的曲线函数（`curvePoints` /
 * `pointOnCurve` / `curveD`），不要在 CSS 里再攒第二套动效：两套动效的差别
 * 不在长相，在于「什么时候该停」这件事会各答一次，然后总有一处答错。
 *
 * 几条硬约束，代码按它写：
 *
 * 1. **不经过 React**。每一帧只改 SVG 的属性和 transform；走 state 的话，
 *    1.2 秒里要重渲七十多次整棵树，最后看起来像卡了。
 * 2. **一次飞行只有一条路径**。弯度按 eventId 定种子：每次事件可以不同，
 *    同一次里逐帧不变 —— 逐帧随机就是抖动，抖动的光看着像信号不好。
 * 3. **该停就停**。没有在飞的就 cancelAnimationFrame；页面藏起来就冻结；
 *    层销毁时把节点、监听、定时器全清掉。空闲时还在跑帧循环，是在拿电池换什么都不做。
 * 4. **尊重 prefers-reduced-motion**。那种设置下不飞行：画一条静止的线、
 *    在终点留一下，然后收掉。动了就是没尊重。
 * 5. **不用大面积模糊**。一条描边加一个小点足够了；拿 blur 铺一层光晕，
 *    在暗色底上糊成一片，看不出它从哪来、到哪去。
 */

export interface Pt {
  x: number
  y: number
}

/** 一束光的请求。坐标是光线层所在的坐标系（通常就是页面像素）。 */
export interface LightEmit {
  /** 稳定事件 id：同一次业务事件只能有一个 */
  eventId: string
  /** 起点语义 id：`model:<agentId>` / `anchor:<turnId>` / `node:<节点 id>` */
  fromId: string
  /** 终点语义 id：`node:<节点 id>` */
  toId: string
  from: Pt
  to: Pt
  /** 与所属工作树一致的颜色（css 颜色值） */
  color: string
  /** 默认 1.2 秒 */
  durationMs?: number
  /**
   * 线的粗细倍率，默认 1。横跨整屏的长途（模型 → 右栏）用得上：
   * 同样的 1.1px 描边，飞 800px 和飞 200px 看起来完全不是一个东西 ——
   * 近处那条像一束光，远处那条像屏幕上的一道划痕。
   */
  weight?: number
  /** 落地时给这个元素补一下高亮（直接改 class，不走 React） */
  targetEl?: Element | null
}

export interface FlightRecord {
  eventId: string
  fromId: string
  toId: string
  from: Pt
  to: Pt
  color: string
  /** true = 尊重降级（静止，不飞行） */
  still: boolean
  at: number
}

export interface LightLayer {
  /** 打一束。返回 false 表示这次没有画（层已销毁） */
  emit(req: LightEmit): boolean
  /** 最近打过的那些（诊断与冒烟用；最多留 24 条） */
  flights(): FlightRecord[]
  /** 还有没有在飞的 */
  busy(): boolean
  destroy(): void
}

export const FLIGHT_MS = 1200
/** 落地后停留、再收掉 */
const LAND_MS = 180
/** 降级模式：静止线留这么久 */
const STILL_MS = 700
/**
 * 目标高亮时长（规则在 css 里，这里只管什么时候摘）。
 * 420 是编码工作台的节奏（`wtx-hit` 0.42s）。别的屏的关键帧比它长时自己传 `hitMs`，
 * 否则类被提前摘掉，动画会在半路硬切回底色。
 */
const HIT_MS = 420
const NS = 'http://www.w3.org/2000/svg'

/** 慢起、加速、慢落。三次曲线的中段最快，两端最慢 —— 正好是这句话的形状 */
export function easeInOutCubic(t: number): number {
  const x = Math.min(1, Math.max(0, t))
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2
}

/** 字符串 → 种子。同一串永远同一个数（跨进程也一样，不依赖 Math.random） */
export function seedOf(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

export interface Curve {
  p0: Pt
  p1: Pt
  p2: Pt
  p3: Pt
}

/**
 * 一条三次贝塞尔。弯度由种子定：同一次飞行整段用同一组控制点，
 * 所以它不会抖；换一个事件就是另一条弧，所以路径不会千篇一律。
 */
export function curvePoints(from: Pt, to: Pt, seed: number): Curve {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  const side = seed % 2 === 0 ? 1 : -1
  const spread = 0.3 + ((seed >>> 3) % 100) / 100 // 0.3 – 1.29
  /*
   * 弯度跟着距离走，但封得比较低。
   *
   * 从顶栏的模型标记飞到右栏那一步，直线有七八百像素；按比例给弯度会长成一条
   * 甩出去的大弧，横穿整片正文 —— 那不是「一束光指过去」，那是一道帘子。
   * 封在 64 像素以内，它只是稍微拱一下，仍然一眼看得出从哪到哪。
   */
  const bow = side * (14 + Math.min(64, len * 0.12)) * spread
  // 起终点各退一点，弧才不是从圆心直接戳出去
  const w1 = 0.26
  const w2 = 0.74
  return {
    p0: from,
    p1: { x: from.x + dx * w1 + nx * bow, y: from.y + dy * w1 + ny * bow },
    p2: { x: from.x + dx * w2 + nx * bow * 0.92, y: from.y + dy * w2 + ny * bow * 0.92 },
    p3: to,
  }
}

/** 曲线上 t 处的点 */
export function pointOnCurve(c: Curve, t: number): Pt {
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const d = 3 * u * t * t
  const e = t * t * t
  return {
    x: a * c.p0.x + b * c.p1.x + d * c.p2.x + e * c.p3.x,
    y: a * c.p0.y + b * c.p1.y + d * c.p2.y + e * c.p3.y,
  }
}

export function curveD(c: Curve): string {
  const f = (n: number): string => (Math.round(n * 10) / 10).toString()
  return `M ${f(c.p0.x)} ${f(c.p0.y)} C ${f(c.p1.x)} ${f(c.p1.y)}, ${f(c.p2.x)} ${f(c.p2.y)}, ${f(c.p3.x)} ${f(c.p3.y)}`
}

/** 路径长度：用直线弦长当近似足够（它只决定流动的节奏，不决定落点） */
function curveLen(c: Curve): number {
  let len = 0
  let prev = c.p0
  for (let i = 1; i <= 16; i++) {
    const p = pointOnCurve(c, i / 16)
    len += Math.hypot(p.x - prev.x, p.y - prev.y)
    prev = p
  }
  return len
}

function el(name: string, attrs: Record<string, string>): SVGElement {
  const node = document.createElementNS(NS, name)
  for (const k of Object.keys(attrs)) node.setAttribute(k, attrs[k] as string)
  return node
}

interface Active {
  rec: FlightRecord
  g: SVGGElement
  head: SVGPathElement
  dot: SVGCircleElement
  halo: SVGCircleElement
  curve: Curve
  len: number
  startedAt: number
  duration: number
  /** 已经飞完，正在停留 */
  landed: boolean
  landedAt: number
  target: Element | null
}

export interface CreateLightOptions {
  /** 强制降级（测试用）；不给就看系统设置 */
  reduceMotion?: boolean
  /**
   * 落点高亮用的 class，默认 `wtx-hit`（编码工作台那一套）。
   * 别的屏复用时给自己的类名，别去蹭别人的 —— 两个屏的「到了」不该长得一样，
   * 但「什么时候到了」只能由这里一处回答。
   */
  hitClass?: string
  /**
   * 高亮留多久再摘（ms）。默认 420，必须 ≥ 落点那几条关键帧里最长的一条，
   * 不然「到了」只演一半。右栏判断卡的 cl-form 是 0.9s，所以它传 1000。
   */
  hitMs?: number
  /** 时间源（测试用） */
  now?: () => number
  /** 帧源（测试用）；默认 requestAnimationFrame */
  raf?: (cb: (t: number) => void) => number
  cancelRaf?: (id: number) => void
}

/**
 * 建一层光。`svg` 由调用方给（通常铺满整个工作台），这层只管往里画。
 */
export function createLightLayer(svg: SVGSVGElement, opts: CreateLightOptions = {}): LightLayer {
  const now = opts.now ?? (() => performance.now())
  const raf = opts.raf ?? ((cb: (t: number) => void) => requestAnimationFrame(cb))
  const cancel = opts.cancelRaf ?? ((id: number) => cancelAnimationFrame(id))
  const active: Active[] = []
  const log: FlightRecord[] = []
  let frame: number | null = null
  let pausedAt: number | null = null
  let dead = false
  const hits = new Map<Element, number>()

  const reduce = (): boolean => {
    if (typeof opts.reduceMotion === 'boolean') return opts.reduceMotion
    try {
      return matchMedia('(prefers-reduced-motion: reduce)').matches
    } catch {
      return false
    }
  }

  const drop = (a: Active): void => {
    a.g.remove()
    const i = active.indexOf(a)
    if (i >= 0) active.splice(i, 1)
  }

  /** 落点补的那一下用哪个 class。默认是编码工作台的，别的屏自己给 */
  const hitClass = opts.hitClass ?? 'wtx-hit'
  const hitMs = opts.hitMs ?? HIT_MS
  const hit = (node: Element | null): void => {
    if (!node) return
    node.classList.add(hitClass)
    const prev = hits.get(node)
    if (prev) window.clearTimeout(prev)
    const t = window.setTimeout(() => {
      node.classList.remove(hitClass)
      hits.delete(node)
    }, hitMs)
    hits.set(node, t)
  }

  const stop = (): void => {
    if (frame !== null) {
      cancel(frame)
      frame = null
    }
  }

  const loop = (): void => {
    frame = null
    if (dead || pausedAt !== null) return
    const t = now()
    let running = false
    for (const a of [...active]) {
      const elapsed = t - a.startedAt
      if (!a.landed && elapsed >= a.duration) {
        a.landed = true
        a.landedAt = t
        a.head.setAttribute('stroke-dashoffset', '0')
        const end = pointOnCurve(a.curve, 1)
        a.dot.setAttribute('cx', String(end.x))
        a.dot.setAttribute('cy', String(end.y))
        a.halo.setAttribute('cx', String(end.x))
        a.halo.setAttribute('cy', String(end.y))
        hit(a.target)
      }
      if (a.landed) {
        const after = t - a.landedAt
        const k = Math.max(0, 1 - after / LAND_MS)
        a.g.setAttribute('opacity', k.toFixed(3))
        a.dot.setAttribute('r', (2.6 + (1 - k) * 3).toFixed(2))
        a.halo.setAttribute('opacity', (0.16 * k).toFixed(3))
        if (after >= LAND_MS) {
          drop(a)
          continue
        }
      } else {
        const p = easeInOutCubic(elapsed / a.duration)
        a.head.setAttribute('stroke-dashoffset', String(a.len * (1 - p)))
        a.head.setAttribute('opacity', (0.55 + 0.45 * Math.min(1, p * 2)).toFixed(3))
        const at = pointOnCurve(a.curve, p)
        a.dot.setAttribute('cx', String(at.x))
        a.dot.setAttribute('cy', String(at.y))
        a.halo.setAttribute('cx', String(at.x))
        a.halo.setAttribute('cy', String(at.y))
      }
      running = true
    }
    if (running) frame = raf(loop)
  }

  const ensureLoop = (): void => {
    if (frame === null && !dead && pausedAt === null) frame = raf(loop)
  }

  /** 页面藏起来就冻结：不光停帧，还要把时间基准往后挪，否则回来时所有光都已经过站了 */
  const onVisibility = (): void => {
    if (dead) return
    if (document.visibilityState === 'hidden') {
      if (pausedAt === null) pausedAt = now()
      stop()
      return
    }
    if (pausedAt !== null) {
      const offset = now() - pausedAt
      for (const a of active) {
        a.startedAt += offset
        if (a.landed) a.landedAt += offset
      }
      pausedAt = null
      ensureLoop()
    }
  }

  const layer: LightLayer = {
    emit(req) {
      if (dead) return false
      const duration = Math.max(200, req.durationMs ?? FLIGHT_MS)
      const seed = seedOf(req.eventId)
      const still = reduce()
      const rec: FlightRecord = {
        eventId: req.eventId,
        fromId: req.fromId,
        toId: req.toId,
        from: { ...req.from },
        to: { ...req.to },
        color: req.color,
        still,
        at: now(),
      }
      log.push(rec)
      if (log.length > 24) log.splice(0, log.length - 24)

      const curve = curvePoints(req.from, req.to, seed)
      const len = Math.max(1, curveLen(curve))
      const d = curveD(curve)

      const g = el('g', {
        class: still ? 'lg-flight still' : 'lg-flight',
        'data-event': req.eventId,
        'data-from': req.fromId,
        'data-to': req.toId,
      }) as SVGGElement
      /*
       * 粗细随 weight 走。默认 1 是工作台那套（短途、贴得近），
       * 长途那几束由调用方给 1.8–2.2：飞八百像素时 1.1px 在屏幕上几乎读不出来。
       * 圆点与光晕同步放大，否则头重脚轻，看起来像线断了。
       */
      const w = Math.max(0.5, req.weight ?? 1)
      const trail = el('path', {
        class: 'lg-trail',
        d,
        stroke: req.color,
        'fill-rule': 'nonzero',
        'stroke-width': (1.1 * w).toFixed(2),
        'stroke-linecap': 'round',
        opacity: still ? '0.55' : '0.18',
      }) as SVGPathElement
      const head = el('path', {
        class: 'lg-head',
        d,
        stroke: req.color,
        'stroke-width': (1.7 * w).toFixed(2),
        'stroke-linecap': 'round',
        'stroke-dasharray': len.toFixed(1),
        'stroke-dashoffset': still ? '0' : len.toFixed(1),
        opacity: still ? '0.9' : '0.55',
      }) as SVGPathElement
      const halo = el('circle', {
        class: 'lg-halo',
        cx: String(req.to.x),
        cy: String(req.to.y),
        r: String(6 * w),
        fill: req.color,
        opacity: '0.16',
      }) as SVGCircleElement
      const dot = el('circle', {
        class: 'lg-dot',
        cx: String(still ? req.to.x : req.from.x),
        cy: String(still ? req.to.y : req.from.y),
        r: String(2.6 * w),
        fill: req.color,
        opacity: still ? '0.8' : '1',
      }) as SVGCircleElement
      g.appendChild(trail)
      g.appendChild(head)
      g.appendChild(halo)
      g.appendChild(dot)
      svg.appendChild(g)

      if (still) {
        // 不飞：一条静止的线摆一下，落地提示按同一套规则给
        hit(req.targetEl ?? null)
        window.setTimeout(() => g.remove(), STILL_MS)
        return true
      }

      const a: Active = {
        rec,
        g,
        head,
        dot,
        halo,
        curve,
        len,
        startedAt: now(),
        duration,
        landed: false,
        landedAt: 0,
        target: req.targetEl ?? null,
      }
      active.push(a)
      ensureLoop()
      return true
    },

    flights() {
      return log.slice()
    },

    busy() {
      return active.length > 0
    },

    destroy() {
      dead = true
      stop()
      document.removeEventListener('visibilitychange', onVisibility)
      for (const a of [...active]) a.g.remove()
      active.length = 0
      for (const [, t] of hits) window.clearTimeout(t)
      hits.clear()
      if ((svg as unknown as { __lancerLight?: LightLayer }).__lancerLight === layer) {
        delete (svg as unknown as { __lancerLight?: LightLayer }).__lancerLight
      }
    },
  }

  document.addEventListener('visibilitychange', onVisibility)
  // 冒烟与诊断要能读到「刚打过哪些光」，看的是语义 id 和落点，不是截图
  ;(svg as unknown as { __lancerLight?: LightLayer }).__lancerLight = layer
  return layer
}
