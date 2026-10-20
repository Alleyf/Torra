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
  planGrid,
  planPanes,
  shiftSeam,
  swapAt,
  trackIndex,
  trackPx,
  wallTracks,
} from '../src/renderer/chatWall'

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
    assert.equal(p.cols, 2)
    assert.equal(planPanes({ ids: ['a'] }).cols, 1, '单格要占满，别留半面空墙')
  })

  await it('放大：只剩那一枚挂载，其余全部退回标签', () => {
    /*
     * 其余窗格不是「藏起来」而是从 DOM 卸载 —— WebviewDock 卸载会 dismiss 掉原生视图，
     * 那几枚的渲染进程要到那一刻才真的还给系统。挂着不放等于放大没省内存。
     */
    const p = planPanes({ ids: ['a', 'b', 'c'], expanded: 'b' })
    assert.deepEqual(p.live, ['b'])
    assert.deepEqual(p.rest, ['a', 'c'])
    assert.equal(p.cols, 1)
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
     */
    const ids = ['a', 'b', 'c', 'd', 'e']
    assert.ok(!planPanes({ ids }).live.includes('e'), '夹具本身：e 起初确实不在墙上')
    const p = planPanes({ ids, promoted: ['e'] })
    assert.deepEqual(p.live, ['e', 'a', 'b', 'c'])
    assert.deepEqual(p.rest, ['d'])
  })

  await it('退出参与者后不留悬空引用', () => {
    const p = planPanes({ ids: ['a', 'b'], promoted: ['x', 'a'], cap: 1 })
    assert.deepEqual(p.live, ['a'], '换进来名单里那个已经不存在的 id 不能被挂上去')
    assert.deepEqual(p.rest, ['b'])
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
    assert.equal(seven.cols, 4)

    const nine = planPanes({ ids: Array.from({ length: 9 }, (_, i) => `m${i + 1}`), box: { w: 1770, h: 760 } })
    assert.equal(nine.live.length, 9, '760px 高才付得起三行（3×240+2×7=734）')
    assert.equal(nine.cols, 3, '九枚摆 3×3 正好补满，摆 4 列要留三格空位')
    const short = planPanes({ ids: Array.from({ length: 9 }, (_, i) => `m${i + 1}`), box: { w: 1770, h: 723 } })
    assert.equal(short.live.length, 8, '同一堵墙矮了 37px 就只剩两行：多出来那枚退回标签，不是硬挤')
    assert.deepEqual([short.cols, short.rows], [4, 2])

    const narrow = planPanes({ ids: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], box: { w: 1240, h: 700 } })
    assert.deepEqual(narrow.live, ['a', 'b', 'c', 'd'])
    assert.deepEqual(narrow.rest, ['e', 'f', 'g'], '摆不下的退回标签条，点一下换进来')
    assert.equal(narrow.cols, 2)
    // 只挂两枚时不该占三列：中间那根空列在墙上是一竖条应用底色
    const two = planPanes({ ids: ['a', 'b'], box: { w: 1770, h: 723 } })
    assert.equal(two.cols, 2)
    assert.equal(two.rest.length, 0)
  })

  await it('「这一屏放得下几枚」报的是墙，不是这次的摆法', () => {
    /*
     * 这句提示是用户判断「还要不要拖宽」的唯一依据，所以它必须回答容量。
     * 实测栽过一次：1710×758 的墙挂三枚，摆法选了 3×1，提示跟着写成「放 3 枚」——
     * 用户据此以为这墙已经满了，而它按地板档还摆得下 12 格。
     */
    const three = planPanes({ ids: ['a', 'b', 'c'], box: { w: 1710, h: 758 } })
    assert.deepEqual([three.cols, three.live.length, three.rest.length], [3, 3, 0])
    assert.equal(three.cap, 12, '1710 宽 4 列 × 758 高 3 行 = 12 格，与摆法无关')
    // 枚数摆满时下方没有标签条，「每格低于舒适档」只能靠墙头上那颗徽章说，徽章要写真实的行列
    const seven = planPanes({ ids: ['a', 'b', 'c', 'd', 'e', 'f', 'g'], box: { w: 1710, h: 758 } })
    assert.deepEqual([seven.cols, seven.rows, seven.tier], [4, 2, 1], '七枚摆 4×2：428px 宽低于舒适档，如实报挤')
    assert.equal(seven.rest.length, 0, '这一屏摆得下就一枚都不必退回标签')
    assert.deepEqual([three.cols, three.rows, three.tier], [3, 1, 0], '三枚摆 3×1：570×758 两维都过舒适档')
    const tall = planPanes({ ids: Array.from({ length: 12 }, (_, i) => `m${i}`), box: { w: 1710, h: 758 } })
    assert.deepEqual([tall.cols, tall.rows, tall.cap], [4, 3, 12], '十二枚摆满 4×3，行列都顶到天花板')
    const p = planPanes({ ids: ['a', 'b', 'c'], box: { w: 1770, h: 723 }, cap: 1 })
    assert.equal(p.cap, 1, '显式 cap 就是这一路的格数口径：它压过尺寸，一路用到底')
    assert.deepEqual([p.cols, p.rows], [1, 1], '被压成一格时行列都跟着收成 1')
  })

  await it('墙上的两句账都落在界面上：徽章说摆法，标签条说容量', () => {
    /*
     * tier 只由渲染层那两处消费：下方标签条（有候补才存在）与墙头徽章（摆满时唯一的出口）。
     * 少接一处，症状是「格子已经挤到读不动，界面一句话不说」。
     */
    const page = readSrc('src/renderer/components/ChatPage.tsx')
    assert.match(page, /wall\.tier > 0 && \(/, '摆满没有标签条时，徽章是唯一的说法')
    assert.match(page, /每格低于舒适档 · \{wall\.cols\}×\{wall\.rows\}/, '徽章写真实行列，不写容量')
    assert.match(page, /这一屏放得下 \$\{wall\.cap\} 枚/, '标签条那句说的是容量')
    assert.match(page, /位参与者已全部挂上/, '没摆满时不许劝用户拖宽')
    const css = readSrc('src/renderer/styles.css')
    assert.match(css, /\.cx-wall-tier \{/, '徽章样式得真的存在，否则那颗只是一个裸 <b>')
  })

  await it('缝自己占一条轨道：算格数要先把缝的钱付掉', () => {
    assert.equal(SEAM_PX, 7, '缝宽就是那条轨道的宽度，与 .cx-wall-seam 同口径')
    assert.equal(wallTracks([100, 100]), `minmax(0,100fr) ${SEAM_PX}px minmax(0,100fr)`)
    assert.equal(wallTracks([100]), 'minmax(0,100fr)', '一格没有缝')
    // 每格 = (总宽 - 缝) / 格数：拿总宽去除，就把缝也算成了可读面积
    const three = trackPx(1710, [100, 100, 100])
    assert.equal(three.length, 3)
    assert.ok(Math.abs(three[0] - (1710 - 2 * SEAM_PX) / 3) < 0.01, '等分时每格正好平分扣掉缝之后的空间')
    assert.equal(trackIndex(0), 1)
    assert.equal(trackIndex(2), 5, '第 3 格落在第 5 轨：中间那两条是缝')
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

  await it('比例破了地板档：容量按最窄那一格算，多出来的退回标签条', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    // 1710×758、六枚本来摆 3×2；第三列只剩 226px（低于地板档 420）——
    // 拖动已经拖不出这一种了（shiftSeam 夹在地板档），它来自拖完之后墙变小。
    const narrow = { cols: [130, 130, 40], rows: null }
    const p = planPanes({ ids, box: { w: 1710, h: 758 }, seams: narrow })
    assert.ok(p.cols < 3, `最窄一格破了地板档就不许再摆三列（实际 ${p.cols} 列）`)
    assert.equal(p.live.length, p.cap, '多出来的退回标签条，不是挂在一格看不清的墙上')
    assert.equal(p.rest.length, ids.length - p.live.length, '退回去那几枚还在标签条上，点一下就换进来')
    assert.deepEqual(p.colW, Array.from({ length: p.cols }, () => 100), '形状一换，拖开的比例作废：重新等分')
    assert.equal(p.colW.length, p.cols, '权重长度永远等于列数，否则轨道会少数一条')
    assert.equal(p.rowW.length, p.rows)
    assert.equal(p.breachCols, true, '破的是列轴，界面要能一轴一轴地认')
    assert.equal(p.breachRows, false, '行轴没拖过，不该被一起算成破档')

    /*
     * 拖动期间要钉住形状。不钉的话，那一帧列数退了，
     * 用户按着的那根把手连同它所属的格子一起消失 —— 手感是「拖到一半被弹开」。
     */
    const held = planPanes({ ids, box: { w: 1710, h: 758 }, seams: narrow, cap: 6, hold: { cols: 3, rows: 2 } })
    assert.deepEqual([held.cols, held.rows, held.live.length], [3, 2, 6], '钉住：这一下里格数与形状都不动')
    assert.deepEqual(held.colW, [130, 130, 40], '钉住的同时，拖开的比例照常生效')
    assert.equal(held.tier, 1, '那一格确实低于舒适档，徽章要跟着说')
    assert.equal(held.seamBreached, false, '钉住期间不报破档：形状还没定，报出来只会让墙头那颗钮一闪一闪')
  })

  await it('破档要单独报一声，且点未挂载那枚标签能自己复位回来', () => {
    /*
     * 实测撞到的死路（本机 layout 里就存着这一组）：墙 1786×717，比例是
     * cols [180,20] / rows [152,48] —— 最窄一格 178px，远低于地板档 420。
     * 于是这一屏按最窄那一格折算容量，cap 掉到 1，墙上只剩一格、连一条缝都不剩，
     * 而界面还在写「这一屏放得下 1 枚」和「双击恢复等分」。
     * 双击谁？没有缝了。点另一枚标签只是把那唯一一格顶掉 —— 用户的话是
     * 「变成只能切换单个窗口无法并存了」。
     */
    const ids = ['a', 'b']
    const box = { w: 1786, h: 717 }
    const crushed = planPanes({ ids, box, seams: { cols: [180, 20], rows: [152, 48] } })
    assert.deepEqual([crushed.cols, crushed.rows, crushed.cap], [1, 1, 1], '整面 1786×717 的墙被折成一格')
    assert.equal(crushed.live.length, 1, '另一枚退回标签条')
    assert.equal(crushed.seamBreached, true, '这一种要单独报出来：不是墙只能摆一格，是比例把它压成一格')
    assert.equal(crushed.seamPinned, false, '破档时列数由容量决定，不该再说「比例钉住了列数」')
    assert.equal(crushed.breachCols, true)
    assert.equal(crushed.breachRows, true)

    // 只破一轴时另一轴不许被牵连：复位要按轴清，不然用户故意拖宽的格子被顺手抹平
    const oneAxis = planPanes({ ids, box, seams: { cols: [180, 20], rows: [100, 100] } })
    assert.equal(oneAxis.breachCols, true)
    assert.equal(oneAxis.breachRows, false, '行轴等分就是等分，没破档')

    /*
     * 复位之后必须真的回到两格 —— 那颗钮删的是存值，不是往墙上硬塞一格。
     * 同一堵墙、同样两枚参与者，没有那组比例时容量立刻回到 8。
     */
    const fixed = planPanes({ ids, box })
    assert.equal(fixed.seamBreached, false, '等分就没有破档可言')
    assert.deepEqual([fixed.cols, fixed.rows, fixed.live.length], [2, 1, 2], '两枚都回到墙上，各占一半')
    assert.ok(fixed.cap > 1, `复位后容量不该还是 1（实际 ${fixed.cap}）`)

    const page = readSrc('src/renderer/components/ChatPage.tsx')
    assert.match(page, /wall\.seamBreached\n\s+\? `，格子的比例破了地板档/, '标签条那句先认破档，再谈别的三种真相')
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
    assert.match(page, /onClick=\{seamResetBoth\}[\s\S]{0,160}aria-label="恢复等分"/, '两颗轴一起复位')
    assert.match(page, /setColStored\(null\)\n\s*setRowStored\(null\)/, '复位 = 删存值，与双击同一条路')
    /*
     * 点标签这一路：破档时它是「加回来」而不是「换进来」，所以先清破了的那一轴再 promote。
     * 只清破的那一轴 —— 另一轴是用户故意拖出来的宽窄。
     * 两个入口（下方参与者徽章、墙上那条「未挂载」标签）必须共用同一段动作：
     * 只修好一个入口，用户在墙上看到的那枚标签照样只会顶掉唯一那一格。
     */
    assert.match(page, /const promotePane = \(id: string\) => \{\n\s*if \(wall\.breachCols\) setColStored\(null\)\n\s*if \(wall\.breachRows\) setRowStored\(null\)\n\s*setExpandedPane\(null\)\n\s*setPaneOrder\(/, '点未挂载那枚 = 复位 + 加回来')
    assert.equal((page.match(/promotePane\(m\.id\)/g) || []).length, 2, '两个入口都走 promotePane，不给同一句话留两种结果')
    assert.equal((page.match(/被破了地板档的比例挤下了墙/g) || []).length, 2, '两枚标签的 tooltip 都要说清这次点下去是加回来')
  })

  await it('拖开过的比例自己报列数：一放手格子不许自己长回去', () => {
    /*
     * 实测栽过的第二种「少挂一枚」：墙 1372×717、八枚参与者，自然摆法是 3 列。
     * 用户在已经退成 2 列的墙上再拖一次缝（[91,109]，两格都过地板档），
     * 松手后 3 长度旧比例不再匹配，planGrid 照原始墙宽把列数开回 3 ——
     * 刚拖出来的宽窄和好不容易少下来的那两格一起没了。
     * 认这条比例报出的列数，等于把「我要这几列、这个宽窄」一起存下来。
     */
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const box = { w: 1372, h: 717 }
    const p = planPanes({ ids, box, seams: { cols: [91, 109], rows: null } })
    assert.deepEqual([p.cols, p.rows], [2, 2], '两列就摆两列，不因墙还能开第三列而改主意')
    assert.deepEqual(p.colW, [91, 109], '拖开的比例照常生效，不被等分冲掉')
    assert.equal(p.cap, 6, 'cap 说的还是墙（3×2 摆得下 6 枚），不是这次的摆法')
    assert.equal(p.live.length, 4, '两列两行只装得下四枚：摆不下的退回标签条，而不是把第三行挤到地板档以下')
    assert.equal(p.rest.length, 4)
    assert.equal(p.seamPinned, true, '没摆满是被比例钉住的，界面要据此说明')
    assert.equal(p.tier, 0, '622×742 配 355 格高都在舒适档之上')

    // 太长的一组（超过列数上限）不许把墙切成五列：退回自然摆法 + 等分
    const five = planPanes({ ids, box: { w: 2200, h: 723 }, seams: { cols: [120, 110, 100, 90, 80], rows: null } })
    assert.deepEqual([five.cols, five.colW.length], [4, 4], '列数顶到 MAX_PANE_COLS，权重按等分而不是照抄那五段')
    assert.equal(five.seamPinned, false)
  })

  await it('双击恢复等分 = 删掉存值：列数交回墙说了算', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    const box = { w: 1372, h: 717 }
    const plain = planPanes({ ids, box })
    assert.deepEqual([plain.cols, plain.rows, plain.live.length], [3, 2, 6], '没有缝的比例时按墙宽开三列，六枚上墙')
    assert.equal(plain.seamPinned, false, '这一路不该说「缝钉住了列数」')
  })

  await it('没摆满的三种真相要说清那一种：标签条那句跟着 seamPinned 分叉', () => {
    const page = readSrc('src/renderer/components/ChatPage.tsx')
    assert.match(page, /wall\.rest\.length > 0/, '先问「还有候补吗」，不许拿 live 与 cap 比大小冒充全挂上')
    assert.match(page, /缝的比例把这一屏钉成 \$\{wall\.cols\} 列/, '钉住列数时把这一句说出来')
    assert.match(page, /双击任意缝恢复等分/, '给出退路，否则用户只能自己发现')
    assert.match(page, /\{stripTail\}/, '那句话真的落在标签条上')
    assert.match(page, /wall\.live\.length >= wall\.cap \|\| wall\.seamPinned/, '被钉住时点标签也是换进来，不是追加')
  })

  await it('缝落在界面上：格在奇数轨、把手在偶数轨，等分口径的旧规则一起退场', () => {
    const page = readSrc('src/renderer/components/ChatPage.tsx')
    const seam = readSrc('src/renderer/components/WallSeam.tsx')
    const css = readSrc('src/renderer/styles.css')
    assert.match(page, /gridTemplateColumns: wallTracks\(wall\.colW\)/, '列轨由 planPanes 的权重拼出来')
    assert.match(page, /gridTemplateRows: wallTracks\(wall\.rowW\)/, '行轨同理：横缝也要拖得动')
    assert.match(page, /className=\{`cx-cell/, '一格一个盒子，落位写在 style 里')
    assert.match(page, /data-wall-index=\{k\}/, '格子带着自己的排位：松手时照着它认「落在哪一格」')
    assert.match(page, /gridColumn: trackIndex\(k % wall\.cols\)/, '格只占奇数轨')
    assert.match(page, /gridColumn: 2 \* i \+ 2/, '竖缝占两格之间那条偶数轨')
    assert.match(page, /<WallSeam/, '把手真的接进了墙上')
    assert.match(seam, /setPointerCapture/, '原生视图会抢焦点，指针必须捕获到缝上')
    assert.match(seam, /'wall-resizing-col'/, '拖竖缝时光标与禁选中要跟着')
    assert.match(seam, /'wall-resizing-row'/, '拖横缝同理')
    assert.match(css, /\.cx-wall-seam\.seam-col \{/, '缝的命中带与光标真的存在')
    assert.match(css, /\.cx-wall > \.cx-cell > \.webview-dock/, '格子里的窗格仍要能收缩')
    assert.match(page, /拖开后最窄一格/, '拖开过之后那句提示要报真实最窄格，不能继续念等分口径')
    /*
     * 那句话的后半也要跟着改口。旧的「拖破就少挂一枚」是这一轮要撤销的口径：
     * 它把一次能自救的拖拽说成了拆墙，而实测里它给出的正是「点别的加不回来」。
     */
    assert.doesNotMatch(page, /拖破就少挂一枚/, '拖不再能拖破地板档，这句旧口径得退场')
    assert.match(page, /缝拖到这一格剩地板档就停手/, '提示要说清拖到哪儿停，而不是吓用户少挂一枚')
    assert.match(page, /最窄拖到地板档就停手，双击恢复等分/, '墙上那句总说明：停手 + 退路 + 独占走放大')
    /*
     * 地板档由渲染层传给缝：把手自己不该再揣一个更小的数。
     */
    assert.match(seam, /const floorOf = \(axis: SeamAxis\): number => \(axis === 'col' \? FLOOR_PANE\.w : FLOOR_PANE\.h\)/, '两轴各自的地板档由 chatWall 给')
    assert.equal((seam.match(/floorOf\(axis\)/g) || []).length, 2, '竖缝横缝都夹在地板档上')
    assert.match(seam, /最窄拖到地板档就停手/, '把手自己的 tooltip 也给出口')
    /*
     * 模板字符串里漏一个 $ 是不报错的：tooltip 会把 `{wall.cols}` 原样念出来。
     * 这一条曾经真的漏过三处，所以钉在这句原文上，而不是靠一个扫全文件的形式判据 ——
     * 扫全篇的正则分不清「在模板串里」和「在两个模板串之间的那段 JSX」。
     */
    assert.match(
      page,
      /这一屏摆满 \$\{wall\.cols\}×\$\{wall\.rows\} 后每格低于舒适档 \$\{COMFY_PANE\.w\}×\$\{COMFY_PANE\.h\}，但仍在地板档 \$\{FLOOR_PANE\.w\}×\$\{FLOOR_PANE\.h\} 之上/,
      '舒适档那颗徽章的 tooltip 数字要真被插进去，不能念出大括号',
    )
    assert.doesNotMatch(css, /pane-cols-/, '列数改由轨道决定，那四条等分规则必须一起退场')
    assert.doesNotMatch(page, /pane-cols-/, '渲染层也不再拼那个类名')
  })

  await it('权重存的是比例，跨重启还在（主进程那条闸门认得数组）', () => {
    const layout = readSrc('src/renderer/layout.ts')
    const preload = readSrc('src/preload/index.ts')
    const main = readSrc('src/main/index.ts')
    assert.match(layout, /export function useStoredWeights/, '渲染层有一组权重的读写口')
    assert.match(layout, /vecOf\(v as number\[\]\)/, '冷启动加载时数组也要认，否则拖开的比例重启就忘')
    assert.match(preload, /value: number \| number\[\] \| string\[\] \| null/, '通道收两组数组：权重与 id 顺序')
    assert.match(main, /Array\.isArray\(o\.value\)/, '主进程为数组单开一条判据')
    /*
     * 权重不能套那条 120~4000 的像素闸门：65 这种完全正常的比例会被判成「尺寸太小」拒掉，
     * 症状是「拖得动、重启就没了」，最难查。
     */
    assert.match(main, /n < 20 \|\| n > 500/, '比例走自己的区间')
  })

  await it('顺序存的是 id 数组：两格对调只动这两格，参与者变了也能自愈', () => {
    assert.deepEqual(swapAt(['a', 'b', 'c'], 0, 2), ['c', 'b', 'a'], '对调两端')
    assert.deepEqual(swapAt(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c'], '自己和自己 = 不动')
    assert.deepEqual(swapAt(['a', 'b', 'c'], 0, 9), ['a', 'b', 'c'], '越界不许抛错，也不许把数组拉长')
    assert.deepEqual(swapAt(['a', 'b', 'c'], -1, 0), ['a', 'b', 'c'], '负下标同理')
    const src = ['a', 'b', 'c']
    assert.notEqual(swapAt(src, 0, 1), src, '返回新数组')
    /*
     * 不改传入的那一份是有原因的：wallIds 是个 memo，就地改的话 React 看不出它变了，
     * 而下一段拖动读到的还是按下那一刻的快照 —— 症状是「连拖两次只生效一次」。
     */
    assert.deepEqual(src, ['a', 'b', 'c'], '传入的那份保持原样')

    /*
     * 存 id 而不是存格号，是为了让它自己愈合：参与者少了一枚（退出聊天）
     * 或多了一枚（加进来），那份顺序只是「优先照这个摆」——
     * 不在场的被忽略，新来的追加在末尾，既不会留一个空洞，也不会把新人吞掉。
     */
    const ids = ['a', 'b', 'c']
    const box = { w: 1770, h: 723 }
    const healed = planPanes({ ids, box, promoted: ['x', 'c', 'a'] })
    assert.deepEqual(healed.live, ['c', 'a', 'b'], '旧顺序里已经退出的那一枚直接被丢掉，b 是新来的排在后面')
    assert.equal(healed.live.length, ids.length, '一枚都没少：自愈不是少挂一格')
    const dup = planPanes({ ids, box, promoted: ['a', 'a', 'b'] })
    assert.deepEqual(dup.live, ['a', 'b', 'c'], '重复的那一枚只算第一次：不会挤没 c，也不会两格挂同一家对抢一个视图')

    const page = readSrc('src/renderer/components/ChatPage.tsx')
    assert.match(page, /const \[paneOrder, setPaneOrder\] = useStoredOrder\('wall\.order'\)/, '「换进来提到最前」与「拖动对调」共用同一份存值')
    assert.match(page, /promoted: paneOrder \?\? undefined/, '墙的那一份顺序由存值喂给 planPanes')
    assert.match(page, /const wallIds = useMemo\(\(\) => \[\.\.\.wall\.live, \.\.\.wall\.rest\]\.map\(\(m\) => m\.id\)/, '第 k 格 ↔ 第 k 个 id 读的是当下这份摆法')
    /*
     * 退出聊天时把存值里的死 id 清掉。不清也能跑（上面那条自愈），但盘上会越攒越多
     * 已经不存在的模型 —— 而这份偏好是给用户看的，不是给 planPanes 兜底的。
     */
    assert.match(page, /setPaneOrder\(paneOrder\.filter/, '参与者变了就修存值')
  })

  await it('id 数组落盘：主进程先跟权重数组分家，再各判各的', () => {
    const layout = readSrc('src/renderer/layout.ts')
    const preload = readSrc('src/preload/index.ts')
    const main = readSrc('src/main/index.ts')
    assert.match(layout, /export function useStoredOrder/, '渲染层有 id 数组的读写口')
    assert.match(layout, /strArrayOf\(v as string\[\]\)/, '冷启动加载时这一种也要认，否则重启就忘')
    assert.match(layout, /update\(next && next\.length > 0 \? \[\.\.\.next\] : null\)/, '空数组当成「没拖过」交回 CSS/等分，而不是存一个空顺序')
    assert.match(preload, /layoutGet: \(\): Promise<Record<string, number \| number\[\] \| string\[\]>>/, '读回来承认这三种')

    /*
     * 数组得先分家再判：把 ['kimi','deepseek'] 丢进 Number() 会得到 NaN，
     * 于是走权重那条判据被整条拒掉 —— 症状还是「拖得动、重启就没了」。
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
    assert.match(page, /onSwapGrip=\{wall\.live\.length > 1 \? \(e\) => swapDown\(k, e\)/, '只剩一格时不给把手')
    assert.match(css, /\.wdh-grip \{[\s\S]{0,240}cursor: grab/, '把手得看着能拖')
    assert.match(css, /\.wdh-grip \{[\s\S]{0,240}touch-action: none/, '触摸板上起手不许先变成滚动')

    // 没越过阈值的那一下是普通点击：头部那颗放大按钮还得照常工作
    assert.match(page, /if \(e\.button !== 0 \|\| expandedPane \|\| wall\.live\.length < 2\) return/, '右键、独占态、一格墙都不进手势')
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
    assert.match(page, /setPaneOrder\(swapAt\(order, from, to\)\)/, '换的就是那一份顺序')
    assert.match(page, /已交换「\$\{nameOf\(order\[from\]\)\}」与「\$\{nameOf\(order\[to\]\)\}」/, '换完说清是哪两格，并且要说「已」')
    assert.match(page, /要换位置就按住窗格头部拖到另一格上/, '墙上那句总说明里有这条新手势')

    /*
     * 三条退出路都得把视图还回来：Escape、窗口失焦、pointercancel。
     * 少摘一个监听更糟 —— 下一次拖动会多一套幽灵监听，同一帧 setPaneSwap 两次。
     */
    for (const ev of ['pointermove', 'pointerup', 'pointercancel', 'keydown', 'blur']) {
      assert.match(page, new RegExp(`window\\.addEventListener\\('${ev}'`), `拖动要听 ${ev}`)
      assert.match(page, new RegExp(`window\\.removeEventListener\\('${ev}'`), `${ev} 的监听得摘干净`)
    }
    assert.match(page, /if \(ev\.key === 'Escape'\) done\(false\)/, 'Escape 取消')
    assert.match(page, /const cancel = \(\) => done\(false\)/, '失焦与 pointercancel 走同一条取消')
    assert.match(page, /setPaneSwap\(null\)\n\s*if \(!commit \|\| !live\) return/, '先把格子交还给贴合循环，再决定换不换')
  })

  await it('显式 cap 仍能压过尺寸（测试与「整面墙收起」那两路用得上）', () => {
    const p = planPanes({ ids: ['a', 'b', 'c'], box: { w: 1770, h: 723 }, cap: 1 })
    assert.deepEqual(p.live, ['a'])
    assert.deepEqual(p.rest, ['b', 'c'])
    assert.equal(p.cols, 1)
    /*
     * tier 必须按「实际挂了几枚、占几列」算。900×700 的墙摆 2×2 时那一格 450×350 确实挤，
     * 但被显式 cap 压成一整格后它是 900×700 —— 照抄前一句就是对着一条大格喊「低于舒适档」。
     */
    const squeezed = planPanes({ ids: ['a', 'b', 'c', 'd'], box: { w: 900, h: 700 } })
    assert.deepEqual([squeezed.cols, squeezed.rows, squeezed.tier], [2, 2, 1], '2×2 摆满：450×350 确实低于舒适档')
    const alone = planPanes({ ids: ['a', 'b', 'c', 'd'], box: { w: 900, h: 700 }, cap: 1 })
    assert.deepEqual([alone.cols, alone.rows, alone.tier], [1, 1, 0], '同一堵墙压成一整格：900×700 不挤')
  })

  await it('放大那一枚时列数回到 1，尺寸只管未放大时的格数', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    const p = planPanes({ ids, box: { w: 1770, h: 723 }, expanded: 'b' })
    assert.deepEqual(p.live, ['b'])
    assert.equal(p.cols, 1)
    assert.equal(p.rows, 1, '独占那一格是一行一格，不是未放大时的那 4×2')
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
    assert.match(page, /const leanOn = lean && \(active\?\.turns\.length \?\? 0\) > 0/, '一轮都没问过时别挂一条空轨')
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
     * 布局类挂 leanOn 而不是 lean：一轮都没问过时收的是「一条空轨」，
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
