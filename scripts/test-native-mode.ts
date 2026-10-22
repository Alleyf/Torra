/**
 * 聊天模式「原生 / 提取」双视图的离线回归（不需要 Electron）
 *
 * 起因：聊天模式原本只有一条链路 —— 把话键进站点，再把正文从回复容器里读回来。
 * 读回来那半条依赖站点结构，而站点天天改版；改一次就是「生成结束但未捕获到内容」，
 * 用户看到的是一排缺席，实际答案好好地在人家页面上。
 * 现在拆成两半：投递（两条链路共用，含同源闸门与注入）与读回（只有提取要）。
 * 原生模式只投递，回答留在站点自己的页面里，由右侧的原生墙一次全贴出来。
 *
 * 钉三层：
 * - 纯函数层：墙同时挂几枚、放大哪一枚、换进来谁让位（错了不崩，只是点了没反应）；
 * - 数据层：只配投递的适配器必须合格，配了读回却缺容器必须不合格（静默降级最难查）；
 * - 接线层：主进程按 webMode 分叉、两条入口共用同一段投递、渲染层默认原生且认得新事件。
 *
 * 运行：npm run test:native-mode
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { validateSpec } from '../src/main/adapters/registry'
import {
  DEFAULT_LIVE_PANES,
  FLOOR_PANE,
  SEAM_PX,
  COMFY_PANE,
  equalW,
  gridTree,
  layoutWall,
  planGrid,
  planPanes,
  setNodeWeights,
  shiftSeam,
  trackPx,
  insertPane,
  treeCellCount,
  treePages,
  foldInto,
  movePageInto,
  setActiveTab,
  splitLeafOut,
  swapCells,
  nodeAt,
} from '../src/renderer/chatWall'
import type { WallNode } from '../src/shared/wall-tree'
import { sanitizeWallLayout, wallLeafIds } from '../src/shared/wall-tree'

const ROOT = path.resolve(__dirname, '..')

let pass = 0
let fail = 0

async function it(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  [PASS] ${name}`)
  } catch (e) {
    fail++
    console.log(`  [FAIL] ${name}`)
    console.log(`         ${(e as Error).message.split('\n').slice(0, 4).join('\n         ')}`)
  }
}

function readSrc(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')
}

/** 从 layoutWall 的铺法里取某一格的矩形 */
const cellOf = (laid: ReturnType<typeof layoutWall>, id: string) => {
  const c = laid.cells.find((x) => x.id === id)
  assert.ok(c, `夹具本身：${id} 应该在墙上`)
  return c
}

/**
 * 从格子矩形反推「几列几行」。
 *
 * 切分树不再有 cols/rows 这个概念 —— 形状是逐节点的，一行里可以有两格、下一行三格。
 * 但旧的编排断言（"四枚摆 2×2"、"七枚摆 4×2"）问的是**自动等分摆法**的形状，
 * 那一条路还在（planGrid + gridTree），所以这里按矩形量回来判：
 * 行数 = 不同的 y 有几种，列数 = 同一行里最多几格。
 */
const shapeOf = (p: ReturnType<typeof planPanes>): { cols: number; rows: number } => {
  const cells = p.layout.cells
  if (cells.length === 0) return { cols: 0, rows: 0 }
  const ys = [...new Set(cells.map((c) => Math.round(c.y)))]
  let cols = 0
  for (const y of ys) cols = Math.max(cols, cells.filter((c) => Math.round(c.y) === y).length)
  return { cols, rows: ys.length }
}

/** 一份合格的最小适配器；下面的用例都从它派生，改一个字段看校验是否真的在管 */
function baseSpec(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'web-demo',
    name: '演示',
    transport: 'webview',
    entry: 'https://demo.example.com/',
    selectors: { input: 'textarea.i', send: 'button.s', stream: '.out' },
    completion: { mode: 'dom_stable', timeout_s: 60 },
    automation: { typing_delay_ms: [8, 20], pre_send_pause_ms: [200, 500], max_wait_s: 120, jitter: true },
    health_probe: 'textarea.i',
    verified_at: '2026-10-01',
    ...over,
  }
}

