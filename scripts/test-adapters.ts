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
import { AdapterRegistry, validateSpec } from '../src/main/adapters/registry'
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

/**
 * 最小假 DOM，只为页内定位这一组测试存在。
 *
 * 为什么要自己造而不借真实站点：locateTurn 的判据全是「结构上的排除」——
 * 命中节点是不是落在正文容器/输入框的子树里、是不是零尺寸。真实页面上这三样
 * 同时出现的机会极少，一次改版就全变了；把这些形态写死在夹具里，
 * 判据退化了测试会立刻红，而不是等用户在页面上看到一次莫名的跳动。
 *
 * 节点只实现注入脚本真正会摸到的那几件事：innerText（由子孙文本拼出）、
 * getBoundingClientRect、contains、closest('textarea,input,[contenteditable…]')、
 * parentElement、getAttribute、scrollIntoView。选择器命中靠 serves 显式登记，
 * 不做 CSS 匹配 —— 测试里的选择器都是我们自己写的简单 token。
 */
function makeFakeWorld(): any {
  const world: any = { nodes: [] as any[], texts: [] as any[], scrolled: [] as any[] }

  function collectText(node: any): string {
    const parts: string[] = []
    if (node.own) parts.push(String(node.own))
    for (const c of node.children) parts.push(collectText(c))
    return parts.join(' ')
  }

  world.el = function el(parent: any, init: any): any {
    const node: any = {
      tagName: String(init.tag || 'DIV').toUpperCase(),
      className: init.cls || '',
      id: init.id || '',
      children: [] as any[],
      serves: (init.serves || []) as string[],
      editable: !!init.editable,
      attrs: init.attrs || {},
      own: init.text || '',
      offsetParent: {},
      parentElement: parent || null,
      getAttribute(k: string) {
        return node.attrs[k] || ''
      },
      getBoundingClientRect: () => ({
        width: init.w === undefined ? 620 : init.w,
        height: init.h === undefined ? 44 : init.h,
        top: init.top || 0,
      }),
      scrollIntoView: () => world.scrolled.push(node),
      contains(other: any) {
        let n = other
        while (n) {
          if (n === node) return true
          n = n.parentElement
        }
        return false
      },
      closest(sel: string) {
        // 注入脚本只用这一条选择器串判「是不是可编辑框」，不必做通用匹配
        if (!/textarea|input|contenteditable|textbox/.test(sel)) return null
        let n = node
        while (n) {
          if (n.editable || n.tagName === 'TEXTAREA' || n.tagName === 'INPUT') return n
          n = n.parentElement
        }
        return null
      },
      get innerText() {
        return collectText(node)
      },
      get textContent() {
        return collectText(node)
      },
    }
    if (parent) parent.children.push(node)
    world.nodes.push(node)
    if (node.own) world.texts.push({ nodeValue: node.own, parentElement: node })
    return node
  }

  world.body = world.el(null, { tag: 'BODY' })

  world.install = function install(): () => void {
    const g = globalThis as any
    const saved: Record<string, unknown> = {}
    for (const k of ['document', 'location', 'window', 'NodeFilter', 'HTMLInputElement', 'Event']) {
      saved[k] = g[k]
    }
    const queryAll = (sel: string) => world.nodes.filter((n: any) => n.serves.includes(sel))
    g.document = {
      body: world.body,
      title: 'fake',
      readyState: 'complete',
      visibilityState: 'visible',
      documentElement: world.body,
      querySelector: (sel: string) => queryAll(sel)[0] || null,
      querySelectorAll: queryAll,
      addEventListener: () => {},
      contains: (el: unknown) => world.body.contains(el),
      createRange: () => ({ selectNodeContents: () => {} }),
      execCommand: () => true,
      createTreeWalker: (root: any) => {
        let i = 0
        return {
          nextNode: () => {
            while (i < world.texts.length) {
              const t = world.texts[i++]
              if (!root || root.contains(t.parentElement)) return t
            }
            return null
          },
        }
      },
    }
    g.location = { pathname: '/chat', href: 'https://fake/chat' }
    g.window = {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', position: 'fixed' }),
      innerWidth: 1280,
      innerHeight: 900,
      getSelection: () => ({ removeAllRanges: () => {}, addRange: () => {} }),
    }
    g.NodeFilter = { SHOW_TEXT: 4 }
    g.HTMLInputElement = class {}
    g.Event = class {
      constructor(public type: string, public init?: unknown) {}
    }
    return function restore(): void {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete g[k]
        else g[k] = saved[k]
      }
    }
  }

  return world
}

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
    // 钉顺序不钉签名：isLoginWall 现在收输入框选择器，找 'isLoginWall()' 会跟着过期
    const loginIdx = INJECT_SCRIPT.indexOf('if (isLoginWall(inputSel))')
    const inputIdx = INJECT_SCRIPT.indexOf('waitFor(spec.selectors.input')
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
    assert.match(wvSrc, /notStarted \|\| staleComposer \? 'not-started' : 'adapter-broken'/, '发送失败的结论又合回一条了')
    // 「框里留着上一轮的话」也不能算适配器坏了：选择器指对了节点，是那家编辑器
    // 不让 DOM 删。判成 adapter-broken 会让人去体检选择器，而体检全绿。
    assert.match(wvSrc, /startsWith\('composer holds previous text'\)/, '清不掉残留的独立结论没了')
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
      // 走「真的看得见」那条路径：注入脚本现在严格按可见性挑写入/点击的节点，
      // 夹具要是缺了 rect / computed style，测的就只是判不出来时的兜底。
      offsetParent = {}
      isContentEditable = false
      getBoundingClientRect() { return { width: 600, height: 40 } }
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
      offsetParent: {},
      getBoundingClientRect: () => ({ width: 40, height: 40 }),
      click() { state.nodes.push({ innerText: 'NEW ANSWER' }) },
    }
    const qsa = (sel: string): any[] =>
      sel === '#i' ? [state.input] : sel === '#s' ? [state.send] : sel === '.a' ? state.nodes : []
    const g = globalThis as any
    const saved: Record<string, unknown> = {}
    for (const k of ['document', 'location', 'window', 'HTMLInputElement', 'Event']) saved[k] = g[k]
    g.document = { body: {}, contains: () => true, querySelector: (s: string) => qsa(s)[0] || null, querySelectorAll: qsa, addEventListener: () => {} }
    g.location = { pathname: '/chat', href: 'https://fake/chat' }
    g.window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', position: 'static' }) }
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

  await itAsync('写入被拒时先认登录弹窗，别让人去重试一堵墙（Kimi 游客实测）', async () => {
    /*
     * 2026-10-20 独立浏览器实测：kimi.com 未登录时输入框照常存在、照常看得见，
     * 按下回车弹出的是「微信扫码登录 / 手机号码登录 / 企业 SSO 登录」模态框，
     * 话一个字都留不下。若只报「站点拒收了这次写入，请重试」，用户会重试到明天。
     * 所以：写不进去 → 先看有没有弹出来的登录框，有就说 login-required。
     * 反过来，页头/侧栏那枚常驻「登录」按钮不能算墙 —— 未登录的 chatgpt.com
     * 侧栏一直挂着它，那一轮照样发得出去。
     */
    const state: any = { typed: '', dialog: true }
    const editor: any = {
      tagName: 'DIV',
      className: 'chat-input-editor',
      isContentEditable: true,
      offsetParent: {},
      getBoundingClientRect: () => ({ width: 700, height: 60 }),
      getAttribute: () => '',
      focus() {},
      dispatchEvent() {},
      get innerText() { return state.typed },
    }
    const dialog: any = {
      tagName: 'DIV',
      className: 'login-modal',
      offsetParent: {},
      getBoundingClientRect: () => ({ width: 420, height: 360 }),
      getAttribute: () => '',
      get innerText() { return state.dialog ? '微信扫码登录 手机号码登录 +86 发送验证码 企业 SSO 登录' : '' },
    }
    const g = globalThis as any
    const saved: Record<string, unknown> = {}
    for (const k of ['document', 'location', 'window', 'HTMLInputElement', 'Event']) saved[k] = g[k]
    g.document = {
      body: { innerText: '' },
      title: 'fake',
      readyState: 'complete',
      visibilityState: 'visible',
      querySelector: (s: string) => (s.indexOf('#box') >= 0 ? editor : null),
      querySelectorAll: (sel: string) => {
        if (sel === '#box') return [editor]
        if (sel.indexOf('aria-modal') >= 0 || sel.indexOf('[role="dialog"]') >= 0) return [dialog]
        return []
      },
      addEventListener: () => {},
      contains: (el: unknown) => el === editor,
      // 这位站点一个字都不收
      execCommand: () => false,
    }
    g.location = { pathname: '/', href: 'https://fake/chat' }
    g.window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', position: 'static' }), innerWidth: 1280, innerHeight: 900 }
    g.HTMLInputElement = class {}
    g.Event = class { constructor(public type: string, public init?: unknown) {} }
    try {
      new Function(INJECT_SCRIPT)()
      const torra = g.window.__torra
      const spec = {
        selectors: { input: '#box', stream: '.a' },
        input_kind: 'contenteditable',
        send_mode: 'enter',
        stream_mode: 'last',
        automation: { typing_delay_ms: [0, 0], pre_send_pause_ms: [0, 0], jitter: false },
      }
      const withDialog = await torra.typePrompt(spec, 'hi there friend')
      assert.equal(withDialog.ok, false, '一个字都没落地却报成功了')
      assert.equal(withDialog.reason, 'login-required', `有登录弹窗却仍报「拒收写入」：${withDialog.reason}`)
      // 弹窗收起（站点只是暂时不认写入）→ 仍要说清是写入被拒，不是登录
      state.dialog = false
      const withoutDialog = await torra.typePrompt(spec, 'hi there friend')
      assert.ok(String(withoutDialog.reason).startsWith('input did not keep the prompt'),
        `没有登录弹窗时该照实说写入被拒：${withoutDialog.reason}`)
    } finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete g[k]
        else g[k] = saved[k]
      }
    }
  })

  await itAsync('清空要动编辑器的状态机，不能只改 textContent（Kimi 双句实测）', async () => {
    /*
     * 2026-10-20 在 kimi.com 连发两轮：第二轮框里留下
     * 「只回复两个字：收到只回复两个字：收到」。原因是 Lexical 这类编辑器由内部
     * 文档拥有 DOM —— 直接 textContent='' 它不认，下一次 input 事件就把旧内容渲染回来。
     * 现在先走「全选 + execCommand(delete)」，动的是浏览器删除通道，编辑器的状态机跟着走。
     * 夹具照站点行为写成「改 textContent 无效、只认 delete 命令」，两轮后必须只剩第二句。
     */
    const state: any = { typed: '', cmds: [] as string[] }
    const editor: any = {
      tagName: 'DIV',
      className: 'chat-input-editor',
      isContentEditable: true,
      offsetParent: {},
      getBoundingClientRect: () => ({ width: 700, height: 60 }),
      getAttribute: () => '',
      focus() {},
      dispatchEvent() {},
      get innerText() { return state.typed },
      // 站点的关键行为：直接赋 textContent 被状态机忽略，一个字都清不掉
      set textContent(_v: string) { /* 故意什么都不做 */ },
      get textContent() { return state.typed },
    }
    const g = globalThis as any
    const saved: Record<string, unknown> = {}
    for (const k of ['document', 'location', 'window', 'HTMLInputElement', 'Event']) saved[k] = g[k]
    g.document = {
      body: { innerText: '' },
      title: 'fake',
      readyState: 'complete',
      visibilityState: 'visible',
      querySelector: (s: string) => (s.indexOf('#box') >= 0 ? editor : null),
      querySelectorAll: (sel: string) => (sel === '#box' ? [editor] : []),
      addEventListener: () => {},
      contains: (el: unknown) => el === editor,
      createRange: () => ({ selectNodeContents: () => {} }),
      execCommand: (cmd: string, _u: boolean, v: string) => {
        state.cmds.push(cmd)
        if (cmd === 'delete') { state.typed = ''; return true }
        if (cmd === 'insertText') { state.typed += String(v || ''); return true }
        return false
      },
    }
    g.location = { pathname: '/', href: 'https://fake/chat' }
    g.window = {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', position: 'static' }),
      innerWidth: 1280, innerHeight: 900,
      getSelection: () => ({ removeAllRanges: () => {}, addRange: () => {} }),
    }
    g.HTMLInputElement = class {}
    g.Event = class { constructor(public type: string, public init?: unknown) {} }
    try {
      new Function(INJECT_SCRIPT)()
      const torra = g.window.__torra
      const spec = {
        selectors: { input: '#box' },
        input_kind: 'contenteditable',
        send_mode: 'enter',
        stream_mode: 'last',
        automation: { typing_delay_ms: [0, 0], pre_send_pause_ms: [0, 0], jitter: false },
      }
      const first = await torra.typePrompt(spec, '第一句话')
      assert.equal(first.ok, true, `第一轮写入失败：${first.reason}`)
      assert.equal(state.typed, '第一句话')
      const second = await torra.typePrompt(spec, '第二句话')
      assert.equal(second.ok, true, `第二轮写入失败：${second.reason}`)
      assert.equal(state.typed, '第二句话', `旧内容没清掉，站点会收到拼起来的那一句：${state.typed}`)
      assert.ok(state.cmds.indexOf('delete') >= 0, '清空没走浏览器的删除通道（编辑器状态机不认 textContent 赋值）')
    } finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete g[k]
        else g[k] = saved[k]
      }
    }
  })

  await itAsync('清不掉的残留要停住，不能把两轮发言拼成一句发出去（Lexical 实测）', async () => {
    /*
     * 上一句那个夹具证明「走对通道就能清掉」，这一句证明清不掉时不硬发。
     * 2026-10-20 在 kimi.com 实测：全选删除、range 删除、改 textContent 三条 DOM 路径
     * 删完再读，框里的字一个不少。此时若继续写入，站点收到的是两句拼起来的一句，
     * 而写入回执（首尾探针 + 长度）对拼好的那句照样判通过 —— 每一步都是 ok，
     * 用户拿到的却是一个答非所问的回复。所以这一刻必须停下来报错，
     * 并把「用浏览器级按键真删一次」这个动作留给主进程（真人按键走 beforeinput，状态机认）。
     */
    const state: any = { typed: '上一轮没清掉的那句话', cmds: [] as string[] }
    const editor: any = {
      tagName: 'DIV',
      className: 'lexical-editor',
      isContentEditable: true,
      offsetParent: {},
      getBoundingClientRect: () => ({ width: 700, height: 60 }),
      getAttribute: () => '',
      focus() {},
      dispatchEvent() {},
      get innerText() { return state.typed },
      set textContent(_v: string) { /* 状态机忽略：一个字都清不掉 */ },
      get textContent() { return state.typed },
    }
    const g = globalThis as any
    const saved: Record<string, unknown> = {}
    for (const k of ['document', 'location', 'window', 'HTMLInputElement', 'Event']) saved[k] = g[k]
    g.document = {
      body: { innerText: '' },
      title: 'fake',
      readyState: 'complete',
      visibilityState: 'visible',
      querySelector: (s: string) => (s.indexOf('#box') >= 0 ? editor : null),
      querySelectorAll: (sel: string) => (sel === '#box' ? [editor] : []),
      addEventListener: () => {},
      contains: (el: unknown) => el === editor,
      createRange: () => ({ selectNodeContents: () => {} }),
      // 关键：delete 命令被站点吞了，内容原样留着 —— 这就是「DOM 侧删不动」
      execCommand: (cmd: string, _u: boolean, v: string) => {
        state.cmds.push(cmd)
        if (cmd === 'insertText') state.typed += String(v || '')
        return true
      },
    }
    g.location = { pathname: '/', href: 'https://fake/chat' }
    g.window = {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', position: 'static' }),
      innerWidth: 1280, innerHeight: 900,
      getSelection: () => ({ removeAllRanges: () => {}, addRange: () => {} }),
    }
    g.HTMLInputElement = class {}
    g.Event = class { constructor(public type: string, public init?: unknown) {} }
    try {
      new Function(INJECT_SCRIPT)()
      const torra = g.window.__torra
      const res = await torra.typePrompt(
        {
          selectors: { input: '#box' },
          input_kind: 'contenteditable',
          send_mode: 'enter',
          stream_mode: 'last',
          automation: { typing_delay_ms: [0, 0], pre_send_pause_ms: [0, 0], jitter: false },
        },
        '这一轮想说的话',
      )
      assert.equal(res.ok, false, '框里明明还留着上一轮，回执却说可以发')
      assert.match(res.reason, /^composer holds previous text/, `结论没分家：${res.reason}`)
      assert.ok(state.cmds.indexOf('insertText') < 0, '停住之前还硬写了一遍：站点会收到拼起来的那一句')
      assert.equal(state.typed, '上一轮没清掉的那句话')

      // 主进程那半边：真人按键删一次（Ctrl+A → Delete），验过真空了才重试，且只重试一次
      const wv = await fs.readFile(path.join(__dirname, '../src/main/agents/webview-agent.ts'), 'utf8')
      assert.match(wv, /async function clearComposerTrusted/, '按键清空输入框这条路没了')
      assert.match(wv, /keyCode: 'A', modifiers: \['control'\]/, '全选没带 Ctrl —— 光按 A 只会往框里写字母')
      assert.match(wv, /keyCode: 'Delete'/, '删除键没按')
      assert.match(wv, /__torra\.composerText/, '删完没验框里还剩几个字')
      assert.equal(
        (wv.match(/await runType\(\)/g) || []).length,
        2,
        '键入重试的次数不再受限：清不干净时反复写会把框越拼越长',
      )
    } finally {
      for (const k of Object.keys(saved)) {
        if (saved[k] === undefined) delete g[k]
        else g[k] = saved[k]
      }
    }
  })

  await itAsync('整段写入要等一帧再判：状态机编辑器同步读到的还是旧 DOM（kimi 实测重复发言）', async () => {
    /*
     * 2026-10-20 kimi.com 实测：execCommand('insertText') 已经把整段收进内部文档，
     * 但 DOM 要下一帧才渲染。旧写法同步 holdsWhole 于是判「拒收」，退去走逐字兜底，
     * 兜底期间编辑器把整段那份渲染了回来 —— 框里最终留下「新一轮写入的句子一轮写入的句子」，
     * 9 个字的提示词变成 15 个字，而末尾回执对拼好的串照样判通过。
     * 夹具把「下一帧才渲染」如实写出来：insertText 先进 pending，30ms 后才并入 innerText。
     */
    const state: any = { committed: '', pending: '', cmds: [] as string[] }
    const editor: any = {
      tagName: 'DIV',
      className: 'lexical-editor',
      isContentEditable: true,
      offsetParent: {},
      getBoundingClientRect: () => ({ width: 700, height: 60 }),
      getAttribute: () => '',
      focus() {},
      dispatchEvent() {},
      get innerText() { return state.committed },
      set textContent(_v: string) { /* 状态机忽略直接赋值 */ },
      get textContent() { return state.committed },
    }
    const g = globalThis as any
    const saved: Record<string, unknown> = {}
    for (const k of ['document', 'location', 'window', 'HTMLInputElement', 'Event']) saved[k] = g[k]
    g.document = {
      body: { innerText: '' },
      title: 'fake',
      readyState: 'complete',
      visibilityState: 'visible',
      querySelector: (s: string) => (s.indexOf('#box') >= 0 ? editor : null),
      querySelectorAll: (sel: string) => (sel === '#box' ? [editor] : []),
      addEventListener: () => {},
      contains: (el: unknown) => el === editor,
      createRange: () => ({ selectNodeContents: () => {} }),
      execCommand: (cmd: string, _u: boolean, v: string) => {
        state.cmds.push(cmd)
        if (cmd === 'insertText') {
          state.pending += String(v || '')
          const q = state.pending
          state.pending = ''
          setTimeout(() => { state.committed += q }, 30)
          return true
        }
        if (cmd === 'delete') { state.committed = ''; state.pending = ''; return true }
        return true
      },
    }
    g.location = { pathname: '/', href: 'https://fake/chat' }
    g.window = {
      getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1', position: 'static' }),
      innerWidth: 1280, innerHeight: 900,
      getSelection: () => ({ removeAllRanges: () => {}, addRange: () => {} }),
    }
    g.HTMLInputElement = class {}
    g.Event = class { constructor(public type: string, public init?: unknown) {} }
    try {
      new Function(INJECT_SCRIPT)()
      const torra = g.window.__torra
      const spec = {
        selectors: { input: '#box' },
        input_kind: 'contenteditable',
        send_mode: 'enter',
        stream_mode: 'last',
        automation: { typing_delay_ms: [0, 0], pre_send_pause_ms: [0, 0], jitter: false },
      }
      const res = await torra.typePrompt(spec, '一轮完整的提示词')
      assert.equal(res.ok, true, `整段其实落地了，却被判成拒收：${res.reason}`)
      assert.equal(res.mode, 'whole', '慢一帧渲染的编辑器又退去走逐字兜底 —— 站点会收到拼起来的那一句')
      assert.equal(state.committed, '一轮完整的提示词', `框里留下了别的东西：${state.committed}`)
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
    assert.match(INJECT_SCRIPT, /if \(!writeWhole\(input, text, kind\)\) return charFallback/)
    assert.match(INJECT_SCRIPT, /return waitMs\(WHOLE_SETTLE_MS\)\.then\(function \(\) \{\s*\n\s*if \(holdsWhole\(input, text\)\) return 'whole'/, '写完要等一帧再验：同步读会把已落地的整段误判成拒收')
    assert.match(
      INJECT_SCRIPT,
      /got\.indexOf\(want\.slice\(0, 12\)\) >= 0 &&\s*got\.indexOf\(want\.slice\(-12\)\) >= 0/,
      '只比长度会放行站点改写过的半句话：头尾都得以原文出现',
    )
    assert.match(INJECT_SCRIPT, /function charFallback[\s\S]{0,200}clearInput\(input, kind\)/, '整段没落地要先擦干净，否则兜底会拼出半句话')
    assert.match(INJECT_SCRIPT, /if \(composerText\(input\)\.length > 0\) return 'stuck'/, '擦不干净还要逐字往下拼 —— 站点收到的就是两句')
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
    /*
     * 发送按钮必须只在「看得见」的命中里挑。
     * pickVisible 在全不可见时兜底返回第一个命中，而 SPA 换页后旧发送按钮
     * 常整块留在树里只是隐藏 —— click() 打在 display:none 的节点上，
     * 站点一点没收到，我们却以为按过了，只能等满窗口报「生成未开始」。
     * 没有可见按钮就退回键盘 Enter：那至少作用在当前这枚框上。
     */
    assert.match(INJECT_SCRIPT, /sendBtn = sendMode === 'click' && sel\.send \? pickVisibleOnly\(sel\.send\)/)
    assert.match(INJECT_SCRIPT, /isVisible\(pickVisible\(sel\.stop\)\)/)
  })

  it('发送回执的每一条成功路径都带 accepted 与证据', () => {
    /*
     * 聊天模式只看 accepted 决定这一轮算不算发出去了。
     * 曾经 pressSend 只在超时时带回原因，成功分支 return {ok:true} 不带 accepted，
     * 于是豆包游客明明回复都长出来了，界面上仍是「站点没接走这一轮」。
     * 所有成功出口必须走 taken(via)，把证据（生成中 / 回复节点 / 步骤 / 清框）一起交出。
     */
    assert.match(INJECT_SCRIPT, /function taken\(via\)[\s\S]{0,200}accepted: true/)
    assert.equal(
      (INJECT_SCRIPT.match(/resolve\(taken\('([a-z-]+)'\)\)/g) || []).length,
      4,
      '成功出口应各有其一：generating / stream / steps / composer-cleared',
    )
    assert.doesNotMatch(
      INJECT_SCRIPT.slice(INJECT_SCRIPT.indexOf('pressSend: function'), INJECT_SCRIPT.indexOf('holdsPrompt: function')),
      /resolve\(\{ ok: true, reason: '' \}\)/,
      '又有成功分支不带 accepted 了 —— 聊天模式会把它读成「站点没接走」',
    )
  })

  it('回复区多出空壳节点不算「站点接走了这一轮」', () => {
    /*
     * 2026-10-20 在 chatgpt.com 游客落地页实测：页面会短暂挂出一枚
     * data-message-author-role=assistant 的空节点，节点数 0→1 在 250ms 一档里就成立，
     * 于是收据 accepted:true / via:stream，而那一轮压根没发出去、框里的话原样留着。
     * 用户看到的是一张「已送达」却永远没有下文的卡片 —— 比一句报错更难查。
     * 「回复区变长」这条必须读得出正文；只清框没正文的站点由 composer-cleared 接住。
     */
    const seg = INJECT_SCRIPT.slice(INJECT_SCRIPT.indexOf('pressSend: function'), INJECT_SCRIPT.indexOf('holdsPrompt: function'))
    assert.doesNotMatch(seg, /now > baseline/, '又只看节点数判接收了')
    assert.match(seg, /var flow = readStream\([\s\S]{0,200}if \(flow\)/, '「回复区变长」这条收据要先读得出正文')
  })

  it('键入只等看得见的框，写不进去要说得出原因', () => {
    // 第三参 true：只等可见节点；失败分「命中但没画出来」和「根本没有这个节点」两档
    assert.match(INJECT_SCRIPT, /waitFor\(spec\.selectors\.input, 15000, true\)/)
    assert.match(INJECT_SCRIPT, /function pickVisibleOnly/)
    assert.match(INJECT_SCRIPT, /function hiddenHits/)
    assert.match(INJECT_SCRIPT, /input not visible/)
    assert.match(INJECT_SCRIPT, /input did not keep the prompt/)
    // 回执以「我们写过字的那一枚」为准，全局扫描只作第二道
    assert.match(INJECT_SCRIPT, /if \(!\(holdsWhole\(input, prompt\) \|\| holdsPromptText\(prompt\)\)\)/)
    // position:fixed 的可见框 offsetParent 就是 null，不能当成隐藏
    assert.match(INJECT_SCRIPT, /el\.offsetParent === null && st\.position !== 'fixed'/)
    // 写入被拒 / 等不到生成时，弹出来的登录框优先于「请重试」
    assert.match(INJECT_SCRIPT, /function loginDialogUp/)
    assert.match(INJECT_SCRIPT, /if \(loginDialogUp\(\)\) \{\s*return \{ ok: false, reason: 'login-required'/)
    assert.match(INJECT_SCRIPT, /if \(isLoginWall\(sel\.input\) \|\| loginDialogUp\(\)\)/)
  })

  console.log('\n=== 只读的内置目录（打包后在 app.asar 里） ===')

  const specYaml = (id: string): string =>
    YAML.stringify({
      id,
      name: `测试·${id}`,
      transport: 'webview',
      entry: `https://${id}.example.com/`,
      selectors: { input: 'textarea.i', stream: '.out' },
      completion: { mode: 'dom_stable', timeout_s: 20 },
      automation: { typing_delay_ms: [8, 20], pre_send_pause_ms: [200, 500], max_wait_s: 60, jitter: true },
      health_probe: 'textarea.i',
      verified_at: new Date().toISOString().slice(0, 10),
      tos_notice: '测试用',
    })

  await itAsync('内置目录不可建（asar 只读）也要把适配器读满', async () => {
    /*
     * 复刻打包版的形态：内置目录可读但不可创建。真实 app.asar 里对它 mkdir 抛 ENOTDIR，
     * 这里用一个同名普通文件占住「内置目录」的位置，并把 YAML 放在它的兄弟路径上 ——
     * 对 <file>/nested 做任何 mkdir 都必抛 ENOTDIR，而 readdir 走的是另一条路径，
     * 于是这个夹具只掐掉 mkdir，不掐掉读盘，正好是要钉住的那件事。
     * 旧写法把 mkdir 当成 readdir 的前提，catch 掉之后整批内置清单静默归零 ——
     * 用户端表现是「每个模型都没有适配器」，而日志里一个字都没有。
     */
    const os = await import('node:os')
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'torra-adapter-'))
    const placeholder = path.join(base, 'app.asar')
    await fs.writeFile(placeholder, 'not a directory', 'utf8')
    const builtin = path.join(placeholder, 'adapters')
    const readable = path.join(base, 'readable-adapters')
    await fs.mkdir(readable, { recursive: true })
    const fixture = validateSpec(YAML.parse(specYaml('alpha')))
    assert.ok(fixture.ok, `夹具 YAML 不合格：${!fixture.ok && fixture.errors.join('; ')}`)
    for (const id of ['alpha', 'beta']) {
      await fs.writeFile(path.join(readable, `${id}.yaml`), specYaml(id), 'utf8')
    }
    // 内置路径不可建（ENOTDIR），但同一注册表的可读目录里确有 YAML：
    // 走 builtin=不可建路径 → 应当留下 0 条且不抛出；走可读路径 → 必须读满
    const blocked = new AdapterRegistry(builtin, path.join(base, 'udata', 'adapters'))
    await blocked.loadAll()
    assert.equal(blocked.list().length, 0, '不可建的内置目录不应凭空多出适配器')

    const readableReg = new AdapterRegistry(readable, path.join(base, 'udata', 'adapters'))
    await readableReg.loadAll()
    assert.equal(readableReg.list().length, 2, `可读目录应读满 2 条，实读 ${readableReg.list().length}`)
    assert.ok(readableReg.list().every((r) => r.spec.origin === 'builtin'), '内置适配器出身标记不对')

    // 真实包里的 7 条内置清单在任何夹具下都不该归零
    const real = new AdapterRegistry(path.join(__dirname, '../adapters'), path.join(base, 'udata2', 'adapters'))
    await real.loadAll()
    assert.equal(real.list().length, 7, `真实内置清单应读满 7 条，实读 ${real.list().length}`)
    await fs.rm(base, { recursive: true, force: true })
  })

  await itAsync('用户目录不存在时按需建出来，内置目录不尝试创建', async () => {
    const os = await import('node:os')
    const src = await fs.readFile(path.join(__dirname, '../src/main/adapters/registry.ts'), 'utf8')
    const body = src.slice(src.indexOf('private async resync'), src.indexOf('private async loadFile'))
    assert.match(body, /if \(writable\) await fs\.mkdir/, 'resync 又对每个目录无条件 mkdir 了')
    assert.match(body, /path\.resolve\(dir\) === path\.resolve\(this\.userDir\)/, '可写判定不再只认用户目录')
    assert.match(body, /目录不可读/, '目录读失败仍然是静默 continue，失败不会留下任何痕迹')
    const base = await fs.mkdtemp(path.join(os.tmpdir(), 'torra-adapter-'))
    const userDir = path.join(base, 'udata', 'torra', 'adapters')
    const reg = new AdapterRegistry(path.join(__dirname, '../adapters'), userDir)
    await reg.loadAll()
    assert.ok((await fs.readdir(userDir)).length >= 0, '用户目录没有被按需建出来')
    await reg.saveUser(YAML.parse(specYaml('madeup')) as never)
    assert.ok(reg.get('madeup'), 'saveUser 之后新适配器没进注册表')
    assert.equal(reg.get('madeup')?.spec.origin, 'user', '自建适配器出身应标为 user')
    await fs.rm(base, { recursive: true, force: true })
  })

  await itAsync('CSP 只按 <img> 的取用方式放行 torra-icon', async () => {
    /*
     * 图标唯一的消费方是 <img src="torra-icon://…">，走 img-src。
     * 别把它加进 connect-src 去「支持 fetch」：真实应用是 file:// 页面，
     * 实测连 fetch('https://clients2.google.com') 都直接 TypeError ——
     * 拦它的是 Chromium 的不透明源，不是 CSP，放宽 connect-src 只会白白扩大自定义方案的取值面。
     */
    const html = await fs.readFile(path.join(__dirname, '../src/renderer/index.html'), 'utf8')
    const csp = (html.match(/content="([^"]*img-src[^"]*)"/) ?? [])[1] ?? ''
    assert.match(csp, /img-src[^;]*torra-icon:/, 'img-src 应放行 torra-icon')
    assert.doesNotMatch(csp, /connect-src[^;"]*torra-icon:/, 'connect-src 不该放行 torra-icon（file:// 页面根本 fetch 不动，见注释）')
  })

  console.log('\n=== 页内定位（__torra.locateTurn）===')

  /*
   * 这一组只测一件事：命中「我们发出去的那一句」，别的都不许命中。
   * 三条实测干扰源都摆进夹具里 —— 助手把问题原文复述进回答（DeepSeek 第一行就是加粗的
   * 问题本身）、输入框还装着上一句、侧栏历史条目同样写着这句话但宽 0。
   * 少排除任何一个，滚过去的就不是那一问，而用户看到的是一次莫名其妙的跳动。
   */

  await itAsync('定位只认用户气泡：复述、输入框、零尺寸侧栏副本一律不算命中', async () => {
    const want = '帮我把这轮圆桌的结论整理成三条可执行的下一步'
    const w = makeFakeWorld()
    const sideHistory = w.el(w.body, { text: want, w: 0, h: 0 })
    const composer = w.el(w.body, { id: 'box', serves: ['#box'], editable: true, text: want })
    const stream = w.el(w.body, { serves: ['#stream'] })
    w.el(stream, { text: want })
    const bubble = w.el(w.body, { text: want })
    assert.ok(sideHistory && composer, '夹具没搭起来')
    const restore = w.install()
    try {
      new Function(INJECT_SCRIPT)()
      const r = (globalThis as any).window.__torra.locateTurn(
        { selectors: { input: '#box', stream: '#stream' } },
        want,
        1,
      )
      assert.equal(r.ok, true, `页面上明明挂着这一问，却定位失败：${r.reason}`)
      assert.equal(r.found, 1, `命中了 ${r.found} 处 —— 复述/输入框/侧栏副本没被排除干净`)
      assert.equal(r.mode, 'heuristic', '没配 user_turn 却报精确档，站点改版时没人知道该补哪个字段')
      assert.equal(w.scrolled[0], bubble, '滚过去的不是那枚用户气泡')
    } finally {
      restore()
    }
  })

  await itAsync('同一句在页面上出现多次时按 nth 取第 K 处，并把 K 报回去', async () => {
    /*
     * 用户连着问两遍同一句话是真实场景（第一遍站点没接走，原话重发）。
     * 此时两处都是合法气泡，不能随便挑 —— 取错一处等于跳到另一轮的回答上。
     */
    const want = '第三轮的那个折中方案再讲一遍，短一点'
    const w = makeFakeWorld()
    const first = w.el(w.body, { text: want, top: 300 })
    const second = w.el(w.body, { text: want, top: 1800 })
    const restore = w.install()
    try {
      new Function(INJECT_SCRIPT)()
      const torra = (globalThis as any).window.__torra
      const r = torra.locateTurn({ selectors: {} }, want, 2)
      assert.equal(r.found, 2, '两处同名气泡应都数出来，好让结论写清「取第 K 处」')
      assert.equal(r.index, 2)
      assert.equal(w.scrolled[0], second, 'nth=2 却滚到了第一处')
      const r1 = torra.locateTurn({ selectors: {} }, want, 1)
      assert.equal(r1.index, 1)
      assert.equal(w.scrolled[1], first, 'nth=1 却滚到了第二处')
    } finally {
      restore()
    }
  })

  await itAsync('配了 user_turn 走精确档：真气泡优先，藏在正文里的同名节点照样排除', async () => {
    // 元宝实测 [data-conv-speaker="human"] 稳定（还带 data-conv-idx / data-conv-id），
    // 有这一档就别再启发式扫全文 —— 启发式只在「站点的用户气泡没有任何可辨特征」时兜底。
    const want = '按刚才那份大纲把第二章写成一段完整的论述'
    const w = makeFakeWorld()
    const stream = w.el(w.body, { serves: ['#stream'] })
    // 站点把用户气泡的样式类也复用到「引用原话」那一段上 —— 精确档同样不能被它骗过去
    w.el(stream, { serves: ['.me'], text: want })
    w.el(w.body, { cls: 'hist', serves: ['.me'], text: want, w: 0, h: 0 })
    const real = w.el(w.body, { cls: 'msg', serves: ['.me'], text: want })
    const restore = w.install()
    try {
      new Function(INJECT_SCRIPT)()
      const r = (globalThis as any).window.__torra.locateTurn(
        { selectors: { input: '#box', stream: '#stream', user_turn: '.me' } },
        want,
        1,
      )
      assert.equal(r.ok, true, `精确档定位失败：${r.reason}`)
      assert.equal(r.mode, 'user_turn')
      assert.equal(r.found, 1, `精确档命中 ${r.found} 处，排除区没作用到 user_turn 分支`)
      assert.equal(w.scrolled[0], real, '滚到了正文里的引用段或侧栏副本，不是真气泡')
      assert.equal(real.className, 'msg')
    } finally {
      restore()
    }
  })

  await itAsync('虚拟化把那一轮摘掉了就照实说 not mounted，别硬滚', async () => {
    /*
     * ChatGPT / DeepSeek 的消息列表只挂最近一两个回合（adapters/chatgpt.yaml 已记）。
     * 旧轮次不在 DOM 里，这不是选择器写错，重试与「体检」都修不好。
     * 如实回 not mounted，调用方才有依据去走「跳回那一场会话」这条路。
     */
    const want = '把上一轮那张对照表按成本重新排一遍'
    const w = makeFakeWorld()
    const stream = w.el(w.body, { serves: ['#stream'] })
    w.el(stream, { text: '好的，这是重新排过的对照表：按成本从低到高依次是……' })
    w.el(w.body, { id: 'box', serves: ['#box'], editable: true, text: '下一轮的新问题' })
    const restore = w.install()
    try {
      new Function(INJECT_SCRIPT)()
      const r = (globalThis as any).window.__torra.locateTurn(
        { selectors: { input: '#box', stream: '#stream' } },
        want,
        1,
      )
      assert.equal(r.ok, false, '那一轮早被摘出 DOM，却报定位成功')
      assert.equal(r.found, 0)
      assert.equal(r.reason, 'not mounted', `该说「不在页面上」，实际说了 ${r.reason}`)
      assert.equal(w.scrolled.length, 0, '没命中还滚了一下，用户会看到一次没有落点的跳动')
    } finally {
      restore()
    }
  })

  it('定位只按原文头尾判，短语太短直接拒', () => {
    // 只比长度会放行站点改写过的半句；比开头+结尾 12 字才认「就是这一句」。
    assert.match(INJECT_SCRIPT, /var head = want\.slice\(0, 12\)/)
    assert.match(INJECT_SCRIPT, /tail = want\.length > 24 \? want\.slice\(-12\) : ''/)
    assert.match(INJECT_SCRIPT, /if \(want\.length < 2\) return \{ ok: false, found: 0, mode: '', reason: 'empty prompt' \}/)
    // 排除区必须同时盖住正文容器与输入框，且选择器写坏时宁可少认也别整条路失效
    assert.match(INJECT_SCRIPT, /collect\(sel\.stream\)[\s\S]{0,120}collect\(sel\.input\)/)
    assert.match(INJECT_SCRIPT, /r\.width < 2 \|\| r\.height < 2/)
    assert.match(INJECT_SCRIPT, /if \(inField\(el\) \|\| blockedBy\(el\)\) return/)
  })

  await itAsync('会话指针这条链路四层都在，跳回那一步锁同源', async () => {
    /*
     * 页内找到那句话只是一半。另一半是「那一轮根本不在 DOM 里」时的退路：
     * 投递完把站点自己的会话 URL 存进这一格，点旧问题时先找、找不到就导航回去。
     * 这四层（agent → 主进程 IPC → preload → 渲染层存档）任何一层漏了都不报错，
     * 只表现为「点了没反应」或「永远说找不到」—— 所以钉在源码形状上。
     */
    const read = (p: string) => fs.readFile(path.join(__dirname, '..', p), 'utf8')
    const wv = await read('src/main/agents/webview-agent.ts')
    assert.match(wv, /const url = await this\.siteConversationUrl\(d\.view\)/, '原生投递没顺手抓会话指针')
    assert.match(wv, /\.\.\.\(url \? \{ url \} : \{\}\)/, '拿到的指针没进这一轮的返回')
    assert.match(
      wv,
      /for \(let i = 0; i < 6 && \(!url \|\| sameAsEntry\(url\)\); i\+\+\)/,
      '路由是发送后才换的，URL 还停在入口要等一下，否则指针恒为空',
    )
    assert.match(wv, /return sameAsEntry\(url\) \? '' : url/, '仍停在入口就得上报「没有指针」，不能把入口当会话地址存下来')
    assert.match(
      wv,
      /!!entryOrigin && originOf\(want\) === entryOrigin \? want : ''/,
      '导航没锁同源：指针存在可被改写的会话存档里，不能当任意跳转的授权',
    )
    // 定位同样是「往当前文档放我们的代码」，判源必须走在 ensureInjected 前面
    const gate = wv.indexOf('isEntryOrigin(spec.entry, safeUrl(view))')
    const inject = wv.indexOf('await this.ensureInjected()', gate)
    assert.ok(gate > 0 && inject > gate, 'locateTurn 不再判源就往页面铺脚本了')

    const main = await read('src/main/index.ts')
    assert.match(main, /send\('chat:delivered', \{ chatId, modelId, accepted: r\.accepted, note: r\.note, url: r\.url \}\)/, 'chat:delivered 没把指针带给界面')
    assert.match(main, /ipcMain\.handle\('chat:locate'/, '定位这条 IPC 通道没了')
    assert.match(main, /agent\.locateTurn\(prompt, url\)/, 'chat:locate 没接到 agent 上')

    const pre = await read('src/preload/index.ts')
    assert.match(pre, /chatLocate:[\s\S]{0,240}ipcRenderer\.invoke\('chat:locate'/, '渲染层没有可用的定位入口')

    const page = await read('src/renderer/components/ChatPage.tsx')
    assert.match(page, /\.\.\.\(url \? \{ siteUrl: url \} : \{\}\)/, '收据带来的指针没存进这一格')
    assert.match(page, /c\.siteUrl \? \{ url: c\.siteUrl \} : \{\}/, '定位没把这一格的指针传下去，跳回会话那条退路等于没接')
    assert.match(page, /locateInPanes\(id\)/, '点问题轨不再驱动页内定位')
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
