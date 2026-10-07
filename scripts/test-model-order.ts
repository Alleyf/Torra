/**
 * 模型顺序与启停的离线回归（纯函数 + 静态守卫，不需要 Electron）
 *
 * 「排序 / 停用 / 移除」原先有两处入口：侧栏卡片（拖动 + 电源键）和设置页的
 * 「顺序与启停」分区。两处管同一件事，用户要先想「我该去哪儿改」，代码要维护两份接线。
 * 现在收回到侧栏一处，设置页只管加模型、配密钥、恢复被隐藏的模型。
 *
 * 于是这个套件要钉的是两件事：
 * - 侧栏那份实现本身是对的：顺序语义只有 moveBefore 一个来源，不许再长出第二份 splice；
 * - 重复入口没有回来：设置页不再接排序/启停，侧栏的四个动作一个都不能少。
 *
 * 运行：npm run test:model-order
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

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
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

function exists(rel: string): boolean {
  return fs.existsSync(path.join(ROOT, rel))
}

import { moveBefore } from '../src/renderer/modelOrder'

const BASE = ['a', 'b', 'c', 'd']
const isPerm = (xs: string[]) => xs.length === BASE.length && [...xs].sort().join() === BASE.slice().sort().join()

function main(): void {
  console.log('\n── 模型顺序与启停（侧栏唯一入口）')

  /* ── 纯函数层：侧栏拖动的落点算法 ───────────────────────────── */

  it('moveBefore：落在目标之前', () => {
    assert.deepEqual(moveBefore(['a', 'b', 'c', 'd'], 'd', 'b'), ['a', 'd', 'b', 'c'])
    assert.deepEqual(moveBefore(['a', 'b', 'c', 'd'], 'a', 'c'), ['b', 'a', 'c', 'd'])
    // 拖动语义如实保留：把 a 放到紧跟着它的 b 之前 = 还在原地（所以侧栏相邻互拖不该跳位）
    assert.deepEqual(moveBefore(['a', 'b', 'c', 'd'], 'a', 'b'), ['a', 'b', 'c', 'd'])
  })

  it('moveBefore：目标不在列表里追加到末尾（与侧栏拖到空白处一致）', () => {
    assert.deepEqual(moveBefore(['a', 'b', 'c'], 'c', 'zzz'), ['a', 'b', 'c'])
    assert.deepEqual(moveBefore(['a', 'b', 'c'], 'x', 'a'), ['x', 'a', 'b', 'c'])
  })

  it('moveBefore：原地拖动等价于不变，且返回的是新数组', () => {
    const src = ['a', 'b', 'c']
    const out = moveBefore(src, 'b', 'b')
    assert.deepEqual(out, src)
    assert.notEqual(out, src, '不该把原数组交出去')
    out.push('z')
    assert.equal(src.length, 3, '改返回值不该影响入参')
  })

  it('moveBefore：绝不改动入参', () => {
    const src = ['a', 'b', 'c', 'd']
    moveBefore(src, 'd', 'a')
    moveBefore(src, 'a', 'd')
    assert.deepEqual(src, ['a', 'b', 'c', 'd'])
  })

  it('不变量：全枚举 4×4，结果永远是同集合的置换，且落点紧贴目标', () => {
    for (const drag of BASE) {
      for (const target of BASE) {
        const out = moveBefore(BASE, drag, target)
        assert.ok(isPerm(out), `${drag}→${target} 结果不是置换：${out}`)
        if (drag !== target) {
          assert.equal(out.indexOf(drag), out.indexOf(target) - 1, `${drag} 应正好落在 ${target} 之前`)
        }
      }
    }
  })

  /* ── 口径层：顺序语义只有一个来源 ───────────────────────────── */

  const rail = readSrc('src/renderer/components/ModelRail.tsx')
  const orderSrc = readSrc('src/renderer/modelOrder.ts')

  it('口径层：侧栏拖动调用共享函数，不再自带 splice', () => {
    assert.match(rail, /import \{ moveBefore \} from '\.\.\/modelOrder'/, '侧栏没接上共享实现')
    assert.match(rail, /onReorder\(moveBefore\(models\.map\(\(m\) => m\.id\), dragId, targetId\)\)/, '拖动落点没走 moveBefore')
    assert.doesNotMatch(rail, /rest\.splice\(/, '侧栏仍留着一份自己的 splice 排序')
  })

  it('口径层：modelOrder 只剩 moveBefore 一个口径，且不写 splice', () => {
    assert.equal((orderSrc.match(/export function moveBefore/g) ?? []).length, 1)
    assert.doesNotMatch(orderSrc, /\.splice\(/, '共享实现自己不该再写 splice')
    assert.match(orderSrc, /return \[\.\.\.ids\]/, '原地拖动要返回副本而不是原数组')
    // 设置页那份上下移动入口已经删掉，留着的纯函数就是没人用的死代码
    assert.doesNotMatch(orderSrc, /export function moveStep/, 'moveStep 已无消费方，该一并删掉')
  })

  /* ── 入口层：同一件事只有一个地方能改 ───────────────────────── */

  it('入口层：设置页的「顺序与启停」分区没有回来', () => {
    assert.equal(exists('src/renderer/components/ModelManageSection.tsx'), false, '重复入口的组件又出现了')
    const settings = readSrc('src/renderer/components/SettingsPage.tsx')
    assert.doesNotMatch(settings, /ModelManageSection/, '设置页又引回了排序/启停分区')
    assert.doesNotMatch(settings, /onReorder|onToggleEnabled/, '设置页不该再接排序与启停的 handler')
    assert.ok(!settings.includes('顺序与启停'), '设置页仍有与侧栏重复的分区标题')
  })

  it('入口层：App 只把排序/启停接到侧栏，不再双份下发', () => {
    const app = readSrc('src/renderer/App.tsx')
    const railUsage = app.slice(app.indexOf('<ModelRail'), app.indexOf('/>', app.indexOf('<ModelRail')))
    assert.match(railUsage, /onReorder=\{\(ids\) => void handleReorder\(ids\)\}/, '侧栏没拿到排序 handler')
    assert.match(railUsage, /onToggleEnabled=\{\(id, enabled\) => void handleToggleEnabled\(id, enabled\)\}/, '侧栏没拿到启停 handler')
    const settingsUsage = app.slice(app.indexOf('<SettingsPage'), app.indexOf('/>', app.indexOf('<SettingsPage')))
    assert.doesNotMatch(settingsUsage, /onReorder|onToggleEnabled/, '设置页又接了一份同名 handler')
  })

  it('入口层：侧栏四个动作齐全（拖动排序、停用、移除、批量清停用）', () => {
    assert.match(rail, /<GripVertical/, '侧栏没有拖动把手')
    assert.match(rail, /draggable=\{!!onReorder\}/, '卡片没按 handler 在场与否开启拖动')
    assert.match(rail, /<Power size=\{11\} \/>/, '侧栏没有启停按钮')
    assert.match(rail, /onRemove\(m\.id\)/, '侧栏没有移除入口')
    assert.match(rail, /onClearDisabled && disabledCount > 0 &&/, '侧栏没有「清理已停用」的批量出口')
  })

  it('入口层：停用仍是隐藏而非真删，恢复出口留在设置页', () => {
    // 侧栏只管开关；被移除的内置模型仍要在设置页找得回来
    const settings = readSrc('src/renderer/components/SettingsPage.tsx')
    assert.match(settings, /listHiddenModels/, '设置页不再列出被隐藏的模型')
    assert.match(settings, /window\.torra\.restoreModel/, '设置页不再有恢复入口')
    assert.match(settings, /已隐藏的模型/, '恢复分区标题不见了')
  })

  it('接线层：写盘与脱勾仍归 App 的 handler，组件不自己碰 IPC', () => {
    assert.doesNotMatch(rail, /window\.torra\.(setModelOrder|reorder)/, '侧栏绕过 App 直接写盘')
    const app = readSrc('src/renderer/App.tsx')
    // 停用要顺带从参与名单/主持里摘掉 —— 这条不变量在 App 侧
    assert.match(app, /if \(!enabled\) pruneForGone\(id\)/)
  })

  it('接线层：套件已挂进 npm test 链', () => {
    const pkg = JSON.parse(readSrc('package.json'))
    assert.match(String(pkg.scripts['test:model-order']), /scripts\/test-model-order\.ts/, '缺独立脚本项')
    assert.match(String(pkg.scripts.test), /run-tests/, 'npm test 必须走 scripts/run-tests.js 汇总跑法')
  })

  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`)
  if (fail > 0) process.exit(1)
}

main()