async function main(): Promise<void> {
  console.log('\n=== 窗格编排：同时挂几枚、放大哪一枚 ===')

  await it('默认口径：上限 4 枚，两枚以上才分栏', () => {
    assert.equal(DEFAULT_LIVE_PANES, 4, '上限就是 4：再多只是把内存花在看不到字的页面上')
    const p = planPanes({ ids: ['a', 'b', 'c', 'd', 'e', 'f'] })
    assert.deepEqual(p.live, ['a', 'b', 'c', 'd'])
    assert.deepEqual(p.rest, ['e', 'f'])
    assert.deepEqual(shapeOf(p), { cols: 2, rows: 2 }, '四枚摆 2×2')
    assert.equal(shapeOf(planPanes({ ids: ['a'] })).cols, 1, '单格要占满，别留半面空墙')
  })

  await it('放大：只剩那一枚挂载，其余全部退回标签', () => {
    /*
     * 其余窗格不是「藏起来」而是从 DOM 卸载 —— WebviewDock 卸载会 dismiss 掉原生视图，
     * 那几枚的渲染进程要到那一刻才真的还给系统。挂着不放等于放大没省内存。
     */
    const p = planPanes({ ids: ['a', 'b', 'c'], expanded: 'b' })
    assert.deepEqual(p.live, ['b'])
    assert.deepEqual(p.rest, ['a', 'c'])
    assert.equal(p.layout.cells.length, 1, '放大态只铺出一格')
    assert.equal(p.layout.seams.length, 0, '一格没有缝')
  })

  await it('放大一枚不在墙上的模型时当作没发生，不能挂出空墙', () => {
    const p = planPanes({ ids: ['a', 'b'], expanded: 'zzz' })
    assert.deepEqual(p.live, ['a', 'b'])
    assert.deepEqual(p.rest, [])
  })

  await it('换进来排最前：第五枚点一下必须真的看得见，而不是追加到队尾', () => {
    /*
     * 上限之外的模型只在标签条里。点它若只是 push 到 ids 末尾，
     * slice(0, 4) 之后它仍然不在窗上 —— 用户看到的是「点了没反应」。
     *
     * 树自己记着谁在哪一格之后，这一件事改的是树（insertPane），不再是名单。
     */
    const ids = ['a', 'b', 'c', 'd', 'e']
    /* 墙只摆得下四枚：e 起初确实在标签条里 */
    const plain = planPanes({ ids, cap: 4 })
    assert.ok(!plain.live.includes('e'), '夹具本身：e 起初确实不在墙上')
    const inserted = insertPane(plain.root, 'e', plain.cap)
    const p = planPanes({ ids, tree: inserted })
    assert.ok(p.live.includes('e'), '点一下之后 e 真的在墙上了')
    assert.equal(p.layout.cells.length, plain.layout.cells.length, '墙满时它是折进最后一格，格子数不变')
    assert.ok(p.layout.cells.some((c) => c.pages.includes('e')), 'e 成了那一格上的一个标签')
  })

  await it('墙满了再换进来：折进最后一格，而不是把谁挤下墙', () => {
    /*
     * 旧口径是「顶掉最后一格」—— 被顶掉的那枚退回标签条。
     * 但现在一格已经能装多页（折叠），顶掉就纯属浪费：
     * 用户点了「换进来」，看到的却是自己刚折好的那一叠少了一个标签。
     * 折进去什么都不丢，而格子数不变，也就没有「半面墙搬家」。
     */
    const ids = ['a', 'b', 'c', 'd']
    const full = planPanes({ ids, cap: 3 })
    assert.deepEqual(full.live, ['a', 'b', 'c'], '夹具本身：d 在标签条里')
    const swapped = insertPane(full.root, 'd', 3)
    assert.equal(treeCellCount(swapped), 3, '格子数不许超过这一屏的容量')
    assert.ok(wallLeafIds(swapped).includes('d'), '换进来的那枚真的上墙了')
    assert.equal(wallLeafIds(swapped).filter((x) => x === 'd').length, 1, '同一页不许在两格里各挂一次')
    assert.deepEqual(wallLeafIds(swapped).sort(), ['a', 'b', 'c', 'd'], '一枚都没丢：折进去不是顶掉')
  })

  await it('退出参与者后不留悬空引用', () => {
    /*
     * 树里存着 id，所以「参与者退了一个」这件事必须被摘干净：
     * 留着就是一格挂着一个已经不参与的站点，而且它还会占住一个 WebContentsView。
     */
    const tree: WallNode = {
      kind: 'split',
      axis: 'x',
      weights: [100, 100],
      children: [{ kind: 'leaf', ids: ['a'] }, { kind: 'leaf', ids: ['x'] }],
    }
    const p = planPanes({ ids: ['a', 'b'], box: { w: 1770, h: 723 }, tree })
    assert.deepEqual(p.live, ['a', 'b'], '退场的那一枚被摘掉，新来的补上：一格不多一格不少')
    assert.equal(p.layout.cells.length, 2, '摘掉一格之后摊平，不留空洞')
  })

  await it('上限 0 = 整面墙收起，也不至于挂出一枚', () => {
    const p = planPanes({ ids: ['a', 'b'], cap: 0 })
    assert.deepEqual(p.live, [])
    assert.deepEqual(p.rest, ['a', 'b'])
  })

  console.log('\n── 格数自适应：墙多大就摆几格，先补满再挑形状')

  await it('量不到尺寸时退回旧的 2×2 四格口径（首帧不能比昨天差）', () => {
    const g = planGrid(null)
    assert.deepEqual([g.cols, g.rows, g.cap, g.tier], [2, 2, DEFAULT_LIVE_PANES, 0])
    assert.equal(planGrid({ w: 0, h: 0 }).cap, DEFAULT_LIVE_PANES, '零尺寸和没尺寸同一条路')
  })

  await it('cap 用地板档算，形状用舒适档挑', () => {
    /*
     * 这两件事必须分开。拿舒适档(560×340)当 cap 的尺，1920 窗口把左栏展开、墙拖到 950px 时
     * 只会算出「1 列 × 2 行」—— 四家参与者当场掉成两家，「放更多」变成了「先变少」。
     * 地板档(420×240)在这里给出 2×2，与旧口径一模一样；多出来的格数才是净增益。
     */
    assert.equal(planGrid({ w: 950, h: 723 }, 4).cols, 2)
    assert.equal(planGrid({ w: 950, h: 723 }, 4).rows, 2, '四枚摆满 2×2：950px 的墙不该比旧口径少挂')
    /*
     * 723px 高摆三行 240 的格要 3×240+2×7=734 —— 差 11px 就是摆不下，
     * 所以缝算成本之后这里的容量是 2×2=4，而不是旧口径的 6。
     * 这不是倒退：缝是真占地方的把手（原生视图盖不住它才拖得动），
     * 把它当 0 成本只会换来「说好摆得下、实际横向溢出」。
     */
    assert.equal(planGrid({ w: 950, h: 723 }, 8).cap, 4, 'cap 报的是墙（2×2，含缝成本），不是这次挑的摆法')
    const eight = planPanes({ ids: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], box: { w: 950, h: 723 } })
    assert.equal(eight.live.length, 4, '摆不下的退回标签，而不是硬塞成看不清楚的小格')
    assert.deepEqual(eight.rest, ['e', 'f', 'g', 'h'])
    // 第三列要 3×420+2×7=1274px 才付得起
    assert.equal(planGrid({ w: 1770, h: 723 }, 7).cols, 4)
    assert.equal(planGrid({ w: 1240, h: 700 }, 4).cols, 2, '1240 的墙开不了第三列：连第二列都勉强')
    assert.equal(planGrid({ w: 1260, h: 700 }, 8).cap, 4, '1260 宽没有第三列：3×420=1260 看着够，加上两条缝就不够')
    assert.equal(planGrid({ w: 1274, h: 700 }, 8).cap, 6, '1274 = 3×420+2×7，刚好付得起两条缝，容量当场多两格')
  })

  await it('参与者少时格子变大，不留空位', () => {
    /*
     * 第一判据是空格子数：四枚摆进三列会留两格空位，墙上看着像坏了一半。
     * 所以 6 枚摆 3×2 补满，7 枚才让出一格换成 4×2。
     */
    const six = planGrid({ w: 1770, h: 723 }, 6)
    assert.deepEqual([six.cols, six.rows], [3, 2])
    assert.equal(six.cols * six.rows, 6, '六枚要正好补满')
    assert.equal(six.tier, 0, '590×361 两维都过舒适档，不该报「挤」')
    assert.deepEqual([planGrid({ w: 1770, h: 723 }, 4).cols, planGrid({ w: 1770, h: 723 }, 4).rows], [2, 2])
    assert.deepEqual([planGrid({ w: 1770, h: 723 }, 7).cols, planGrid({ w: 1770, h: 723 }, 7).rows], [4, 2])
  })

  await it('挤到地板档要如实报告（界面据此说明「已挤一档」）', () => {
    assert.equal(planGrid({ w: 1770, h: 723 }, 8).tier, 1, '443px 宽低于舒适档')
    assert.equal(planGrid({ w: 600, h: 620 }, 2).tier, 1, '600 宽的墙两格都在让')
  })

  await it('planPanes 把格数用在挂载名单上：多出来的退回标签，列数跟实际枚数取小', () => {
    /*
     * 1770×723 这堵墙按地板档能摆 4×3，但真正挂几格由「补满且形状不难看」决定：
     * 7 枚摆成 4×2 留一格空位，比摆成 3×3 那种又矮又扁的格子好读。
     * 1240 宽的墙还是老四格 —— 这一档必须和改动前一模一样，多挂只可能是净增益。
     */
    const seven = planPanes({ ids: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], box: { w: 1770, h: 723 } })
    assert.equal(seven.live.length, 7, '这一屏摆得下 4×2=8 格，七枚全挂')
    assert.deepEqual(seven.rest, [])
    assert.deepEqual(shapeOf(seven), { cols: 4, rows: 2 }, '七枚摆 4×2：顶行四格、底行三格')

    const nine = planPanes({ ids: Array.from({ length: 9 }, (_, i) => `m${i + 1}`), box: { w: 1770, h: 760 } })
    assert.equal(nine.live.length, 9, '760px 高才付得起三行（3×240+2×7=734）')
    assert.deepEqual(shapeOf(nine), { cols: 3, rows: 3 }, '九枚摆 3×3 正好补满，摆 4 列要留三格空位')
    const short = planPanes({ ids: Array.from({ length: 9 }, (_, i) => `m${i + 1}`), box: { w: 1770, h: 723 } })
    assert.equal(short.live.length, 8, '同一堵墙矮了 37px 就只剩两行：多出来那枚退回标签，不是硬挤')
    assert.deepEqual([shapeOf(short).cols, shapeOf(short).rows], [4, 2])

    const narrow = planPanes({ ids: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], box: { w: 1240, h: 700 } })
    assert.deepEqual(narrow.live, ['a', 'b', 'c', 'd'])
    assert.deepEqual(narrow.rest, ['e', 'f', 'g'], '摆不下的退回标签条，点一下换进来')
    assert.equal(shapeOf(narrow).cols, 2)
    // 只挂两枚时不该占三列：中间那根空列在墙上是一竖条应用底色
    const two = planPanes({ ids: ['a', 'b'], box: { w: 1770, h: 723 } })
    assert.deepEqual(shapeOf(two), { cols: 2, rows: 1 }, '两枚摆 2×1，不留空列')
    assert.equal(two.rest.length, 0)
  })

  await it('「这一屏放得下几枚」报的是墙，不是这次的摆法', () => {
    /*
     * 这句提示是用户判断「还要不要拖宽」的唯一依据，所以它必须回答容量。
     * 实测栽过一次：1710×758 的墙挂三枚，摆法选了 3×1，提示跟着写成「放 3 枚」——
     * 用户据此以为这墙已经满了，而它按地板档还摆得下 12 格。
     */
    const three = planPanes({ ids: ['a', 'b', 'c'], box: { w: 1710, h: 758 } })
    assert.deepEqual([shapeOf(three).cols, three.live.length, three.rest.length], [3, 3, 0])
    assert.equal(three.cap, 12, '1710 宽 4 列 × 758 高 3 行 = 12 格，与摆法无关')
    // 枚数摆满时下方没有标签条，「每格低于舒适档」只能靠墙头上那颗徽章说，徽章要写真实的行列
    const seven = planPanes({ ids: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], box: { w: 1710, h: 758 } })
    assert.deepEqual([shapeOf(seven).cols, shapeOf(seven).rows, seven.tier], [4, 2, 1], '七枚摆 4×2：428px 宽低于舒适档，如实报挤')
    assert.equal(seven.rest.length, 0, '这一屏摆得下就一枚都不必退回标签')
    assert.deepEqual([shapeOf(three).cols, shapeOf(three).rows, three.tier], [3, 1, 0], '三枚摆 3×1：570×758 两维都过舒适档')
    const tall = planPanes({ ids: Array.from({ length: 12 }, (_, i) => `m${i}`), box: { w: 1710, h: 758 } })
    assert.deepEqual([shapeOf(tall).cols, shapeOf(tall).rows, tall.cap], [4, 3, 12], '十二枚摆满 4×3，行列都顶到天花板')
    const p = planPanes({ ids: ['a', 'b', 'c'], box: { w: 1770, h: 723 }, cap: 1 })
    assert.equal(p.cap, 1, '显式 cap 就是这一路的格数口径：它压过尺寸，一路用到底')
    assert.deepEqual([shapeOf(p).cols, shapeOf(p).rows], [1, 1], '被压成一格时行列都跟着收成 1')
  })

  await it('墙上的两句账都落在界面上：徽章说摆法，标签条说容量', () => {
    /*
     * tier 只由渲染层那两处消费：下方标签条（有候补才存在）与墙头徽章（摆满时唯一的出口）。
     * 少接一处，症状是「格子已经挤到读不动，界面一句话不说」。
     */
    const page = readSrc('src/renderer/components/ChatPage.tsx')
    assert.match(page, /wall\.tier > 0 && \(/, '摆满没有标签条时，徽章是唯一的说法')
    assert.match(page, /每格低于舒适档 · \{wall\.live\.length\} 格/, '徽章写真实的格数，不写容量')
    assert.match(page, /这一屏放得下 \$\{wall\.cap\} 枚/, '标签条那句说的是容量')
    assert.match(page, /位参与者已全部挂上/, '没摆满时不许劝用户拖宽')
    const css = readSrc('src/renderer/styles.css')
    assert.match(css, /\.cx-wall-tier \{/, '徽章样式得真的存在，否则那颗只是一个裸 <b>')
  })

  await it('缝自己占 7px 命中带：算格数要先把缝的钱付掉', () => {
    assert.equal(SEAM_PX, 7, '缝宽就是那段命中带的宽度，与 .cx-wall-seam 同口径')
    // 每格 = (总宽 - 缝) / 格数：拿总宽去除，就把缝也算成了可读面积
    const three = trackPx(1710, [100, 100, 100])
    assert.equal(three.length, 3)
    assert.ok(Math.abs(three[0] - (1710 - 2 * SEAM_PX) / 3) < 0.01, '等分时每格正好平分扣掉缝之后的空间')

    /*
     * 切分树铺出来的矩形：格与格之间正好留一条 SEAM_PX，缝自己占住它。
     * 这一条是「缝拖得动」的几何前提 —— WebContentsView 画在渲染层之上，
     * 压在窗格上的像素收不到指针，缝不占自己的地盘就又是「按下去是站点页面」。
     */
    const laid = layoutWall(gridTree(['a', 'b'], 2, 1), { w: 1000, h: 600 })
    assert.deepEqual(laid.cells.map((c) => c.id), ['a', 'b'], 'DFS 序 = 先行后列的阅读序')
    assert.equal(laid.seams.length, 1, '两格一条缝')
    const [ca, cb] = laid.cells
    const s0 = laid.seams[0]!
    assert.ok(ca && cb && s0)
    assert.equal(s0.w, SEAM_PX, '竖缝宽就是 SEAM_PX')
    assert.equal(s0.x, ca.x + ca.w, '缝紧贴左格右边界')
    assert.ok(Math.abs(cb.x - (s0.x + s0.w)) < 0.01, '缝右边界就是右格的左边界：不多不少')
    assert.equal(s0.axis, 'x', '两格横排的是竖缝')
    assert.equal(s0.path.length, 0, '这条缝属于根节点')
    assert.equal(laid.cells[1]!.x + laid.cells[1]!.w, 1000, '最后一格正好贴到墙边')
  })

  await it('切分树：一条缝只管自己那两格，同列其余格一像素不动', async () => {
    /*
     * 这一条是本次重构的靶心。旧的共享轨道里，列轨整墙共用，拖第 1 列与第 2 列
     * 之间那条缝会把**所有行**的第 1、2 格一起改宽窄 —— 用户要的「只调这一格」做不到。
     * 切分树里每一刀记在自己的节点上：把左边那一格切两半之后，
     * 拖「左半与右半之间」那条缝只改这两格，右列那格一像素不动。
     */
    const box = { w: 1400, h: 900 }
    const root: WallNode = {
      kind: 'split',
      axis: 'x',
      weights: [100, 100],
      children: [
        {
          kind: 'split',
          axis: 'y',
          weights: [100, 100],
          children: [
            { kind: 'leaf', ids: ['a'] },
            { kind: 'leaf', ids: ['b'] },
          ],
        },
        { kind: 'leaf', ids: ['c'] },
      ],
    }
    const before = layoutWall(root, box)
    assert.equal(before.cells.length, 3)
    assert.equal(before.seams.length, 2, '一刀竖缝 + 左列内部一刀横缝')
    const seamLR = before.seams.find((s) => s.axis === 'x')!
    const seamAB = before.seams.find((s) => s.axis === 'y')!
    assert.ok(seamLR && seamAB, '两种缝各一条')
    /*
     * 缝只覆盖相邻两格的公共边：a 与 b 之间的横缝不许延伸到右列 c 上，
     * 否则它又会横穿别人的格子，退回「一拖一整行」。
     */
    const cRect = cellOf(before, 'c')
    assert.ok(seamAB.x + seamAB.w <= cRect.x + 0.01, '左列内部的横缝不许伸到右列那格上')

    // 拖左列内部那条横缝：a 变高、b 变矮，右列那格与整墙列宽一概不动
    const dragged = setNodeWeights(root, seamAB.path, shiftSeam(seamAB.totalPx, seamAB.weights, seamAB.index, 120, FLOOR_PANE.h))
    const after = layoutWall(dragged, box)
    const a0 = cellOf(before, 'a')
    const a1 = cellOf(after, 'a')
    const b1 = cellOf(after, 'b')
    const c1 = cellOf(after, 'c')
    assert.ok(a1.h - a0.h > 110 && a1.h - a0.h < 130, `a 吃下这 120px（实测 ${Math.round(a1.h - a0.h)}）`)
    assert.deepEqual([c1.x, c1.y, c1.w, c1.h], [cRect.x, cRect.y, cRect.w, cRect.h], '右列那格一像素不动 —— 这就是单格独立控制')
    assert.deepEqual(
      [a1.x, a1.w, b1.x, b1.w],
      [a0.x, a0.w, cellOf(before, 'b').x, cellOf(before, 'b').w],
      '列宽不受行内那一刀影响',
    )
    // 拖动只改一个节点的权重：另一处（根那一刀）必须原样留着
    assert.deepEqual(after.seams.find((s) => s.axis === 'x')!.weights, seamLR.weights)
  })

  await it('拖一条缝只动相邻两格，其余格一个像素都不变', () => {
    const total = 1710
    const base = [100, 100, 100]
    const next = shiftSeam(total, base, 0, 100, FLOOR_PANE.w)
    const a = trackPx(total, base)
    const b = trackPx(total, next)
    assert.ok(b[0] - a[0] > 95 && b[0] - a[0] < 105, `第一格吃下这 100px（实测 ${Math.round(b[0] - a[0])}）`)
    assert.ok(a[1] - b[1] > 95 && a[1] - b[1] < 105, '第二格把同样的像素交出去')
    assert.ok(
      Math.abs(a[2] - b[2]) < 1.5,
      '第三格没参与这次拖动，一像素都不该动 —— 这就是「其余格继续等分剩余空间」',
    )
    assert.ok(next.every((x) => x > 0), '权重保持正数')

    // 同一组格想一次吃 200px：三格等分时每格 565，地板档只让它再吃 139 —— 停手，不是失灵。
    // 停手之后按整数权重量回来仍必须 ≥ 地板档：差 2px 也会被 shrinkBoxFor 认成破档，
    // 而它一认，2 列当场塌成 1 列 —— 那正是这次要根治的死状态。
    const capped = trackPx(total, shiftSeam(total, base, 0, 200, FLOOR_PANE.w))
    assert.ok(
      capped[0] - a[0] > 130 && capped[0] - a[0] < 146,
      `到地板档就停（实测多吃 ${Math.round(capped[0] - a[0])}px）`,
    )
    assert.ok(Math.min(...capped) >= FLOOR_PANE.w, '夹住之后每格仍在地板档之上（含整数权重的舍入）')
    assert.ok(Math.min(...trackPx(1787, shiftSeam(1787, [100, 100], 0, 4000, FLOOR_PANE.w))) >= FLOOR_PANE.w, '实测那组 1787 两格：拖到底不许折成 418')

    /*
     * 拖到底的下限是**这一轴的地板档**，不是某个更小的硬底。
     * 曾经这里放行到 180px，意思是「先拖破地板、少挂一枚」；实测那等于把墙拖死：
     * 两轴都拖破之后墙只剩一格，而一格没有缝，点别的标签只是把那格顶掉，
     * 用户再也回不到并存（用户原话：「变成只能切换单个窗口无法并存了」）。
     * 想独占整面墙走「放大此窗格」，那是一条说得清楚、也还得回来的路。
     */
    const crushed = trackPx(total, shiftSeam(total, base, 0, -4000, FLOOR_PANE.w))
    assert.ok(crushed[0] >= FLOOR_PANE.w, `最窄那一格拖到地板档就停手（实测 ${Math.round(crushed[0])}px）`)
    assert.ok(crushed[1] >= FLOOR_PANE.w, '反方向同理：被吃的那一格也不许破地板档')
    assert.ok(crushed[1] > a[1], '另一侧确实在变宽 —— 停手是夹住，不是整条缝失灵')
    assert.ok(Math.min(...trackPx(total, shiftSeam(total, base, 1, 4000, FLOOR_PANE.w))) >= FLOOR_PANE.w)

    // 已经在地板档以下（拖完之后墙变小）：那一格不许再让出一像素，但往回拖得动
    const broken = [163, 37]
    const before = trackPx(1131, broken)
    const drained = trackPx(1131, shiftSeam(1131, broken, 0, 4000, FLOOR_PANE.w))
    assert.ok(
      Math.abs(drained[1] - before[1]) < 2,
      `破档那一格一格都不许再让出去（实测 ${Math.round(before[1])} → ${Math.round(drained[1])}）`,
    )
    const healed = trackPx(1131, shiftSeam(1131, broken, 0, -4000, FLOOR_PANE.w))
    assert.ok(healed[1] > before[1] + 100, '往回拖得动：另一格把像素还给它 —— 手感是「拖得回来，拖不坏」')
    assert.ok(healed[0] >= FLOOR_PANE.w, '还回去也不许把另一格拖破地板档')
  })

  await it('树的比例破了地板档：如实报破，且形状对不上时整份作废重新等分', () => {
    // 三枚摆一横排，第三格只剩 226px（低于地板档 420）——
    // 拖动本身拖不出这一种（shiftSeam 夹在地板档），它来自拖完之后墙变小 / 左栏展开。
    const box = { w: 1710, h: 758 }
    const narrow: WallNode = {
      kind: 'split',
      axis: 'x',
      weights: [130, 130, 40],
      children: [
        { kind: 'leaf', ids: ['a'] },
        { kind: 'leaf', ids: ['b'] },
        { kind: 'leaf', ids: ['c'] },
      ],
    }
    const p = planPanes({ ids: ['a', 'b', 'c'], box, tree: narrow })
    assert.equal(p.live.length, 3, '树对得上名单就用它：格数不因破档被硬砍')
    assert.equal(p.seamBreached, true, '破了地板档要如实报出来：界面据此给复位钮')
    assert.equal(p.tier, 1, '低于舒适档的那一句也要跟着说')
    assert.ok(cellOf(p.layout, 'c').w < FLOOR_PANE.w, '报破的依据就是实际矩形')

    /*
     * 形状对不上（存的是三格的切法，现在挂了六枚）时整份作废、回到等分摆法。
     * 不许部分采信：把三格的比例硬套到六格上，会得到一个谁都没拖过的形状。
     */
    const six = planPanes({ ids: ['a', 'b', 'c', 'd', 'e', 'f'], box, tree: narrow })
    assert.equal(six.seamBreached, false, '等分摆法没有破档可言')
    assert.deepEqual(six.live, ['a', 'b', 'c', 'd', 'e', 'f'], '一枚都没少：作废的是比例，不是参与者')
    assert.deepEqual(shapeOf(six), { cols: 3, rows: 2 }, '回到墙宽说了算的 3×2')
    assert.deepEqual(wallLeafIds(six.root), six.live, '铺上墙的叶子就是挂上的那几枚')
  })

  await it('拖动一条缝不改形状：把手所属的格子不会中途消失', () => {
    /*
     * 旧那套「拖动期间钉住格数与形状」（hold/cap）是为共享轨道写的：拖到破地板的那一帧
     * 列数会退，用户按着的那根把手连同它所属的格子一起消失，手感是「拖到一半被弹开」。
     * 切分树里拖动只改一个节点的权重，形状（几格、怎么切）压根不在被改的东西里，
     * 所以这一条从「需要补丁」变成「结构上不可能」—— 这里把它钉住，别让它退回。
     */
    const ids = ['a', 'b', 'c', 'd']
    const box = { w: 1710, h: 758 }
    const plain = planPanes({ ids, box })
    const seam = plain.layout.seams[0]!
    assert.ok(seam, '四枚的墙上至少有一条缝')
    // 往任何一个方向拖到底：格数、形状、缝的条数都不动
    for (const delta of [-4000, 4000]) {
      const next = shiftSeam(seam.totalPx, seam.weights, seam.index, delta, FLOOR_PANE.w)
      const held = planPanes({ ids, box, tree: plain.root, drag: { path: seam.path, weights: next } })
      assert.deepEqual(held.live, plain.live, '拖动中途不许有人掉下墙')
      assert.equal(held.layout.cells.length, plain.layout.cells.length, '格子条数不变')
      assert.equal(held.layout.seams.length, plain.layout.seams.length, '缝的条数不变：把手不会把自己拖没')
      assert.ok(held.layout.cells.every((c) => c.w >= FLOOR_PANE.w - 1 && c.h >= FLOOR_PANE.h - 1), '拖到底也不许破地板档')
    }
  })

  await it('破档要单独报一声，且点未挂载那枚标签能自己复位回来', () => {
    /*
     * 实测撞到的死路（本机 layout 里就存着这一组比例）：最窄一格被压到 178px，
     * 远低于地板档 420，于是墙上只剩一格、连一条缝都不剩，
     * 而界面还在写「这一屏放得下 1 枚」和「双击恢复等分」。
     * 双击谁？没有缝了。点另一枚标签只是把那唯一一格顶掉 —— 用户的话是
     * 「变成只能切换单个窗口无法并存了」。
     * 切分树里这一种仍可能出现（墙变小把比例压破），所以那两条退路都得在。
     */
    const ids = ['a', 'b']
    const box = { w: 1786, h: 717 }
    const crushedTree: WallNode = {
      kind: 'split',
      axis: 'x',
      weights: [180, 20],
      children: [
        { kind: 'leaf', ids: ['a'] },
        { kind: 'leaf', ids: ['b'] },
      ],
    }
    const crushed = planPanes({ ids, box, tree: crushedTree })
    assert.equal(crushed.seamBreached, true, '这一种要单独报出来：不是墙只能摆一格，是比例把它压破了')
    assert.ok(cellOf(crushed.layout, 'b').w < FLOOR_PANE.w, '被压破的那一格确实在墙上')

    /*
     * 复位之后必须真的回到两格等宽 —— 那颗钮删的是整棵树，不是往墙上硬塞一格。
     */
    const fixed = planPanes({ ids, box })
    assert.equal(fixed.seamBreached, false, '等分就没有破档可言')
    assert.deepEqual([shapeOf(fixed).cols, shapeOf(fixed).rows, fixed.live.length], [2, 1, 2], '两枚都回到墙上，各占一半')
    assert.ok(fixed.cap > 1, `复位后容量不该还是 1（实际 ${fixed.cap}）`)
    assert.ok(Math.abs(cellOf(fixed.layout, 'a').w - cellOf(fixed.layout, 'b').w) < 2, '复位是真的等分')

    const page = readSrc('src/renderer/components/ChatPage.tsx')
    assert.match(page, /wall\.seamBreached\n\s+\? `，格子的比例破了地板档/, '标签条那句先认破档，再谈别的真相')
    /*
     * 同一屏只剩一格还有第二种成因：用户自己点了放大。这时那句
     * 「没在墙上（这一屏只放得下 12 枚）」读起来像墙坏了 —— 容量是真的，
     * 只是这一格被独占占着。所以独占要按独占说，两枚标签一起改口。
     */
    assert.match(page, /const stripTail = solo\n\s+\? `，\$\{solo\.displayName\} 正在独占整面墙/, '独占时标签条那句先认独占')
    assert.match(page, /正在独占整面墙：点这枚标签退出独占、两格一起回到墙上/, '把点下去会发生什么说到底')
    assert.equal((page.match(/点这枚退出「/g) || []).length, 2, '墙上标签与参与者徽章都按当下成因说话')
    assert.match(page, /点右上「恢复等分」[\s\S]{0,40}直接点没挂上的标签复位/, '两条退路都要说出来')
    assert.match(page, /const seamStuck = seamUsed \|\| wall\.seamBreached/, '拖开过或拖破过，墙头就得给这颗钮')
    assert.match(page, /onClick=\{seamResetBoth\}[\s\S]{0,160}aria-label="恢复等分"/, '整墙一起复位')
    assert.match(page, /const seamResetBoth = \(\) => \{\n\s*setTreeStored\(null\)/, '复位 = 删掉整棵树，与双击同一条路')
    /*
     * 点标签这一路：破档时它是「加回来」而不是「换进来」，所以先清树再 promote。
     * 两个入口（下方参与者徽章、墙上那条「未挂载」标签）必须共用同一段动作：
     * 只修好一个入口，用户在墙上看到的那枚标签照样只会顶掉唯一那一格。
     */
    /*
     * 点未挂载那枚 = 复位 + 加回来。树自己记着谁在哪一格，所以这里不再改名单：
     * 破档时清树（形状作废、按墙宽重排，那一枚自然回到墙上），
     * 没破档时把它插进树里（insertPane）。
     */
    assert.match(page, /const promotePane = \(id: string\) => \{[\s\S]{0,240}if \(wall\.seamBreached\) \{[\s\S]{0,160}setTreeStored\(null\)[\s\S]{0,80}\}[\s\S]{0,120}insertPane\(wall\.root, id, wall\.cap\)/, '点未挂载那枚 = 复位 + 加回来')
    assert.equal((page.match(/promotePane\(m\.id\)/g) || []).length, 2, '两个入口都走 promotePane，不给同一句话留两种结果')
    assert.equal((page.match(/被破了地板档的比例挤下了墙/g) || []).length, 2, '两枚标签的 tooltip 都要说清这次点下去是加回来')
  })

  await it('拖开过的比例一放手不许自己长回去：树对得上名单就照它摆', () => {
    /*
     * 实测栽过的第二种「少挂一枚」：用户好不容易拖出来的宽窄，下一帧被等分冲掉 ——
     * 症状是「我一放手格子自己长回去了」。旧口径靠「比例自己报列数」把这句话存下来，
     * 切分树直接存整棵形状：只要叶子数还等于挂上的枚数，拖出来的宽窄就照常生效。
     */
    const ids = ['a', 'b', 'c', 'd']
    const box = { w: 1372, h: 717 }
    const dragged: WallNode = {
      kind: 'split',
      axis: 'y',
      weights: [100, 100],
      children: [
        { kind: 'split', axis: 'x', weights: [91, 109], children: [{ kind: 'leaf', ids: ['a'] }, { kind: 'leaf', ids: ['b'] }] },
        { kind: 'split', axis: 'x', weights: [91, 109], children: [{ kind: 'leaf', ids: ['c'] }, { kind: 'leaf', ids: ['d'] }] },
      ],
    }
    const p = planPanes({ ids, box, tree: dragged })
    assert.equal(p.live.length, 4)
    assert.deepEqual(shapeOf(p), { cols: 2, rows: 2 }, '两列两行照树摆，不因墙还能开第三列而改主意')
    const a = cellOf(p.layout, 'a')
    const b = cellOf(p.layout, 'b')
    assert.ok(b.w > a.w * 1.15, `拖开的比例照常生效（实测 ${Math.round(a.w)} vs ${Math.round(b.w)}），不被等分冲掉`)
    assert.equal(p.tier, 0, '622×742 配 355 格高都在舒适档之上')
    /*
     * 树里存的 id 只是占位：真正上墙的是对到 live 名单上的那几枚。
     * 换进来一枚新的（顺序变了）形状要跟着走，而不是把某个已经不参与的 id 挂在墙上。
     */
    const rotated = planPanes({ ids: ['e', 'a', 'b', 'c'], box, tree: dragged })
    assert.deepEqual(rotated.live, ['e', 'a', 'b', 'c'], '名单优先：树只借形状，不借人')
    assert.deepEqual(wallLeafIds(rotated.root), ['e', 'a', 'b', 'c'], '铺上墙的叶子按位置认领新名单')
  })

  await it('双击一条缝 = 只把那一刀恢复等分，其余格是用户故意拖出来的', () => {
    const ids = ['a', 'b', 'c', 'd']
    const box = { w: 1372, h: 717 }
    const wide: WallNode = {
      kind: 'split',
      axis: 'y',
      weights: [150, 50],
      children: [
        { kind: 'split', axis: 'x', weights: [130, 70], children: [{ kind: 'leaf', ids: ['a'] }, { kind: 'leaf', ids: ['b'] }] },
        { kind: 'split', axis: 'x', weights: [100, 100], children: [{ kind: 'leaf', ids: ['c'] }, { kind: 'leaf', ids: ['d'] }] },
      ],
    }
    const before = planPanes({ ids, box, tree: wide })
    const rowSeam = before.layout.seams.find((s) => s.axis === 'y')!
    assert.ok(rowSeam, '两行之间有一条横缝')
    // 双击那条横缝：ChatPage 的 seamReset 走的就是 setNodeWeights(…, equalW(n))
    const reset = setNodeWeights(wide, rowSeam.path, equalW(rowSeam.weights.length))
    const after = planPanes({ ids, box, tree: reset })
    const [r0, r1] = after.layout.cells
    assert.ok(r0 && r1)
    assert.ok(Math.abs(r0.h - r1.h) < 2, '那一刀回到等分：两行一样高')
    assert.ok(cellOf(after.layout, 'a').w > cellOf(after.layout, 'b').w * 1.5, '顶行那两格的宽窄是用户拖出来的，不许被顺手抹平')
  })

  await it('等分摆法照旧按墙宽开列：没有树时与改动前同一口径', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const box = { w: 1372, h: 717 }
    const plain = planPanes({ ids, box })
    assert.deepEqual([shapeOf(plain).cols, shapeOf(plain).rows, plain.live.length], [3, 2, 6], '没有树的比例时按墙宽开三列，六枚上墙')
    assert.equal(plain.cap, 6, 'cap 说的还是墙（3×2 摆得下 6 枚）')
    assert.equal(plain.rest.length, 2, '摆不下的退回标签条')
  })

  await it('没摆满时那句要说清代价：标签条那句不许拿 live 与 cap 比大小冒充全挂', () => {
    const page = readSrc('src/renderer/components/ChatPage.tsx')
    assert.match(page, /wall\.rest\.length > 0/, '先问「还有候补吗」，不许拿 live 与 cap 比大小冒充全挂上')
    assert.match(page, /点标签换进墙里/, '有候补时说清点下去会发生什么')
    assert.match(page, /\{stripTail\}/, '那句话真的落在标签条上')
    assert.match(page, /wall\.live\.length >= wall\.cap \? '（最后一格让位）'/, '摆满时点标签是换进来，不是追加')
  })

  await it('缝落在界面上：格子与缝都照 layoutWall 的矩形绝对定位', () => {
    const page = readSrc('src/renderer/components/ChatPage.tsx')
    const seam = readSrc('src/renderer/components/WallSeam.tsx')
    const css = readSrc('src/renderer/styles.css')
    assert.match(page, /wall\.layout\.cells\.map\(\(cell\) =>/, '格子由切分树铺出来的矩形驱动，不在 JSX 里现算')
    assert.match(page, /left: cell\.x,\n\s*top: cell\.y,\n\s*width: cell\.w,\n\s*height: cell\.h,/, '一格一个盒子，矩形写在 style 里')
    assert.match(page, /wall\.layout\.seams\.map\(\(s\) =>/, '缝同样由树铺出来：一条缝 = 一个节点的边界段')
    assert.match(page, /<WallSeam\n\s*key=\{s\.key\}\n\s*seam=\{s\}/, '把手真的接进了墙上，且带自己那段矩形的身份')
    assert.match(page, /data-wall-index=\{k\}/, '格子带着自己的排位：松手时照着它认「落在哪一格」')
    assert.match(page, /className=\{`cx-cell/, '格子类名不变：窗格收缩那套规则照旧')
    assert.match(css, /\.cx-wall \{[\s\S]{0,600}position: relative/, '墙是定位上下文：格子按它的左上角摆')
    assert.match(css, /\.cx-wall > \.cx-cell \{ position: absolute/, '格子绝对定位 —— 共享轨道一退场，单格才可能独立')
    assert.match(css, /\.cx-wall-seam \{\n\s*\*?[^\n]*\n?\s*position: absolute/, '缝也绝对定位：它只覆盖自己那一段边界')
    assert.match(css, /\.cx-wall-seam\.seam-col \{/, '缝的命中带与光标真的存在')
    assert.match(css, /\.cx-wall > \.cx-cell > \.webview-dock/, '格子里的窗格仍要能收缩')
    assert.match(page, /拖开后最窄一格/, '拖开过之后那句提示要报真实最窄格，不能继续念等分口径')
    /*
     * 那句话的后半也要跟着改口。旧的「拖破就少挂一枚」是这一轮要撤销的口径：
     * 它把一次能自救的拖拽说成了拆墙，而实测里它给出的正是「点别的加不回来」。
     */
    assert.doesNotMatch(page, /拖破就少挂一枚/, '拖不再能拖破地板档，这句旧口径得退场')
    assert.match(page, /缝拖到这一格剩地板档就停手/, '提示要说清拖到哪儿停，而不是吓用户少挂一枚')
    /*
     * 墙头那句常驻总说明（停手 + 退路 + 独占走放大）删了：它常年占着一行，
     * 同样的指引就在缝把手自己的 tooltip 里（见下方 seam 断言），不必再挂一面横幅。
     */
    assert.doesNotMatch(page, /最窄拖到地板档就停手，双击恢复等分/, '墙头不再常驻那句总说明')
    assert.doesNotMatch(page, /回答留在各家自己的页面上/, '墙头不再常驻「不提取正文」那句')
    /*
     * 地板档由渲染层传给缝：把手自己不该再揣一个更小的数。
     */
    assert.match(seam, /const floorOf = \(axis: SeamAxis\): number => \(axis === 'x' \? FLOOR_PANE\.w : FLOOR_PANE\.h\)/, '两轴各自的地板档由 chatWall 给')
    assert.equal((seam.match(/floorOf\(axis\)/g) || []).length, 2, '竖缝横缝都夹在地板档上')
    assert.match(seam, /最窄拖到地板档就停手/, '把手自己的 tooltip 也给出口')
    assert.match(seam, /其余格一像素不动/, '把手的 tooltip 要说清这次拖动的影响范围')
    /*
     * 模板字符串里漏一个 $ 是不报错的：tooltip 会把 `{wall.live.length}` 原样念出来。
     * 这一条曾经真的漏过三处，所以钉在这句原文上，而不是靠一个扫全文件的形式判据 ——
     * 扫全篇的正则分不清「在模板串里」和「在两个模板串之间的那段 JSX」。
     */
    assert.match(
      page,
      /墙上这 \$\{wall\.live\.length\} 格里有低于舒适档 \$\{COMFY_PANE\.w\}×\$\{COMFY_PANE\.h\} 的，但仍在地板档 \$\{FLOOR_PANE\.w\}×\$\{FLOOR_PANE\.h\} 之上/,
      '舒适档那颗徽章的 tooltip 数字要真被插进去，不能念出大括号',
    )
    assert.doesNotMatch(css, /pane-cols-/, '列数改由切分树决定，那四条等分规则必须一起退场')
    assert.doesNotMatch(page, /pane-cols-/, '渲染层也不再拼那个类名')
    // 旧的共享轨道那套（栅格模板 + 交错轨）必须整套退场，留着就是两套形状判断打架
    assert.doesNotMatch(page, /wallTracks|trackIndex|gridTemplateColumns/, '轨道拼接与奇偶轨落位不再存在')
  })

  await it('树存的是比例，跨重启还在（主进程那条闸门认得对象）', () => {
    const layout = readSrc('src/renderer/layout.ts')
    const preload = readSrc('src/preload/index.ts')
    const main = readSrc('src/main/index.ts')
    assert.match(layout, /export function useStoredWallTree/, '渲染层有切分树的读写口')
    assert.match(layout, /const tree = treeOf\(v as \{ root: WallNode \}\)/, '冷启动加载时树也要认，否则拖出来的形状重启就忘')
    assert.match(preload, /value: number \| number\[\] \| string\[\] \| WallLayout \| null/, '通道多认一种：切分树')
    assert.match(main, /sanitizeWallLayout\(o\.value\)/, '主进程为树单开一条判据')
    /*
     * 树不能套那条 120~4000 的像素闸门：Number({root:…}) 是 NaN，会被判成
     * 「尺寸超出可用范围」整份拒掉，症状是「拖得动、重启就没了」，最难查。
     */
    const obj = main.indexOf("typeof o.value === 'object'")
    const px = main.indexOf('const px = Number(o.value)')
    assert.ok(obj > 0 && px > obj, '先认树、再走像素闸门：顺序反了树就被像素判据吃掉')
    assert.match(main, /窗格形状不合法/, '拒的时候要给出理由，别静默丢掉')
  })

  await it('树的校验只有一份：主进程、渲染层、手改的偏好文件走同一个判据', () => {
    const ok = sanitizeWallLayout({
      kind: 'split',
      axis: 'x',
      weights: [130, 70],
      children: [
        { kind: 'leaf', ids: ['a'] },
        { kind: 'leaf', ids: ['b'] },
      ],
    })
    assert.ok(ok, '合法的树要收下来')
    assert.deepEqual(wallLeafIds(ok!.root), ['a', 'b'])
    /*
     * 下面每一种都必须整份作废而不是「修修看」：半吊子的树会画出一个谁都没拖过的形状，
     * 比回到等分更难解释。判据与渲染层共用同一份，所以不会出现「主进程收下了、
     * 重启后渲染层不认」那种「改得动、重启就没了」。
     */
    const bad: unknown[] = [
      null,
      {},
      { root: { kind: 'mystery' } },
      // 权重长度 ≠ 子格数
      { root: { kind: 'split', axis: 'x', weights: [100], children: [{ kind: 'leaf', ids: ['a'] }, { kind: 'leaf', ids: ['b'] }] } },
      // 重复的 id：两格挂同一家站点，两个贴合循环对着同一个视图抢矩形
      { root: { kind: 'split', axis: 'x', weights: [100, 100], children: [{ kind: 'leaf', ids: ['a'] }, { kind: 'leaf', ids: ['a'] }] } },
      // 越界的权重
      { root: { kind: 'split', axis: 'x', weights: [100, 900], children: [{ kind: 'leaf', ids: ['a'] }, { kind: 'leaf', ids: ['b'] }] } },
      // 单孩子的切分节点是纯噪声
      { root: { kind: 'split', axis: 'x', weights: [100], children: [{ kind: 'leaf', ids: ['a'] }] } },
      // 轴不认识
      { root: { kind: 'split', axis: 'z', weights: [100, 100], children: [{ kind: 'leaf', ids: ['a'] }, { kind: 'leaf', ids: ['b'] }] } },
    ]
    for (const v of bad) assert.equal(sanitizeWallLayout(v), null, `应当拒掉：${JSON.stringify(v)}`)
  })

  await it('旧那两把权重键退场：没人读的死值不许留在偏好文件里', () => {
    const main = readSrc('src/main/index.ts')
    /*
     * 上一版把每轴一组权重存成 wall.colw / wall.roww。切分树表达得了那套形状，
     * 于是这两把键成了谁也不再读的死值 —— 留着的话，用户打开偏好文件看到它，
     * 会以为自己的宽窄还在（其实早就被等分冲掉了）。
     * 读的时候就不给，写新的树时顺手删掉。
     */
    const get = main.slice(main.indexOf("ipcMain.handle('layout:get'"), main.indexOf("ipcMain.handle('layout:set'"))
    assert.match(get, /delete next\['wall\.colw'\]|delete rest\['wall\.colw'\]|'wall\.colw': _/, '读的时候要把旧键剔掉')
    assert.match(get, /wall\.roww/, '两把都要剔')
    const set = main.slice(main.indexOf("ipcMain.handle('layout:set'"), main.indexOf("ipcMain.handle('theme:get'"))
    assert.match(set, /delete out\['wall\.colw'\]\n\s*delete out\['wall\.roww'\]/, '写新树时顺手把旧键删掉')
    // 渲染层不再有那两把键的读写口
    const layout = readSrc('src/renderer/layout.ts')
    assert.doesNotMatch(layout, /useStoredWeights/, '每轴一组权重的读写口已经没人用，退场')
    assert.doesNotMatch(readSrc('src/renderer/components/ChatPage.tsx'), /wall\.colw|wall\.roww/, '渲染层不再提那两把键')
  })

  await it('「谁在第几格」那份名单也退场：树自带每格是谁，名单是死值', () => {
    const main = readSrc('src/main/index.ts')
    const page = readSrc('src/renderer/components/ChatPage.tsx')
    /*
     * 上一版把「哪一格装谁」存成一份 id 数组（wall.order），换位置就改它。
     * 现在切分树的叶子自带 id —— 换位置、折叠、拆出全是改那棵树，
     * 于是名单那份没人读了。留着它比留着权重键更误导：
     * 用户在偏好文件里看到一份「换过的顺序」，会以为重启后位置还在。
     */
    const get = main.slice(main.indexOf("ipcMain.handle('layout:get'"), main.indexOf("ipcMain.handle('layout:set'"))
    assert.match(get, /'wall\.order': _/, '读的时候要把名单剔掉')
    const set = main.slice(main.indexOf("ipcMain.handle('layout:set'"), main.indexOf("ipcMain.handle('theme:get'"))
    assert.match(set, /delete out\['wall\.order'\]/, '写任何一格布局时顺手把名单删掉')
    assert.doesNotMatch(page, /wall\.order/, '渲染层不再提这份名单')
    assert.doesNotMatch(page, /useStoredOrder/, '渲染层不再读它')
  })

  await it('两格对调：只动这两格的内容，矩形与其余格一概不变', () => {
    /*
     * 对调的是「哪一格装哪几页」，不是「哪一格多宽」。
     * 所以两格的矩形必须原样留着（用户拖出来的宽窄不该因为搬家而变），
     * 而其余格更不该被牵动 —— 这条从旧的「名单对调」搬过来，判据更硬：
     * 现在连位置都不必借名单去推断，直接看树。
     */
    const box = { w: 1770, h: 723 }
    const p = planPanes({ ids: ['a', 'b', 'c', 'd'], box })
    const [c0, c1, c2] = p.layout.cells
    assert.ok(c0 && c1 && c2, '夹具本身：至少三格')
    const swapped = swapCells(p.root, c0.path, c1.path)
    const after = layoutWall(swapped, box)
    const a0 = cellOf(after, c1.id)
    const a1 = cellOf(after, c0.id)
    assert.ok(Math.abs(a0.x - c0.x) < 0.01 && Math.abs(a0.w - c0.w) < 0.01, '搬过来的那一页占的还是原来那一格的矩形')
    assert.ok(Math.abs(a1.x - c1.x) < 0.01 && Math.abs(a1.w - c1.w) < 0.01, '另一页同理：对调换内容不换地方')
    const same = cellOf(after, c2.id)
    assert.deepEqual([same.x, same.y, same.w, same.h], [c2.x, c2.y, c2.w, c2.h], '第三格没参与，一像素不动')
    /*
     * 自己跟自己对调、路径越界都不该改坏树：松手落在缝上、落在自己那一格上，
     * 这些情况每次都发生，报错或改坏都比「什么都没发生」糟。
     */
    assert.deepEqual(swapCells(p.root, c0.path, c0.path), p.root, '同一格 = 不动')
    assert.deepEqual(swapCells(p.root, [9], c0.path), p.root, '路径不存在 = 不动')
  })

  await it('折叠成一叠：两格并成一组，露着的还是原来那页', () => {
    const box = { w: 1770, h: 723 }
    const p = planPanes({ ids: ['a', 'b', 'c'], box })
    const [ca, cb] = p.layout.cells
    const folded = foldInto(p.root, ca.path, cb.path)
    assert.equal(treeCellCount(folded), 2, '三格折成两格：源格整个消失')
    assert.deepEqual(wallLeafIds(folded), ['b', 'a', 'c'], '折进来的接在后面，目标那格露着的仍是它自己')
    const laid = layoutWall(folded, box)
    assert.equal(laid.cells.length, 2, '墙上的格子也只剩两格')
    const group = laid.cells.find((x) => x.pages.length > 1)
    assert.ok(group, '有一格是折起来的一叠')
    assert.deepEqual(group!.pages, ['b', 'a'], '这一叠的次序：露着的在前')
    /*
     * 折不进去的几种情形都得原样返回，而不是把树改坏：
     * 祖孙关系（折进去会自噬）与「已经是一叠了」是最容易撞上的两种。
     */
    const parent = laid.cells[0]!.path.slice(0, 1)
    assert.deepEqual(foldInto(folded, parent, laid.cells[0]!.path), folded, '把整折到自己身上 = 不动')
    assert.deepEqual(foldInto(folded, laid.cells[0]!.path, laid.cells[0]!.path), folded, '同一格 = 不动')
  })

  await it('切到折叠里的另一页：只换露着谁，页面次序跟着挪到队首', () => {
    const box = { w: 1770, h: 723 }
    const p = planPanes({ ids: ['a', 'b', 'c'], box })
    const [ca, cb] = p.layout.cells
    const folded = foldInto(p.root, ca.path, cb.path)
    const laid = layoutWall(folded, box)
    const group = laid.cells.find((x) => x.pages.length > 1)!
    assert.equal(group.id, 'b', '夹具本身：露着的是 b')
    const picked = setActiveTab(folded, group.path, 'a')
    const after = layoutWall(picked, box)
    const g2 = after.cells.find((x) => x.pages.length > 1)!
    assert.equal(g2.id, 'a', '点一下标签，露着的换成 a')
    assert.deepEqual(g2.pages, ['a', 'b'], '折叠的次序也换了：a 在前')
    assert.deepEqual(
      [g2.x, g2.y, g2.w, g2.h],
      [group.x, group.y, group.w, group.h],
      '切页不改几何：这一格还是那一格，宽高一分没动',
    )
    assert.deepEqual(setActiveTab(folded, group.path, 'zzz'), folded, '切到不在这一叠里的页 = 不动')
  })

  await it('把一页拆出去自己占一格：落在原格正下方，不飞到墙尾', () => {
    const box = { w: 1770, h: 723 }
    const p = planPanes({ ids: ['a', 'b', 'c'], box })
    const [ca, cb] = p.layout.cells
    const folded = foldInto(p.root, ca.path, cb.path)
    const laid = layoutWall(folded, box)
    const group = laid.cells.find((x) => x.pages.length > 1)!
    const split = splitLeafOut(folded, group.path, 'a')
    assert.equal(treeCellCount(split), 3, '拆出来之后又是三格')
    const after = layoutWall(split, box)
    const out = cellOf(after, 'a')
    const kept = cellOf(after, 'b')
    assert.ok(out.y > kept.y, '拆出来的那一格在原格**下方**：用户松手的地方附近')
    assert.ok(Math.abs(out.x - kept.x) < 1 && Math.abs(out.w - kept.w) < 1, '同一列里，宽度跟着原格')
    assert.deepEqual(kept.pages, ['b'], '原格只剩它自己那一页')
    /*
     * 露着的那一页也可以被拆出去 —— 但这时原格要接着露另一页，
     * 否则画面上露着的还是一张「已经不在这一格」的页面（画面与标签条对不上）。
     */
    const swapped = splitLeafOut(folded, group.path, 'b')
    const afterSwap = layoutWall(swapped, box)
    const g3 = afterSwap.cells.find((x) => x.id === 'a')
    assert.ok(g3, '拆走 b 之后 a 还在墙上')
    assert.deepEqual(g3!.pages, ['a'], '原格只剩 a 那一页')
    assert.equal(afterSwap.cells.find((x) => x.id === 'b')?.id, 'b', 'b 独占一格')
    assert.deepEqual(splitLeafOut(folded, group.path, 'zzz'), folded, '拆一个不在这叠里的页 = 不动')
  })

  await it('把一页挪进另一格：源格摘空就消失，没摘空就继续当一格', () => {
    const box = { w: 1770, h: 723 }
    const p = planPanes({ ids: ['a', 'b', 'c'], box })
    const [ca, cb, cc] = p.layout.cells
    // 先折一次：a 进 b → 一格 [b,a]，另一格 c
    const folded = foldInto(p.root, ca.path, cb.path)
    const laid = layoutWall(folded, box)
    const group = laid.cells.find((x) => x.pages.length > 1)!
    const alone = laid.cells.find((x) => x.pages.length === 1)!
    // 把 a 从折叠格里挪到 c 那一格：源格还剩 b，于是两格都还在
    const moved = movePageInto(folded, group.path, 'a', alone.path)
    assert.deepEqual(wallLeafIds(moved), ['b', 'c', 'a'], 'a 从折叠组搬到 c 那一格后面')
    assert.equal(treeCellCount(moved), 2, '两格都还在：源格没被摘空')
    /*
     * 反过来，把源格最后一页挪走时源格必须整格消失 ——
     * 留一个「零页的格子」在墙上，画出来就是一块谁也看不见的空白，
     * 而它的缝还在，用户会拖到一条没有格子的缝。
     */
    const emptied = movePageInto(moved, alone.path, 'c', group.path)
    assert.equal(treeCellCount(emptied), 2, 'c 那一格被挪空了，整格消失')
    assert.ok(!wallLeafIds(emptied).includes('x'), '名单里不许留下幽灵')
  })

  await it('折叠省出的空位要补上人：折起来是省地方，不是把谁踢下墙', () => {
    /*
     * 这一条是 Obsidian 那套手势在「容量」上的落点。用户把两页折成一格，
     * 墙上就空出一格 —— 空位若不补上候补页面，他看到的就是
     * 「我折起来一叠，另一枚却还躺在标签条里」，省地方的意义当场没了。
     */
    const box = { w: 1770, h: 723 }
    const ids = ['a', 'b', 'c', 'd', 'e']
    const p = planPanes({ ids, box, cap: 4 })
    assert.deepEqual(p.live, ['a', 'b', 'c', 'd'], '夹具本身：e 在标签条里')
    const [ca, cb] = p.layout.cells
    const folded = foldInto(p.root, ca.path, cb.path)
    const after = planPanes({ ids, box, cap: 4, tree: folded })
    assert.ok(after.live.includes('e'), '折起来腾出的那一格，由 e 补上')
    assert.equal(treePages(after.root), 5, '一页都没少：折起来的是页数不变、格子数变少')
    assert.equal(after.layout.cells.length, 4, '墙上的格子数仍受容量约束')
  })

  await it('id 数组这一路退场：主进程仍分家判，但渲染层不再写它', () => {
    const layout = readSrc('src/renderer/layout.ts')
    const preload = readSrc('src/preload/index.ts')
    const main = readSrc('src/main/index.ts')
    /*
     * 切分树的叶子自带 id，「谁在第几格」那份名单（wall.order）没人读了，
     * 渲染层于是不再有 id 数组的读写口。留着它只会让人以为还能改那份名单。
     */
    assert.doesNotMatch(layout, /export function useStoredOrder/, '渲染层的 id 数组读写口退场')
    assert.doesNotMatch(layout, /strArrayOf/, '冷启动也不再认这一种')
    assert.match(preload, /layoutGet: \(\): Promise<Record<string, number \| number\[\] \| string\[\] \| WallLayout>>/, '读回来承认这四种')

    /*
     * 主进程那边的判据留着（它认得这一种形状，不认就等于把别人的偏好文件判非法），
     * 但数组必须先分家再判：把 ['kimi','deepseek'] 丢进 Number() 会得到 NaN，
     * 于是走权重那条判据被整条拒掉 —— 症状是「拖得动、重启就没了」。
     */
    const str = main.indexOf("raw.every((x) => typeof x === 'string')")
    const num = main.indexOf('const nums = raw.map')
    assert.ok(str > 0 && num > str, '先认 id 数组、再认权重数组：顺序反过来就两败俱伤')
    assert.match(main, /ids\.length > 12/, '上限跟着参与者规模，不照抄权重的 8')
    assert.match(main, /s\.length === 0 \|\| s\.length > 64/, '空串与超长 id 拒掉')
    assert.match(main, /new Set\(ids\)\.size !== ids\.length/, '重复 id 拒掉：两份同一个 id 会让 planPanes 少摆一枚')
  })

  await it('拖窗格交换位置：起手先把原生视图摘走，松手才换得到', () => {
    const page = readSrc('src/renderer/components/ChatPage.tsx')
    const dock = readSrc('src/renderer/components/WebviewDock.tsx')
    const css = readSrc('src/renderer/styles.css')

    /*
     * 手势只能从窗格头部起手，且只有一只把手：格子里那一大片是原生视图，
     * 画在渲染层之上，指针一进去就归站点 —— 与「缝要占一条自己的轨道」同一个原因。
     */
    assert.match(dock, /className="wdh-grip"/, '把手画在头部里，不是整格可拖')
    assert.match(dock, /onPointerDown=\{onSwapGrip\}/, '把手真的接上了手势')
    assert.match(page, /onSwapGrip=\{wall\.layout\.cells\.length > 1 \? \(e\) => swapDown\(k, e\)/, '只剩一格时不给把手')
    assert.match(css, /\.wdh-grip \{[\s\S]{0,240}cursor: grab/, '把手得看着能拖')
    assert.match(css, /\.wdh-grip \{[\s\S]{0,240}touch-action: none/, '触摸板上起手不许先变成滚动')

    // 没越过阈值的那一下是普通点击：头部那颗放大按钮还得照常工作
    assert.match(page, /if \(e\.button !== 0 \|\| expandedPane\) return/, '右键与独占态不进手势')
    assert.match(page, /if \(Math\.hypot\(ev\.clientX - x0, ev\.clientY - y0\) < SWAP_SLOP_PX\) return/, '起手先走一小段阈值')

    /*
     * 越过阈值第一件事是把墙上所有视图摘回离屏宿主：摘掉之后整格才又是 DOM，
     * 「松手落在哪一格」才量得到。摘的同时得按住贴合循环 ——
     * 一边摘一边每帧贴回去，屏幕上就是一闪一闪。
     */
    assert.match(dock, /if \(holdRef\.current\) \{[\s\S]{0,240}return\n\s*\}/, '让位期间这一帧直接结束，不再 present')
    assert.match(dock, /sent !== 'hold'/, '只摘一次：每帧都发 dismiss 等于对着主进程刷噪声')
    assert.match(dock, /if \(!swapHold\) requeueRef\.current\?\.\(\)/, '松手作废矩形缓存，下一帧照当下尺寸贴回来')
    assert.match(page, /swapHold=\{!!paneSwap\}/, '每一格一起让位，整面墙才都是 DOM')
    assert.match(dock, /className="wd-empty swap-veil"/, '空着的那格要说话：只是暂时让位，不是页面没了')
    assert.match(css, /\.webview-dock\.swap-hold \.webview-dock-body/, '让位期间的底色真的写了规则')
    assert.match(css, /body\.wall-swapping \.cx-wall-seam \{ pointer-events: none/, '拖动期间缝让开命中：它只有 7px，压在上面松手不该什么都不换')

    // 命中不到具体格子 ≠ 不在墙上；出了墙界一律算取消
    assert.match(page, /querySelectorAll\('\[data-wall-index\]'\)/, '按格子矩形兜底命中')
    assert.match(page, /grid\.left \|\| x > grid\.right \|\| y < grid\.top/, '出了墙界不算命中任何一格')
    assert.match(page, /setTreeStored\(swapCells\(wall\.root, a\.path, b\.path\)\)/, '换的是树里那两格的内容')
    assert.match(page, /已交换「\$\{paneName\(a\.id\)\}」与「\$\{paneName\(b\.id\)\}」所在格的位置/, '换完说清是哪两格，并且要说「已」')
    assert.doesNotMatch(page, /要换位置就按住窗格头部拖到另一格上/, '换位指引不再靠墙头横幅常驻')

    /*
     * 三条退出路都得把视图还回来：Escape、窗口失焦、pointercancel。
     * 少摘一个监听更糟 —— 下一次拖动会多一套幽灵监听，同一帧 setPaneSwap 两次。
     */
    for (const ev of ['pointermove', 'pointerup', 'pointercancel', 'keydown', 'blur']) {
      assert.match(page, new RegExp(`window\\.addEventListener\\('${ev}'`), `拖动要听 ${ev}`)
      assert.match(page, new RegExp(`window\\.removeEventListener\\('${ev}'`), `${ev} 的监听得摘干净`)
    }
    assert.match(page, /if \(ev\.key === 'Escape'\) done\(false\)/, 'Escape 取消')
    assert.match(page, /const cancel = \(\): void => done\(false\)/, '失焦与 pointercancel 走同一条取消')
    assert.match(page, /setPaneSwap\(null\)\n\s*if \(!ok \|\| !live\) return/, '先把格子交还给贴合循环，再决定换不换')
  })

  await it('落点分头与体：头=折成一叠，体=与它换位（Obsidian 那套手势）', () => {
    const page = readSrc('src/renderer/components/ChatPage.tsx')
    const dock = readSrc('src/renderer/components/WebviewDock.tsx')

    /*
     * 两种手势落在同一个矩形里，用户分不出意图 —— 所以按「落在哪一段」分：
     * 头部（那一格的标题条）= 并进去，主体（原生视图那一大片）= 与它换位。
     * 头与体分开的判据在 hitCell 里，它量的是目标格头部的矩形。
     */
    assert.match(page, /const hitCell = \(x: number, y: number\): \{ index: number \| null; zone: 'head' \| 'body' \| null \}/, '命中要带上落在哪一段')
    assert.match(page, /querySelector\('\.webview-dock-head'\)/, '头部这一段靠头条的矩形认')
    assert.match(page, /const inHead = !!hr && y >= hr\.top && y <= hr\.bottom/, '落在头条矩形内才算是头部')
    assert.match(page, /return \{ index: i, zone: inHead \? 'head' : 'body' \}/, '头部与主体分两种落点')

    /*
     * 两条分支各自改树：头部走 foldInto（两格合成一叠），主体走 swapCells（换位）。
     * 写反了症状是「拖到标签上却把两格位置换了」，用户完全看不懂。
     */
    assert.match(page, /if \(to\.zone === 'head'\) \{\n\s*setTreeStored\(foldInto\(wall\.root, a\.path, b\.path\)\)/, '落在头部 = 折进那一格')
    assert.match(page, /setTreeStored\(swapCells\(wall\.root, a\.path, b\.path\)\)/, '落在主体 = 与那一格换位')

    /*
     * 拖某一页（折叠标签）是另一套落点：落别格 = 折进去，落到墙外 = 拆出去自己一格。
     */
    assert.match(page, /setTreeStored\(movePageInto\(wall\.root, src\.path, pageId, dst\.path\)\)/, '拖一页落别格 = 折进那一格')
    assert.match(page, /setTreeStored\(splitLeafOut\(wall\.root, src\.path, pageId\)\)/, '拖一页落墙外 = 拆出去自己一格')

    /*
     * 折叠标签同时挂着 click（切页）与 pointerdown（起手拖）。
     * 浏览器在 pointerup 之后还会补一发 click —— 不吃掉它的话，
     * 「把这一页折进别格」的同一下手势会在松手后又把它切成露着的那页，折叠被自己撤销。
     */
    assert.match(dock, /onClick=\{\(\) => onPaneTabPick\?\.\(t\.id\)\}/, '标签点一下是切页')
    assert.match(dock, /onPointerDown=\{\(e\) => onPaneTabGrip\?\.\(t\.id, e\)\}/, '标签按住能拖')
    assert.match(page, /if \(dragTabRef\.current === pageId\) \{[\s\S]{0,160}return\n\s*\}/, '刚拖过的那一枚，紧跟的 click 不许再切页')
    assert.match(page, /if \(pageId\) dragTabRef\.current = pageId/, '拖的是某一页才记这笔；拖整格不记')
  })

  await it('显式 cap 仍能压过尺寸（测试与「整面墙收起」那两路用得上）', () => {
    const p = planPanes({ ids: ['a', 'b', 'c'], box: { w: 1770, h: 723 }, cap: 1 })
    assert.deepEqual(p.live, ['a'])
    assert.deepEqual(p.rest, ['b', 'c'])
    assert.equal(p.layout.cells.length, 1, '被压成一格时墙上就只铺一格')
    /*
     * tier 必须按「实际挂了几枚、占几列」算。900×700 的墙摆 2×2 时那一格 450×350 确实挤，
     * 但被显式 cap 压成一整格后它是 900×700 —— 照抄前一句就是对着一条大格喊「低于舒适档」。
     */
    const squeezed = planPanes({ ids: ['a', 'b', 'c', 'd'], box: { w: 900, h: 700 } })
    assert.deepEqual([shapeOf(squeezed).cols, shapeOf(squeezed).rows, squeezed.tier], [2, 2, 1], '2×2 摆满：450×350 确实低于舒适档')
    const alone = planPanes({ ids: ['a', 'b', 'c', 'd'], box: { w: 900, h: 700 }, cap: 1 })
    assert.deepEqual([shapeOf(alone).cols, shapeOf(alone).rows, alone.tier], [1, 1, 0], '同一堵墙压成一整格：900×700 不挤')
    assert.ok(cellOf(alone.layout, 'a').w > 890, '那一格真的吃满整墙')
  })

  await it('放大那一枚时只铺一格，尺寸只管未放大时的格数', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const p = planPanes({ ids, box: { w: 1770, h: 723 }, expanded: 'b' })
    assert.deepEqual(p.live, ['b'])
    assert.equal(p.layout.cells.length, 1, '独占那一格是一格，不是未放大时的那 4×2')
    assert.deepEqual([cellOf(p.layout, 'b').w, cellOf(p.layout, 'b').h], [1770, 723], '那一枚吃满整墙')
    assert.equal(p.cap, 8, 'cap 仍是这一屏摆得下的格数（4×2）：放大只是临时的，还原后又回到 4×2 那种摆法')
    assert.equal(p.rest.length, 6)
    assert.equal(p.tier, 0, '1770×723 的一整格又宽又高，不许把未放大时那句「挤了一档」搬到放大态上')
    const tight = planPanes({ ids: ['a', 'b', 'c', 'd'], box: { w: 500, h: 700 }, expanded: 'a' })
    assert.equal(tight.tier, 1, '墙本来就只有 500 宽：放大到一整格仍然不到 560，这句要照实说')
  })

  console.log('\n=== 适配器：只配投递也要合格 ===')

  await it('去掉 stream 与 completion 也合格（原生模式只需要输入框）', () => {
    const r = validateSpec(baseSpec({ selectors: { input: 'textarea.i', send: 'button.s' }, completion: undefined }))
    assert.ok(r.ok, r.ok ? '' : r.errors.join('; '))
    /*
     * 读侧到处是 spec.completion.mode / .stable_ms。校验器在这里一次性补上保守默认，
     * 比让每个消费者都判一次 undefined 更不容易漏 —— 漏掉的那处是运行时 TypeError。
     */
    assert.equal(r.ok ? r.spec.completion?.mode : '', 'dom_stable', '缺省的 completion 没有被补上默认')
  })

  await it('配了 completion 却没给 stream：判不合格（没有容器就没有可读的东西）', () => {
    const r = validateSpec(baseSpec({ selectors: { input: 'textarea.i', send: 'button.s' } }))
    assert.equal(r.ok, false)
    assert.ok(!r.ok && r.errors.some((e) => e.includes('stream')), !r.ok ? r.errors.join('; ') : '')
  })

  await it('配了 stream 却没给 completion：判不合格（静默降级会读回半截答案）', () => {
    const r = validateSpec(baseSpec({ completion: undefined }))
    assert.equal(r.ok, false)
    assert.ok(!r.ok && r.errors.some((e) => e.includes('completion')), !r.ok ? r.errors.join('; ') : '')
  })

  await it('输入框仍然必填：没有它两条链路都投递不出去', () => {
    const r = validateSpec(baseSpec({ selectors: { stream: '.out' } }))
    assert.equal(r.ok, false)
    assert.ok(!r.ok && r.errors.some((e) => e.includes('selectors.input')), !r.ok ? r.errors.join('; ') : '')
  })

  await it('七份内置适配器在放宽后的口径下依然全部合格', () => {
    const dir = path.join(ROOT, 'adapters')
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'))
    assert.equal(files.length, 7, `内置适配器应 7 份，实际 ${files.length}`)
    const bad: string[] = []
    for (const f of files) {
      const raw = YAML.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as Record<string, unknown>
      const r = validateSpec(raw)
      if (!r.ok) bad.push(`${f}: ${r.errors.join('; ')}`)
    }
    assert.deepEqual(bad, [])
  })

  console.log('\n── 接线层：主进程按 webMode 分叉')

  await it('chat:send 认 webMode，缺省仍是提取（旧行为不被悄悄换掉）', () => {
    const src = readSrc('src/main/index.ts')
    assert.match(src, /const webMode = p\.webMode === 'native' \? 'native' : 'extract'/)
  })

  await it('原生分支投完就 continue：不进读流循环，也就没有 max_wait 悬挂', () => {
    const src = readSrc('src/main/index.ts')
    const branch = src.slice(src.indexOf("if (isWeb && webMode === 'native')"), src.indexOf('let streamed ='))
    assert.match(branch, /agent\s*\n?\s*\.deliverNative\(ctx\)/, '原生分支必须调 deliverNative')
    assert.ok(branch.includes("send('chat:delivered'"), '原生的一轮以收据收口')
    assert.match(
      src,
      /if \(isWeb && webMode === 'native'\)[\s\S]*?\n      \}\n      let streamed =/,
      '分叉后必须真的跳过读回那半条链路：原生分支的 continue 后面紧接着的就是提取那段',
    )
    assert.ok(!branch.includes('chat:done'), '原生不该发 chat:done：那条事件承诺的是正文')
  })

  await it('投递段被两条入口共用，API 通道不受 webMode 影响', () => {
    const src = readSrc('src/main/agents/webview-agent.ts')
    assert.match(src, /async deliverNative\(/)
    assert.match(src, /const d = await this\.deliverTurn\(ctx\)/, 'send() 与 deliverNative() 都要经由同一段投递')
    // 只配投递的适配器被拿去提取：必须明确报错，而不是读回一句「未捕获到内容」
    assert.match(src, /if \(!spec\.selectors\.stream\)/)
    assert.match(src, /仅支持原生模式/)
    const api = readSrc('src/main/agents/api-agent.ts')
    assert.ok(!api.includes('deliverNative'), 'API 通道本来就有正文，不该出现原生分支')
  })

  await it('池子的 wall 挂载不摘别人，非 wall 仍保持一次只挂一枚', () => {
    const src = readSrc('src/main/webview/pool.ts')
    // 锚在方法定义那行：present( / dismiss( 在注释里也出现，随便找一处会切出半句话
    const from = src.indexOf('\n  present(')
    const to = src.indexOf('\n  dismiss(')
    assert.ok(from > 0 && to > from, '没锚到 pool 的 present / dismiss 定义')
    const body = src.slice(from, to)
    assert.match(body, /if \(!opts\?\.wall\) \{/, '互斥摘除只在非 wall 那一路')
    assert.match(body, /for \(const other of this\.entries\.values\(\)\)/)
    assert.match(body, /other\.attached/, '摘的是别的已挂载视图，不是自己')
  })

  console.log('\n── 接线层：渲染层默认原生、认得新事件')

  await it('聊天模式默认原生，且开关会持久化', () => {
    const src = readSrc('src/renderer/components/ChatPage.tsx')
    assert.match(src, /localStorage\.getItem\(VIEW_MODE_KEY\) === 'extract' \? 'extract' : 'native'/)
    assert.match(src, /localStorage\.setItem\(VIEW_MODE_KEY, viewMode\)/)
    assert.match(src, /webMode: viewMode/, '发送时要把当前口径带给主进程，否则分叉收不到指令')
  })

  await it('原生墙用 pane 变体多枚并挂，提取模式仍走单窗 dock', () => {
    const src = readSrc('src/renderer/components/ChatPage.tsx')
    assert.match(src, /variant="pane"/)
    assert.match(src, /planPanes\(\{/, '挂哪几枚交给纯函数，不在 JSX 里现算')
    const dock = readSrc('src/renderer/components/WebviewDock.tsx')
    assert.match(dock, /presentWebview\(id, b, wall \? \{ wall: true \} : undefined\)/)
    assert.match(dock, /type DockVariant = 'dock' \| 'pane'/)
    // 只挂一列的窗格不该参与全局放大那套 body class，否则同一面墙互相挤没
    assert.match(dock, /if \(isPane\) return/)
  })

  await it('chat:delivered 有订阅，也进了推送通道白名单', () => {
    const page = readSrc('src/renderer/components/ChatPage.tsx')
    assert.match(page, /window\.torra\.on\('chat:delivered'/)
    assert.match(page, /offDelivered\(\)/, '订阅必须在清理里摘掉，否则热更新后一个事件两个人接')
    const preload = readSrc('src/preload/index.ts')
    assert.match(preload, /^\s*'chat:delivered',/m, 'PUSH_CHANNELS 漏一条是白屏级的')
  })

  await it('原生那轮的卡片装收据，不装「等待回答」', () => {
    const page = readSrc('src/renderer/components/ChatPage.tsx')
    assert.match(page, /\{cell\.native \? '投递中' : '生成中'\}/, '标题上的状态要说这一轮在投递，不是在生成')
    assert.match(page, /cx-ans-native/)
    assert.match(page, /本地不留正文/, '得讲清为什么这张卡片是空的')
  })

  await it('原生视图左栏不给网页模型放卡片，状态与重试另有落点', () => {
    /*
     * 实测踩到的：原生墙挂上来之后，左栏还照旧摆一排提取式卡片 —— 那些格子在原生那一轮
     * 只有收据，切回历史看又是上一场的旧正文。回答明明就在右边那一格里，左栏再复述一遍
     * 等于立第二份真相：站点自己写的那页不会过期，我们从 DOM 里读回来的那半句会。
     * 所以原生视图整列不渲染网页模型的卡片（API 模型照旧），并且隐藏按「当下视图模式」算，
     * 不按「这一轮当初走的哪条链路」算 —— 切到原生连历史正文一起收起，切回提取又全在。
     */
    const page = readSrc('src/renderer/components/ChatPage.tsx')
    assert.match(page, /hideWeb=\{viewMode === 'native'\}/, '调用处要按当下视图模式传下去')
    assert.match(page, /const shown = hideWeb \? order\.filter\(\(id\) => !isWebCell\(id\)\) : order/)
    assert.match(page, /transport === 'webview'/, '过滤按通道，不是按「这一轮是不是原生」—— API 卡片要留下')
    assert.match(page, /\{shown\.length > 0 && \(/, '一格不剩时连网格容器都不放，空栅格就是一块假面板')

    // 卡片没了，「送进去没有」与「再送一次」只能长在参与者徽章和窗格头部
    assert.match(page, /className="cx-chip-state"/, '徽章上要能读出投递状态')
    assert.match(page, /st\.tone === 'error' && active/, '窗格头部只在真出错时给重试')
    assert.match(page, /regenerateCell\(active\.id, st\.turnId, m\.id\)/, '重试要拿得到轮次 id')
  })

  console.log('\n── 原生让屏：整屏给网页，左栏收成轨、输入压成条')

  await it('骨架：顶栏与输入坞住在墙够不着的那一层', () => {
    /*
     * WebContentsView 是主进程贴上去的原生视图，永远画在渲染层之上 ——
     * 压在墙矩形里的 DOM 不是「被遮住」，是根本点不到。所以顶栏和输入坞必须搬到整宽那一层
     * （.cx-body 竖排：顶栏 / 那一行 / 坞），让墙只量中间那行，坞自然落在墙下面。
     * 这条结构一旦退回「坞在 .cx-main 里」，输入框会在原生模式下变成一块死区。
     */
    const page = readSrc('src/renderer/components/ChatPage.tsx')
    const body = page.indexOf('<div className="cx-body">')
    const row = page.indexOf('<div className={`cx-row')
    const dock = page.indexOf('className={`cx-dock')
    assert.ok(body > 0 && row > body && dock > row, '顺序得是 cx-body > cx-row > 输入坞')
    assert.match(
      page.slice(row, dock),
      /\n {8}<\/div>\n\n {8}\{targets\.length > 0 && \(/,
      '输入坞必须是 cx-row 的兄弟：留在 cx-main 里就会被墙盖住',
    )
    const css = readSrc('src/renderer/styles.css')
    assert.match(css, /\.cx-body \{[^}]*flex-direction: column/, '.cx-body 不竖排，墙就量不出让给输入条的那一截')
  })

  await it('窄轨：默认只在「左栏本来就没东西可看」时收起来', () => {
    const page = readSrc('src/renderer/components/ChatPage.tsx')
    assert.ok(
      page.includes("const lean = viewMode === 'native' && (leanPinned ?? apiTargets.length === 0)"),
      '收起口径要能被用户否决（leanPinned），且默认只在没有 API 参与者时收',
    )
    assert.match(page, /const apiTargets = useMemo\(\(\) => targets\.filter\(\(m\) => m\.transport === 'api'\)/, 'API 参与者的回答只有本地卡片这一份，收起来就是把它藏了')
    /*
     * 0 轮也收：旧口径「一轮都没问过时不收」实测是反的 —— 新会话那一整屏介绍占掉近半屏，
     * 而用户此刻要看的是右边那几格网页。让位的对象是网页，所以判据换成「墙会不会出现」。
     */
    assert.match(page, /const leanOn = lean && webTargets\.length > 0/, '有网页可挂就收，0 轮也收')
    assert.doesNotMatch(
      page,
      /const leanOn = lean && \(active\?\.turns\.length \?\? 0\) > 0/,
      '不许退回「问过一轮才收」：那等于把整屏介绍留在新会话里',
    )
    assert.match(page, /const showAnchors = !leanOn &&/, '轨态和轮次锚点互斥，否则右侧那条导航指着一列不存在的卡片')
    assert.match(page, /\{viewMode === 'native' && \(/, '开关只在原生那一侧出现')
    assert.match(page, /onClick=\{\(\) => setLeanPinned\(!leanOn\)\}/)
    /*
     * 收起态下这颗按钮绝不能置灰。实测踩过：写成 disabled={lean} 之后，窄轨一收，
     * 顶栏那个「展开」就成了 disabled —— 唯一的回头路变成点编号，
     * 而用户根本不知道那条轨道是可点的。
     */
    assert.match(page, /disabled=\{lean && !leanOn\}/, '只在「收了也没东西可摆」时置灰')
    assert.doesNotMatch(page, /disabled=\{lean\}/, 'disabled={lean} 会在收起态锁死唯一的展开入口')
    const css = readSrc('src/renderer/styles.css')
    assert.match(css, /\.cx-main\.lean \{[^}]*flex: 0 0 74px/, '收起来的左栏就是一枚编号的宽度')
    /*
     * 布局类挂 leanOn 而不是 lean：没有网页可挂时（墙不出现）让位无从谈起，
     * 那时候连 .lean 一起给，等于把「准备好了，问一个值得比较的问题」那屏介绍压进 74px。
     */
    assert.match(page, /<div className=\{`cx-row\$\{leanOn \? ' lean' : ''\}`\}>/, '空轨态不许把聊天列也收成窄轨')
    assert.match(page, /cx-main\$\{showAnchors \? ' anchors' : ''\}\$\{leanOn \? ' lean' : ''\}/)
    // 墙跟着让位：窄轨态不再沿用量够 2 列就够的 1240px 顶（那会把墙焊死在两列）
    assert.doesNotMatch(
      css,
      /\.cx-row\.lean \.cx-webview\.wall \{[^}]*max-width: min\(1240px/,
      '窄轨态的 1240px 顶会让第三列永远出不来',
    )
  })

  await it('窄轨上那一轮：原文走系统 tooltip，点开先展开再补一次滚动', () => {
    /*
     * 自绘弹层在原生模式下永远输给那一格原生视图 —— 往右探出去的部分会被直接切掉，
     * 所以原文只能用 title 属性。展开之后还要滚过去：轮次流是重新挂载的，
     * 只 setLeanPinned(false) 不滚的话，用户点了 Q3 结果看见的还是 Q1。
     */
    const page = readSrc('src/renderer/components/ChatPage.tsx')
    assert.match(page, /<div className="cx-rail">/)
    assert.match(page, /className=\{`cx-rail-dot/)
    assert.match(page, /title=\{`第 \$\{i \+ 1\} 轮 · \$\{t\.question/, '悬停看原文')
    assert.ok(!/class(?:Name)?="cx-rail-pop/.test(page), '窄轨不该有自绘弹层：它压不过原生视图')
    assert.match(page, /setLeanPinned\(false\)\n\s*pendingScrollRef\.current = t\.id/, '点轨上那一轮 = 展开 + 记下要滚去哪')
    assert.match(page, /if \(!id \|\| leanOn\) return\n\s*pendingScrollRef\.current = null\n\s*scrollToTurn\(id\)/, '等轮次流真的挂出来再滚')
    /*
     * 窄轨态看不见列宽分隔条：墙吃满整屏之后把手拖不动任何东西，
     * 留着它只会让人以为右边那条缝还能拖没（实测就是这么误解的）。
     * 藏法与 zoom 态那条 body.webview-zoom .col-split 一致：display:none，组件留在树上，
     * 收起/展开每次重建把手没有意义 —— 它的双击恢复默认、键盘微调都该跟着这一列本身。
     */
    assert.match(page, /\{\/\* 窄轨态把这条把手藏掉[\s\S]*style=\{leanOn \? \{ display: 'none' \} : undefined\}\n\s*measure=\{\(\) =>/, '收起态的把手要藏起来，但不是摘下来')
    assert.ok(!/\{!leanOn && \(\n\s+<Splitter/.test(page), '不许用条件挂载：切换一次就把把手连它的手感一起重建')
    assert.doesNotMatch(page, /leanOn \? 150 : 420/, '把手一退场，那个为它准备的窄轨上限就是死代码')
    assert.match(page, /\(sessionsRef\.current\?\.offsetWidth \|\| 208\) -\n\s+420,/, '展开态仍给轮次流留 420px')
  })

  await it('底部输入条：收起态那一行由 JS 定高，焦点记在坞上', () => {
    /*
     * textarea 的高度本来就被那段自动长高的 inline 赋值管着，样式表里写任何高度都盖不过它 ——
     * 想让 CSS 单独收起它就得连自动长高一起废掉。所以「一行」还是「面板」交回 JS：
     * 高度在这里定，CSS 只管外观（无边框大阴影、圆角、留白）。
     * 焦点记在坞上而不是输入框上：点附件那颗按钮会让 textarea 先失焦，
     * 只盯 textarea 的条会在用户眼皮底下当场缩回去一次。
     * 还有一条补：点墙上的站点页面时焦点交给了那格原生视图，DOM 里不会有 blur 落进坞，
     * 只能靠 window 失焦收尾 —— 否则输入条一直摊着挡在网页前面。
     */
    const page = readSrc('src/renderer/components/ChatPage.tsx')
    assert.match(page, /const barOpen = viewMode !== 'native' \|\| barFocus \|\| input\.trim\(\)\.length > 0 \|\| pending\.length > 0/)
    assert.match(page, /if \(!barOpen\) \{\n\s*el\.style\.height = '22px'/, '收起态把高度写死，展开态才交回 scrollHeight')
    assert.ok(
      page.includes("`cx-dock${viewMode === 'native' ? ` bar${barOpen ? ' open' : ''}` : ''}`"),
      '细条的 bar 与展开的 open 都只在原生那一侧出现',
    )
    assert.match(page, /onFocus=\{\(\) => setBarFocus\(true\)\}/)
    assert.match(page, /if \(!e\.currentTarget\.contains\(e\.relatedTarget as Node \| null\)\) setBarFocus\(false\)/)
    assert.match(page, /window\.addEventListener\('blur', drop\)/, '原生视图抢焦点时只有 window 会失焦')
    const css = readSrc('src/renderer/styles.css')
    assert.match(css, /\.cx-dock\.bar \{[^}]*box-shadow: none/, '细条不带大阴影：网页是主角')
    assert.match(css, /\.cx-dock\.bar:not\(\.open\) \.cx-input \{[^}]*min-height: 22px/, '样式表和 JS 只能有一套收起口径')
    assert.ok(!css.includes(':not(.has-content)'), 'CSS 里不能再留 :focus-within 那套旧口径，两张皮会互相盖')
  })

  await it('顶栏让得开：多出来的视图开关不能把标题和状态压成叠字', () => {
    /*
     * 实测踩到的：原生墙一开，左列常塌到 400px 上下，顶栏要摆下标题、目标数、
     * 状态胶囊、视图开关、布局开关、图标按钮六样东西。原来只在视口 ≤980px 才折行，
     * 于是 .cx-topbar-id 被压到 36px，nowrap 的 .cx-meta 直接溢出到「会话就绪」身上 ——
     * 截图上就是两行字叠在一起。列宽不等于视口宽度，所以折行不能挂在 @media 上。
     */
    const css = readSrc('src/renderer/styles.css')
    const rule = (sel: string): string => {
      const i = css.indexOf(`\n${sel} {`)
      assert.ok(i >= 0, `找不到 ${sel} 规则`)
      return css.slice(i, css.indexOf('}', i) + 1)
    }
    for (const sel of ['.cx-topbar', '.cx-topbar-id', '.cx-topbar-actions']) {
      assert.match(rule(sel), /flex-wrap: wrap/, `${sel} 不折行，窄列下必然压字`)
    }
    assert.match(rule('.cx-meta'), /overflow: hidden/, '溢出即裁，不再盖到邻居身上')
    // 折下去的那一行只有操作组，推到行尾才和标题右缘对齐
    assert.match(rule('.cx-topbar-actions'), /margin-left: auto/)
    assert.doesNotMatch(css, /@media \(max-width: 980px\)[\s\S]{0,200}\.cx-topbar \{ flex-wrap/, '按视口折行那条是死代码，留着会误导')
  })

  await it('墙给聊天列留位：拖出来的像素宽不会随窗口缩小', () => {
    /*
     * 拖拽存的是 --cx-web-w 的像素值（chat.webview），窗口一缩它不跟着缩。
     * 实测 1024 宽的窗口下，785px 的墙把聊天列压到 165px —— 顶栏六样东西挤成一团，
     * 聊天区等于没了。墙是默认视图，不能让一截固定像素把列宽吃光。
     */
    const css = readSrc('src/renderer/styles.css')
    const i = css.indexOf('\n.cx-webview.wall {')
    assert.ok(i >= 0, '找不到 .cx-webview.wall 规则')
    const body = css.slice(i, css.indexOf('}', css.indexOf('max-width', i)) + 1)
    assert.match(body, /max-width:\s*min\(1240px,\s*calc\(100% - \d+px\)\)/, '墙的上限要同时给聊天列留位')
    const reserved = Number(body.match(/calc\(100% - (\d+)px\)/)?.[1])
    assert.ok(reserved >= 380, `留给聊天列的 ${reserved}px 顶不住顶栏那一排控件`)
  })

  await it('窄轨态墙吃满整屏：收起左栏腾出来的宽度一格都不许剩', () => {
    /*
     * 实测的抱怨是「没展开用户输入的问题时，右边空出了一大部分没用上」。
     * 病根不在 max-width 那一顶，而在 flex 仍是 0 0 <像素宽>：
     * 拖过的像素不随窗口长回来，收起左栏腾出来的那一截就堆在右缘成了死区 ——
     * 而窄轨态收的正是「没有别的东西要看」的左栏，留白比留列更没道理。
     * 只有 grow 起来才对：墙跟着行宽长，宽度买到的还是列数本身。
     */
    const css = readSrc('src/renderer/styles.css')
    const i = css.indexOf('\n.cx-row.lean .cx-webview.wall {')
    assert.ok(i >= 0, '找不到窄轨态那条墙规则')
    const body = css.slice(i, css.indexOf('}', i) + 1)
    assert.match(body, /flex: 1 1 var\(--cx-web-w/, '窄轨态必须让墙长满，光放开 max-width 还是会留死区')
    assert.match(body, /max-width: none/, '窄轨态不留任何上限：那一顶是给能读的聊天列留的')
    assert.doesNotMatch(body, /calc\(100% - \d+px\)/, '再写一条按行宽扣的顶，就是在墙上重新挖一条死区')
    // 文案不能指着一条已经不存在的把手劝用户拖
    const page = readSrc('src/renderer/components/ChatPage.tsx')
    assert.match(page, /leanOn\n\s+\? '，墙已占满这一屏，再要多一格只能先摘一位参与者'/, '满了就说满了')
    assert.match(page, /: '，把墙拖宽或收起左栏还能多挂'/, '展开态还留着拖宽这一条路')
  })

  console.log('\n── 注册')

  await it('注册：npm run test:native-mode 存在且在 npm test 链里', () => {
    const pkg = JSON.parse(readSrc('package.json')) as { scripts: Record<string, string> }
    assert.ok(pkg.scripts['test:native-mode'], '缺少 test:native-mode 脚本')
    assert.match(pkg.scripts.test ?? '', /run-tests\.js/, 'npm test 不该再手写套件名单')
    const runner = readSrc('scripts/run-tests.js')
    assert.match(runner, /startsWith\('test:'\)|keys\(PKG\.scripts\)/, '汇总跑法应从 package.json 取套件清单')
  })

  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`)
  if (fail > 0) process.exitCode = 1
}

void main()
