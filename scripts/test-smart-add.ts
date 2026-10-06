/**
 * 智能添加的纯逻辑回归（开发期自检）
 *
 * 为什么要单独守住：这几段逻辑的失败方式都不是报错，而是「页面看起来正常但配置是错的」
 * 或直接白屏 —— 报过的 Cannot read properties of undefined (reading 'includes')
 * 就是扫描结果没归一化，渲染层读到 undefined 选择器导致的。
 *
 * 页内脚本（拾取 / 驱动 / 回复探针）也在这里用桩 DOM 真跑一遍：它没有类型检查，
 * 少一个变量只会在真实站点上表现为「识别不出候选」或「消息根本没发出去」。
 *
 * 运行：npm run test:smart-add
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  webModelSlug,
  webModelInputFromPlan,
  webSpecFromPlan,
} from '../src/main/setup/web-spec'
import {
  applyAnswer,
  blockingFailRoles,
  fitsTarget,
  gradeCheck,
  preserveAnswers,
  replyAppeared,
  sanitizeQuestions,
  sanitizeSelectors,
  toPickScan,
  type RawScan,
  type ReplyProbe,
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

type Stub = Record<string, unknown>

interface Picker {
  scan(): { stream: Array<{ chosen: string }>; input: unknown[] }
  verify(sel: string): { ok: boolean; matches: number; covers: boolean }
  reply(echo?: string): ReplyProbe & { error?: string }
  drive(inputSel: string, text: string, sendSel: string): {
    ok: boolean
    via?: string
    reason?: string
    typed?: number
    input?: string
    left?: boolean
    absent?: boolean
    echoed?: boolean
    url?: string
  }
  focusComposer(sel: string): { ok: boolean; reason?: string; input?: string; ce?: boolean }
  holds(sel: string, text: string): boolean
  bubble(text: string): boolean
}

/**
 * 浏览器里 input.value 是原型上的访问器，React 受控组件只认「原型 setter + input 事件」
 * 这条写入通道。桩节点必须照同样的结构造，否则测的是一段真实站点上并不存在的写法。
 */
class FakeInput {}
Object.defineProperty(FakeInput.prototype, 'value', {
  configurable: true,
  get(this: Stub) {
    return (this.__v ?? '') as string
  },
  set(this: Stub, v: unknown) {
    this.__v = String(v)
  },
})

// 页内脚本按浏览器全局写，Node 里缺的那几个补最小实现。
// 必须在整轮测试期间常驻：drive() 是在 loadPicker 返回之后才调的。
{
  const g = globalThis as Stub
  if (g.HTMLInputElement === undefined) g.HTMLInputElement = FakeInput
  if (g.KeyboardEvent === undefined) {
    g.KeyboardEvent = class {
      type: string
      init: Stub
      constructor(t: string, i: Stub) {
        this.type = t
        this.init = i
      }
    }
  }
}

function loadPicker(doc: Stub, win: Stub = {}): Picker {
  const load = new Function(
    'window',
    'document',
    'location',
    'innerWidth',
    'innerHeight',
    `${PICKER_SCRIPT}\nreturn window.__torraPicker`,
  )
  return load(
    { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }), ...win },
    doc,
    { href: 'https://example.com/chat', pathname: '/chat' },
    1280,
    800,
  ) as Picker
}

/** 造一个「写不进去」的节点：站点自己拦下 setter 时读回来恒为空 */
function stubValue(el: Stub, reject: boolean): Stub {
  if (reject) Object.defineProperty(el, 'value', { configurable: true, get: () => '', set: () => {} })
  return el
}

