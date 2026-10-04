/**
 * 智能添加的纯逻辑回归（开发期自检）
 *
 * 为什么要单独守住：这几段逻辑的失败方式都不是报错，而是「页面看起来正常但配置是错的」
 * 或直接白屏 —— 报过的 Cannot read properties of undefined (reading 'includes')
 * 就是扫描结果没归一化，渲染层读到 undefined 选择器导致的。
 *
 * 运行：npm run test:smart-add
 */

import assert from 'node:assert/strict'
import {
  applyAnswer,
  blockingFailRoles,
  fitsTarget,
  gradeCheck,
  sanitizeQuestions,
  sanitizeSelectors,
  toPickScan,
  type RawScan,
} from '../src/main/setup/smart-add'
import { PICKER_SCRIPT } from '../src/main/webview/picker'
import type { WebPlan } from '../src/shared/smart-add'

let pass = 0
let fail = 0

function it(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`)
  } catch (e) {
    fail++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`)
    console.log(`       ${(e as Error).message.split('\n')[0]}`)
  }
}

function blankPlan(): WebPlan {
  return {
    planId: 'p1',
    entry: 'https://example.com/',
    name: '示例',
    selectors: { input: 'textarea', send: '', stop: '', stream: 'div.msg', generating: '' },
    input_kind: 'textarea',
    send_mode: 'enter',
    stream_mode: 'last',
    completion_mode: 'dom_stable',
    stable_ms: 3000,
    confidence: {},
    why: {},
    risks: [],
    questions: [],
    checks: {},
    source: 'heuristic',
    assistant: null,
    login: { state: 'unknown', reason: '' },
    rounds: 1,
  }
}

