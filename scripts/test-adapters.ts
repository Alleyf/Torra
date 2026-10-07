/**
 * 适配器 YAML 校验回归（开发期自检）
 *
 * 为什么要单独守住：适配器 YAML 是纯数据，tsc 不会检查它。
 * 一个选择器写错或字段缺失，运行时只表现为「该模型打开失败」，
 * 排查成本极高。故在此对全部内置适配器做静态校验。
 *
 * 运行：npm run test:adapters
 */

import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { validateSpec } from '../src/main/adapters/registry'
import { ADAPTER_STALE_DAYS } from '../src/shared/adapter'
import { INJECT_SCRIPT } from '../src/main/webview/inject'
import { PICKER_SCRIPT } from '../src/main/webview/picker'

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

async function itAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`)
  } catch (e) {
    fail++
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}`)
    console.log(`       ${(e as Error).message.split('\n')[0]}`)
  }
}

const ADAPTER_DIR = path.resolve(__dirname, '..', 'adapters')

async function main(): Promise<void> {
  const files = (await fs.readdir(ADAPTER_DIR)).filter((f) => f.endsWith('.yaml'))
  const specs = new Map<string, unknown>()

  for (const f of files) {
    const raw = YAML.parse(await fs.readFile(path.join(ADAPTER_DIR, f), 'utf8'))
    specs.set(f.replace(/\.ya?ml$/, ''), raw)
  }

  console.log(`\n=== 内置适配器校验（${files.length} 份）===`)

  it('全部内置适配器通过结构校验', () => {
    const bad: string[] = []
    for (const [name, raw] of specs) {
      const r = validateSpec(raw)
      if (!r.ok) bad.push(`${name}: ${r.errors.join('; ')}`)
    }
    assert.equal(bad.length, 0, bad.join('\n'))
  })

  it('DeepSeek 可用（此前该站无适配器，网页通道完全打不开）', () => {
    assert.ok(specs.has('deepseek'), '缺少 deepseek.yaml')
    const r = validateSpec(specs.get('deepseek'))
    assert.ok(r.ok, r.ok ? '' : r.errors.join('; '))
  })

  it('DeepSeek 用文本稳定判定而非停止按钮', () => {
    // 逆向确证：DeepSeek 发送与停止复用同一 button，
    // 「按钮消失」永远不成立，用 stop_button_hidden 会永远判定已完成。
    const s = specs.get('deepseek') as { completion: { mode: string } }
    assert.equal(s.completion.mode, 'dom_stable')
  })

  it('DeepSeek 启动时做页面预检以识别 localStorage 登录态', () => {
    const s = specs.get('deepseek') as { prewarm?: boolean }
    assert.equal(s.prewarm, true)
  })

  it('DeepSeek 输入框候选全部指向聊天输入框', () => {
    /*
     * 2026-10-04 抓线上 main.6fca03582d.js（meta commit-id=44809ea4）逐个核对：
     * - name:"user query" 出现在 DSL Textarea 的 textareaDomProps 里，同处带 Enter 提交分支；
     * - name:"search" 是自适应 textarea 组件硬编码的 name，该组件有 ArrowUp 取历史
     *   + Enter 调 submit('enter')，是输入框而不是搜索框；
     * - 占位符来自 i18n chatInputPlaceholderChat「给 DeepSeek 发送消息 」。
     * 三档都是输入框特征，任何一档在场都能用。
     */
    const s = specs.get('deepseek') as { selectors: Record<string, string> }
    for (const cand of ['user query', 'search', '给 DeepSeek 发送消息']) {
      assert.ok(s.selectors.input.includes(cand), `输入候选缺少 ${cand}`)
    }
    assert.doesNotMatch(s.selectors.input, /\[class\*="_|:r\d+:/, '输入候选含易漂 token')
  })

  it('DeepSeek 正文/思考分通道并以 Enter 发送', () => {
    // 2026-10-04 domscan 实测：div.ds-markdown 同时罩住思考块，会把思维链混进正文。
    // 正文只认 .ds-assistant-message-main-content，思考走独立的 .ds-think-content。
    const s = specs.get('deepseek') as { selectors: Record<string, string>; send_mode?: string }
    assert.equal(s.selectors.stream, 'div.ds-assistant-message-main-content')
    assert.equal(s.selectors.reasoning, 'div.ds-think-content')
    assert.equal(s.send_mode, 'enter')
    assert.ok(!s.selectors.send, 'send_mode=enter 后不应再保留发送按钮选择器')
  })

  it('Kimi 声明为 contenteditable 且拼接全部 segment', () => {
    // Kimi 是 Lexical 富文本：逐字改 textContent 会被其状态机覆盖，
    // 且单条 segment 只含片段内容，故必须 all。
    const s = specs.get('kimi') as {
      input_kind?: string
      stream_mode?: string
      selectors: Record<string, string>
      steps_mode?: string
    }
    assert.equal(s.input_kind, 'contenteditable')
    assert.equal(s.stream_mode, 'all')
    // domscan 实测：正文=.markdown-container（排除 toolcall 子树），
    // 执行过程=toolcall-rollup/plugin-toolcall-item/tool-call-section，两通道必须分离
    assert.match(s.selectors.stream, /markdown-container/)
    assert.doesNotMatch(s.selectors.stream.slice(0, s.selectors.stream.indexOf(':not')), /toolcall-content-text/, '正文不应直接命中过程节点')
    assert.match(s.selectors.stream, /toolcall-content-text/, '正文需用 :not 排除过程节点')
    assert.match(s.selectors.steps, /toolcall-rollup/)
    assert.equal(s.steps_mode, 'all')
  })

  it('豆包用 data-testid 而非哈希类名', () => {
    const s = specs.get('doubao') as { selectors: Record<string, string> }
    assert.match(s.selectors.input, /data-testid/, '哈希类名会随发版失效')
    assert.match(s.selectors.stop, /data-testid/)
  })

  it('qwen 的停止按钮与发送按钮可区分', () => {
    const s = specs.get('qwen') as { selectors: Record<string, string>; completion: { mode: string } }
    assert.notEqual(s.selectors.send, s.selectors.stop)
    assert.equal(s.completion.mode, 'stop_button_hidden')
  })

  it('全部适配器新鲜度在阈值内', () => {
    const stale: string[] = []
    for (const [name, raw] of specs) {
      const s = raw as { verified_at: string }
      const days = (Date.now() - Date.parse(s.verified_at)) / 86_400_000
      if (!(days >= 0) || days > ADAPTER_STALE_DAYS) stale.push(`${name} (${s.verified_at})`)
    }
    assert.equal(stale.length, 0, `以下适配器已「长期未验证」：${stale.join(', ')}`)
  })

  it('全部适配器均带服务条款提示', () => {
    // PRD 11.3：首次接入须向用户提示自动化访问风险
    const missing: string[] = []
    for (const [name, raw] of specs) {
      const s = raw as { tos_notice?: string }
      if (!s.tos_notice || s.tos_notice.trim().length < 5) missing.push(name)
    }
    assert.equal(missing.length, 0, `缺少 tos_notice：${missing.join(', ')}`)
  })

  it('ChatGPT 兼容当前 ProseMirror 编辑器与本地化按钮', () => {
    const s = specs.get('chatgpt') as { selectors: Record<string, string>; health_probe: string }
    assert.match(s.selectors.input, /contenteditable="true"\]\[role="textbox"/)
    assert.match(s.selectors.input, /aria-label\*="ChatGPT"/)
    assert.match(s.selectors.input, /#prompt-textarea/, '应保留旧版 textarea 作为回退')
    // 实测发送按钮是 button[aria-label="发送"]（英文 Send），「发送消息」已 0 命中
    assert.match(s.selectors.send, /Send" i/)
    assert.match(s.selectors.send, /发送/)
    assert.match(s.selectors.stop, /停止/)
    assert.equal(s.health_probe, s.selectors.input)
  })

  console.log('\n=== 注入脚本可执行性 ===')

  it('INJECT_SCRIPT 语法合法', () => {
    assert.doesNotThrow(() => {
      // eslint-disable-next-line no-new-func
      new Function(`return (${INJECT_SCRIPT.trim().replace(/;$/, '')})`)
    }, 'INJECT_SCRIPT 存在语法错误')
  })

  it('PICKER_SCRIPT 语法合法', () => {
    assert.doesNotThrow(() => {
      // eslint-disable-next-line no-new-func
      new Function(`return (${PICKER_SCRIPT.trim().replace(/;$/, '')})`)
    }, 'PICKER_SCRIPT 存在语法错误')
  })

  it('登录墙判定早于选择器判定', () => {
    const loginIdx = INJECT_SCRIPT.indexOf('isLoginWall()')
    const inputIdx = INJECT_SCRIPT.indexOf('spec.selectors.input')
    assert.ok(loginIdx > 0 && inputIdx > 0)
    assert.ok(loginIdx < inputIdx, '未登录时会被误报为适配器失效')
  })

  it('React 受控输入走原生 setter（否则键入无效）', () => {
    // 直接 el.value += x 会被 React 的 value tracker 忽略，表现为「打了字但框里空着」
    assert.match(INJECT_SCRIPT, /getOwnPropertyDescriptor/)
    assert.match(INJECT_SCRIPT, /HTMLTextAreaElement/)
  })

  it('contenteditable 走 execCommand（富文本编辑器唯一可用通道）', () => {
    assert.match(INJECT_SCRIPT, /execCommand\('insertText'/)
  })

  it('完成判定支持降级而非单点失败', () => {
    assert.match(INJECT_SCRIPT, /dom_stable/)
    assert.match(INJECT_SCRIPT, /generating_absent/)
  })

  it('ChatGPT 复用既有回复节点时仍能捕获本轮内容', () => {
    // ChatGPT 有时填充发送前已经存在的 assistant 节点，不能只按节点数量截断。
    assert.match(INJECT_SCRIPT, /baselineTail/)
    assert.match(INJECT_SCRIPT, /tail !== baselineTail/)
    assert.match(INJECT_SCRIPT, /tail\.slice\(baselineTail\.length\)/)
    assert.match(INJECT_SCRIPT, /streamBaselineText/)
  })

  await itAsync('带附件的一轮：收据判开始、用户回合不进正文', async () => {
    // 图片轮次的实测故障（DeepSeek）：站点早已收下这一轮，但回复容器要等上传 + 视觉理解
    // 才长出来，只按「容器变长」判开始会把成立的发言判死；同时带 blob 缩略图 + 文件名的
    // 用户那句落在同一个回合容器里，会被当成本轮回复读走（答非所问的源头）。
    assert.match(INJECT_SCRIPT, /pressSend: function \(spec, prompt, attachments\)/)
    assert.match(INJECT_SCRIPT, /accepted: true/, '缺少「输入框已清空 = 站点收下单」的收据分支')
    assert.match(INJECT_SCRIPT, /isAttachmentTurn\(nodes\[k\]/, 'all 模式没过滤用户回合')
    assert.match(INJECT_SCRIPT, /isAttachmentTurn\(nodes\[j\]/, 'last 模式没过滤用户回合')
    assert.match(INJECT_SCRIPT, /isAttachmentTurn\(lastNode/, '复用节点回退没过滤用户回合')
    // 主进程侧两条时间线：空正文不能太早判完成，也不能拖到 max_wait 才说清是哪段
    const wvSrc = await fs.readFile(path.join(__dirname, '../src/main/agents/webview-agent.ts'), 'utf8')
    assert.match(wvSrc, /FIRST_TOKEN_GRACE_MS/, '空正文的首字宽限期没了')
    assert.match(wvSrc, /NO_CONTENT_MS/, '已接收但零产出的止损线没了')
    // 结论必须分家：站点没接走（下一轮可能就好）≠ 适配器指错元素（要改选择器），
    // 也 ≠ 已接收但没回复（该重发或去网页看一眼）。混成 adapter-broken 会把好适配器标红。
    assert.match(wvSrc, /notStarted \? 'not-started' : 'adapter-broken'/, '发送失败的结论又合回一条了')
    assert.match(wvSrc, /new AgentError\('no-reply'/, '已接收但零产出的结论丢了')
    const agentSrc = await fs.readFile(path.join(__dirname, '../src/main/agents/agent.ts'), 'utf8')
    assert.match(agentSrc, /'not-started':[\s\S]{0,60}本轮没发出去/, '「没发出去」的文案不成人话')
    assert.match(agentSrc, /case 'no-reply':/, '「已接收但没回复」的文案没了')
  })

  await itAsync('旧会话文本不会被当成本轮发言（陈旧快照防护）', async () => {
    // 豆包工作流/虚拟化实测：发送后页面重排，上一会话的长回答会以
    // 「新增索引」的身份出现在 sinceCount 之后，索引防线失守。
    // 唯一可靠的内容防线是发送瞬间的文本快照 —— 本测试驱动真实 send/read 验证。
    const state: any = { nodes: [{ innerText: 'OLD ANSWER' }] }
    class FakeInput {
      _v = ''
      offsetParent = null
      isContentEditable = false
      focus() {}
      dispatchEvent() {}
      getAttribute() { return '' }
    }
    Object.defineProperty(FakeInput.prototype, 'value', {
      get(this: FakeInput) { return this._v },
      set(this: FakeInput, v: string) { this._v = v },
      configurable: true,
    })
    state.input = new FakeInput()
    state.send = {
      offsetParent: null,
      click() { state.nodes.push({ innerText: 'NEW ANSWER' }) },
    }
    const qsa = (sel: string): any[] =>
      sel === '#i' ? [state.input] : sel === '#s' ? [state.send] : sel === '.a' ? state.nodes : []
    const g = globalThis as any
    const saved: Record<string, unknown> = {}
    for (const k of ['document', 'location', 'window', 'HTMLInputElement', 'Event']) saved[k] = g[k]
    g.document = { body: {}, contains: () => true, querySelector: (s: string) => qsa(s)[0] || null, querySelectorAll: qsa, addEventListener: () => {} }
    g.location = { pathname: '/chat', href: 'https://fake/chat' }
    g.window = {}
    g.HTMLInputElement = FakeInput
    g.Event = class { constructor(public type: string, public init?: unknown) {} }
    try {
      new Function(INJECT_SCRIPT)()
      const torra = g.window.__torra
      const spec = {
        selectors: { input: '#i', stream: '.a', send: '#s' },
        input_kind: 'textarea',
        send_mode: 'click',
        stream_mode: 'last',
        automation: { typing_delay_ms: [0, 0], pre_send_pause_ms: [0, 0], jitter: false },
      }
      const res = await torra.send(spec, 'hi')
      assert.equal(res.ok, true, `send 未通过：${res.reason}`)
      assert.equal(res.streamCount, 1, '基线应是发送前已有的 1 个旧节点')
      // 正常新增节点：照常返回
      assert.equal(torra.read('.a', 'last', 1, 'OLD ANSWER', 'hi'), 'NEW ANSWER')
      // 虚拟化重排：旧文本以新索引混进来 —— 必须跳过，继续找真正的新内容
      state.nodes.push({ innerText: 'OLD ANSWER' })
      assert.equal(torra.read('.a', 'last', 1, 'OLD ANSWER', 'hi'), 'NEW ANSWER')
      // all 模式同样不吃陈旧快照
      assert.equal(torra.read('.a', 'all', 0, '', 'hi'), 'NEW ANSWER')
    } finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete g[k]
        else g[k] = saved[k]
      }
    }
  })

  await itAsync('空态 class 随字消失也要能发出（Quill / 元宝）', async () => {
    // div.ql-editor.ql-blank 里的 .ql-blank 只在编辑器为空时存在，字一落地就被移除，
    // 选择器从此查无此框。发送阶段若按选择器重查，就报「input vanished before send」——
    // 元宝真机踩过；这里用会自毁的选择器把整条 typePrompt → pressSend 链跑通。
    const state: any = { nodes: [], typed: '', enters: 0 }
    const editor: any = {
      tagName: 'DIV',
      className: 'ql-editor ql-blank',
      isContentEditable: true,
      offsetParent: {},
      textContent: '',
      get innerText() { return state.typed },
      getBoundingClientRect: () => ({ width: 600, height: 40 }),
      getAttribute: () => '',
      focus() {},
      dispatchEvent(ev: any) {
        // 站点只监听 keydown（一次发送只该生成一条回复）
        if (ev.type !== 'keydown' || ev.key !== 'Enter') return
        state.enters += 1
        state.nodes.push({ innerText: 'SITE ANSWER' })
        state.typed = ''
      },
    }
    const qsa = (sel: string): any[] => {
      if (sel === 'div.ql-editor.ql-blank') return state.typed.length ? [] : [editor]
      if (sel === '.a') return state.nodes
      return []
    }
    const g = globalThis as any
    const saved: Record<string, unknown> = {}
    for (const k of ['document', 'location', 'window', 'HTMLInputElement', 'Event', 'KeyboardEvent']) saved[k] = g[k]
    g.document = {
      body: { innerText: '' },
      title: 'fake',
      readyState: 'complete',
      visibilityState: 'visible',
      querySelector: (s: string) => qsa(s)[0] || null,
      querySelectorAll: qsa,
      addEventListener: () => {},
      contains: (el: unknown) => el === editor,
      execCommand: (_: string, __: boolean, v: string) => { state.typed += v; return true },
    }
    g.location = { pathname: '/chat', href: 'https://fake/chat' }
    g.window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }), innerWidth: 1280, innerHeight: 900 }
    g.HTMLInputElement = class {}
    g.Event = class { constructor(public type: string, public init?: unknown) {} }
    g.KeyboardEvent = class { type: string; key: string; constructor(t: string, init: any) { this.type = t; this.key = init.key } }
    try {
      new Function(INJECT_SCRIPT)()
      const torra = g.window.__torra
      const spec = {
        selectors: { input: 'div.ql-editor.ql-blank', stream: '.a' },
        input_kind: 'contenteditable',
        send_mode: 'enter',
        stream_mode: 'last',
        automation: { typing_delay_ms: [0, 0], pre_send_pause_ms: [0, 0], jitter: false },
      }
      const res = await torra.send(spec, 'hi')
      assert.equal(res.ok, true, `send 未通过：${res.reason}`)
      assert.equal(state.enters, 1, '回车应派发在键入过的那个节点上')
      assert.equal(torra.read('.a', 'last', 0, '', 'hi'), 'SITE ANSWER')
    } finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete g[k]
        else g[k] = saved[k]
      }
    }
  })

  await itAsync('站点拒收整段写入时退回逐字（不是发半句出去）', async () => {
    // 整段 insertText 是把 90% 的墙钟从「我们敲字」变成「站点生成」的唯一杠杆，
    // 但它是个未经真机验证的假设：个别编辑器只吃单字符 insertText。
    // 兜底必须是「判定不通过 → 清空 → 逐字」，而不是带着半句话按发送。
    const state: any = { typed: '', calls: [] as string[] }
    const editor: any = {
      tagName: 'DIV',
      className: 'ql-editor',
      isContentEditable: true,
      offsetParent: {},
      textContent: '',
      get innerText() { return state.typed },
      getBoundingClientRect: () => ({ width: 600, height: 40 }),
      getAttribute: () => '',
      focus() {},
      dispatchEvent() {},
    }
    const g = globalThis as any
    const saved: Record<string, unknown> = {}
    for (const k of ['document', 'location', 'window', 'HTMLInputElement', 'Event']) saved[k] = g[k]
    g.document = {
      body: { innerText: '' },
      title: 'fake',
      readyState: 'complete',
      visibilityState: 'visible',
      // 只认输入框这一个选择器：裸写 () => editor 会让登录墙探针
      // （form[action*=login] 等）也命中假框，整轮被判成未登录
      querySelector: (s: string) => (s.indexOf('#box') >= 0 ? editor : null),
      querySelectorAll: (sel: string) => (sel === '#box' ? [editor] : []),
      addEventListener: () => {},
      contains: (el: unknown) => el === editor,
      // 这位站点只接受一个字符一次的 insertText
      execCommand: (_: string, __: boolean, v: string) => {
        state.calls.push(v)
        if (String(v).length > 1) return false
        state.typed += v
        return true
      },
    }
    g.location = { pathname: '/chat', href: 'https://fake/chat' }
    g.window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }), innerWidth: 1280, innerHeight: 900 }
    g.HTMLInputElement = class {}
    g.Event = class { constructor(public type: string, public init?: unknown) {} }
    try {
      new Function(INJECT_SCRIPT)()
      const torra = g.window.__torra
      const spec = {
        selectors: { input: '#box', stream: '.a', send: '#s' },
        input_kind: 'contenteditable',
        send_mode: 'enter',
        stream_mode: 'last',
        automation: { typing_delay_ms: [0, 0], pre_send_pause_ms: [0, 0], jitter: false },
      }
      const res = await torra.typePrompt(spec, 'hi there friend')
      assert.equal(res.ok, true, `typePrompt 未通过：${res.reason}`)
      assert.equal(res.mode, 'char', '整段被拒时该退回逐字兜底')
      assert.equal(state.typed, 'hi there friend', '兜底要把整段补齐，不能留半句')
      // 一次整段尝试 + 清空后逐字（15 字 → 15 次），绝不该是「整段试完就算了」
      assert.equal(state.calls[0], 'hi there friend', '第一笔该是整段写入')
      assert.equal(state.calls.length, 16, `调用次数不对：${state.calls.length}`)
      // 反过来：站点认整段时不该再逐字（那才是省下来的三百秒）
      state.typed = ''
      state.calls.length = 0
      g.document.execCommand = (_: string, __: boolean, v: string) => { state.calls.push(v); state.typed += v; return true }
      const fast = await torra.typePrompt(spec, 'hi there friend')
      assert.equal(fast.mode, 'whole', '认整段的站点该走一次写入')
      assert.equal(state.calls.length, 1, `整段写入后又逐字补了一遍：${state.calls.length} 次`)
      assert.equal(state.typed, 'hi there friend')
    } finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete g[k]
        else g[k] = saved[k]
      }
    }
  })

  await itAsync('整段写入的三条硬形态：验过才认、没落地先擦干净、走了哪条要记进日志', async () => {
    // 省下来的三百秒全押在「站点确实认下了这段字」上，所以判据必须落在写入之后 ——
    // execCommand 不抛错不等于落地，它可能被站点拦下来只收了一部分。
    assert.match(INJECT_SCRIPT, /if \(insertWhole\(input, text, kind\)\) return Promise\.resolve\('whole'\)/)
    assert.match(INJECT_SCRIPT, /return holdsWhole\(input, text\)/, '写完就验，不是没抛错就算成')
    assert.match(
      INJECT_SCRIPT,
      /got\.indexOf\(want\.slice\(0, 12\)\) >= 0 &&\s*got\.indexOf\(want\.slice\(-12\)\) >= 0/,
      '只比长度会放行站点改写过的半句话：头尾都得以原文出现',
    )
    assert.match(INJECT_SCRIPT, /clearInput\(input, kind\);[\s\S]{0,120}return typeCharByChar/, '整段没落地要先擦干净，否则兜底会拼出半句话')
    assert.match(INJECT_SCRIPT, /function typeCharByChar/, '逐字循环是兜底，不能删 —— 拒收整段的站点只剩这条路')

    // 流水线日志要记本次走了哪条：真机验证（doctor --live）比的就是这一格的秒数
    const wv = await fs.readFile(path.join(__dirname, '../src/main/agents/webview-agent.ts'), 'utf8')
    assert.match(wv, /typed=\$\{typed\.mode \|\| 'char'\}/, "selector|type 那行得写出走了整段还是逐字")
  })

  await itAsync('浏览器级补刀不按输入框选择器反查（空态 class 会自毁）', async () => {
    // 补刀的判据是「框里还装着本轮提示词」。若按 spec.selectors.input 反查，
    // Quill 的 .ql-blank 在字落地后已经查不到节点，补刀就永远开不了枪。
    // 同一条判据也被 pressSend 用作「站点收下单」的收据（见 holdsPrompt），
    // 所以扫描整体住在注入脚本里，主进程只调用 —— 两处必须共用同一个判据。
    const src = await fs.readFile(path.join(__dirname, '../src/main/agents/webview-agent.ts'), 'utf8')
    const at = src.indexOf(`startsWith('generation did not start')`)
    assert.ok(at > 0, '补刀分支不见了')
    const w = src.slice(at, at + 2000)
    assert.match(w, /__torra\.holdsPrompt/, '补刀不再复用页面级的「框里还有没有字」判据')
    assert.doesNotMatch(w, /document\.querySelector\(\$\{inputSel\}/, '补刀又回去按选择器反查了')
    assert.match(INJECT_SCRIPT, /function holdsPromptText[\s\S]*?\[contenteditable\]/, '扫描通用可编辑候选的判据不见了')
  })

  it('输入框多命中时按可见优先选取', () => {
    // input 写成候选并集时（DeepSeek 三档），querySelectorAll 按文档顺序返回，
    // 一旦混进镜像节点或侧栏输入框，提示词就会打进错的框 ——
    // 表现为「发送了，但永远等不到回复」。
    assert.match(INJECT_SCRIPT, /function pickVisible/)
    const w = INJECT_SCRIPT.slice(INJECT_SCRIPT.indexOf('function waitFor'), INJECT_SCRIPT.indexOf('setNativeValue'))
    assert.match(w, /pickVisible\(selector\)/, 'waitFor 又退回裸 querySelector')
    // 体检必须复用同一条通道，否则会出现「体检测 A 框全绿、讨论里写进 B 框」
    assert.match(INJECT_SCRIPT, /pickInput: function/)
  })

  it('发送与完成控件也按可见优先选取', () => {
    assert.match(INJECT_SCRIPT, /sendBtn = sendMode === 'click' && sel\.send \? pickVisible\(sel\.send\)/)
    assert.match(INJECT_SCRIPT, /isVisible\(pickVisible\(sel\.stop\)\)/)
  })

  console.log('\n=== 选择器拾取器 ===')

  it('剔除 React 动态 id', () => {
    // 形如 :r3: 的 id 每次渲染都变，用它生成的选择器必然失效
    assert.match(PICKER_SCRIPT, /REACT_ID/)
  })

  it('剔除哈希类名', () => {
    assert.match(PICKER_SCRIPT, /HASHY/)
  })

  it('优先采用 data-testid', () => {
    // candidatesFor 内 testid 必须排在 id / aria-label / class 之前，
    // 否则生成的会是不稳定的哈希类名选择器
    const body = PICKER_SCRIPT.slice(
      PICKER_SCRIPT.indexOf('function candidatesFor'),
      PICKER_SCRIPT.indexOf('function evaluate'),
    )
    const firstPush = body.indexOf('out.push')
    const testidAt = body.indexOf('data-testid')
    const idAt = body.indexOf("el.id &&")
    assert.ok(testidAt > 0, '未找到 data-testid 分支')
    assert.ok(testidAt < idAt, 'data-testid 应排在 id 之前')
    assert.ok(testidAt > 0 && testidAt < body.indexOf('out.push', firstPush + 1) + 1)
  })

  console.log(`\n${'='.repeat(46)}`)
  console.log(`  通过 ${pass} · 失败 ${fail}`)
  console.log('='.repeat(46) + '\n')

  process.exit(fail > 0 ? 1 : 0)
}

void main()
