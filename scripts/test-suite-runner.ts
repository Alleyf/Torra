/**
 * 测试汇总跑法（scripts/run-tests.js）的回归 —— 纯函数 + 注入假执行器，不真跑 25 个套件
 *
 * 这一套要钉的是「验证通道本身可信不可信」：`npm test` 原来是 24 段 `&&`，第一处失败就把后面
 * 的套件全部跳过，而输出里只看得到那一条失败。第 1 轮的假绿基线和第 8 轮被遮蔽的 11 个套件
 * 都出在这里。所以核心不变量只有一条：**任何一处失败都不许影响后面套件是否执行**。
 *
 * 运行：npm run test:suite-runner
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// run-tests.js 是 CommonJS 纯脚本（无 .d.ts），走 require 而不是 import，免声明文件之争
type SuiteResult = { key: string; code: number; output: string; summary: { pass: number; fail: number } | null }
type Runner = {
  listSuites: (scripts: Record<string, string>) => string[]
  parseSummary: (output: string) => { pass: number; fail: number } | null
  runSuites: (suites: string[], execute: (key: string) => { code: number; output: string }) => SuiteResult[]
  formatReport: (results: SuiteResult[]) => { report: string; exitCode: number }
}

const ROOT = path.resolve(__dirname, '..')
const runner = require(path.join(ROOT, 'scripts', 'run-tests.js')) as Runner

const PKG = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
  scripts: Record<string, string>
}

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

/** 全绿的假执行器：套件顺序、汇总行格式都照仓库里真实存在的三种口径 */
function fakeExecute(codes: Record<string, number>, outputs: Record<string, string> = {}) {
  const called: string[] = []
  return {
    called,
    run: (key: string) => {
      called.push(key)
      return { code: codes[key] ?? 0, output: outputs[key] ?? `  通过 3 · 失败 ${(codes[key] ?? 0) === 0 ? 0 : 1}` }
    },
  }
}