function main(): void {
  console.log('\n智能添加逻辑回归\n' + '='.repeat(46))

  it('扫描结果归一化：缺 chosen 时 selector 是空串而不是 undefined', () => {
    // 站点侧返回的字段名是 chosen；这一层改名丢了，弹窗就会在 .includes 上崩
    const raw = { input: [{ candidates: undefined, tag: undefined }], send: [] } as unknown as RawScan
    const scan = toPickScan(raw)
    assert.equal(scan.input[0]?.selector, '')
    assert.deepEqual(scan.input[0]?.candidates, [])
    assert.deepEqual(scan.stop, [])
    assert.equal(typeof scan.input[0]?.tag, 'string')
  })

  it('扫描结果归一化：chosen 正常映射为 selector', () => {
    const scan = toPickScan({ input: [{ chosen: 'textarea#q', candidates: [{ selector: 'textarea', matches: 2 }] }] } as RawScan)
    assert.equal(scan.input[0]?.selector, 'textarea#q')
    assert.equal(scan.input[0]?.candidates[0]?.matches, 2)
  })

  it('命中 0 判 fail，命中全页判 warn，正常命中判 ok', () => {
    assert.equal(gradeCheck('input', 'div.ql-editor', 0).level, 'fail')
    assert.equal(gradeCheck('stream', 'div', 900).level, 'warn')
    assert.equal(gradeCheck('input', 'textarea', 1).level, 'ok')
    assert.equal(gradeCheck('stream', 'div.msg', 3).level, 'ok')
  })

  it('stream 罩住输入框＝整页外壳，判 fail（命中数看不出来）', () => {
    // 这是「生成结束但未捕获到内容」的源头：main / body 只命中 1 个，
    // 光看命中数会放行，运行时读到的却是整页文本
    assert.equal(gradeCheck('stream', 'main', 1, true).level, 'fail')
    assert.ok(gradeCheck('stream', 'main', 1, true).note?.includes('输入框'))
    assert.equal(gradeCheck('stream', 'div.ds-markdown', 2, false).level, 'ok')
    // 输入框角色本来就应该是那个含输入框的元素，不受这条约束
    assert.equal(gradeCheck('input', 'textarea', 1, true).level, 'ok')
  })

  it('未填写时只有必需角色算阻断项', () => {
    assert.equal(gradeCheck('send', '', 0).level, 'ok')
    assert.equal(gradeCheck('stream', '', 0).level, 'fail')
    assert.deepEqual(blockingFailRoles({ input: gradeCheck('input', '', 0), send: gradeCheck('send', '', 0) }), ['input'])
  })

  it('选择器清洗：控制字符与超长一律丢弃', () => {
    const clean = sanitizeSelectors({ input: 'textarea\x01', send: 'x'.repeat(900), stop: 42 })
    assert.equal(clean.input, '')
    assert.equal(clean.send.length, 400)
    assert.equal(clean.stop, '')
  })

  it('澄清问题：target 不在白名单或无合法选项时整条丢弃', () => {
    const qs = sanitizeQuestions([
      { id: 'q1', prompt: '哪个是输入框？', target: 'selectors.input', options: [{ value: 'textarea', label: '输入框' }] },
      { id: 'q2', prompt: '坏目标', target: 'selectors.evil', options: [{ value: 'a', label: 'A' }] },
      { id: 'q3', prompt: '没有选项', target: 'name', options: [] },
    ])
    assert.equal(qs.length, 1)
    assert.equal(qs[0]?.id, 'q1')
    assert.equal(qs[0]?.target, 'selectors.input')
  })

  it('回答只接受合法取值', () => {
    assert.ok(fitsTarget('send_mode', 'click'))
    assert.ok(!fitsTarget('send_mode', 'moonwalk'))
    assert.ok(fitsTarget('selectors.stream', 'div.msg'))
    assert.ok(!fitsTarget('name', '   '))
  })

  it('回答写回方案：枚举与选择器各自落到正确字段', () => {
    const plan = blankPlan()
    applyAnswer(plan, 'send_mode', 'click')
    applyAnswer(plan, 'selectors.stream', '  div.reply  ')
    applyAnswer(plan, 'input_kind', 'moonwalk')
    assert.equal(plan.send_mode, 'click')
    assert.equal(plan.selectors.stream, 'div.reply')
    assert.equal(plan.input_kind, 'textarea') // 非法值不得污染
  })

  it('注入脚本本身可用：模板转义后的正则仍是 \\s+ 而不是 s+', () => {
    // TS 模板字面量里 \s 会被吃掉一个反斜杠，写错就变成「匹配字母 s」
    assert.ok(PICKER_SCRIPT.includes('replace(/\\s+/g'), 'norm() 的空白折叠正则被转义错了')
    assert.doesNotThrow(() => new Function(PICKER_SCRIPT))
    assert.ok(PICKER_SCRIPT.includes('outline'), '拾取脚本必须提供 outline() 快照')
    assert.ok(PICKER_SCRIPT.includes('verify'), '拾取脚本必须提供 verify() 命中数')
    assert.ok(PICKER_SCRIPT.includes('covers'), 'verify() 必须报告命中元素是否含输入框')
  })

  it('注入脚本在桩 DOM 里真跑一遍 scan/verify（引用到不存在的变量会在这里炸）', () => {
    // 页内脚本没有类型检查，删掉一个 var 只会在线上表现为 scan() 抛错、
    // 智能识别拿不到任何候选 —— 编译通过说明不了任何事
    const el = (tag: string, text: string, editable = false): Record<string, unknown> => ({
      tagName: tag.toUpperCase(),
      id: '',
      className: '',
      classList: [],
      innerText: text,
      value: '',
      textContent: text,
      childElementCount: 0,
      children: [],
      parentNode: null,
      getAttribute: (a: string) => (a === 'name' && editable ? 'user query' : null),
      matches: (s: string) => editable && s.includes('textarea'),
      querySelector: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 120, height: 40 }),
      isContentEditable: editable,
    })
    const reply = el('div', 'x'.repeat(60))
    const composer = el('textarea', '', true)
    const all = [reply, composer]
    const nodes: Record<string, unknown[]> = {
      'textarea,input[type="text"],[contenteditable="true"],[role="textbox"]': [composer],
      'button,[role="button"]': [],
      '[class*="markdown"]': [reply],
    }
    const doc = {
      title: '桩页面',
      cookie: '',
      querySelectorAll: (s: string) => {
        // 未预置的选择器一律回全部节点：够用来验证 covers 的两种取值
        const list = nodes[s] ?? all
        return Object.assign(list.slice(), { forEach: (fn: (x: unknown) => void) => list.forEach(fn) })
      },
    }
    const win: Record<string, unknown> = {}
    const load = new Function('window', 'document', 'location', 'innerWidth', 'innerHeight', `${PICKER_SCRIPT}\nreturn window.__torraPicker`)
    const picker = load(win, doc, { href: 'https://example.com/chat', pathname: '/chat' }, 1280, 800) as {
      scan(): { stream: Array<{ chosen: string }>; input: unknown[] }
      verify(sel: string): { ok: boolean; matches: number; covers: boolean }
    }
    assert.equal(picker.scan().input.length, 1, '输入框候选应只来自可编辑控件')
    assert.equal(picker.scan().stream[0]?.chosen, 'div', '够长的语义类节点应进 stream 候选')
    // 命中范围里含着输入框 = 整页外壳，verify 必须把 covers 报上来
    assert.deepEqual(picker.verify('div'), { ok: true, matches: 2, covers: true })
    assert.deepEqual(picker.verify('[class*="markdown"]'), { ok: true, matches: 1, covers: false })
  })

  console.log(`\n${'='.repeat(46)}`)
  console.log(`  通过 ${pass} · 失败 ${fail}`)
  console.log('='.repeat(46) + '\n')
  process.exit(fail > 0 ? 1 : 0)
}

void main()
