/**
 * WebView 池的内存取舍（纯函数真跑 + 接线形状，不需要 Electron）
 *
 * 这一项要钉的是一件很具体的事：「Torra 占 1.5GB 高不高、能不能降」。
 * 1.5GB 的主体是 7~8 个网页模型各自的 Chromium 渲染进程（每枚实测 300~500MB），
 * 不是泄漏 —— 但旧代码用「枚数 × 250MB」估值做预算判断，七枚折合 1750MB，
 * 永远落在 1800MB 预算线下：回收那条路一次都走不到，空闲实例常驻到退出。
 *
 * 于是这里分两层钉：
 * - 纯函数层（pool-memory.ts）：给一批实例 + 实测占用，取舍必须是对的 ——
 *   LRU 顺序、保护期、attached/busy/loading 不动、讨论中只挂起不回收；
 * - 接线层（pool.ts / index.ts）：判定确实吃实测、回收与超时拆卸确实接上、
 *   停用的模型确实不预热不占内存。
 *
 * 运行：npm run test:pool-memory
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  PRESSURE_FREE_MB,
  planEvictions,
  planIdle,
  planLimit,
  underPressure,
  type Evictable,
} from '../src/main/webview/pool-memory'

const ROOT = path.resolve(__dirname, '..')

let pass = 0
let fail = 0

function it(name: string, fn: () => void): void {
  try {
    fn()
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

/** 测试用实例：只有 lastUsedAt 参与排序，其余按需覆盖 */
const entry = (modelId: string, lastUsedAt: number, over: Partial<Evictable> = {}): Evictable => ({
  modelId,
  lastUsedAt,
  attached: false,
  ...over,
})

const NOW = 1_000_000
const MB = () => 400