/** 够格当「可见对话框」的桩节点 */
function stubComposer(props: Stub = {}, reject = false): Stub {
  const el: Stub = Object.create(FakeInput.prototype)
  Object.assign(el, {
    tagName: 'TEXTAREA',
    isContentEditable: false,
    offsetParent: {},
    getAttribute: () => '发消息',
    getBoundingClientRect: () => ({ left: 0, top: 620, width: 700, height: 44, bottom: 664 }),
    matches: (s: string) => s.includes('textarea'),
    querySelector: () => null,
    focus() {},
    dispatchEvent() {},
    ...props,
  })
  return stubValue(el, reject)
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

  it('回复判据：只有真的多出一条回复才算「回回来了」', () => {
    const p = (bubbles: number, last: string, chars: number, sig: string[] = []): ReplyProbe => ({
      bubbles,
      last,
      chars,
      sig,
    })
    // 新开的页面 0 气泡 → 冒出一条：最常见的成功路径
    assert.ok(replyAppeared(p(0, '', 900), p(1, '好的，我来看下这个站点', 924)))
    // 整页字数变了但没有新气泡：计时器、侧栏、虚拟滚动都会造成这种变化
    assert.ok(!replyAppeared(p(2, '回复A', 900), p(2, '回复A', 1500)))
    // 同一条气泡在流式追加：内容换了且确实变长
    assert.ok(replyAppeared(p(1, '好的，', 900), p(1, '好的，先看这里', 913)))
    // 内容换了但总字数没涨够，多半是重排/折叠，不能当回复
    assert.ok(!replyAppeared(p(1, 'aaaaaaaaaa', 900), p(1, 'bbbbbbbbbb', 905)))
    assert.ok(!replyAppeared(p(1, '同一句', 900), p(1, '同一句', 999)))
    // 元宝真机那次：新开对话把示例面板换成真回复 —— 块数不涨、整页字数还跌，只有内容指纹能认出来
    assert.ok(
      replyAppeared(
        p(3, '支持文件格式：jpg、png、pdf', 154, ['专家模式 技能 深度研究 专业写作', '支持文件格式：jpg、png、pdf', '安装电脑版 内容由AI生成']),
        p(3, '支持文件格式：jpg、png、pdf', 154, [
          '专家模式 技能 深度研究 专业写作',
          '你好！我是元宝，腾讯的AI助手。很高兴见到你～有什么我可以帮你的吗？',
          '支持文件格式：jpg、png、pdf',
        ]),
      ),
    )
    // 同一批块只是重新排一遍：指纹集合没变，不能算回复
    assert.ok(!replyAppeared(p(2, '甲', 100, ['这是一条已经存在的长文本块内容', '这是另一条已经存在的长文本块内容']), p(2, '乙', 100, ['这是一条已经存在的长文本块内容', '这是另一条已经存在的长文本块内容'])))
  })

  it('重新识别后保住人答过的字段，且不原地改掉上一轮方案', () => {
    const old = blankPlan()
    old.name = '元宝（用户命名）'
    old.send_mode = 'click'
    old.selectors.stream = 'div.user-picked'
    const fresh = blankPlan()
    fresh.planId = 'plan-new'
    fresh.send_mode = 'enter'
    fresh.selectors.stream = 'div.auto-guessed'
    fresh.questions = [
      { id: 'q1', prompt: '站点叫什么？', target: 'name', options: [] },
      { id: 'q2', prompt: '怎么发送？', target: 'send_mode', options: [] },
      { id: 'q3', prompt: '停止按钮是哪个？', target: 'selectors.stop', options: [] },
    ]
    const merged = preserveAnswers(old, fresh, ['name', 'send_mode', 'selectors.stream'])
    assert.equal(merged.name, '元宝（用户命名）')
    assert.equal(merged.send_mode, 'click')
    assert.equal(merged.selectors.stream, 'div.user-picked')
    assert.equal(merged.planId, 'p1') // 弹窗与主进程都按 planId 索引，换了就找不到方案
    assert.equal(merged.rounds, 2)
    assert.deepEqual(
      merged.questions.map((q) => q.id),
      ['q3'],
    )
    assert.equal(fresh.selectors.stream, 'div.auto-guessed')
  })

  it('注入脚本本身可用：模板转义后的正则仍是 \\s+ 而不是 s+', () => {
    // TS 模板字面量里 \s 会被吃掉一个反斜杠，写错就变成「匹配字母 s」
    assert.ok(PICKER_SCRIPT.includes('replace(/\\s+/g'), 'norm() 的空白折叠正则被转义错了')
    assert.doesNotThrow(() => new Function(PICKER_SCRIPT))
    assert.ok(PICKER_SCRIPT.includes('outline'), '拾取脚本必须提供 outline() 快照')
    assert.ok(PICKER_SCRIPT.includes('verify'), '拾取脚本必须提供 verify() 命中数')
    assert.ok(PICKER_SCRIPT.includes('covers'), 'verify() 必须报告命中元素是否含输入框')
    assert.ok(PICKER_SCRIPT.includes('drive'), '拾取脚本必须提供 drive()：识别链靠它发出第一条消息')
    assert.ok(PICKER_SCRIPT.includes('focusComposer'), '拾取脚本必须提供 focusComposer()：浏览器级输入通道靠它交焦点')
    assert.ok(PICKER_SCRIPT.includes('holds'), '拾取脚本必须提供 holds()：发送成败以「文本还在不在框里」为准')
    assert.ok(PICKER_SCRIPT.includes('reply'), '拾取脚本必须提供 reply() 探针：主进程靠它判断回复长出来没有')
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
    const picker = loadPicker(doc)
    assert.equal(picker.scan().input.length, 1, '输入框候选应只来自可编辑控件')
    assert.equal(picker.scan().stream[0]?.chosen, 'div', '够长的语义类节点应进 stream 候选')
    // 命中范围里含着输入框 = 整页外壳，verify 必须把 covers 报上来
    assert.deepEqual(picker.verify('div'), { ok: true, matches: 2, covers: true })
    assert.deepEqual(picker.verify('[class*="markdown"]'), { ok: true, matches: 1, covers: false })
  })

  it('drive：textarea 走原生 setter，没有发送按钮就按回车', () => {
    const body = '你好，帮我看看这个站点能不能接入'
    const sent: string[] = []
    const ta = stubComposer({
      dispatchEvent: (e: { type: string }) => {
        sent.push(e.type)
      },
    })
    const picker = loadPicker({ body: { innerText: '' }, querySelectorAll: (s: string) => (s === 'textarea' ? [ta] : []) })
    const r = picker.drive('textarea', body, '')
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.via, 'enter')
    assert.equal(ta.__v, body, '没走原生 setter，React 就认为框里没字')
    assert.equal(r.typed, body.length)
    // 清空和写入各发一次 input（受控组件两步都要同步），再回车三件套
    assert.deepEqual(sent, ['input', 'input', 'keydown', 'keypress', 'keyup'])
  })

  it('drive：回车没让站点收单时，才退回去点候选按钮', () => {
    const body = '你好'
    const sent: string[] = []
    const ta = stubComposer({
      dispatchEvent: (e: { type: string }) => {
        sent.push(e.type)
      },
    })
    let clicked = 0
    const btn: Stub = {
      tagName: 'BUTTON',
      offsetParent: {},
      getAttribute: () => '发送',
      getBoundingClientRect: () => ({ left: 700, top: 620, width: 40, height: 40, bottom: 660 }),
      click: () => {
        clicked++
        ta.__v = '' // 真发送：站点把框清空
      },
    }
    const picker = loadPicker({
      body: { innerText: '' },
      querySelectorAll: (s: string) => (s === 'textarea' ? [ta] : s === 'button.send' ? [btn] : []),
    })
    const r = picker.drive('textarea', body, 'button.send')
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.via, 'enter+click')
    assert.equal(clicked, 1)
    assert.equal(r.left, false, '框已空＝站点收下了')
    assert.deepEqual(sent, ['input', 'input', 'keydown', 'keypress', 'keyup'], '先按回车，字还在框里才点按钮')
  })

  it('drive：误点的按钮把页面跳走了，不能当成「消息发出去了」', () => {
    // 元宝那次就是这样：规则把「进入临时对话」认成发送键，一点整页重置、
    // 旧输入框脱离文档后读起来是空的，看着像「站点把消息收走了」，于是白等 90 秒
    const body = '你好'
    const ta = stubComposer()
    let present = true
    const btn: Stub = {
      tagName: 'DIV',
      offsetParent: {},
      getAttribute: () => '进入临时对话',
      getBoundingClientRect: () => ({ left: 20, top: 20, width: 40, height: 40, bottom: 60 }),
      click: () => {
        present = false
      },
    }
    const picker = loadPicker({
      body: { innerText: '' },
      querySelectorAll: (s: string) =>
        s === 'textarea' ? (present ? [ta] : []) : s === 'div.tmp' ? [btn] : [],
    })
    const r = picker.drive('textarea', body, 'div.tmp')
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.absent, true, '输入框没了＝页面被重置')
    assert.equal(r.left, true, '页面跳走一律算没发出去')
  })

  it('drive：没给输入框选择器时按几何认对话框（最靠下、够宽）', () => {
    // 侧栏搜索框又窄又靠上，不该被当成对话框
    const side = stubComposer({ getBoundingClientRect: () => ({ left: 0, top: 40, width: 120, height: 30, bottom: 70 }) })
    const main = stubComposer({ getBoundingClientRect: () => ({ left: 0, top: 600, width: 700, height: 44, bottom: 664 }) })
    const picker = loadPicker({
      body: { innerText: '' },
      querySelectorAll: (s: string) =>
        s === 'textarea,input[type="text"],[contenteditable="true"],[role="textbox"]' ? [side, main] : [],
    })
    const r = picker.drive('', '这条要发进主对话框', '')
    assert.equal(r.ok, true, r.reason)
    assert.equal(main.__v, '这条要发进主对话框')
    assert.equal(side.__v, undefined)
  })

  it('drive：contenteditable 只能走 execCommand insertText', () => {
    // Lexical/Slate/ProseMirror 类输入框：改 textContent 会被它自己的状态覆盖回去
    const body = '这是一条要发出去的消息内容'
    let focused: Stub | null = null
    const ce = stubComposer({
      tagName: 'DIV',
      isContentEditable: true,
      innerText: '',
      matches: (s: string) => s.includes('contenteditable'),
      focus() {
        focused = ce
      },
    })
    const doc: Stub = {
      body: { innerText: '' },
      querySelectorAll: (s: string) => (s === '[contenteditable="true"]' ? [ce] : []),
      execCommand: (cmd: string, _ui: unknown, val: unknown) => {
        if (cmd === 'insertText' && focused) focused.innerText = String(val)
        if (cmd === 'delete' && focused) focused.innerText = ''
        return true
      },
    }
    const r = loadPicker(doc).drive('[contenteditable="true"]', body, '')
    assert.equal(r.ok, true, r.reason)
    assert.equal(ce.innerText, body)
    assert.equal(r.input, 'div 「发消息」', '回报里要带一段人看得懂的控件描述')
  })

  it('drive：站点拒收合成输入时如实报错，不假装发出去了', () => {
    const ta = stubComposer({}, true)
    const picker = loadPicker({ body: { innerText: '' }, querySelectorAll: (s: string) => (s === 'textarea' ? [ta] : []) })
    const r = picker.drive('textarea', '这句话看着进了框', '')
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /拒收/)
  })

  it('drive：页面上没有对话框（停在登录页）时报错并提示人工处理', () => {
    const picker = loadPicker({ body: { innerText: '请先登录' }, querySelectorAll: () => [] })
    const r = picker.drive('textarea', '你好', '')
    assert.equal(r.ok, false)
    assert.match(r.reason ?? '', /找不到/)
  })

  it('focusComposer：交焦点给对话框并回报是哪个元素，找不到就如实说', () => {
    // 浏览器级输入通道（insertText + 真实回车）要先有焦点；成败不靠 activeElement
    // —— 窗口没系统焦点时它会被打回 body，那时误判会把一次本来能成的发送判死
    let focused = 0
    const ta = stubComposer({
      focus() {
        focused++
      },
    })
    const picker = loadPicker({ body: { innerText: '' }, querySelectorAll: (s: string) => (s === 'textarea' ? [ta] : []) })
    const r = picker.focusComposer('textarea')
    assert.equal(r.ok, true)
    assert.equal(focused, 1, '没把焦点交给输入框，insertText 会打进别的控件')
    assert.match(r.input ?? '', /textarea/)
    const empty = loadPicker({ body: { innerText: '请先登录' }, querySelectorAll: () => [] }).focusComposer('textarea')
    assert.equal(empty.ok, false)
    assert.match(empty.reason ?? '', /找不到/)
  })

  it('holds：文本还在框里＝站点没收下；发完清空＝false', () => {
    const ta = stubComposer()
    const picker = loadPicker({ body: { innerText: '' }, querySelectorAll: (s: string) => (s === 'textarea' ? [ta] : []) })
    assert.equal(picker.drive('textarea', '你好呀', '').ok, true, '先把文本写进框')
    assert.equal(picker.holds('textarea', '你好呀'), true)
    ta.__v = ''
    assert.equal(picker.holds('textarea', '你好呀'), false, '框空了＝站点把消息交出去了')
    assert.equal(picker.holds('textarea', ''), false, '空文本不构成「还留着」')
  })

  it('bubble：页面上真多出这句话的气泡才算「站点收下了」', () => {
    const body = '你好，帮我看下这个站点'
    const ta = stubComposer()
    const node = (text: string, extra: Stub = {}): Stub => ({
      offsetParent: {},
      innerText: text,
      matches: () => false,
      querySelector: () => null,
      ...extra,
    })
    const mine = node(body)
    const shell = node(body + '其余整页文字', { querySelector: () => ta }) // 罩着输入框＝不是气泡
    const picker = loadPicker({
      body: { innerText: '' },
      querySelectorAll: (s: string) => {
        if (s === 'textarea') return [ta]
        if (s === 'div,section,article,li,p,span') return [shell, mine]
        return []
      },
    })
    assert.equal(picker.bubble(body), true, '用户气泡和输入框里的字一样长，正是「发出去了」的证据')
    assert.equal(picker.bubble('这句话页面上并没有'), false)
    assert.equal(picker.bubble(''), false, '空文本不构成证据')
  })

  it('drive：换 URL 的开对话站点用 echoed 说明消息真的在页面上', () => {
    const body = '你好'
    const ta: Stub = stubComposer()
    // 站点在回车这一下把草稿收走：框清空，同时页面上长出用户气泡
    ta.dispatchEvent = (e: { type: string }) => {
      if (e.type === 'keydown') ta.__v = ''
    }
    const bubbleNode: Stub = {
      offsetParent: {},
      innerText: body,
      matches: () => false,
      querySelector: () => null,
    }
    const picker = loadPicker({
      body: { innerText: body },
      querySelectorAll: (s: string) => {
        if (s === 'textarea') return [ta]
        if (s === 'div,section,article,li,p,span') return [bubbleNode]
        return []
      },
    })
    const r = picker.drive('textarea', body, '')
    assert.equal(r.ok, true, r.reason)
    assert.equal(r.left, false, '框已被清空')
    assert.equal(r.absent, false, '输入框还在，页面只是补上了会话 id')
    assert.equal(r.echoed, true, '页面上找得到这句话')
  })

  it('drive：空文本不发', () => {
    const picker = loadPicker({ body: { innerText: '' }, querySelectorAll: () => [stubComposer()] })
    assert.equal(picker.drive('textarea', '   ', '').ok, false)
  })

  it('reply：长文本块才算回复；外壳、短句、刚发出去的提问都不算', () => {
    const node = (text: string, extra: Stub = {}): Stub => ({
      offsetParent: {},
      innerText: text,
      childElementCount: 0,
      matches: () => false,
      querySelector: () => null,
      getAttribute: () => null,
      contains(other: Stub) {
        return (this as Stub).__kids?.includes(other) === true
      },
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 120, bottom: 120 }),
      ...extra,
    })
    const ta = stubComposer()
    const short = node('a'.repeat(12)) // 不够长，更像按钮文案或占位
    const reply = node('b'.repeat(40))
    const shell = node('c'.repeat(80), { querySelector: () => ta }) // 罩着输入框＝整页外壳
    const tiny = node('好的')
    const wrapper = node('d'.repeat(60), { __kids: [reply] }) // 包裹层，回复在它里面：只该数最里面那条
    Object.assign(reply, { __parent: wrapper })
    const mine = node('你好，帮我把这个站点的对话结构梳理一下再给结论吧，谢谢') // 刚替用户发出去的那句
    const doc: Stub = {
      body: { innerText: 'x'.repeat(500) },
      querySelectorAll: (s: string) => {
        if (s === 'div,section,article,li,p,span') return [shell, short, wrapper, reply, tiny, mine]
        if (s.includes('contenteditable') || s.includes('textarea')) return [ta]
        return []
      },
    }
    const r = loadPicker(doc).reply('你好，帮我把这个站点的对话结构梳理一下再给结论吧，谢谢')
    assert.equal(r.error, undefined, String(r.error))
    assert.equal(r.bubbles, 1, '外壳/短句/包裹层/自己发出去的那句都不该算回复')
    assert.equal(r.last, 'b'.repeat(40))
    assert.equal(r.chars, 500)
    assert.equal(loadPicker(doc).reply('').bubbles, 2, '不给 echo 时自己那条也在内——正好说明排掉是必要的')
    assert.deepEqual(r.sig, ['b'.repeat(40)], 'sig 是「这一页说过哪些话」的指纹：换掉示例面板时要靠它认出新增的那块')
  })

  it('reply：哈希类名站点没有语义类，靠长文本块数出第一条回复', () => {
    // 元宝的气泡 class 是哈希串，语义类一条都不命中；而首轮对话里用户气泡和
    // 助手气泡 class 也不同，「和兄弟同类」的老判据永远数不到第一条回复
    const ta = stubComposer()
    const node = (text: string): Stub => ({
      offsetParent: {},
      className: '_x1a2b3c',
      innerText: text,
      matches: () => false,
      querySelector: () => null,
      contains: () => false,
      getAttribute: () => null,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 200, bottom: 200 }),
    })
    const mine = node('你好')
    const answer = node('你好呀！我可以帮你看看这个站点，先把页面结构读一遍再说结论。')
    const doc: Stub = {
      body: { innerText: 'y'.repeat(120) },
      querySelectorAll: (s: string) => {
        if (s === 'div,section,article,li,p,span') return [mine, answer]
        if (s.includes('textarea')) return [ta]
        return []
      },
    }
    const r = loadPicker(doc).reply('你好')
    assert.equal(r.bubbles, 1)
    assert.equal(r.last, '你好呀！我可以帮你看看这个站点，先把页面结构读一遍再说结论。')
  })

  console.log('\n=== 方案 → 适配器规格（创建路径唯一定义处）===')

  // 真机验证（doctor --live）与设置页「直接创建」共用 setup/web-spec.ts。
  // 一旦两处各写一份映射，命令行的「能跑」就对不上 app 里那个模型，验证结论作废。
  const planLike = (over: Partial<WebPlan>): WebPlan =>
    ({
      planId: 'p1',
      entry: 'https://yuanbao.tencent.com/',
      name: '元宝',
      selectors: {
        input: 'div.ql-editor.ql-blank',
        send: '',
        stop: '',
        stream: 'div.hyc-common-markdown',
        generating: '',
      },
      input_kind: 'contenteditable',
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
      login: { state: 'logged-in', reason: '有输入框' },
      rounds: 1,
      ...over,
    }) as WebPlan

  it('元宝这套配置映射出来的 spec 就是运行时认的形态', () => {
    const spec = webSpecFromPlan('web-yuanbao', webModelInputFromPlan(planLike({})))
    assert.equal(spec.transport, 'webview')
    assert.equal(spec.entry, 'https://yuanbao.tencent.com/')
    assert.equal(spec.selectors.input, 'div.ql-editor.ql-blank')
    assert.equal(spec.selectors.stream, 'div.hyc-common-markdown')
    // 代发证明的是「浏览器级回车」这条路，空 send 不能让映射又退回点按钮
    assert.equal(spec.send_mode, 'enter')
    assert.ok(!('send' in spec.selectors), 'send 为空就不该写进 selectors')
    assert.equal(spec.completion.mode, 'dom_stable')
    assert.equal(spec.completion.stable_ms, 3000)
    assert.ok(spec.completion.timeout_s > spec.automation.max_wait_s, 'timeout_s 必须比 max_wait_s 宽，否则回合被自己掐断')
    assert.equal(spec.health_probe, 'div.ql-editor.ql-blank')
    assert.equal(spec.origin, 'user')
  })

  it('custom 完成策略不许漏进运行时', () => {
    // custom 只是推断阶段的中间表达，注入脚本不认；漏进去这轮永远等不到完成判定
    const spec = webSpecFromPlan('web-x', webModelInputFromPlan(planLike({ completion_mode: 'custom' as never })))
    assert.equal(spec.completion.mode, 'dom_stable')
    assert.equal(spec.completion.stable_ms, 3000)
  })

  it('选择器全缺省也要给出可运行的骨架', () => {
    const spec = webSpecFromPlan('web-y', { displayName: '某站', entry: 'https://x.dev/' })
    assert.equal(spec.name, '某站')
    assert.equal(spec.selectors.input, 'textarea')
    assert.equal(spec.selectors.stream, 'div')
    assert.equal(spec.send_mode, 'enter', '没有发送按钮就只能按回车')
    assert.equal(spec.completion.mode, 'dom_stable')
  })

  it('有发送按钮时默认走 click', () => {
    const spec = webSpecFromPlan('web-z', {
      displayName: 'z',
      entry: 'https://x.dev/',
      selectors: { input: 'textarea', send: 'button.send', stream: 'div.msg' },
    })
    assert.equal(spec.send_mode, 'click')
    assert.equal(spec.selectors.send, 'button.send')
  })

  it('id 从名称派生，中文名称也不会生成空 id', () => {
    assert.equal(webModelSlug('元宝'), 'custom')
    assert.equal(webModelSlug('DeepSeek Web'), 'deepseek-web')
    assert.equal(webModelSlug('ChatGPT 免费版'), 'chatgpt')
  })

  it('静态守卫：主进程建模型必须走 webSpecFromPlan', () => {
    const src = readFileSync(join(__dirname, '..', 'src', 'main', 'index.ts'), 'utf8')
    const at = src.indexOf('async function createWebModel')
    assert.ok(at > 0, 'createWebModel 不见了')
    const next = src.indexOf('\nfunction ', at + 10)
    const body = src.slice(at, next > 0 ? next : at + 2500)
    assert.match(body, /webSpecFromPlan\(/, 'createWebModel 又自己拼 spec —— 真机验证就与创建路径脱钩了')
    assert.match(body, /webModelSlug\(/, 'id 派生规则也必须同一份')
    assert.doesNotMatch(body, /typing_delay_ms:/, '自动化参数不该在创建处再写一遍')
  })

  console.log('\n=== 识别窗口与网页视图：谁开的、谁能关 ===')

  // 这一节守的是「用户关得掉」这一件事。它坏掉的方式不会报错：
  // 窗口压在应用之上、找不到关闭入口、关一次又被被动复验偷偷重开 —— 用户只能放弃。
  const read = (p: string[]): string => readFileSync(join(__dirname, '..', ...p), 'utf8')
  const smartSrc = read(['src', 'main', 'setup', 'smart-add.ts'])
  const poolSrc = read(['src', 'main', 'webview', 'pool.ts'])
  const cssSrc = read(['src', 'renderer', 'styles.css'])
  const drawerSrc = read(['src', 'renderer', 'components', 'AssistantDrawer.tsx'])
  const appSrc = read(['src', 'renderer', 'App.tsx'])

  it('识别窗口顶着 Torra 自己的标题，不被站点标题换掉', () => {
    assert.match(smartSrc, /export const SCAN_WINDOW_TITLE = 'Torra · 网页识别窗口/)
    assert.match(smartSrc, /title: SCAN_WINDOW_TITLE/)
    // 站点的 <title> 一更新，窗口就变成「元宝」，用户分不清这是谁开的、该在哪儿关
    assert.match(poolSrc, /'page-title-updated', \(e\) => e\.preventDefault\(\)/)
  })

  it('用户关掉的识别窗口不会被被动复验偷偷重开', () => {
    const ensure = smartSrc.slice(
      smartSrc.indexOf('async function ensureScanWindow'),
      smartSrc.indexOf('async function resolveAssistant'),
    )
    assert.match(ensure, /if \(scanDismissed && !reopen\) return null/)
    const page = smartSrc.slice(
      smartSrc.indexOf('async function ensurePage'),
      smartSrc.indexOf('/** 用户答完澄清问题'),
    )
    assert.match(page, /ensureScanWindow\(entry, false\)/, '被动复验路径必须 reopen=false')
    // 只有「重新识别」这一个明确意图保留重开的权利
    assert.match(smartSrc, /await ensureScanWindow\(parsed\.toString\(\)\)/)
  })

  it('closeScanWindow 先摘引用再 destroy：据此区分用户关与程序关', () => {
    const at = smartSrc.indexOf('function closeScanWindow')
    const body = smartSrc.slice(at, smartSrc.indexOf('\n  }', at))
    assert.ok(
      body.indexOf('scanWin = null') < body.indexOf('w.destroy()'),
      'destroy 之前必须先把 scanWin 摘掉，否则回调会把程序自己的关闭误判成用户关闭',
    )
  })

  it('窗口的开与关都推给界面，界面上有按得动的关闭', () => {
    assert.match(smartSrc, /deps\.onScanWindow\(\{ open: true, entry \}\)/)
    assert.match(smartSrc, /deps\.onScanWindow\(\{ open: false \}\)/)
    assert.match(appSrc, /on\('smartadd:scan-window'/)
    assert.match(appSrc, /window\.torra\.smartAddClose\(\)/)
  })

  it('助手抽屉开着时，网页视图让出它占的那条带', () => {
    // WebContentsView 永远画在渲染层之上：不让位就会连抽屉一起压住，
    // 而抽屉的关闭按钮正是被压住的那块 DOM
    assert.match(drawerSrc, /classList\.add\('assistant-open'\)/)
    assert.match(drawerSrc, /--a-drawer-reserve/)
    assert.match(cssSrc, /body\.assistant-open \.webview-dock \{ padding-right: var\(--a-drawer-reserve/)
    // 让位宽度必须每次重新实测：只挂一次的 ResizeObserver 在全屏档下不重测，
    // 于是变量永远停在 440 的兜底值上，网页照旧压在抽屉身上
    const reserve = drawerSrc.slice(
      drawerSrc.indexOf('const sync = () => {'),
      drawerSrc.indexOf('}, [full])'),
    )
    assert.ok(reserve.length > 80, '让位宽度的那段 effect 找不到了')
    assert.match(reserve, /rootRef\.current/, 'sync 里要现读节点，不能只在挂载时抓一次引用')
    assert.match(drawerSrc, /\}, \[full\]\)/, 'effect 必须随全屏档重新绑定')
    // CSS 让不开时（宿主被 flex 撑破视口）由这里按视口坐标硬夹，夹没了就摘掉视图
    const dockSrc = read(['src', 'renderer', 'components', 'WebviewDock.tsx'])
    assert.match(dockSrc, /Math\.min\(r\.right, right\)/)
    assert.match(dockSrc, /b\.width < 24 \|\| b\.height < 24[\s\S]{0,200}dismissWebview/)
    // 让位量必须每帧现读 CSS 变量：抽屉改宽度时本容器矩形可以不变，
    // 只盯矩形（或只挂一次 MutationObserver）就会永远停在旧的让位值上
    assert.match(dockSrc, /requestAnimationFrame\(tick\)/, '贴合改用逐帧轮询，事件补漏已经不够')
    assert.match(dockSrc, /getPropertyValue\('--a-drawer-reserve'\)/, '要盯住变量本身，不能只在挂载时读一次')
  })

  it('附件图片预览走 blob，CSP 必须放行；点开能放大，Esc 不越级', () => {
    // 渲染层是 file:// 页面，img-src 少一个 blob: 就是输入框里一枚坏图占位符，
    // 不报错、不提示，用户只会以为「粘贴没生效」
    const htmlSrc = read(['src', 'renderer', 'index.html'])
    assert.match(htmlSrc, /img-src [^;]*blob:/)
    const zoomSrc = read(['src', 'renderer', 'components', 'ImageZoom.tsx'])
    // 放大层挂在顶层：玻璃容器的 backdrop-filter 会成为 fixed 的包含块，就地画会被裁掉
    assert.match(appSrc, /<ImageZoomHost \/>/)
    assert.match(cssSrc, /\.img-zoom-mask \{[\s\S]{0,200}z-index: 200/)
    // 捕获阶段截下 Esc，否则图关了、助手抽屉也跟着关
    assert.match(zoomSrc, /addEventListener\('keydown', onKey, true\)/)
    assert.match(zoomSrc, /e\.stopPropagation\(\)/)
    const chatSrc = read(['src', 'renderer', 'components', 'ChatPage.tsx'])
    assert.match(chatSrc, /onClick=\{\(\) => openImageZoom\(p\.url!,/, '输入框缩略图要点得开')
    assert.match(chatSrc, /onClick=\{\(\) => openImageZoom\(url, att\.name\)\}/, '消息里的附件图要点得开')
  })

  it('助手抽屉有全屏档，且 Esc 逐层退', () => {
    assert.match(drawerSrc, /assistant-drawer\$\{full \? ' full' : ''\}/)
    assert.match(cssSrc, /\.assistant-drawer\.full \{/)
    assert.match(cssSrc, /\.assistant-resize-handle \{/)
    assert.match(drawerSrc, /if \(fullRef\.current\) \{[\s\S]{0,160}toggleFull\(\)/)
    // 视图偏好要留得住：每次重开都回到 440px 等于没有这一档
    assert.match(drawerSrc, /writeFullPref\(next\)/)
    assert.match(drawerSrc, /writeInsetPref\(insetRef\.current\)/)
  })

  console.log(`\n${'='.repeat(46)}`)
  console.log(`  通过 ${pass} · 失败 ${fail}`)
  console.log('='.repeat(46) + '\n')
  process.exit(fail > 0 ? 1 : 0)
}

void main()
