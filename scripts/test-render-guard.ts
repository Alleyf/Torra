/**
 * 渲染层兜底的离线回归（假异常，不需要 Electron）
 *
 * 白屏这件事的代价不在「会不会崩」，而在崩了以后没人知道发生了什么、也没有任何出口。
 * 能钉死的两层：
 * - 纯函数层：任何被抛出的值都要变成一行能给人看的话，连续快速崩溃要能被识别出来；
 * - 接线层：兜底确实套在应用外面、回退区确实给了恢复入口、样式确实存在且不带硬编码色值。
 *
 * 运行：npm run test:render-guard
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { RAPID_LIMIT, RAPID_WINDOW_MS, crashLine, isRapidCrash, noteCrash } from '../src/renderer/renderError'

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
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
}

/** 造一条真实形状的堆栈：第一行是消息，之后才是帧 */
function errWithStack(message: string, stack: string[]): Error {
  const err = new Error(message)
  err.stack = [`${message}`, ...stack].join('\n')
  return err
}

async function main(): Promise<void> {
  console.log('='.repeat(46))
  console.log('  渲染层兜底：崩了要说清、要有出口')
  console.log('='.repeat(46))

  await it('崩溃文案：Error 带上出错位置，只留文件名不甩整条 URL', () => {
    const line = crashLine(errWithStack('Cannot read properties of undefined (reading "chats")', [
      '    at ChatPage (http://localhost:5173/src/renderer/pages/ChatPage.tsx:140:22)',
      '    at renderWithHooks (A:\\dashboard\\GH_Repos\\Torra\\node_modules\\react-dom\\cjs\\react-dom.development.js:16305:18)',
    ]))
    assert.match(line, /^Cannot read properties of undefined/)
    assert.match(line, /（ChatPage\.tsx:140:22）$/, '要给的是第一个调用帧的位置')
    assert.doesNotMatch(line, /localhost/, '主机名对人没有信息量')
    assert.doesNotMatch(line, /react-dom/, 'React 自己的帧不该占掉这一行')
  })

  await it('崩溃文案：不是 Error 的东西也要转述，不能显示成 [object]', () => {
    assert.equal(crashLine('字符串异常'), '字符串异常')
    assert.equal(crashLine(undefined), '（未给出原因）')
    assert.equal(crashLine(null), '（未给出原因）')
    assert.match(crashLine({ code: 'EPERM' }), /EPERM/, '裸对象要能把关键字段带出来')
    const circular: Record<string, unknown> = { name: 'loop' }
    circular.self = circular
    assert.match(crashLine(circular), /无法显示/, '循环引用不能把兜底自己也崩掉')
  })

  await it('崩溃文案：换行收平、超长截断，一行放不下的不硬撑', () => {
    const folded = crashLine(new Error('第一行\n第二行\n第三行'))
    assert.doesNotMatch(folded, /\n/, '界面上这是单行文本，堆栈留在控制台')
    assert.ok(folded.startsWith('第一行 第二行 第三行'), `换行要收平成空格，实际：${folded}`)
    const long = crashLine(new Error('x'.repeat(500)))
    assert.ok(long.length <= 180, `截断后仍要放得下（实际 ${long.length}）`)
    assert.ok(long.endsWith('…'), '截断要留下截断的样子')
  })

  await it('连续崩溃计数：隔着窗口期的重试不并入，紧跟着的才计数', () => {
    const t0 = 1_000_000
    const first = noteCrash(null, t0)
    assert.equal(first.count, 1, '第一次没有「上一次」可比')
    assert.equal(noteCrash(first, t0 + RAPID_WINDOW_MS - 1).count, 2, '窗口内接着崩要并入')
    assert.equal(noteCrash(first, t0 + RAPID_WINDOW_MS + 60_000).count, 1, '隔了一分钟再崩是新一场，不该继承旧账')
    assert.equal(isRapidCrash({ at: t0, count: RAPID_LIMIT - 1 }), false)
    assert.equal(isRapidCrash({ at: t0, count: RAPID_LIMIT }), true, '到上限就该转向重新载入而不是继续劝重试')
  })

  await it('接线：兜底套在应用最外层，出错的是一整棵子树时也拦得住', () => {
    const boot = readSrc('src/renderer/main.tsx')
    assert.match(boot, /<RenderGuard>[\s\S]*<StrictMode>[\s\S]*<App \/>/, 'RenderGuard 要在 App 之外')
    assert.match(boot, /from '\.\/components\/RenderGuard'/)
  })

  await it('接线：回退区既有说明也有出口，异常原文进控制台', () => {
    const guard = readSrc('src/renderer/components/RenderGuard.tsx')
    assert.match(guard, /componentDidCatch/, '没有这个钩子，异常会一路冒到 React 外部')
    assert.match(guard, /console\.error\('[^\n]*',\s*error/, '完整堆栈要留在控制台，供 CDP 与 doctor 捞')
    assert.match(guard, /getDerivedStateFromError/, '先切回退分支，别把 #root 卸掉')
    assert.match(guard, /className="render-guard"/)
    assert.match(guard, /role="alert"/, '读屏也要知道这是错误而不是正常内容')
    assert.match(guard, /重试这一屏/, '留在原地的恢复入口')
    assert.match(guard, /window\.location\.reload\(\)/, '重试没用时的第二个出口')
    assert.match(guard, /isRapidCrash/, '连续崩溃要改口径，不能一直让人点重试')
  })

  await it('样式：兜底块用现有 .btn 与变量，不带回卡片盒和硬编码色', () => {
    const css = readSrc('src/renderer/styles.css')
    const at = css.indexOf('/* ── 渲染层兜底')
    assert.ok(at > 0, 'styles.css 里要有兜底区这一块')
    const block = css.slice(at)
    assert.match(block, /\.render-guard \{/)
    assert.match(block, /\.render-guard > \.rg-actions/, '按钮横排沿用文档流，不做浮层')
    assert.doesNotMatch(block, /box-shadow/, '不出卡片盒')
    assert.doesNotMatch(block, /#[0-9a-fA-F]{3,8}\b/, '颜色一律走主题变量')
    assert.match(block, /var\(--text\)/)
  })

  await it('用例本身挂在 npm test 链上，不是一跑而过就没人看的孤儿', () => {
    const pkg = JSON.parse(readSrc('package.json')) as { scripts: Record<string, string> }
    assert.equal(pkg.scripts['test:render-guard'].includes('scripts/test-render-guard.ts'), true)
    assert.match(pkg.scripts.test, /test:render-guard/, 'npm test 必须跑到这一套')
  })

  console.log('-'.repeat(46))
  console.log(`  通过 ${pass} · 失败 ${fail}`)
  console.log('='.repeat(46))
  if (fail > 0) process.exit(1)
}

void main()