function main(): void {
  console.log('='.repeat(46))
  console.log('  WebView 池内存：判定吃实测、空闲要还内存')
  console.log('='.repeat(46))

  /* ── 纯函数层：超预算的 LRU 取舍 ────────────────────────────── */

  it('没超预算时一个人都不挤', () => {
    const plan = planEvictions({
      entries: [entry('a', NOW - 10 * 60_000), entry('b', NOW - 20 * 60_000)],
      totalMb: 800,
      budgetMb: 1800,
      mbOf: MB,
      protectAfter: NOW - 15_000,
    })
    assert.deepEqual(plan.evict, [])
    assert.equal(plan.remainingOverMb, 0)
  })

  it('超预算按 LRU 挤，挤够了就停手，且按实测占用扣减', () => {
    // 4 枚 × 400MB = 1600MB，预算 1000MB → 需要挤掉 2 枚
    const plan = planEvictions({
      entries: [
        entry('newest', NOW - 5 * 60_000),
        entry('mid', NOW - 6 * 60_000),
        entry('old', NOW - 7 * 60_000),
        entry('oldest', NOW - 8 * 60_000),
      ],
      totalMb: 1600,
      budgetMb: 1000,
      mbOf: MB,
      protectAfter: NOW - 15_000,
    })
    assert.deepEqual(plan.evict, ['oldest', 'old'], '先挤最久没被碰的两枚')
    assert.equal(plan.remainingOverMb, 0, '600MB 超支刚好由两枚 400MB 抵掉')
  })

  it('实测占用不均匀时按各自的实际大小扣减', () => {
    const big = new Map([
      ['biggest', 700],
      ['small', 120],
    ])
    const plan = planEvictions({
      entries: [entry('biggest', NOW - 9 * 60_000), entry('small', NOW - 8 * 60_000)],
      totalMb: 820,
      budgetMb: 200,
      mbOf: (e) => big.get(e.modelId) ?? MB(e),
    })
    // 最小一枚只有 120MB；挤掉最大的先满足不了（820-700=120 ≤ 200）→ 只挤一枚
    assert.deepEqual(plan.evict, ['biggest'])
    assert.equal(plan.remainingOverMb, 0)
  })

  it('保护期内的实例不动（预热循环不许被自己的回收杀掉）', () => {
    const plan = planEvictions({
      entries: [entry('just-ensured', NOW - 3_000), entry('stale', NOW - 60 * 60_000)],
      totalMb: 1200,
      budgetMb: 500,
      mbOf: MB,
      protectAfter: NOW - 15_000,
    })
    assert.deepEqual(plan.evict, ['stale'], '刚 ensure() 的那枚即使最久没碰也留着')
  })

  it('attached / busy / loading 一律不挤，可回收对象用尽时如实报告剩余超支', () => {
    const plan = planEvictions({
      entries: [
        entry('watching', NOW - 60 * 60_000, { attached: true }),
        entry('generating', NOW - 60 * 60_000, { busy: true }),
        entry('loading', NOW - 60 * 60_000, { loading: true }),
        entry('idle', NOW - 60 * 60_000),
      ],
      totalMb: 1600,
      budgetMb: 200,
      mbOf: MB,
      protectAfter: NOW - 15_000,
    })
    assert.deepEqual(plan.evict, ['idle'])
    assert.equal(plan.remainingOverMb, 1000, '还剩 1000MB 挤不动，要如实报出来而不是假装达标')
  })

  it('挤人循环不会改动入参', () => {
    const entries = [entry('b', NOW - 2), entry('a', NOW - 1)]
    const before = entries.map((e) => e.modelId)
    planEvictions({ entries, totalMb: 1000, budgetMb: 100, mbOf: MB, protectAfter: NOW - 15_000 })
    assert.deepEqual(
      entries.map((e) => e.modelId),
      before,
      '排序要排序副本',
    )
  })

  /* ── 纯函数层：空闲挂起与超时拆卸 ───────────────────────────── */

  it('空闲到点挂起，没过线不动', () => {
    const plan = planIdle({
      entries: [entry('idle', NOW - 4 * 60_000), entry('fresh', NOW - 30_000)],
      now: NOW,
      idleMs: 3 * 60_000,
      disposeIdleMs: 10 * 60_000,
    })
    assert.deepEqual(plan.suspend, ['idle'])
    assert.deepEqual(plan.dispose, [], '才 4 分钟，不到拆实例的时候')
  })

  it('空闲超过 disposeIdleMs 直接回收（真正把内存还给系统）', () => {
    const plan = planIdle({
      entries: [entry('forgotten', NOW - 20 * 60_000), entry('idle', NOW - 4 * 60_000)],
      now: NOW,
      idleMs: 3 * 60_000,
      disposeIdleMs: 10 * 60_000,
    })
    assert.deepEqual(plan.dispose, ['forgotten'])
    assert.deepEqual(plan.suspend, ['idle'], '该回收的不再重复挂起')
  })

  it('讨论进行中（disposeIdleMs=0）只挂起、绝不回收', () => {
    const plan = planIdle({
      entries: [entry('forgotten', NOW - 60 * 60_000)],
      now: NOW,
      idleMs: 3 * 60_000,
      disposeIdleMs: 0,
    })
    assert.deepEqual(plan.dispose, [], '一场讨论里拆实例 = 把这路判缺席（站点重落地会读回上一条旧答案）')
    assert.deepEqual(plan.suspend, ['forgotten'])
  })

  it('已挂起的不重复挂起；attached / busy / loading 既不挂起也不回收', () => {
    const plan = planIdle({
      entries: [
        entry('already', NOW - 4 * 60_000, { suspended: true }),
        entry('watching', NOW - 60 * 60_000, { attached: true }),
        entry('generating', NOW - 60 * 60_000, { busy: true }),
        entry('loading', NOW - 60 * 60_000, { loading: true }),
      ],
      now: NOW,
      idleMs: 3 * 60_000,
      disposeIdleMs: 10 * 60_000,
    })
    assert.deepEqual(plan.suspend, [], '已挂起的不再重复挂起')
    assert.deepEqual(plan.dispose, [], 'attached / busy / loading 再久也不拆')
  })

  it('已挂起但久到 disposeIdleMs，同样会被回收（挂起只省 CPU，不省内存）', () => {
    const plan = planIdle({
      entries: [entry('suspended-long', NOW - 30 * 60_000, { suspended: true })],
      now: NOW,
      idleMs: 3 * 60_000,
      disposeIdleMs: 10 * 60_000,
    })
    assert.deepEqual(plan.dispose, ['suspended-long'])
  })

  /* ── 纯函数层：常驻枚数上限 ─────────────────────────────────── */

  it('没超过枚数上限时一枚都不裁', () => {
    const evict = planLimit({
      entries: [entry('a', NOW - 10 * 60_000), entry('b', NOW - 20 * 60_000)],
      limit: 3,
      protectAfter: NOW - 15_000,
    })
    assert.deepEqual(evict, [])
  })

  it('超过上限时保留最近用过的 limit 枚，其余按最久没用先裁', () => {
    const evict = planLimit({
      entries: [
        entry('newest', NOW - 1 * 60_000),
        entry('mid', NOW - 5 * 60_000),
        entry('old', NOW - 8 * 60_000),
        entry('oldest', NOW - 30 * 60_000),
      ],
      limit: 2,
      protectAfter: NOW - 15_000,
    })
    // 保留 newest / mid；剩下的按最久没用先走
    assert.deepEqual(evict, ['oldest', 'old'])
  })

  it('limit=0 时只留正在看的/在跑的（系统内存吃紧时的紧急释放）', () => {
    const evict = planLimit({
      entries: [
        entry('watching', NOW - 60 * 60_000, { attached: true }),
        entry('generating', NOW - 60 * 60_000, { busy: true }),
        entry('idle-a', NOW - 1 * 60_000),
        entry('idle-b', NOW - 2 * 60_000),
      ],
      limit: 0,
      protectAfter: NOW - 15_000,
    })
    assert.deepEqual(evict, ['idle-b', 'idle-a'], 'attached / busy 既不占名额也不被裁')
  })

  it('保护期内的实例算「保留」，但不占限额名额（刚 ensure 的一批不会被自己裁掉）', () => {
    // 两枚都在保护期内、一枚早已用旧：限额 1 时旧的走，两枚新的都算保留
    const evict = planLimit({
      entries: [
        entry('fresh-a', NOW - 3_000),
        entry('fresh-b', NOW - 4_000),
        entry('stale', NOW - 60 * 60_000),
      ],
      limit: 1,
      protectAfter: NOW - 15_000,
    })
    assert.deepEqual(evict, ['stale'])
  })

  it('枚数裁剪不夹带 attached / busy / loading（limit=0 也只裁空闲的那枚）', () => {
    const evict = planLimit({
      entries: [
        entry('watching', NOW - 60 * 60_000, { attached: true }),
        entry('generating', NOW - 60 * 60_000, { busy: true }),
        entry('loading', NOW - 60 * 60_000, { loading: true }),
        entry('idle', NOW - 60 * 60_000),
      ],
      limit: 0,
      protectAfter: NOW - 15_000,
    })
    assert.deepEqual(evict, ['idle'])
  })

  /* ── 纯函数层：保活名单（原生墙的参与者） ────────────────────── */

  it('保活的实例连限额都不占：六枚参与者不会把后台名额吃光', () => {
    /*
     * 这条是整件事的枢纽。以前 pinned 只是「跳过不裁」，仍然 counted 进 kept ——
     * 于是「6 枚参与者 + 限额 3」会把名额吃干，任何一枚普通后台实例一进来就被裁，
     * 用户感觉像「随便开个网页它都冷启动」。保活的意思是它不在这一道账本里。
     */
    const evict = planLimit({
      entries: [
        entry('web-a', NOW - 60 * 60_000, { pinned: true }),
        entry('web-b', NOW - 60 * 60_000, { pinned: true }),
        entry('web-c', NOW - 60 * 60_000, { pinned: true }),
        entry('web-d', NOW - 60 * 60_000, { pinned: true }),
        entry('warm-1', NOW - 5 * 60_000),
        entry('warm-2', NOW - 6 * 60_000),
        entry('warm-3', NOW - 7 * 60_000),
        entry('warm-4', NOW - 8 * 60_000),
      ],
      limit: 3,
      protectAfter: NOW - 15_000,
    })
    assert.deepEqual(evict, ['warm-4'], '只有第四枚普通后台实例超了限额，保活的一枚不动')
  })

  it('空闲清扫对保活实例只挂起、不拆（拆了就等于把用户的会话页打回站点入口）', () => {
    const plan = planIdle({
      entries: [
        entry('pinned-idle', NOW - 30 * 60_000, { pinned: true }),
        entry('plain-idle', NOW - 30 * 60_000),
      ],
      now: NOW,
      idleMs: 3 * 60_000,
      disposeIdleMs: 10 * 60_000,
    })
    assert.deepEqual(plan.dispose, ['plain-idle'])
    assert.deepEqual(plan.suspend, ['pinned-idle'], '省 CPU 那一半照做：挂起不丢页面，随时能换进墙')
  })

  it('MB 预算回收不碰保活实例，但会把超支如实报出来', () => {
    /*
     * remainingOverMb 是正数 = 「能挤的都挤完了还是超」，日志据此说话，
     * 而不是假装内存已经还回去了。
     */
    const plan = planEvictions({
      entries: [entry('pinned', NOW - 60 * 60_000, { pinned: true })],
      totalMb: 2400,
      budgetMb: 1800,
      mbOf: MB,
      protectAfter: NOW - 15_000,
    })
    assert.deepEqual(plan.evict, [])
    assert.equal(plan.remainingOverMb, 600, '只剩保活实例时这一轮确实一点内存都没还')
  })

  it('系统吃紧那一路（ignorePinned）才按 LRU 牺牲保活实例', () => {
    const evict = planLimit({
      entries: [
        entry('pinned-old', NOW - 20 * 60_000, { pinned: true }),
        entry('pinned-new', NOW - 20 * 60_000 + 1_000, { pinned: true }),
        entry('watching', NOW - 60 * 60_000, { attached: true }),
      ],
      limit: 0,
      protectAfter: NOW - 15_000,
      ignorePinned: true,
    })
    // 保活这一路 limit=0 意味着「一个后台名额都不给」，所以两枚都放；
    // attached 的那枚仍然不动 —— 它不是保活换来的，是用户正在看。
    assert.deepEqual(evict, ['pinned-old', 'pinned-new'], '按最久没用的先走，正在看的那枚始终不动')
  })

  /* ── 纯函数层：系统内存压力 ─────────────────────────────────── */

  it('可用内存低于绝对阈值算紧张', () => {
    // 总量取小一点，免得「占比过低」那条先命中，盖掉正在验的绝对阈值
    assert.equal(underPressure({ freeMb: PRESSURE_FREE_MB - 1, totalMb: 4_000 }), true)
    assert.equal(underPressure({ freeMb: PRESSURE_FREE_MB, totalMb: 4_000 }), true)
    assert.equal(underPressure({ freeMb: PRESSURE_FREE_MB + 1, totalMb: 4_000 }), false)
  })

  it('可用内存占比过低也算紧张', () => {
    // 64GB 机器上剩 5GB：绝对值远高于 800MB，但只占 7.8%
    assert.equal(underPressure({ freeMb: 5_000, totalMb: 64_000 }), true)
    assert.equal(underPressure({ freeMb: 40_000, totalMb: 64_000 }), false)
  })

  it('读不到内存（0 / NaN）一律判不紧张：宁可少回收一次，也不能误伤', () => {
    assert.equal(underPressure({ freeMb: 0, totalMb: 32_000 }), false)
    assert.equal(underPressure({ freeMb: -1, totalMb: 32_000 }), false)
    assert.equal(underPressure({ freeMb: Number.NaN, totalMb: 32_000 }), false)
    assert.equal(underPressure(null), false)
    assert.equal(underPressure(undefined), false)
  })

  /* ── 接线层：池子确实吃实测、确实接上两级回收 ──────────────── */

  const pool = readSrc('src/main/webview/pool.ts')
  const boot = readSrc('src/main/index.ts')

  it('占用改吃实测：app.getAppMetrics × getOSProcessId，量不到才退回保守估值', () => {
    assert.match(pool, /app\.getAppMetrics\(\)/, '主进程要读真实进程指标')
    assert.match(pool, /workingSetSize/, 'workingSetSize 是 KB 的工作集，是每枚实例的真实占用')
    assert.match(pool, /webContents\.getOSProcessId\(\)/, '按 pid 把指标摊到每枚实例上')
    assert.match(pool, /unmeasured \* MB_PER_WEBVIEW/, '量不到的那几枚按保守估值补进总数，不能当成「不占」')
    assert.match(pool, /estimateMemoryMb\(\): number \{\n\s*return this\.memoryReport\(\)\.totalMb/, '旧的「枚数 × 250」估值退场')
  })

  it('预算回收走纯函数层，且用实测占用扣减', () => {
    assert.match(pool, /planEvictions\(\{/, '取舍已在 pool-memory.ts（可被本套件真跑）')
    assert.match(pool, /mbOf: \(e\) => byId\.get\(e\.modelId\) \?\? MB_PER_WEBVIEW/, '逐枚用实测值')
    assert.match(pool, /const report = this\.memoryReport\(\)\n\s*if \(report\.totalMb <= this\.opts\.memoryBudgetMb\) return/, '先量再判')
    const mem = readSrc('src/main/webview/pool-memory.ts')
    assert.match(mem, /if \(e\.lastUsedAt > opts\.protectAfter\) continue/, '保护期仍在')
    assert.match(mem, /if \(e\.busy\) continue/, '在跑的实例不进 LRU 名单')
  })

  it('空闲清扫分两级：先挂起，久到 disposeIdleMs 才拆实例', () => {
    assert.match(pool, /export const DEFAULT_IDLE_DISPOSE_MS = 10 \* 60_000/)
    assert.match(pool, /sweepIdle\(idleMs: number, canEvict = true, disposeIdleMs = DEFAULT_IDLE_DISPOSE_MS\)/)
    assert.match(pool, /disposeIdleMs: canEvict \? disposeIdleMs : 0/, '讨论进行中只挂起不回收（canEvict=false 掐成 0）')
    assert.match(pool, /for \(const id of plan\.dispose\) this\.disposeEntry\(id\)/)
    assert.match(pool, /for \(const id of plan\.suspend\) this\.markSuspended\(id, true\)/)
    assert.match(pool, /if \(canEvict\) this\.enforceMemoryBudget\(\)/, '回收要过闸门，挂起不过')
    assert.match(pool, /this\.sweeper = setInterval\(\(\) => this\.sweepIdle\(idleMs, !busy\(\), disposeIdleMs\), intervalMs\)/)
    assert.match(boot, /pool\.startIdleSweeper\(undefined, undefined, \(\) => discussionActive\)/, '周期清扫要在建池之后真的开起来，且讨论中不挤人')
  })

  it('每个分区关掉拼写词典：站点页面用不到，白占几十 MB 常驻', () => {
    assert.match(pool, /ses\.setSpellCheckerEnabled\(false\)/)
  })

  it('停用的模型不预热、不巡检、不占内存，停用当刻就释放实例', () => {
    assert.match(
      boot,
      /const webviews = visibleOrderedModels\(\)\.filter\(\(m\) => m\.transport === 'webview' && m\.enabled !== false\)/,
      '预热名单要剔掉停用与已隐藏的模型 —— 每枚是一个渲染进程，而它们都进不了讨论名单',
    )
    assert.match(boot, /models\.filter\(\(x\) => x\.transport === 'webview' && x\.enabled !== false\)/, '巡检同样剔掉')
    assert.match(boot, /if \(!enabled\) pool\.disposeEntry\(modelId\)/, '停用即释放，重新启用时按需重建（登录态在分区里，不丢）')
  })

  it('内存实况可被诊查询到：逐枚明细 + 是否全部实测', () => {
    assert.match(boot, /ipcMain\.handle\('webview:memory', \(\) => \{/)
    assert.match(boot, /estimatedMb: r\.totalMb, count: r\.count, measured: r\.measured, models: r\.models/, '字段向后兼容并新增明细')
    assert.match(readSrc('src/preload/index.ts'), /models\?: Array<\{ modelId: string; mb: number \| null; pinned: boolean; attached: boolean \}>/, '逐枚明细要带上「为什么还在」：保活与正在看')
    // 性能面板那句「最多保留 3 枚」必须点名保活例外，否则用户按它理解原生墙，会觉得闸门坏了
    assert.match(
      readSrc('src/renderer/components/MemorySection.tsx'),
      /聊天模式原生墙上的参与者是例外|参与者是例外/,
      '文案要写清保活例外',
    )
  })

  it('常驻枚数上限：散场即回收、系统内存压力、手动释放三条路都接上', () => {
    assert.match(pool, /export const DEFAULT_MAX_WARM_INSTANCES = 3/)
    assert.match(pool, /trimToWarmLimit\(limit = DEFAULT_MAX_WARM_INSTANCES, ignorePinned = false\): string\[\] \{/)
    assert.match(
      pool,
      /relievePressure\(\): string\[\] \{\n\s*return this\.trimToWarmLimit\(0, true\)/,
      '只有系统内存吃紧那一路才连保活一起放',
    )
    assert.match(pool, /releaseIdle\(modelId: string\): boolean \{/)
    assert.match(pool, /if \(canEvict\) this\.trimToWarmLimit\(\)/, '空闲清扫在超预算回收之后再按枚数裁一刀')
    assert.match(readSrc('src/main/webview/pool-memory.ts'), /export function planLimit/)
    assert.match(boot, /if \(!discussionActive\) pool\.trimToWarmLimit\(\)/, '散场即回收（幂等，进行中的场次不受影响）')
    assert.match(boot, /function startMemoryWatch\(\): void \{/)
    assert.match(boot, /underPressure\(\{ freeMb, totalMb \}\)/, '系统内存压力判定走纯函数层')
    assert.match(boot, /released = pool\.relievePressure\(\)/)
    assert.match(boot, /stage: 'memory:pressure'/)
    assert.match(boot, /startMemoryWatch\(\)/, '看护要在建池之后真的开起来')
  })

  it('保活名单一路接通：池子记位、主进程开通道、渲染层整批上报', () => {
    /*
     * 这条链断在任何一处，症状都不是报错而是「切回墙上那一格，页面被重新加载了」：
     * 渲染层没报 → 池子不知道谁该保活；主进程没过滤通道 → API 模型占着内存；
     * 池子没把 pinned 投进快照 → 三个纯函数都把它当普通后台实例处理。
     */
    const mem = readSrc('src/main/webview/pool-memory.ts')
    assert.match(mem, /pinned\?: boolean/, 'Evictable 得带这一位，否则纯函数看不见保活')
    assert.match(mem, /if \(e\.pinned\) continue/, 'MB 预算回收放过保活实例')
    assert.match(mem, /if \(e\.pinned && !opts\.ignorePinned\) continue/, '枚数裁剪放过它，也不占名额')
    assert.match(mem, /&& !e\.pinned\) \{\n\s*dispose\.push/, '空闲清扫对它只挂起、不拆')

    assert.match(pool, /pinned\?: boolean/, 'PoolEntry 记位')
    assert.match(pool, /pinned: e\.pinned,/, '快照要把它投影给纯函数层')
    assert.match(pool, /setPinned\(ids: readonly string\[\]\): string\[\] \{/, '整批替换，不做增量')
    /*
     * 名单必须先于实例存在。渲染层是在参与者一变就报的，而那一家往往还没被打开过：
     * 只按「此刻的实例」算的话这一次报就整个落空，三分钟后空闲清扫把它拆掉，
     * 用户点回来是一页重载过的站点 —— 保活白做。所以名单单独存一份，ensure() 建实例时认领。
     */
    assert.match(pool, /private declaredPinned = new Set<string>\(\)/, '声明式名单：先记账，实例随后自己认领')
    assert.match(pool, /this\.declaredPinned = new Set\(ids\)/)
    assert.match(pool, /if \(this\.declaredPinned\.has\(modelId\)\) entry\.pinned = true/, '建实例的那一刻认领保活')

    assert.match(boot, /ipcMain\.handle\('webview:pin', \(_e, modelIds: unknown\) => \{/)
    assert.match(boot, /const pinned = pool\.setPinned\(ids\.filter\(\(id\) => allowed\.has\(id\)\)\)/, '只认 webview 通道')
    const pre = readSrc('src/preload/index.ts')
    assert.match(pre, /webviewPin: \(modelIds: string\[\]\)/)
    assert.match(pre, /ipcRenderer\.invoke\('webview:pin', modelIds\)/)

    const page = readSrc('src/renderer/components/ChatPage.tsx')
    assert.match(
      page,
      /const ids = viewMode === 'native' \? webTargets\.map\(\(m\) => m\.id\) : \[\]/,
      '整场参与者，不只是挂在墙上的那几格',
    )
    assert.match(page, /void window\.torra\.webviewPin\(ids\)/)
  })

  it('回收保活实例的那一刻就推给界面：格子要写明「已回收 · 点击重新加载」', () => {
    /*
     * 不推这一条的话，「绝不静默刷新」只剩半句：池子确实只在系统吃紧时才动它们，
     * 但界面看不见那一刻 —— 矩形没变、DOM 没动，WebviewDock 的逐帧贴合不会重发 present，
     * 于是那一格既不重载也不解释，只剩一片空白。
     */
    assert.match(pool, /if \(wasPinned\) this\.notifyRecycled\(modelId\)/)
    assert.match(pool, /webContents\.send\('webview:recycled', \{ modelId \}\)/)
    const pre2 = readSrc('src/preload/index.ts')
    assert.match(pre2, /^\s*'webview:recycled',/m, '推送通道不在白名单里就是收不到的')
    const page2 = readSrc('src/renderer/components/ChatPage.tsx')
    assert.match(page2, /window\.torra\.on\('webview:recycled'/)
    assert.match(page2, /cx-wall-chip-tag/, '标签条上没挂墙的几枚也要写明')
    assert.match(page2, /已回收·点击重新加载/)
    const dock2 = readSrc('src/renderer/components/WebviewDock.tsx')
    assert.match(dock2, /on\('webview:recycled'/, '挂在墙上的那格同样会被告知')
    assert.match(dock2, /已被系统回收/)
    // 被告知的那一刻只能写字，不能顺手 requeue：那等于替用户把上一场对话刷没
    const handler = dock2.slice(dock2.indexOf("on('webview:recycled'"), dock2.indexOf("on('webview:recycled'") + 500)
    assert.doesNotMatch(handler, /requeueRef/, '回收通知里不许自动重挂：重载必须是用户按下去的那一下')
    const css2 = readSrc('src/renderer/styles.css')
    assert.match(css2, /\.cx-wall-chip\.recycled \{[^}]*var\(--warn\)/, '回收态要用警告色，不能和普通标签一个样')
  })

  it('实例被回收后不把登录态退化成「未登录」（否则状态灯从已登录跳成未知）', () => {
    assert.match(boot, /const wasLoggedIn = lastLoginState\.get\(m\.id\) === 'logged-in'/)
    assert.match(boot, /wasLoggedIn \? 'logged-in' : probe\.likelyLoggedIn \? 'unknown' : 'logged-out'/)
    assert.match(boot, /state !== 'logged-in'\) agent0\.status = 'expired'/)
    assert.match(boot, /wasLoggedIn \? 'ok' : 'login-required'/, '保留已登录结论时适配器健康度按 ok 报')
  })

  it('两条按需释放通道：单枚释放 + 全部后台释放', () => {
    assert.match(boot, /ipcMain\.handle\('webview:memory:release', \(_e, modelId: unknown\) => \{/)
    assert.match(boot, /ipcMain\.handle\('webview:memory:release-idle', \(\) => \{/)
    const pre = readSrc('src/preload/index.ts')
    assert.match(pre, /releaseWebview: \(modelId: string\)/)
    assert.match(pre, /releaseIdleWebviews: \(\)/)
  })

  it('设置页有独立的「性能」页签，逐枚实测与释放按钮都画出来', () => {
    const page = readSrc('src/renderer/components/SettingsPage.tsx')
    assert.match(page, /\{ id: 'memory', label: '性能', icon: Gauge \}/)
    assert.match(page, /\{tab === 'memory' && <MemorySection \/>\}/)
    const sec = readSrc('src/renderer/components/MemorySection.tsx')
    assert.match(sec, /window\.torra\.webviewMemory\(\)/)
    assert.match(sec, /window\.torra\.releaseWebview\(modelId\)/)
    assert.match(sec, /window\.torra\.releaseIdleWebviews\(\)/)
  })

  it('用例本身挂在 npm test 链上，不是一跑而过就没人看的孤儿', () => {
    const pkg = JSON.parse(readSrc('package.json')) as { scripts: Record<string, string> }
    assert.equal(pkg.scripts['test:pool-memory']?.includes('scripts/test-pool-memory.ts'), true)
    assert.match(pkg.scripts.test, /run-tests/, 'npm test 必须走 scripts/run-tests.js 汇总跑法')
  })

  console.log('-'.repeat(46))
  console.log(`  通过 ${pass} · 失败 ${fail}`)
  console.log('='.repeat(46))
  if (fail > 0) process.exit(1)
}

main()
