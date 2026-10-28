/**
 * 首屏关键路径的离线契约（P4）
 *
 * 首屏那一帧真正需要的只有研讨屏的正文；设置页、历史、聊天、报告、助手抽屉都是
 * 「点进去才要」的东西。把它们从静态 import 换成 lazy()，入口块从 491 kB 降到 335 kB
 * （gzip 157 → 109），micromark 那条解析链整个挪到按需取的那一块里。
 *
 * 这件事有两种静默退化的方式，都能在类型检查下通过、只在真打开某一屏时才露出来：
 * 1. 又补回一句静态 import —— 拆包当场失效，构建产物看不出来；
 * 2. 新增一个 lazy 组件却没给 Suspense 边界 —— React 抛「no fallback boundary」，
 *    整棵树被卸掉（这个仓库没有 ErrorBoundary，白屏是唯一的表现）。
 * 所以这里钉的是**结构**，不是体积：体积要靠构建测量，结构能靠源码切片。
 *
 * 运行：npm run test:lazy-routes
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const ROOT = path.resolve(__dirname, '..')
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n')

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

/** 这五屏都不是首屏；名字保持和 JSX 用法一致，别的套件的源码锚点才不会漂 */
const LAZY_VIEWS = [
  'SettingsPage',
  'HistoryPage',
  'ChatPage',
  'ReportWorkspace',
  'AssistantDrawer',
  'TranslatePage',
]

function main(): void {
  const app = read('src/renderer/App.tsx')

  console.log('\n── 首屏懒加载契约（离线源码切片）')

  it('五屏都走 lazy()：const X = lazy(() => import(...))', () => {
    for (const name of LAZY_VIEWS) {
      const decl = new RegExp(`const ${name} = lazy\\(\\(\\) =>\\s*import\\('\\./components/${name}'\\)`)
      assert.match(app, decl, `${name} 不是从 ./components/${name} 懒取的同名 const`)
    }
  })

  it('没有残留的静态 import：一句就把拆包悄悄抹平', () => {
    for (const name of LAZY_VIEWS) {
      const staticImport = new RegExp(`^import[^\\n]*from\\s*['"]\\.\\./components/${name}['"]|^import[^\\n]*from\\s*['"]\\./components/${name}['"]`, 'm')
      assert.doesNotMatch(app, staticImport, `App.tsx 里还有一句 ${name} 的静态 import`)
      // 组件文件内部也不许反手把整条 react-markdown 链拉回入口
      const src = read(`src/renderer/components/${name}.tsx`)
      assert.doesNotMatch(src, /^import\s+\w[\s\S]{0,80}?from\s*['"]react-markdown['"]/m, `${name}.tsx 静态 import 了 react-markdown`)
    }
  })

  it('每一个懒屏都落在某个 Suspense 边界里', () => {
    // 扫一遍开合标签记深度：深度 0 上出现懒组件，就是「点开了才抛」的那一种退化
    const re =
      /<Suspense\b|<\/Suspense>|<(SettingsPage|HistoryPage|ChatPage|ReportWorkspace|AssistantDrawer|TranslatePage)\b/g
    let depth = 0
    const seen: string[] = []
    for (const m of app.matchAll(re)) {
      if (m[0] === '</Suspense>') {
        depth--
        assert.ok(depth >= 0, `</Suspense> 多出来一个（第 ${seen.length} 处用法之后）`)
      } else if (m[0].startsWith('<Suspense')) {
        depth++
      } else {
        seen.push(m[1] as string)
        assert.ok(depth >= 1, `<${m[1]}> 用在任何 Suspense 边界之外：加载那一帧整棵树抛错`)
      }
    }
    assert.ok(seen.length >= LAZY_VIEWS.length, `只扫到 ${seen.length} 处懒组件用法，口径可能漂了`)
    assert.equal(depth, 0, 'Suspense 开合没配平')
  })

  it('正文屏的兜底帧是看得见的字，不是空白', () => {
    assert.match(app, /<Suspense fallback=\{<div className="pane-loading">/, '正文那一格没有 fallback')
    const css = read('src/renderer/styles.css')
    assert.match(css, /^\.pane-loading \{/m, 'styles.css 里没有 .pane-loading：兜底帧会贴在左上角')
    // 抽屉/报告弹窗共用这一格，父级不是 flex 列，靠 min-height 撑着
    assert.match(css, /\.pane-loading[\s\S]{0,400}min-height: 120px/, '兜底帧没有最小高度，非 flex 父级里会塌没')
  })

  it('首屏真正需要的两块仍是静态的：正文与侧栏不能被顺手懒掉', () => {
    // 论题演化图就是研讨屏正文，冷启动第一帧要画它；懒它等于把白屏换成等待
    assert.match(app, /^import \{ TopicEvolution \} from '\.\/components\/TopicEvolution'/m, 'TopicEvolution 被懒掉了')
    assert.doesNotMatch(app, /const TopicEvolution = lazy\(/, '正文不该是 lazy：首屏第一帧就要它')
  })

  it('套件已挂进 npm test 链', () => {
    const pkg = JSON.parse(read('package.json'))
    assert.match(String(pkg.scripts['test:lazy-routes']), /scripts\/test-lazy-routes\.ts/, '缺独立脚本项')
    assert.match(String(pkg.scripts.test), /run-tests/, 'npm test 必须走 scripts/run-tests.js 汇总跑法')
  })

  console.log(`\n  通过 ${pass} · 失败 ${fail}\n`)
  if (fail > 0) process.exit(1)
}

main()