void (async () => {
  console.log('='.repeat(46))
  console.log('  测试汇总跑法：一处失败不许遮蔽后面的套件')
  console.log('='.repeat(46))

  await it('套件清单取自 package.json，不是写死的名单', () => {
    const suites = runner.listSuites({
      build: 'vite build',
      'test:甲': 'ts-node a.ts',
      'test:乙': 'ts-node b.ts',
      lint: 'eslint .',
    })
    assert.deepEqual(suites, ['test:甲', 'test:乙'], '只收 test: 前缀，且保持 package.json 里的键顺序')

    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'run-tests.js'), 'utf8')
    // 名单一旦写死，「加了 test:x 却没进链」就又回来了 —— 这正是本轮要消灭的失效模式
    for (const leaked of ['test:session', 'test:invariants', 'test:webview-guards']) {
      assert.ok(!src.includes(leaked), `run-tests.js 不该出现具体套件名 ${leaked}`)
    }
  })

  await it('汇总行三种历史口径都认，且取最后一条', () => {
    assert.deepEqual(runner.parseSummary('  通过 17 · 失败 0'), { pass: 17, fail: 0 })
    assert.deepEqual(runner.parseSummary('9 passed, 0 failed'), { pass: 9, fail: 0 })
    assert.deepEqual(runner.parseSummary('全部通过：12 passed, 0 failed'), { pass: 12, fail: 0 })
    // 中间过程也可能打印计数，最终计数在末尾 —— 取第一条会把「跑到一半」当成结论
    const two = ['  通过 1 · 失败 1', '  通过 40 · 失败 0'].join('\n')
    assert.deepEqual(runner.parseSummary(two), { pass: 40, fail: 0 })
  })

  await it('解析不到汇总行时返回 null：判定仍以退出码为准', () => {
    assert.equal(runner.parseSummary('没有任何计数的一行'), null)
    assert.equal(runner.parseSummary(''), null)
  })

  await it('核心不变量：第 2 套失败，第 3~5 套照样跑', () => {
    const suites = ['test:a', 'test:b', 'test:c', 'test:d', 'test:e']
    const fake = fakeExecute({ 'test:b': 1 })
    const results = runner.runSuites(suites, fake.run)
    assert.equal(fake.called.length, 5, '一处失败后剩下的套件必须全部执行')
    assert.deepEqual(fake.called, suites)
    assert.equal(results.length, 5)
    assert.equal(results[1]?.code, 1)
    assert.equal(results.filter((r) => r.code !== 0).length, 1)
  })

  await it('报告：任一失败 → 退出码 1，全绿 → 0', () => {
    const allGreen = runner.runSuites(['test:a', 'test:b'], fakeExecute({}).run)
    assert.equal(runner.formatReport(allGreen).exitCode, 0)

    const oneBad = runner.runSuites(['test:a', 'test:b', 'test:c'], fakeExecute({ 'test:c': 2 }).run)
    const { report, exitCode } = runner.formatReport(oneBad)
    assert.equal(exitCode, 1, 'CI 靠退出码判定，这里必须非 0')
    assert.match(report, /FAIL\s+test:c/)
    assert.match(report, /ok\s+test:a/, '通过的套件也要出现在报告里，别让「没跑」和「跑过」看不出区别')
    assert.match(report, /套件 2\/3 通过/, '汇总行要数得出跑了多少套，光看失败条数不行')
  })

  await it('报告把失败套件的完整输出留在末尾，通过套件只占一行', () => {
    const outputs = {
      'test:a': '  通过 3 · 失败 0',
      'test:b': ['[FAIL] 某条断言', '期望 1 实际 2', '  通过 2 · 失败 1'].join('\n'),
    }
    const results = runner.runSuites(['test:a', 'test:b'], fakeExecute({ 'test:b': 1 }, outputs).run)
    const { report } = runner.formatReport(results)
    assert.ok(report.includes('期望 1 实际 2'), '失败详情必须原样给出，否则定位还得再跑一遍')
    // 详情成块放在汇总行之后：先看结论再看堆栈，翻的时候不用来回找
    assert.ok(report.indexOf('期望 1 实际 2') > report.indexOf('套件 1/2 通过'), '失败详情要排在汇总行之后')
    assert.equal(report.split('test:a').length - 1, 1, '通过的套件在报告里只出现一次')
    assert.match(report, /2 通过 \/ 1 失败/)
  })

  await it('接线：npm test 走汇总跑法，不再用 && 串链', () => {
    assert.equal(PKG.scripts.test, 'node scripts/run-tests.js')
    assert.ok(!PKG.scripts.test.includes('&&'), '`&&` 一回来，遮蔽问题就回来了')
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'run-tests.js'), 'utf8')
    assert.match(src, /maxBuffer/, '捕获输出必须显式给缓冲上限，默认 1MB 会把长输出的套件判成失败')
    assert.match(src, /node_modules/, 'PATH 里要补 node_modules/.bin：直接 node 起跑时没人配')
    assert.match(src, /require\.main === module/, '导出给用例用，命令行跑才真正执行')
  })

  await it('真实清单：--list 跑得出全部套件，也包含本套自己', () => {
    const res = spawnSync(`node scripts/run-tests.js --list`, {
      cwd: ROOT,
      shell: true,
      encoding: 'utf8',
    })
    assert.equal(res.status, 0, `--list 应该只列清单不执行：${res.stderr}`)
    const listed = (res.stdout || '').trim().split(/\r?\n/).filter(Boolean)
    const expected = Object.keys(PKG.scripts).filter((k) => k.startsWith('test:'))
    assert.deepEqual(listed, expected, 'CLI 与 package.json 的清单必须一致')
    assert.ok(listed.length >= 25, `套件数不该少于当前 25，实际 ${listed.length}`)
    for (const must of ['test:suite-runner', 'test:webview-guards', 'test:chat-persistence', 'test:session']) {
      assert.ok(listed.includes(must), `${must} 没进链`)
    }
  })

  await it('语法门：run-tests.js 能被 node --check 收下', () => {
    const res = spawnSync('node --check scripts/run-tests.js', { cwd: ROOT, shell: true, encoding: 'utf8' })
    assert.equal(res.status, 0, res.stderr)
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'test-suite-runner.ts')), '本套文件存在')
  })

  console.log('-'.repeat(46))
  console.log(`  通过 ${pass} · 失败 ${fail}`)
  console.log('='.repeat(46))
  if (fail > 0) process.exit(1)
})()
